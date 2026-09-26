import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

import { BaiduPanClient, DEFAULT_REMOTE_SUBDIR, joinRemote, normalizeCredentials, normalizeRemotePath, relativeTo } from './baidu.js'

export const name = 'session-migrate'

// 文件操作全部走 node:fs，因此不再需要 fs / shell / sandboxPolicy 三个宿主服务：
// 这套实现跨平台（Windows 与 macOS 行为一致），也没有 PowerShell 的进程启动开销。
export const inject = ['sessionQuery', 'workspaceRegistry']

// DSH 的会话日志是「一帧一段 JSONL」的多帧 zstd 文件，header 单独占第一帧。
// 因此定位第一帧就能读写会话元数据，完全不必解开后面的事件内容。
const ZSTD_MAGIC = 0xFD2FB528

// header 帧不会大，扫描时只读文件头部即可——不必把几 MB 的会话整个读进内存。
const SESSION_HEAD_BYTES = 64 * 1024

// 与 dsh-session-persistence-jsonl 的 CHECKSUM_OPTIONS 保持一致（帧带校验和），
// 这样改写出来的第一帧与 DSH 自己写出的帧同形。
const ZSTD_FRAME_OPTIONS = zlibConstants.ZSTD_c_checksumFlag === undefined
  ? undefined
  : { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } }

// 返回第一帧的字节范围 [start, end)；结构不完整或不是合法帧时返回 null。
// 规则与 dsh-session-persistence-jsonl 的 scanZstdFrames 一致（含 RLE 块只占 1 字节、
// 可选 4 字节校验和这两个特例）。
function firstZstdFrame(buffer) {
  if (buffer.length < 5) return null
  let offset = 0
  if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return null
  offset += 4
  const descriptor = buffer.readUInt8(offset)
  offset += 1
  if ((descriptor & 24) !== 0) return null
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 32) !== 0
  const checksum = (descriptor & 4) !== 0
  const dictionaryFlag = descriptor & 3
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  for (;;) {
    if (buffer.length - offset < 3) return null
    const blockHeader = buffer.readUIntLE(offset, 3)
    offset += 3
    const lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 3
    const blockSize = blockHeader >>> 3
    if (blockType === 3) return null
    const payloadBytes = blockType === 1 ? 1 : blockSize
    if (buffer.length - offset < payloadBytes) return null
    offset += payloadBytes
    if (lastBlock) break
  }
  if (checksum) {
    if (buffer.length - offset < 4) return null
    offset += 4
  }
  return { start: 0, end: offset }
}

// 宿主 gateway 发现“源码模式”远程端点的唯一依据，是服务原型上这个稳定字符串键
// 描述符——新版协议改用原型属性，正是为了让另一个已安装副本也能读到。
const REMOTE_METHODS_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'

const REMOTE_METHODS = ['listGroups', 'listSessions', 'loadSelection', 'saveSelection', 'unarchive', 'deleteWorkspace', 'deleteSession', 'export', 'import', 'listUnlinkedGroups', 'checkRelocation', 'applyRelocation', 'reconcileMembership', 'baiduStatus', 'baiduLoginStart', 'baiduLoginCancel', 'baiduLogout', 'baiduUpload', 'baiduDownload']

// selection.json 里表示"无工作区会话"那一组的键（cwd 为空的会话）。
const ORPHAN_KEY = '__orphan__'

// 百度网盘应用凭证的文件名（放在 $DSH_HOME/session-migrate/ 下）。
// 这个文件由用户自己维护，插件只读不写——凭证是私密信息，不该由代码生成或覆盖。
const BAIDU_CREDENTIALS_FILE = 'baiduclound.json'

// 归组时读不出 cwd 的会话先落到这一组（等下次读得出来再归位），
// 绝不因为读不出 header 就把用户的勾选丢掉。
const UNKNOWN_KEY = '__unknown__'

function markRemoteMethod(prototype, method) {
  const existing = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHODS_KEY)
  const methods = existing && existing.value && Array.isArray(existing.value.methods) ? existing.value.methods : []
  if (methods.some((entry) => entry.method === method)) return
  Object.defineProperty(prototype, REMOTE_METHODS_KEY, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(methods.concat([Object.freeze({ method: method, invocation: Object.freeze({ kind: 'direct' }) })]))
    })
  })
}

// typert-protocol ≤ 0.1.0 把标记存进模块私有的 WeakMap，跨副本无法手工写入，只能借它
// 的 Remote() 打点；新版写的正是上面那个字符串键（幂等，重复打点会被忽略）。
// 该说明符可能解析到任意版本、也可能根本不存在，所以整体是 best-effort：失败不影响新宿主。
async function markLegacyRemote(instance) {
  let protocol
  try {
    protocol = await import('@deepseek-ai/dsh-typert-protocol')
  } catch (e) {
    return
  }
  const legacyRemote = protocol && protocol.Remote
  if (typeof legacyRemote !== 'function') return
  try {
    for (const method of REMOTE_METHODS) {
      legacyRemote(method)(null, {
        name: method,
        private: false,
        static: false,
        addInitializer: (initializer) => initializer.call(instance)
      })
    }
  } catch (e) {}
}

// 直接按 Cordis 契约注册服务（reflect.provide 的生命周期绑定当前 fiber，插件卸载时自动
// 注销），不继承任何第三方基类——于是不再依赖被别的插件提升上来的 typert-protocol 副本，
// 从根上消除版本劫持。
class SessionMigrateService {
  constructor(ctx) {
    this.name = 'sessionMigrate'
    this.ctx = ctx
    this.sessionQuery = ctx.get('sessionQuery')
    this.workspaceRegistry = ctx.get('workspaceRegistry')
    this.dshHomePath = ctx.get('dshHomePath')
    this.sessionPersistence = ctx.get('sessionPersistence')
    this.sessionLogCache = new Map()
    // ── 百度网盘 ────────────────────────────────────────────────────────────
    // 客户端惰性创建：没配 dshHomePath 或没登录时，整条链路都不该启动。
    this.baidu = undefined
    // 允许测试注入 fetch；undefined 时 BaiduPanClient 自己退回全局 fetch。
    let injectedFetch
    try { injectedFetch = ctx.get('baiduFetch') } catch (e) {}
    this.baiduFetch = typeof injectedFetch === 'function' ? injectedFetch : undefined
    this.baiduPending = null
    this.baiduTimer = null
    this.baiduLastError = null
    this.baiduRefreshFailedAt = 0
    this.baiduTask = null
    this.baiduLocalCache = null
    // 建客户端时用的凭证指纹：用户改了 baiduclound.json 就靠它发现并重建。
    this.baiduCredentialsKey = null
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: 'sessionMigrate',
      namespace: 'sessionMigrate'
    })
    for (const method of REMOTE_METHODS) markRemoteMethod(SessionMigrateService.prototype, method)
    ctx.reflect.provide('sessionMigrate', this, undefined)
  }

  errText(e) {
    if (e && e.message) return e.message
    return String(e)
  }

  projectKey(cwd) {
    if (cwd.length === 0) throw new Error('cannot encode an empty project path')
    let readable = ''
    let separatorRun = false
    for (let i = 0; i < cwd.length; i++) {
      const code = cwd.charCodeAt(i)
      const ch = String.fromCharCode(code)
      if (ch === '/' || ch === '\\' || ch === ':') {
        if (!separatorRun) readable += '-'
        separatorRun = true
      } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
        readable += ch
        separatorRun = false
      } else {
        readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
        separatorRun = false
      }
    }
    return '--' + ((readable.replace(/^-+/, '') || 'root').slice(0, 251)) + '--'
  }

  encodeSegment(raw) {
    if (raw.length === 0) throw new Error('cannot encode an empty path segment')
    if (raw === '.') return '~002E'
    if (raw === '..') return '~002E~002E'
    let out = ''
    for (let i = 0; i < raw.length; i++) {
      const code = raw.charCodeAt(i)
      const ch = String.fromCharCode(code)
      if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
      else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
    return out
  }

  projSeg(cwd) {
    return cwd == null ? '_no-cwd' : this.projectKey(cwd)
  }

  normKey(p) {
    return String(p || '').replace(/\\/g, '/').toLowerCase()
  }

  archivedIds() {
    try {
      if (this.workspaceRegistry !== undefined && this.workspaceRegistry.archivedSessionIds) {
        return this.workspaceRegistry.archivedSessionIds
      }
    } catch (e) {}
    return []
  }

  // 上次导出的内容：直接读 exports/index.json。它本来就是"上次导出了什么"的权威记录，
  // 再单独存一份 export-snapshot.json 只是同一批数据的第二份副本（连会话 id 都要存三遍、
  // size 还要在 fingerprint 之外另存一遍）。
  exportIndexPath() {
    if (typeof this.dshHomePath !== 'function') return undefined
    return this.dshHomePath('session-migrate', 'exports', 'index.json')
  }

  async readExportIndex() {
    const p = this.exportIndexPath()
    if (p === undefined) return []
    try {
      const data = JSON.parse(await this.fsReadText(p))
      const sessions = data === null || typeof data !== 'object' ? undefined : data.sessions
      return Array.isArray(sessions) ? sessions : []
    } catch (e) {
      return []
    }
  }

  // 导出索引按工作区归组：Map<原 cwd 的归一化键, Map<会话 id, fingerprint>>。
  exportIndexByWorkspace(sessions) {
    const groups = new Map()
    for (const entry of sessions) {
      if (entry === null || typeof entry !== 'object') continue
      const key = this.normKey(typeof entry.cwd === 'string' && entry.cwd !== '' ? entry.cwd : ORPHAN_KEY)
      let bucket = groups.get(key)
      if (bucket === undefined) {
        bucket = new Map()
        groups.set(key, bucket)
      }
      bucket.set(String(entry.id), typeof entry.fingerprint === 'string' ? entry.fingerprint : null)
    }
    return groups
  }

  // 在备份目录里按"会话段名 + 文件名"找一个会话的日志副本。
  // 备份可能是按更早的目录命名规则放下的，现算路径找不到时用它兜底。
  async findInExport(exportBase, segment, fileName) {
    let projects = []
    try {
      projects = await readdir(join(exportBase, 'sessions'))
    } catch (e) {
      return null
    }
    for (const project of projects) {
      const candidate = join(exportBase, 'sessions', project, segment, fileName)
      if (await this.fsExists(candidate)) return candidate
    }
    return null
  }

  // 从 DSH 的文件版本串里取出大小（格式 dev:ino:size:mtimeNs:ctimeNs），
  // 因此索引里不必再单独存一份 size。
  fingerprintSize(fingerprint) {
    if (typeof fingerprint !== 'string') return null
    const parts = fingerprint.split(':')
    if (parts.length !== 5) return null
    const size = Number(parts[2])
    return Number.isFinite(size) ? size : null
  }

  // 一次遍历 sessions 目录，得到"磁盘上确实存在日志文件"的会话段集合。
  // 这是判断会话是否还在的权威依据：查询服务的可见性会滞后（刚导入的会话、
  // 尚未重建的索引都可能暂时查不到），但磁盘上的文件不会骗人。
  async scanSessionLogs() {
    const found = new Set()
    if (typeof this.dshHomePath !== 'function') return found
    const root = this.dshHomePath('sessions')
    let projects = []
    try { projects = await readdir(root) } catch (e) { return found }
    for (const proj of projects) {
      let segments = []
      try { segments = await readdir(join(root, proj)) } catch (e) { continue }
      for (const seg of segments) {
        let files = []
        try { files = await readdir(join(root, proj, seg)) } catch (e) { continue }
        if (files.some((name) => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(name))) found.add(seg)
      }
    }
    return found
  }

  // 丢掉"查询索引里还有、磁盘上已经没了"的会话。
  //
  // 宿主的会话查询是 SQLite 派生索引，而它只在**搜索**时才与持久化对账
  // （dsh-session-query-sqlite 的 _reconcile 会算出 persistentDeletes 并删行）。
  // listSessions / filterSessions 是直接读库的，所以删掉日志文件之后，那些会话
  // 会一直留在查询结果里——面板上就表现为"删了还在"。这里按磁盘实际存在的会话过滤。
  async dropMissingSessions(records) {
    if (records.length === 0) return records
    const logs = await this.scanSessionLogs()
    return records.filter((r) => logs.has(this.encodeSegment(String(r.header.id))))
  }

  async isDirectory(path) {
    try {
      const info = await stat(path)
      return info.isDirectory()
    } catch (e) {
      return false
    }
  }

  // 扫 sessions 全集的 header：拿到每个会话的 { id, cwd, 位置, 大小 }。
  // 只读文件头部，所以比逐个完整读取快得多，而且完全不依赖会话查询服务——
  // cwd 未注册的会话在查询索引里根本不存在，只能这样找出来。
  async scanSessionHeaders() {
    const found = []
    if (typeof this.dshHomePath !== 'function') return found
    const root = this.dshHomePath('sessions')
    let projects = []
    try { projects = await readdir(root) } catch (e) { return found }
    for (const proj of projects) {
      let segments = []
      try { segments = await readdir(join(root, proj)) } catch (e) { continue }
      for (const seg of segments) {
        let files = []
        try { files = await readdir(join(root, proj, seg)) } catch (e) { continue }
        const fileName = files.find((name) => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(name))
        if (fileName === undefined) continue
        const filePath = join(root, proj, seg, fileName)
        const header = await this.readSessionHeader(filePath)
        let size = null
        try {
          const info = await stat(filePath)
          size = info.size
        } catch (e) {}
        found.push({
          projectDir: proj,
          segment: seg,
          fileName: fileName,
          filePath: filePath,
          size: size,
          id: header === null ? null : header.id,
          cwd: header === null ? null : header.cwd
        })
      }
    }
    return found
  }

  // 「未关联工作区」：会话带 cwd，但该 cwd 不在本机的工作区注册表里。
  // 这类会话在 DSH 侧栏里不属于任何工作区、因而"隐身"——数据在磁盘上却哪儿都看不到，
  // 所以要单独列出来，配上路径映射做重定位。cwd 为空的会话属于「无工作区会话」，
  // 那是 DSH 自己的 orphan，天生合法，不进这里。
  async listUnlinkedGroups() {
    const state = await this.readSelectionState()
    const registered = new Set()
    if (this.workspaceRegistry !== undefined) {
      for (const w of this.workspaceRegistry.list()) registered.add(this.normKey(w.path))
    }
    const scanned = await this.scanSessionHeaders()
    const cwdExists = new Map()
    const grouped = new Map()
    for (const entry of scanned) {
      if (entry.cwd === null || entry.id === null) continue
      if (registered.has(this.normKey(entry.cwd))) continue
      const key = this.normKey(entry.cwd)
      let group = grouped.get(key)
      if (group === undefined) {
        group = { cwd: entry.cwd, sessions: [] }
        grouped.set(key, group)
      }
      let exists = cwdExists.get(key)
      if (exists === undefined) {
        exists = await this.isDirectory(entry.cwd)
        cwdExists.set(key, exists)
      }
      group.sessions.push({
        id: entry.id,
        fileName: entry.fileName,
        projectDir: entry.projectDir,
        sessionSegment: entry.segment,
        size: entry.size,
        originCwdExists: exists
      })
    }
    const groups = []
    for (const group of grouped.values()) {
      // 该组配过的重映射目标：只有记录里的 cwd 与它的原 cwd **不同**时才算重映射
      // （记录的 cwd 平时就等于会话的真实 cwd，那是"该落到哪"的显式记录）。
      let mapped = null
      for (const session of group.sessions) {
        const record = this.findGroupFor(state, session.id)
        if (record === undefined || record.cwd === null) continue
        if (this.normKey(record.cwd) === this.normKey(group.cwd)) continue
        mapped = record.cwd
        break
      }
      groups.push({
        key: group.cwd,
        cwd: group.cwd,
        title: group.cwd,
        sessionCount: group.sessions.length,
        sessionIds: group.sessions.map((session) => session.id),
        sessions: group.sessions,
        mappedTo: mapped,
        targetExists: mapped === undefined ? null : await this.isDirectory(mapped)
      })
    }
    groups.sort((a, b) => String(a.cwd).localeCompare(String(b.cwd), undefined, { numeric: true, sensitivity: 'base' }))
    return { groups: groups }
  }

  // 会话 id → cwd 的索引。用磁盘扫描而不是会话查询服务，因为未关联工作区的会话
  // （cwd 在本机不存在的那批）在查询索引里根本查不到，而那正是最需要归组的一批。
  async sessionIndex() {
    const index = new Map()
    for (const entry of await this.scanSessionHeaders()) {
      if (entry.id !== null) index.set(String(entry.id), entry.cwd)
    }
    return index
  }

  // 只读文件头部若干字节：扫描全部会话时避免把大文件整个读进内存。
  async readHead(filePath, bytes) {
    const handle = await open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(bytes)
      const result = await handle.read(buffer, 0, bytes, 0)
      return buffer.subarray(0, result.bytesRead)
    } finally {
      await handle.close()
    }
  }

  // 读一个会话日志的 header（解压第一帧、取其中第一行 JSON）。
  // 刻意不依赖会话查询服务：cwd 没注册、索引里查不到的会话同样要读得到——
  // 这正是"未关联工作区"分组与"检测重定位"的数据来源。
  async readSessionHeader(filePath) {
    try {
      let buffer = await this.readHead(filePath, SESSION_HEAD_BYTES)
      let frame = firstZstdFrame(buffer)
      if (frame === null && buffer.length === SESSION_HEAD_BYTES) {
        // 头部不足以容纳完整的第一帧（实际不会发生），退回整文件读取。
        buffer = await readFile(filePath)
        frame = firstZstdFrame(buffer)
      }
      if (frame === null) return null
      const text = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
      const line = text.split('\n').find((entry) => entry.trim() !== '')
      if (line === undefined) return null
      const parsed = JSON.parse(line)
      if (parsed === null || typeof parsed !== 'object') return null
      return {
        id: typeof parsed.id === 'string' ? parsed.id : null,
        cwd: typeof parsed.cwd === 'string' ? parsed.cwd : null
      }
    } catch (e) {
      return null
    }
  }

  // 把会话日志第一帧（header）里的 cwd 改成新值，其余帧逐字节原样保留。
  // 返回是否真的改动了；任何解析失败都抛错，绝不留下改了一半的文件。
  async rewriteSessionHeaderCwd(filePath, nextCwd) {
    const buffer = await readFile(filePath)
    const frame = firstZstdFrame(buffer)
    if (frame === null) throw new Error('无法解析会话日志的 header 帧')
    const text = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
    const lines = text.split('\n')
    const index = lines.findIndex((entry) => entry.trim() !== '')
    if (index < 0) throw new Error('会话日志的 header 帧为空')
    const header = JSON.parse(lines[index])
    if (header === null || typeof header !== 'object') throw new Error('会话日志的 header 不是对象')
    if (header.cwd === nextCwd) return false
    header.cwd = nextCwd
    lines[index] = JSON.stringify(header)
    const nextFrame = zstdCompressSync(Buffer.from(lines.join('\n'), 'utf8'), ZSTD_FRAME_OPTIONS)
    await writeFile(filePath, Buffer.concat([nextFrame, buffer.subarray(frame.end)]))
    return true
  }

  // 同盘用 rename（原子）；跨盘 rename 抛 EXDEV 时退化为拷贝 + 删除。
  async moveFile(src, dst) {
    await mkdir(dirname(dst), { recursive: true })
    try {
      await rename(src, dst)
      return
    } catch (e) {
      if (e === null || e === undefined || e.code !== 'EXDEV') throw e
    }
    await copyFile(src, dst)
    await rm(src, { force: true })
  }

  async flushAll() {
    if (this.sessionPersistence !== undefined) {
      try { await this.sessionPersistence.flush() } catch (e) {}
    }
  }

  // ── 文件操作（node:fs，跨平台） ─────────────────────────────────────────────
  // sha256 十六进制大写，与旧 PowerShell Get-FileHash 输出同形，因此已有的
  // exports/index.json 与快照哈希可以直接比较。
  async hashFile(path) {
    return createHash('sha256').update(await readFile(path)).digest('hex').toUpperCase()
  }

  // 复刻宿主 fs 服务的 version 语义（dsh-fs-local 的 versionOf）：同一文件内容未变时
  // 给出同一个版本串，变了就变——这样已有 export-snapshot.json 里的 fingerprints 不会失效。
  async fileVersion(path) {
    const info = await stat(path, { bigint: true })
    return {
      version: info.dev + ':' + info.ino + ':' + info.size + ':' + info.mtimeNs + ':' + info.ctimeNs,
      size: Number(info.size)
    }
  }

  async copyFileEnsured(src, dst) {
    await mkdir(dirname(dst), { recursive: true })
    await copyFile(src, dst)
  }

  async copyAndHashAll(items) {
    const hashes = {}
    await Promise.all(items.map(async (item) => {
      await this.copyFileEnsured(item.src, item.dst)
      hashes[item.id] = await this.hashFile(item.src)
    }))
    return hashes
  }

  async removePath(path) {
    await rm(path, { recursive: true, force: true })
  }

  // 与原 PowerShell 实现同语义：默认只清空非隐藏条目，保留点文件。
  // 但「获取」时要求本地与云端完全一致，那时连点文件也要清（传 keepDotFiles: false），
  // 否则云端没有的文件会以隐藏文件的形式在本地留一辈子。
  async clearDir(path, options) {
    const keepDotFiles = !(options !== undefined && options !== null && options.keepDotFiles === false)
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch (e) {
      return
    }
    for (const entry of entries) {
      if (keepDotFiles && entry.name.startsWith('.')) continue
      await rm(join(path, entry.name), { recursive: true, force: true })
    }
  }

  async writeTextEnsured(path, content) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
  }

  // 每次请求内按目录缓存一次 readdir：列表页会为每个工作区 × 每个会话查询日志名，
  // 缓存把 N×M 次目录扫描压成每个会话目录一次。
  async findLogFileName(cwd, id) {
    if (typeof this.dshHomePath !== 'function') return undefined
    const dir = this.dshHomePath('sessions', this.projSeg(cwd), this.encodeSegment(id))
    if (this.sessionLogCache.has(dir)) return this.sessionLogCache.get(dir)
    let fileName
    try {
      const entries = await readdir(dir)
      fileName = entries.find((name) => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(name))
    } catch (e) {
      fileName = undefined
    }
    this.sessionLogCache.set(dir, fileName)
    return fileName
  }

  async sessionStat(cwd, id) {
    try {
      const fileName = await this.findLogFileName(cwd, id)
      if (!fileName) return null
      const path = this.dshHomePath('sessions', this.projSeg(cwd), this.encodeSegment(id), fileName)
      return await this.fileVersion(path)
    } catch (e) {
      return null
    }
  }

  async fsWriteText(path, content) {
    await this.writeTextEnsured(path, content)
  }

  async fsReadText(path) {
    return await readFile(path, 'utf8')
  }

  async fsExists(path) {
    try {
      await stat(path)
      return true
    } catch (e) {
      return false
    }
  }


  selectionConfigPath() {
    if (typeof this.dshHomePath !== 'function') return undefined
    return this.dshHomePath('session-migrate', 'selection.json')
  }

  sessionView(r, titleMap) {
    return {
      id: r.header.id,
      title: titleMap[r.header.id] || r.header.id,
      createdAt: r.header.createdAt,
      cwd: r.header.cwd || null,
      parentSession: r.header.parentSession || null,
      live: r.live,
      persisted: r.persisted
    }
  }

  async listGroups() {
    await this.flushAll()
    this.sessionLogCache.clear()
    // 上次导出了什么，直接从导出索引派生——不再有第二份快照文件。
    const exported = this.exportIndexByWorkspace(await this.readExportIndex())
    const archivedSet = new Set(this.archivedIds().map(String))
    const groups = []
    if (this.workspaceRegistry !== undefined) {
      for (const w of this.workspaceRegistry.list()) {
        const expected = exported.get(this.normKey(w.path))
        let hasExport = false
        let status = 'none'
        if (expected !== undefined) {
          hasExport = true
          const cur = Array.from(w.sessionIds).map(String).sort()
          const exp = Array.from(expected.keys()).sort()
          const sameSet = cur.length === exp.length && cur.every(function (v, i) { return v === exp[i] })
          let sameContent = sameSet
          if (sameSet) {
            for (const id of exp) {
              const fp = expected.get(id)
              if (fp == null) continue
              const st = await this.sessionStat(w.path, id)
              if (st != null && st.version !== fp) { sameContent = false; break }
            }
          }
          status = (sameSet && sameContent) ? 'unchanged' : 'changed'
        }
        const sessionIds = Array.from(w.sessionIds).map(String)
        const archivedCount = sessionIds.filter((id) => archivedSet.has(id)).length
        groups.push({ key: w.path, path: w.path, title: w.title, sessionCount: sessionIds.length, archivedCount: archivedCount, sessionIds: sessionIds, hasExport: hasExport, status: status })
      }
    }
    try {
      // 过滤掉磁盘上已经没了的：查询索引是 SQLite 派生库，删文件后它不会自动对账。
      const orphans = await this.dropMissingSessions(
        await this.sessionQuery.filterSessions([{ kind: 'cwd', values: [null] }])
      )
      if (orphans.length > 0) {
        const expected = exported.get(this.normKey(ORPHAN_KEY))
        let hasExport = false
        let status = 'none'
        if (expected !== undefined) {
          hasExport = true
          const cur = orphans.map((o) => o.header.id).map(String).sort()
          const exp = Array.from(expected.keys()).sort()
          const sameSet = cur.length === exp.length && cur.every(function (v, i) { return v === exp[i] })
          let sameContent = sameSet
          if (sameSet) {
            for (const id of exp) {
              const fp = expected.get(id)
              if (fp == null) continue
              const st = await this.sessionStat(null, id)
              if (st != null && st.version !== fp) { sameContent = false; break }
            }
          }
          status = (sameSet && sameContent) ? 'unchanged' : 'changed'
        }
        const orphanIds = orphans.map((o) => o.header.id).map(String)
        const archivedCount = orphanIds.filter((id) => archivedSet.has(id)).length
        groups.push({ key: '__orphan__', path: null, title: '无工作区会话', sessionCount: orphanIds.length, archivedCount: archivedCount, sessionIds: orphanIds, hasExport: hasExport, status: status })
      }
    } catch (e) {}
    // 未导出的工作区沉到末尾；同类内部按显示名称字母排序
    // （大小写不敏感，数字按数值比较，因此 item2 会排在 item10 前面）。
    groups.sort((a, b) => {
      const byExport = (a.hasExport ? 0 : 1) - (b.hasExport ? 0 : 1)
      if (byExport !== 0) return byExport
      const nameA = String(a.title || a.path || '')
      const nameB = String(b.title || b.path || '')
      return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' })
    })
    const debug = '已导出工作区: ' + Array.from(exported.keys()).join(' | ') + '\n工作区数: ' + groups.length + '，已导出: ' + groups.filter((g) => g.hasExport).length
    return { groups: groups, debug: debug }
  }

  async listSessions(cwd) {
    await this.flushAll()
    this.sessionLogCache.clear()
    const cwdValue = (cwd == null) ? null : cwd
    let records
    try {
      records = await this.sessionQuery.filterSessions([{ kind: 'cwd', values: [cwdValue] }])
    } catch (e) {
      return { sessions: [], error: this.errText(e) }
    }
    // 查询索引不会因为文件被删就自动对账（它只在搜索时对账），这里按磁盘实际存在的过滤。
    records = await this.dropMissingSessions(records)
    const titleMap = {}
    try {
      const titles = await this.sessionQuery.readTitleSnapshots(records.map((r) => r.header.id))
      for (const t of titles) {
        if (t && t.status === 'fulfilled' && t.value && t.value.title) titleMap[t.sessionId] = t.value.title.title
      }
    } catch (e) {}
    const archivedSet = new Set(this.archivedIds().map(String))
    // 上次导出的内容直接从导出索引派生（Map<id, fingerprint>）。
    const expected = this.exportIndexByWorkspace(await this.readExportIndex())
      .get(this.normKey(cwd == null ? ORPHAN_KEY : cwd))
    const hasExport = expected !== undefined
    const sessionsOut = []
    for (const r of records) {
      const view = this.sessionView(r, titleMap)
      let status = 'none'
      let size = null
      let sizeDelta = null
      if (hasExport) {
        const st = await this.sessionStat(cwd, r.header.id)
        size = st ? st.size : null
        if (!expected.has(String(r.header.id))) {
          status = 'new'
        } else {
          const fp = expected.get(String(r.header.id))
          // 上次导出时的大小直接从 fingerprint 解析（第 3 段就是 size）。
          const baseSize = this.fingerprintSize(fp)
          if (fp == null) {
            status = 'unchanged'
          } else {
            status = (st != null && st.version !== fp) ? 'changed' : 'unchanged'
          }
          if (baseSize != null && size != null) {
            sizeDelta = size - baseSize
          }
        }
      }
      view.status = status
      view.size = size
      view.sizeDelta = sizeDelta
      view.archived = archivedSet.has(String(r.header.id))
      sessionsOut.push(view)
    }
    sessionsOut.sort(function (a, b) {
      return (a.archived ? 1 : 0) - (b.archived ? 1 : 0)
    })
    return { sessions: sessionsOut }
  }

  // ── selection.json：工作区级别的状态与重映射 ────────────────────────────────
  // 结构：
  // ── selection.json：会话分组 + 重映射目标 ──────────────────────────────────
  // 结构：{ "groups": [ { "cwd": <目标路径或 null>, "sessionIds": [...] } ] }
  // 一条记录就是一组会话：cwd 是这组会话该被重定位到的目标路径（没配就是 null），
  // sessionIds 是组内被勾选的会话。会话属于哪个工作区由它自己的 header 说了算，
  // 所以不需要"工作区主键"——按 session id 就能查到它该落到哪儿，原 cwd 在重定位时
  // 从 header 现读即可。
  async readSelectionState() {
    const state = { groups: [] }
    const pushGroup = (cwd, ids) => {
      const clean = (Array.isArray(ids) ? ids : []).map(String).filter((id) => id !== '')
      if (clean.length === 0) return
      const text = typeof cwd === 'string' && cwd.trim() !== '' ? cwd : null
      // 同一个 cwd 的记录必须合并：重复的组会让界面分组和"按 id 查目标"都对不上
      // （历史数据里出现过，所以读取时兜一下）。
      if (text !== null) {
        for (const existing of state.groups) {
          if (existing.cwd === null) continue
          if (this.normKey(existing.cwd) !== this.normKey(text)) continue
          for (const id of clean) {
            if (!existing.sessionIds.includes(id)) existing.sessionIds.push(id)
          }
          return
        }
      }
      state.groups.push({ cwd: text, sessionIds: clean })
    }
    const configPath = this.selectionConfigPath()
    let raw = null
    if (configPath !== undefined) {
      try { raw = JSON.parse(await this.fsReadText(configPath)) } catch (e) { raw = null }
    }
    if (raw !== null && typeof raw === 'object') {
      if (Array.isArray(raw.groups)) {
        for (const entry of raw.groups) {
          if (entry === null || typeof entry !== 'object') continue
          pushGroup(entry.cwd, entry.sessionIds)
        }
      }
      // 旧格式 1：{"selected":[id,...]} —— 按会话的 cwd 归组；读不出 cwd 的也留在
      // 单独一组，勾选是用户的选择，不该因为读不到 header 就消失。
      if (Array.isArray(raw.selected)) {
        const index = await this.sessionIndex()
        const buckets = new Map()
        for (const id of raw.selected) {
          const cwd = index.get(String(id))
          const key = cwd === undefined ? UNKNOWN_KEY : (cwd === null ? ORPHAN_KEY : this.normKey(cwd))
          if (!buckets.has(key)) buckets.set(key, { cwd: cwd === undefined ? null : cwd, ids: [] })
          buckets.get(key).ids.push(id)
        }
        for (const bucket of buckets.values()) pushGroup(bucket.cwd, bucket.ids)
      }
      // 旧格式 2：{"workspaces":{"<原cwd>":{cwd,sessionIds}}} —— 主键丢掉，但它的"原 cwd"
      // 正好就是这一组该落到哪，补进记录的 cwd。
      const workspaces = raw.workspaces
      if (workspaces !== null && typeof workspaces === 'object' && !Array.isArray(workspaces)) {
        for (const key of Object.keys(workspaces)) {
          const entry = workspaces[key]
          if (entry === null || typeof entry !== 'object') continue
          const target = typeof entry.cwd === 'string' && entry.cwd.trim() !== '' ? entry.cwd : null
          const recorded = target !== null ? target : (key === ORPHAN_KEY || key === UNKNOWN_KEY ? null : key)
          pushGroup(recorded, entry.sessionIds)
        }
      }
    }
    // 一次性兼容更早那版单独存放的 relocations.json：按原 cwd 找到对应会话补上目标。
    try {
      const legacyPath = this.dshHomePath('session-migrate', 'relocations.json')
      const legacy = JSON.parse(await this.fsReadText(legacyPath))
      const mappings = legacy === null || typeof legacy !== 'object' ? undefined : legacy.mappings
      if (mappings !== null && typeof mappings === 'object' && !Array.isArray(mappings)) {
        const targetByNorm = new Map()
        for (const key of Object.keys(mappings)) {
          const target = mappings[key]
          if (typeof target === 'string' && target.trim() !== '') targetByNorm.set(this.normKey(key), target)
        }
        if (targetByNorm.size > 0) {
          const index = await this.sessionIndex()
          for (const group of state.groups) {
            if (group.cwd !== null) continue
            for (const id of group.sessionIds) {
              const realCwd = index.get(String(id))
              if (realCwd === null || realCwd === undefined) continue
              const target = targetByNorm.get(this.normKey(realCwd))
              if (target !== undefined) { group.cwd = target; break }
            }
          }
        }
      }
    } catch (e) {}
    return state
  }

  async writeSelectionState(state) {
    const configPath = this.selectionConfigPath()
    if (configPath === undefined) return false
    try {
      await this.fsWriteText(configPath, JSON.stringify({ groups: state.groups, updatedAt: Date.now() }, null, 2))
      return true
    } catch (e) {
      return false
    }
  }

  // 按 session id 找它所在的那条记录；没有记录返回 undefined。
  findGroupFor(state, sessionId) {
    const wanted = String(sessionId)
    for (const group of state.groups) {
      if (group.sessionIds.includes(wanted)) return group
    }
    return undefined
  }

  // 给这些会话设上（或清除）重映射目标。还没在任何记录里的会话（典型：刚从
  // "未关联工作区"里被处理的那批）会顺手建一条记录——目标必须跟着会话存下来，
  // 否则下次导入按 id 就查不到它该落到哪儿。
  async setRelocationFor(sessionIds, target) {
    const wanted = (sessionIds || []).map(String).filter((id) => id !== '')
    if (wanted.length === 0) return false
    const state = await this.readSelectionState()
    const text = target === undefined || target === null ? '' : String(target).trim()
    const next = text === '' ? null : text
    const wantedSet = new Set(wanted)
    const covered = new Set()
    let changed = false
    for (const group of state.groups) {
      const hits = group.sessionIds.filter((id) => wantedSet.has(String(id)))
      if (hits.length === 0) continue
      for (const id of hits) covered.add(String(id))
      if (group.cwd !== next) { group.cwd = next; changed = true }
    }
    const missing = wanted.filter((id) => !covered.has(String(id)))
    if (missing.length > 0) {
      state.groups.push({ cwd: next, sessionIds: missing })
      changed = true
    }
    if (!changed) return true
    return await this.writeSelectionState(state)
  }

  async loadSelection() {
    this.sessionLogCache.clear()
    const state = await this.readSelectionState()
    // 判据是"磁盘上还有没有这个会话的日志文件"：刚导入的会话可能还没进入查询索引，
    // 若用查询可见性判断，会把刚恢复出来的勾选项立刻删掉。
    const logs = await this.scanSessionLogs()
    const selected = []
    const kept = []
    let changed = false
    for (const group of state.groups) {
      const ids = group.sessionIds.filter((id) => logs.has(this.encodeSegment(String(id))))
      // 注意要在"组内被剔除了成员"时也算改动，否则清理结果写不回文件。
      if (ids.length !== group.sessionIds.length) changed = true
      // 没有成员的组留着也没意义：重映射是"跟着会话"的，没有会话就永远不会被命中。
      if (ids.length === 0) { changed = true; continue }
      group.sessionIds = ids
      kept.push(group)
      selected.push(...ids)
    }
    if (kept.length !== state.groups.length) changed = true
    if (changed) {
      state.groups = kept
      await this.writeSelectionState(state)
    }
    return { selected: selected }
  }

  async saveSelection(sessionIds) {
    const configPath = this.selectionConfigPath()
    if (configPath === undefined) return { ok: false, error: '无法确定配置文件路径' }
    const state = await this.readSelectionState()
    const index = await this.sessionIndex()
    // 已经配过目标的会话留在原组（连同目标一起），只改勾选不会丢重映射；
    // 其余的按真实 cwd 归组；读不出 cwd 的单独一组，绝不因此丢掉勾选。
    const targetOf = new Map()
    for (const group of state.groups) {
      if (group.cwd === null) continue
      for (const id of group.sessionIds) targetOf.set(String(id), group.cwd)
    }
    const groups = []
    const byKey = new Map()
    for (const raw of sessionIds || []) {
      const id = String(raw)
      const target = targetOf.get(id)
      const realCwd = index.get(id)
      // 分组依据就是"最终会写进 cwd 的那个值"：同一目标路径的会话必须在同一条记录里。
      // 之前这里对"继承来的目标"和"按真实 cwd"用了不同的键前缀，于是同一个 cwd 会裂成
      // 两条记录（值一模一样、只是来源不同），导入时按 id 查到的目标也会对不上。
      const effective = target !== undefined ? target : realCwd
      let key
      if (effective === undefined) key = UNKNOWN_KEY
      else if (effective === null) key = ORPHAN_KEY
      else key = 'cwd\u0000' + this.normKey(effective)
      let group = byKey.get(key)
      if (group === undefined) {
        group = {
          cwd: effective === undefined || effective === null ? null : effective,
          sessionIds: []
        }
        byKey.set(key, group)
        groups.push(group)
      }
      group.sessionIds.push(id)
    }
    state.groups = groups
    const ok = await this.writeSelectionState(state)
    return ok ? { ok: true, path: configPath } : { ok: false, error: '写入 selection.json 失败' }
  }

  async unarchive(id) {
    if (!id) return { error: '缺少会话 id' }
    if (this.workspaceRegistry === undefined) return { error: 'workspaceRegistry 服务不可用' }
    try {
      if (typeof this.workspaceRegistry.enqueueOperation === 'function' && typeof this.workspaceRegistry.requireState === 'function' && typeof this.workspaceRegistry.setState === 'function') {
        await this.workspaceRegistry.enqueueOperation(async () => {
          const state = this.workspaceRegistry.requireState()
          if (!state.archivedSessionIds.some((x) => String(x) === String(id))) return
          await this.workspaceRegistry.setState({
            ...state,
            archivedSessionIds: state.archivedSessionIds.filter((x) => String(x) !== String(id))
          })
        })
        return { ok: true, id: id }
      }
      return { error: 'workspaceRegistry 不支持取消归档' }
    } catch (e) {
      return { error: this.errText(e) }
    }
  }

  async deleteWorkspace(path) {
    if (!path) return { error: '缺少工作区路径' }
    if (typeof this.dshHomePath !== 'function') return { error: '无法确定 DSH_HOME 路径' }
    if (this.workspaceRegistry === undefined) return { error: 'workspaceRegistry 服务不可用' }
    let targetWs = null
    for (const w of this.workspaceRegistry.list()) {
      if (this.normKey(w.path) === this.normKey(path)) { targetWs = w; break }
    }
    if (!targetWs) return { error: '未找到工作区' }
    const sessionIds = Array.from(targetWs.sessionIds).map(String)
    const proj = this.projSeg(targetWs.path)
    const projectDir = this.dshHomePath('sessions', proj)
    try { await this.removePath(projectDir) } catch (e) {}
    for (const id of sessionIds) {
      const cachePath = this.dshHomePath('storages', 'session_projcache', 'sessions', id + '.json')
      try { await this.removePath(cachePath) } catch (e) {}
    }
    try { await this.workspaceRegistry.delete(targetWs.id) } catch (e) {}
    return { ok: true, deletedSessions: sessionIds.length }
  }

  // 删除一个会话的全部数据。工作区删除是同样的几个动作，只是范围从"整个工作区"
  // 缩小到"一个会话"：日志、投影缓存、工作区归属、勾选记录都清掉。
  async deleteSession(id) {
    if (!id) return { error: '缺少会话 id' }
    if (typeof this.dshHomePath !== 'function') return { error: '无法确定 DSH_HOME 路径' }
    const wanted = String(id)
    this.sessionLogCache.clear()
    await this.flushAll()
    // 从磁盘上定位：查询服务看不到的会话（cwd 在本机不存在的那批）同样要能删掉。
    const entry = (await this.scanSessionHeaders()).find((item) => String(item.id) === wanted)
    if (entry === undefined) return { error: '未找到该会话的数据' }
    const sessionDir = dirname(entry.filePath)
    const projectDir = dirname(sessionDir)
    try { await this.removePath(sessionDir) } catch (e) {}
    try {
      await this.removePath(this.dshHomePath('storages', 'session_projcache', 'sessions', wanted + '.json'))
    } catch (e) {}
    // 摘掉工作区归属。**不能**拿 sessionIds getter 过滤后的集合来判断"要不要摘"：
    // 那个集合只包含"路径还认得出来"的会话，索引一旦不同步（宿主重建过索引、或文件
    // 已经先被删掉），它里面就没有这个 id，判断会失真，record.sessionIds 上的归属
    // 会永远留着——随后这个会话就以"cwd 认不出来"的形态漂到「无工作区会话」里去。
    // detachSession 对不在名下的 id 是安全的 no-op，所以直接逐个工作区试。
    if (this.workspaceRegistry !== undefined) {
      for (const w of this.workspaceRegistry.list()) {
        try { await w.detachSession(wanted) } catch (e) {}
      }
      // 索引里也要把它清掉：文件已经没了，留着只会让侧栏把它当成"路径认不出来的会话"。
      await this.syncSessionIndex(wanted, null)
    }
    // 勾选记录里也去掉——会话已经不存在了，留着只会被下次读取当成无效项清掉。
    const state = await this.readSelectionState()
    let changed = false
    for (const group of state.groups) {
      const kept = group.sessionIds.filter((sid) => String(sid) !== wanted)
      if (kept.length === group.sessionIds.length) continue
      group.sessionIds = kept
      changed = true
    }
    if (changed) {
      state.groups = state.groups.filter((group) => group.sessionIds.length > 0)
      await this.writeSelectionState(state)
    }
    // 项目目录空了就顺手收掉，免得留下空壳。
    try {
      const left = await readdir(projectDir)
      if (left.length === 0) await this.removePath(projectDir)
    } catch (e) {}
    return { ok: true, id: wanted, cwd: entry.cwd }
  }

  async export(sessionIds) {
    const ids = sessionIds || []
    if (typeof this.dshHomePath !== 'function') return { error: '无法确定 DSH_HOME 路径' }
    await this.flushAll()
    this.sessionLogCache.clear()
    const exportBase = this.dshHomePath('session-migrate', 'exports')
    // 先把上一次记下的上传状态捞出来——导出会清空整个 exports 目录，
    // 等清完再想读就晚了。丢了它，每次导出都会让增量上传彻底失效
    // （表现为：明明什么都没变，却要全量重传）。
    const previousUploads = new Map()
    try {
      for (const entry of await this.readExportIndex()) {
        if (entry === null || typeof entry !== 'object') continue
        if (typeof entry.id !== 'string') continue
        previousUploads.set(String(entry.id), {
          hash: typeof entry.hash === 'string' ? entry.hash : null,
          remoteHash: typeof entry.remoteHash === 'string' ? entry.remoteHash : null
        })
      }
    } catch (e) {}
    try { await this.clearDir(exportBase) } catch (e) {}
    const archived = new Set(this.archivedIds().map(String))
    const headerById = {}
    try {
      // 同样过滤掉查询索引里残留、磁盘上已经没有的会话，否则它们会带着"文件找不到"
      // 混进导出流程（虽然最终会被跳过，但没必要让它们参与）。
      const records = await this.dropMissingSessions(await this.sessionQuery.listSessions())
      for (const r of records) headerById[r.header.id] = r
    } catch (e) {}
    const items = []
    // 防御性：选中项里已经消失的会话（记录没了，或日志文件不在磁盘上）直接跳过。
    // 索引只描述"实际导出成功的内容"，不把这类预期内的缺失写成错误条目。
    for (const id of ids) {
      const rec = headerById[id]
      if (!rec) continue
      const header = rec.header
      const cwd = header.cwd
      let fileName
      try {
        fileName = await this.findLogFileName(cwd, id)
      } catch (e) {
        continue
      }
      if (!fileName) continue
      const seg = this.encodeSegment(id)
      const proj = this.projSeg(cwd)
      const src = this.dshHomePath('sessions', proj, seg, fileName)
      const dst = this.dshHomePath('session-migrate', 'exports', 'sessions', proj, seg, fileName)
      items.push({ id: id, src: src, dst: dst, cwd: cwd || null, proj: proj, seg: seg, fileName: fileName, header: header })
    }
    let hashMap = {}
    if (items.length > 0) {
      try {
        hashMap = await this.copyAndHashAll(items)
      } catch (e) {}
    }
    const entries = []
    for (const item of items) {
      const hash = hashMap[item.id]
      if (!hash) continue
      // 不再单独记 size：fingerprint 的第 3 段就是它（dev:ino:size:mtimeNs:ctimeNs）。
      let fingerprint = null
      try {
        const info = await this.fileVersion(item.src)
        fingerprint = info.version
      } catch (e) {}
      // remoteHash 记的是「网盘上那份内容的 hash」，上传成功后才会被写成当时的 hash。
      // 它必须跨导出保留，但要跟着内容走：
      //   - 内容没变（新旧 hash 相同）→ 继承原值，增量上传才认得出「这份已经传过了」
      //   - 内容变了 → 归零，因为网盘上那份已经不是这个版本了
      const previous = previousUploads.get(String(item.id))
      const remoteHash = previous !== undefined && previous.hash === hash ? previous.remoteHash : null
      // 只写"不可派生"的东西。目录名一律不存：projectKey 是有损编码（D:\a-b\c 和
      // D:\a\b-c 会编成同一个 --D-a-b-c--，超长还会被截断），既反解不回 cwd，也不该
      // 被当成权威——DSH 自己就是按当前规则校验"日志与路径是否相符"的。
      entries.push({
        id: item.id,
        cwd: item.cwd,
        fileName: item.fileName,
        hash: hash,
        remoteHash: remoteHash,
        fingerprint: fingerprint,
        archived: archived.has(String(item.id))
      })
    }
    const index = {
      format: 'dsh-sessions-export',
      // v4：新增 remoteHash（云端那份内容的 hash，用于增量上传）。
      // v3 去掉了可派生的 sessionSegment / relativePath，以及从没被读过、header 里
      // 本来就有 的 createdAt / parentSession / agentPreset / origin。读取兼容 v2/v3。
      version: 4,
      exportedAt: Date.now(),
      sessions: entries
    }
    try {
      await this.fsWriteText(this.dshHomePath('session-migrate', 'exports', 'index.json'), JSON.stringify(index, null, 2))
    } catch (e) {}
    // 这份 index.json 就是"上次导出了什么"的权威记录，状态判定直接从它派生，
    // 不再另存一份形状不同、内容重复的 export-snapshot.json。
    return {
      path: exportBase,
      sessionCount: entries.length
    }
  }

  async import(path) {
    if (typeof this.dshHomePath !== 'function') return { error: '无法确定 DSH_HOME 路径' }
    this.sessionLogCache.clear()
    let p = path || ''
    if (typeof p !== 'string' || p.trim() === '') {
      p = this.dshHomePath('session-migrate', 'exports')
    }
    let base = String(p).replace(/[\\/]+$/, '')
    if (!/index\.json$/.test(base)) base = join(base, 'index.json')
    const index = JSON.parse(await this.fsReadText(base))
    const exportBase = dirname(base)
    const list = (index && index.sessions) || []
    const imported = []
    const overwritten = []
    const detached = []
    const deduped = new Set()
    const writtenById = new Map()
    // 导入后每个会话的新文件版本，用于回写索引的 fingerprint（见写入处与收尾处）。
    const reAligned = new Map()
    // 跳过的条目要报出来：跨机器同步备份时很容易只同步了 index.json 而漏掉 sessions/，
    // 那样以前会表现为"导入成功但一个都没进来"，用户完全不知道发生了什么。
    const skipped = []
    // 已记住的重映射：命中的 cwd 直接落到映射后的位置——文件位置和 header 里的
    // cwd 一起改，恢复出来的会话天生就属于目标工作区，不必事后再手动重定位一遍。
    const selectionState = await this.readSelectionState()
    // 同一会话只允许存在一份：DSH 遇到"同一个 id 出现在两个项目目录"会直接拒绝启动
    // （硬报错，不是警告），所以写入前必须把该 id 在别处的旧副本清掉。
    const existingById = new Map()
    for (const entry of await this.scanSessionHeaders()) {
      if (entry.id === null) continue
      const list = existingById.get(entry.id)
      if (list === undefined) existingById.set(entry.id, [entry])
      else list.push(entry)
    }
    // 同一工作区的会话在备份里共享同一个 cwd。如果其中一部分在本机已经配过落位
    // （selection.json 里有记录、且记的目标与备份里的 cwd 不同），就能推出"这个备份
    // cwd 在本机该落到哪儿"——于是同一工作区里新出现的会话（新 id、本机没有记录）
    // 也能自动落位，不必把同一个映射再手工配一遍。
    const cwdHint = new Map()
    for (const entry of list) {
      if (!entry || !entry.id || !entry.cwd) continue
      const known = this.findGroupFor(selectionState, entry.id)
      if (known === undefined || known.cwd === null) continue
      // 目标与备份里的 cwd 相同说明这个会话没配过映射，推不出任何信息。
      if (this.normKey(known.cwd) === this.normKey(entry.cwd)) continue
      const key = this.normKey(entry.cwd)
      if (!cwdHint.has(key)) cwdHint.set(key, known.cwd)
    }
    for (const s of list) {
      // 防御性：索引条目缺字段、备份文件校验不过、或归属恢复失败，都只跳过这一条，
      // 继续处理其余条目——单条问题不中断整次导入，也不写进任何配置文件。
      try {
        if (!s.id || !s.fileName) {
          skipped.push({ id: s && s.id ? String(s.id) : null, reason: '索引条目缺少 id 或文件名' })
          continue
        }
        // 记录里的 cwd 就是"这组会话该落到哪"；没记录说明这个会话从没被勾选处理过，
        // 这时先借同一个工作区里已配过落位的会话推出目标，推不出来才按备份里的原 cwd 走。
        const record = this.findGroupFor(selectionState, s.id)
        let targetCwd
        if (record !== undefined && record.cwd !== null) {
          targetCwd = record.cwd
        } else {
          const hint = s.cwd ? cwdHint.get(this.normKey(s.cwd)) : undefined
          targetCwd = hint === undefined ? s.cwd : hint
        }
        // 落位一律现算：目录名是有损编码，存下来既反解不回 cwd，规则一变还会被 DSH
        // 判成"日志与路径不符"。所以索引里根本不记目录名。
        const projectDir = this.projSeg(targetCwd === null || targetCwd === undefined ? s.cwd : targetCwd)
        const segment = this.encodeSegment(String(s.id))
        let src = join(exportBase, 'sessions', projectDir, segment, s.fileName)
        if (!(await this.fsExists(src))) {
          // 备份可能是按更早的目录命名规则放下的，现算找不到就按段名扫一遍兜底。
          const found = await this.findInExport(exportBase, segment, s.fileName)
          if (found === null) {
            skipped.push({ id: String(s.id), reason: '备份目录里找不到这个会话的日志文件' })
            continue
          }
          src = found
        }
        const dst = this.dshHomePath('sessions', projectDir, segment, s.fileName)
        if (s.hash) {
          const srcHash = await this.hashFile(src)
          if (srcHash.toLowerCase() !== String(s.hash).toLowerCase()) {
            skipped.push({ id: String(s.id), reason: '文件内容与索引记录的哈希不符' })
            continue
          }
        }
        // 恢复语义：目标已存在也必须用备份替换，否则"恢复"退化成只能补缺失的会话，
        // 用户回滚不了任何改动。替换后清掉派生的投影缓存，让宿主按新内容重建。
        // 清掉该 id 在别处的旧副本：会话换了工作区就不该留两份，否则 DSH 启动时报
        // "duplicate JSONL session id" 直接失败。候选有两类——导入前磁盘上已有的，
        // 以及本次导入刚写下的（同一份索引里出现两条同 id 的情形）。
        const candidates = (existingById.get(s.id) || []).map((entry) => entry.filePath)
        const justWritten = writtenById.get(s.id)
        if (justWritten !== undefined) candidates.push(justWritten)
        for (const otherPath of candidates) {
          if (this.normKey(otherPath) === this.normKey(dst)) continue
          try {
            const otherSessionDir = dirname(otherPath)
            const otherProjectDir = dirname(otherSessionDir)
            await rm(otherSessionDir, { recursive: true, force: true })
            const left = await readdir(otherProjectDir)
            if (left.length === 0) await rm(otherProjectDir, { recursive: true, force: true })
            deduped.add(s.id)
          } catch (e) {}
        }
        writtenById.set(s.id, dst)
        const exists = await this.fsExists(dst)
        await this.copyFileEnsured(src, dst)
        // 落位与备份里记的原 cwd 不同时，必须同步改写 header，否则 DSH 判"日志与路径不符"。
        if (targetCwd !== null && targetCwd !== undefined && this.normKey(targetCwd) !== this.normKey(s.cwd || '')) {
          try { await this.rewriteSessionHeaderCwd(dst, targetCwd) } catch (e) {}
        }
        // 刚刚落盘的这个文件是**新拷贝**：inode、mtime、ctime 全是新的，
        // 与备份里记的 fingerprint 必然对不上。把新版本记下来，导入结束后回写索引——
        // 否则用户刚从备份恢复完，看到的却是满屏「有变化」，而那明明不是他的改动。
        try {
          reAligned.set(String(s.id), (await this.fileVersion(dst)).version)
        } catch (e) {}
        if (exists) {
          overwritten.push(s.id)
          try { await this.removePath(this.dshHomePath('storages', 'session_projcache', 'sessions', s.id + '.json')) } catch (e) {}
        } else {
          imported.push(s.id)
        }
        // 恢复工作区归属。目标机器上很可能还没有这个工作区目录——这恰恰是要从备份
        // 恢复的情形，而 registry.create / attachSession 都要求路径是已存在的真实目录。
        // 所以先补建目录再注册；两步都失败才记入 detached（如实报告，不假装成功）。
        if (targetCwd && this.workspaceRegistry !== undefined) {
          try {
            // 先把索引里这个会话的归属路径对齐到它刚落下的位置，归属才挂得住。
            // 纯内存操作，逐条做也不贵。
            await this.syncSessionIndex(s.id, targetCwd)
            const ws = await this.workspaceRegistry.create(targetCwd)
            await ws.attachSession(s.id)
          } catch (e) {
            try {
              await mkdir(targetCwd, { recursive: true })
              const ws = await this.workspaceRegistry.create(targetCwd)
              await ws.attachSession(s.id)
            } catch (e2) {
              detached.push(s.id)
            }
          }
        }
        if (s.archived && this.workspaceRegistry !== undefined) {
          try {
            await this.workspaceRegistry.archiveSession(s.id)
          } catch (e) {}
        }
      } catch (e) {}
    }
    // 把刚落盘的新文件版本回写索引：导入之后，磁盘上的状态就是「当前状态」，
    // 索引里的 fingerprint 必须跟着走，否则工作区列表会一直显示「有变化」。
    // 内容哈希（hash / remoteHash）不动——恢复的是同一份内容，它们本来就该相等。
    let realigned = 0
    if (reAligned.size > 0) {
      try {
        realigned = await this.realignIndexFingerprints(base, reAligned)
      } catch (e) {}
    }
    // 恢复出来的会话马上就并入勾选（见下），所以这里不需要再重建任何快照——
    // 导出索引只由"导出"这一个动作写。
    // 把刚恢复的会话并入当前勾选（并入而不是替换）：它们是这次操作的对象，默认勾上
    // 比让用户回去逐个勾更合理。saveSelection 会把各工作区已配的重映射原样保留。
    const currentSelection = await this.loadSelection()
    const merged = Array.from(new Set([
      ...currentSelection.selected.map(String),
      ...imported.map(String),
      ...overwritten.map(String),
      ...detached.map(String)
    ]))
    if (merged.length > 0) await this.saveSelection(merged)
    return {
      imported: imported.length,
      overwritten: overwritten.length,
      detached: detached.length,
      deduped: deduped.size,
      skipped: skipped.length,
      realigned: realigned,
      // 明细最多给 20 条：整批都对不上时（典型：只同步了 index.json 没同步 sessions/）
      // 不必把上千条错误塞回界面，有总数和几个样本足够判断原因。
      skippedItems: skipped.slice(0, 20),
      importedIds: imported,
      overwrittenIds: overwritten,
      detachedIds: detached
    }
  }

  /**
   * 把导入后重新落盘的文件版本回写到备份索引里。
   *
   * 为什么必须做：导入是把文件**重新拷贝**一遍，inode / mtime / ctime 全是新的，
   * 而索引里记的 fingerprint 是导出那一刻源文件的版本，两者必然对不上。不对齐的话，
   * 用户刚从备份恢复完，工作区列表却全是「有变化」——那是拷贝的副作用，不是他的改动。
   *
   * 只改 fingerprint。hash / remoteHash 不动：恢复的是同一份内容，它们本来就相等。
   */
  async realignIndexFingerprints(indexPath, fingerprints) {
    const index = JSON.parse(await this.fsReadText(indexPath))
    if (index === null || typeof index !== 'object' || !Array.isArray(index.sessions)) return 0
    let updated = 0
    for (const entry of index.sessions) {
      if (entry === null || typeof entry !== 'object') continue
      const next = fingerprints.get(String(entry.id))
      if (next === undefined) continue
      if (entry.fingerprint === next) continue
      entry.fingerprint = next
      updated += 1
    }
    if (updated > 0) await this.fsWriteText(indexPath, JSON.stringify(index, null, 2))
    return updated
  }

  // 检测一次重定位是否真的可行。逐项给出问题，而不是笼统地说"不行"——
  // 用户在按"应用"之前应该知道到底卡在哪一条。
  async checkRelocation(sourceCwd, targetCwd) {
    const problems = []
    const src = typeof sourceCwd === 'string' ? sourceCwd.trim() : ''
    const dst = typeof targetCwd === 'string' ? targetCwd.trim() : ''
    if (src === '') problems.push({ code: 'no-source', message: '缺少原始工作区路径' })
    if (dst === '') problems.push({ code: 'empty-target', message: '还没有填写目标路径' })
    if (problems.length > 0) return { ok: false, problems: problems, info: null }

    const scanned = await this.scanSessionHeaders()
    const mine = scanned.filter((entry) => entry.cwd !== null && this.normKey(entry.cwd) === this.normKey(src))
    if (mine.length === 0) problems.push({ code: 'no-sessions', message: '该工作区下的会话已经不在磁盘上了' })

    let targetState = 'absent'
    try {
      const info = await stat(dst)
      targetState = info.isDirectory() ? 'directory' : 'file'
    } catch (e) {
      targetState = 'absent'
    }
    if (targetState === 'file') problems.push({ code: 'target-is-file', message: '目标路径已存在，但它不是目录' })

    if (this.workspaceRegistry !== undefined) {
      for (const w of this.workspaceRegistry.list()) {
        if (this.normKey(w.path) === this.normKey(dst)) {
          problems.push({ code: 'target-registered', message: '目标路径已经是本机的工作区，不需要重定位' })
          break
        }
      }
    }

    const state = await this.readSelectionState()
    const mineIdSet = new Set(mine.map((entry) => String(entry.id)))
    for (const group of state.groups) {
      if (group.cwd === null) continue
      if (this.normKey(group.cwd) !== this.normKey(dst)) continue
      // 占用者就是这批会话自己时不算冲突。
      if (group.sessionIds.some((id) => mineIdSet.has(String(id)))) continue
      problems.push({ code: 'target-conflict', message: '目标路径已被另一组会话的重映射占用' })
      break
    }

    const targetProjectDir = this.projSeg(dst)
    const mineIds = new Set(mine.map((entry) => entry.id))
    const clashes = scanned.filter((entry) => entry.projectDir === targetProjectDir && entry.id !== null && mineIds.has(entry.id))
    if (clashes.length > 0) {
      problems.push({ code: 'id-clash', message: '目标位置已存在同 id 的会话：' + clashes.map((entry) => entry.id).join('、') })
    }

    // 目标不存在时要能建得出来：向上找到最近一个已存在的祖先目录。
    if (targetState === 'absent') {
      let ancestor = dirname(dst)
      let reachable = false
      for (let hop = 0; hop < 64; hop++) {
        if (await this.isDirectory(ancestor)) { reachable = true; break }
        const parent = dirname(ancestor)
        if (parent === ancestor) break
        ancestor = parent
      }
      if (!reachable) problems.push({ code: 'target-unreachable', message: '目标路径的上级目录不存在，无法创建' })
    }

    return {
      ok: problems.length === 0,
      problems: problems,
      info: {
        sourceCwd: src,
        targetCwd: dst,
        sessionCount: mine.length,
        sessionIds: mine.map((entry) => entry.id),
        targetState: targetState,
        targetProjectDir: targetProjectDir,
        willCreate: targetState === 'absent'
      }
    }
  }

  // 应用重定位：补建目标目录 → 逐个改写 header 的 cwd 并移到新位置 → 注册工作区、
  // 挂载归属 → 记住这条映射（下次导入时 cwd 命中它就直接落到这里）。
  // 注意：迁移完成后必须重启 DSH，侧栏索引才会认到新路径。
  async applyRelocation(sourceCwd, targetCwd) {
    const check = await this.checkRelocation(sourceCwd, targetCwd)
    if (!check.ok) return { ok: false, problems: check.problems }
    const src = check.info.sourceCwd
    const dst = check.info.targetCwd

    try {
      await mkdir(dst, { recursive: true })
    } catch (e) {
      return { ok: false, problems: [{ code: 'mkdir-failed', message: '无法创建目标目录：' + this.errText(e) }] }
    }

    // 与工作区注册表保持一致，一律用 realpath 规范过的路径：attachSession 要求
    // header.cwd 与工作区路径严格相等，符号链接或大小写差异都会让它失败。
    let canonical = dst
    try { canonical = await realpath(dst) } catch (e) { canonical = dst }

    const scanned = await this.scanSessionHeaders()
    const mine = scanned.filter((entry) => entry.cwd !== null && this.normKey(entry.cwd) === this.normKey(src))
    const targetProjectDir = this.projSeg(canonical)
    const moved = []
    const failed = []
    for (const entry of mine) {
      try {
        const nextPath = this.dshHomePath('sessions', targetProjectDir, entry.segment, entry.fileName)
        if (nextPath !== entry.filePath) {
          const oldSessionDir = dirname(entry.filePath)
          const oldProjectDir = dirname(oldSessionDir)
          await this.moveFile(entry.filePath, nextPath)
          try { await rm(oldSessionDir, { recursive: true, force: true }) } catch (e) {}
          // 旧项目目录空了也一并清掉，别留下一个空的 sessions/<旧编码>/
          try {
            const left = await readdir(oldProjectDir)
            if (left.length === 0) await rm(oldProjectDir, { recursive: true, force: true })
          } catch (e) {}
        }
        await this.rewriteSessionHeaderCwd(nextPath, canonical)
        try { await this.removePath(this.dshHomePath('storages', 'session_projcache', 'sessions', entry.id + '.json')) } catch (e) {}
        moved.push(entry.id)
      } catch (e) {
        failed.push({ id: entry.id, error: this.errText(e) })
      }
    }

    // 挂载归属：尽力而为。会话索引不会实时感知文件搬动，所以这里失败是**预期**的——
    // 重启 DSH 后它会按 header 里的 cwd 自动归位。因此记成"待重启生效"，不报成错误。
    let attached = 0
    let pendingRestart = false
    if (this.workspaceRegistry !== undefined && moved.length > 0) {
      try {
        const ws = await this.workspaceRegistry.create(canonical)
        for (const id of moved) {
          try {
            // 把索引里的旧路径改成新位置：只清缓存不写回的话，attachSession 记下的
            // 归属会被 sessionIds getter 过滤掉，界面上这个工作区的会话数会变 0。
            await this.syncSessionIndex(id, canonical)
            await ws.attachSession(id)
            attached += 1
          } catch (e) {
            pendingRestart = true
          }
        }
      } catch (e) {
        pendingRestart = true
      }
    }

    // 记下重映射：写进这些会话所在分组的记录，下次导入时按 id 命中就直接落位。
    const mappingSaved = await this.setRelocationFor(moved, canonical)
    this.sessionLogCache.clear()
    return {
      ok: true,
      moved: moved.length,
      attached: attached,
      failed: failed,
      sourceCwd: src,
      targetCwd: canonical,
      mappingSaved: mappingSaved,
      pendingRestart: pendingRestart
    }
  }

  // 补登记：把"已经落在正确位置、却没被算进工作区"的会话挂回去。
  // DSH 的工作区归位只在首次初始化时跑一遍（之后 initialized 恒为 true），
  // 所以运行期搬动文件后没有任何东西会补这一步——重定位过的会话要靠这里回到工作区。
  // 只处理 cwd 已注册的会话，因此正常状态下无事可做。
  async reconcileMembership() {
    const registered = new Map()
    if (this.workspaceRegistry !== undefined) {
      for (const w of this.workspaceRegistry.list()) registered.set(this.normKey(w.path), w)
    }
    const scanned = await this.scanSessionHeaders()
    const failed = []
    let repaired = 0
    for (const entry of scanned) {
      if (entry.cwd === null || entry.id === null) continue
      const workspace = registered.get(this.normKey(entry.cwd))
      if (workspace === undefined) continue
      // 先把索引里的归属路径对齐到磁盘上的实际位置：下面的 members 判断走的是
      // sessionIds getter，它只认"路径已知"的会话；索引陈旧时判断会失真，
      // attachSession 也不会真正生效。纯内存操作，逐条做不贵。
      await this.syncSessionIndex(entry.id, entry.cwd)
      const members = Array.from(workspace.sessionIds || []).map(String)
      if (members.includes(String(entry.id))) continue
      try {
        await workspace.attachSession(entry.id)
        repaired += 1
      } catch (e) {
        failed.push({ id: entry.id, error: this.errText(e) })
      }
    }
    if (repaired > 0) this.sessionLogCache.clear()
    return { repaired: repaired, failed: failed, scanned: scanned.length, workspaces: registered.size }
  }

  // 把某个会话在宿主工作区索引里的归属路径，对齐到它当前的真实位置。
  //
  // 必须**直接写索引表**，不能"清掉等宿主重建"：对**活跃会话**（正在对话的那个），
  // readSessionHeader 会先命中 live 会话然后直接 return，根本不会走重建分支
  // （见 dsh-workspace 的 readSessionHeader）。于是 sessionPaths 里永远没有它，
  // sessionIds getter 会把它过滤掉——表现就是它在侧栏里以"路径不认识"的形态
  // 掉进「未分组」。非活跃会话反而会走到重建分支，所以只有当前对话会中招。
  //
  // targetPath 传 null 表示"它不该再属于任何工作区"（删除会话时用）。
  // 这几个字段没有公开 API，全程 best-effort：拿不到就退化成"需要重启"。
  async syncSessionIndex(id, targetPath) {
    if (this.workspaceRegistry === undefined) return
    const registry = this.workspaceRegistry
    const key = String(id)
    const drop = (field) => {
      try {
        const cache = registry[field]
        if (cache !== undefined && typeof cache.delete === 'function') cache.delete(key)
      } catch (e) {}
    }
    // header 缓存一并清掉：我们可能刚改过文件里的 cwd，缓存里那份已经过时了。
    drop('headers')
    if (targetPath === null || targetPath === undefined) {
      drop('sessionPaths')
      drop('invalidSessionPaths')
      return
    }
    // 宿主存的是 realpathNormalize 的结果（解析软链、统一大小写），这里对齐它。
    let canonical = targetPath
    try { canonical = await realpath(targetPath) } catch (e) {}
    try {
      const paths = registry.sessionPaths
      if (paths !== undefined && typeof paths.set === 'function') paths.set(key, canonical)
    } catch (e) {}
    drop('invalidSessionPaths')
  }

  // ── 百度网盘同步 ────────────────────────────────────────────────────────────
  // 本地 exports/ 目录与网盘 /apps/<应用名>/AI/exports 之间逐文件双向同步。
  // 之所以是逐文件而不是打包：百度网盘的分片上传本身就带秒传（MD5 命中就不传），
  // 保持目录结构意味着网盘上能直接看到 index.json 与 sessions/，重传也几乎瞬间完成。

  baiduConfigPath() {
    if (typeof this.dshHomePath !== 'function') return undefined
    return this.dshHomePath('session-migrate', 'baidu.json')
  }

  baiduCredentialsPath() {
    if (typeof this.dshHomePath !== 'function') return undefined
    return this.dshHomePath('session-migrate', BAIDU_CREDENTIALS_FILE)
  }

  /**
   * 读应用凭证。
   *
   * 只从文件读，代码里不留任何默认值：凭证等同于账号身份，写进源码就等于写进版本库，
   * 一次 push 之后再也收不回来。
   *
   * 每种失败都给出可区分的原因——「文件不在」要引导用户去创建，「内容不是 JSON」
   * 要让他去看格式，「缺字段」要指出缺哪个。笼统报一句「凭证有问题」帮不上忙。
   */
  async readBaiduCredentials() {
    const path = this.baiduCredentialsPath()
    if (path === undefined) return { ok: false, reason: 'unavailable', path: null }
    let raw
    try {
      raw = JSON.parse(await this.fsReadText(path))
    } catch (e) {
      const missing = e !== null && e !== undefined && (e.code === 'ENOENT' || /ENOENT/.test(String(e.message)))
      return { ok: false, reason: missing ? 'missing' : 'unreadable', path: path, error: this.errText(e) }
    }
    try {
      return {
        ok: true,
        path: path,
        credentials: normalizeCredentials(raw),
        // 落点与凭证放在同一个文件里：两者都属于「这个应用该怎么用」的配置，
        // 而且都是私密的、由用户自己维护的东西。
        remotePath: normalizeRemotePath(raw)
      }
    } catch (e) {
      return { ok: false, reason: 'invalid', path: path, error: this.errText(e) }
    }
  }

  /**
   * 拿一个可以用的客户端。
   * 凭证换了就重建——否则用户改完文件，插件还在拿旧身份请求授权。
   */
  async baiduClientReady() {
    const state = await this.readBaiduCredentials()
    if (!state.ok) return state
    const key = state.credentials.appKey + '\u0000' + state.credentials.secretKey
    if (this.baidu === undefined || this.baiduCredentialsKey !== key) {
      this.baidu = new BaiduPanClient({ fetchImpl: this.baiduFetch, credentials: state.credentials })
      this.baiduCredentialsKey = key
    }
    return { ok: true, client: this.baidu, path: state.path, remotePath: state.remotePath }
  }

  exportsLocalPath() {
    if (typeof this.dshHomePath !== 'function') return undefined
    return this.dshHomePath('session-migrate', 'exports')
  }

  async readBaiduConfig() {
    const path = this.baiduConfigPath()
    if (path === undefined) return {}
    try {
      const data = JSON.parse(await this.fsReadText(path))
      return data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {}
    } catch (e) {
      return {}
    }
  }

  async writeBaiduConfig(config) {
    const path = this.baiduConfigPath()
    if (path === undefined) return false
    try {
      await this.fsWriteText(path, JSON.stringify(config, null, 2))
      return true
    } catch (e) {
      return false
    }
  }

  baiduReasonText(state) {
    if (state.reason === 'not-logged-in') return '还没有登录百度网盘'
    if (state.reason === 'expired') return '百度网盘的登录态已失效，请重新登录'
    if (state.reason === 'unavailable') return '无法确定 DSH_HOME，百度网盘功能不可用'
    if (state.reason === 'missing') return '还没有配置百度网盘应用凭证：请创建 ' + (state.path || BAIDU_CREDENTIALS_FILE)
    if (state.reason === 'unreadable') return '应用凭证文件读不出来：' + (state.error || '不是合法的 JSON')
    if (state.reason === 'invalid') return '应用凭证不完整：' + (state.error || '')
    return state.error || '百度网盘不可用'
  }

  /**
   * 取一个可用的 access_token。
   * 快过期（不足 10 分钟）时用 refresh_token 换新的；刷新失败不当作致命错误——
   * 旧 token 可能还在有效期内，真的失效会在业务调用上以 errno=-6 如实报出来。
   */
  async ensureBaiduToken() {
    if (this.baiduConfigPath() === undefined) return { ok: false, reason: 'unavailable' }
    const ready = await this.baiduClientReady()
    if (!ready.ok) return { ok: false, reason: ready.reason, path: ready.path, error: ready.error }
    const client = ready.client
    const config = await this.readBaiduConfig()
    const accessToken = typeof config.accessToken === 'string' ? config.accessToken : ''
    if (accessToken === '') {
      client.accessToken = null
      return { ok: false, reason: 'not-logged-in' }
    }
    client.accessToken = accessToken
    const expiresAt = Number(config.expiresAt) || 0
    if (expiresAt - Date.now() > 10 * 60 * 1000) return { ok: true, config }
    const refreshToken = typeof config.refreshToken === 'string' ? config.refreshToken : ''
    if (refreshToken === '') return { ok: true, config }
    // 刷新失败后 60 秒内不再重试：面板会轮询状态，不节流的话会把授权接口打爆
    // （百度对刷新频率有风控，触发后是整个应用一起被限流）。
    if (Date.now() - this.baiduRefreshFailedAt < 60 * 1000) return { ok: true, config }
    try {
      const token = await client.refreshAccessToken(refreshToken)
      const next = {
        ...config,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken || refreshToken,
        expiresAt: token.expiresAt,
        scope: token.scope || config.scope
      }
      await this.writeBaiduConfig(next)
      client.accessToken = next.accessToken
      return { ok: true, config: next }
    } catch (e) {
      this.baiduRefreshFailedAt = Date.now()
      return { ok: true, config, warning: this.errText(e) }
    }
  }

  /**
   * 确定网盘落点。
   *
   * 落点来自 `baiduclound.json` 的 `RemotePath`，两种写法都支持：
   *   - 绝对路径（`/apps/dsh/AI/exports`）：用户已经把话说明白了，不必再探测应用目录
   *   - 相对路径（`AI/exports`）：拼在应用目录后面；应用名只有列一次 /apps 才知道，
   *     探到就记进 baidu.json 复用，下次不必再探
   * 没配则用默认的 AI/exports——不配也能用，配了就按用户的来。
   */
  async resolveBaiduPaths(config) {
    const settings = config || (await this.readBaiduConfig())
    const ready = await this.baiduClientReady()
    if (!ready.ok) return { ok: false, error: this.baiduReasonText(ready) }
    const client = ready.client
    const configured = typeof ready.remotePath === 'string' ? ready.remotePath : ''

    if (configured.startsWith('/')) {
      // 绝对路径：开放平台只允许应用访问自己的 /apps/<应用名>/，路径不合规的话
      // 与其等 API 报一个含糊的 42213，不如在这里就说清楚。
      const segments = configured.split('/').filter((part) => part !== '')
      if (segments.length < 3 || segments[0] !== 'apps') {
        return {
          ok: false,
          error: 'baiduclound.json 里的 RemotePath 必须是 /apps/<应用名>/... 形式的绝对路径，当前是 ' + configured
        }
      }
      const appRoot = '/' + segments[0] + '/' + segments[1]
      return { ok: true, appRoot: appRoot, remotePath: configured, source: 'configured' }
    }

    let appRoot = typeof settings.appRoot === 'string' && settings.appRoot !== '' ? settings.appRoot : null
    if (appRoot === null) {
      try {
        appRoot = await client.findAppRoot()
      } catch (e) {
        return { ok: false, error: this.errText(e) }
      }
      await this.writeBaiduConfig({ ...settings, appRoot })
    }
    const subdir = configured !== '' ? configured : DEFAULT_REMOTE_SUBDIR
    return {
      ok: true,
      appRoot: appRoot,
      remotePath: appRoot.replace(/\/+$/, '') + '/' + subdir,
      source: configured !== '' ? 'configured' : 'default'
    }
  }

  /**
   * 递归扫描本地导出目录，返回待同步的文件清单。
   *
   * 清单里带上索引记录的 `hash` / `remoteHash`——上传靠它俩判断「这份内容是不是
   * 已经在云端了」，从而跳过重传。关联方式是现算的落位（与导出/导入同一套规则），
   * 所以不依赖索引里存目录名。
   */
  async scanLocalExportFiles() {
    const base = this.exportsLocalPath()
    if (base === undefined) return []
    const metaByRelative = new Map()
    for (const entry of await this.readExportIndex()) {
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.id !== 'string' || typeof entry.fileName !== 'string') continue
      const relative = [
        'sessions',
        this.projSeg(entry.cwd === undefined ? null : entry.cwd),
        this.encodeSegment(entry.id),
        entry.fileName
      ].join('/')
      metaByRelative.set(relative, {
        id: entry.id,
        hash: typeof entry.hash === 'string' ? entry.hash : null,
        remoteHash: typeof entry.remoteHash === 'string' ? entry.remoteHash : null
      })
    }
    const found = []
    const walk = async (dir, prefix) => {
      let entries = []
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (e) {
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const relative = prefix === '' ? entry.name : prefix + '/' + entry.name
        const absolute = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(absolute, relative)
          continue
        }
        if (!entry.isFile()) continue
        try {
          const info = await stat(absolute)
          const meta = metaByRelative.get(relative)
          found.push({
            relative: relative,
            absolute: absolute,
            size: info.size,
            mtimeMs: info.mtimeMs,
            ctimeMs: info.ctimeMs,
            id: meta === undefined ? null : meta.id,
            hash: meta === undefined ? null : meta.hash,
            remoteHash: meta === undefined ? null : meta.remoteHash,
            // index.json 自己不在索引的 sessions 列表里，没有可比的哈希。
            // 它很小（几 KB），每次都传，不值得为它再引入一份自指的记录。
            tracked: meta !== undefined
          })
        } catch (e) {}
      }
    }
    await walk(base, '')
    // index.json 排在最后：它是「这份备份完整」的标志。先传会话、最后传索引，
    // 中途失败时网盘上留下的仍然是一份能对得上号的旧备份，而不是半个新备份。
    found.sort((a, b) => {
      const aIndex = a.relative === 'index.json' ? 1 : 0
      const bIndex = b.relative === 'index.json' ? 1 : 0
      if (aIndex !== bIndex) return aIndex - bIndex
      return a.relative.localeCompare(b.relative)
    })
    return found
  }

  /** 本地导出目录的概况。面板会轮询状态，所以这里带 3 秒缓存。 */
  async localExportSummary() {
    const base = this.exportsLocalPath()
    if (base === undefined) {
      return { exists: false, fileCount: 0, totalSize: 0, exportedAt: null, sessionCount: null }
    }
    const now = Date.now()
    if (this.baiduLocalCache !== null && now - this.baiduLocalCache.at < 3000) return this.baiduLocalCache.value
    const files = await this.scanLocalExportFiles()
    let totalSize = 0
    for (const file of files) totalSize += file.size
    let exportedAt = null
    let sessionCount = null
    try {
      const index = JSON.parse(await this.fsReadText(join(base, 'index.json')))
      exportedAt = Number(index.exportedAt) || null
      sessionCount = Array.isArray(index.sessions) ? index.sessions.length : null
    } catch (e) {}
    const value = {
      exists: files.length > 0,
      fileCount: files.length,
      totalSize: totalSize,
      exportedAt: exportedAt,
      sessionCount: sessionCount
    }
    this.baiduLocalCache = { at: now, value }
    return value
  }

  /** 面板要的全部状态。刻意不在这里做网络请求——它会被高频轮询。 */
  async baiduSnapshot() {
    const config = await this.readBaiduConfig()
    const credentialState = await this.readBaiduCredentials()
    const pending = this.baiduPending
    // 凭证没配好时「已登录」无从谈起：那个 token 是用另一份身份换来的。
    const loggedIn = credentialState.ok && typeof config.accessToken === 'string' && config.accessToken !== ''
    const appRoot = typeof config.appRoot === 'string' && config.appRoot !== '' ? config.appRoot : null
    // 落点与 resolveBaiduPaths 保持同一套规则，但这里只做纯计算：
    // 绝对路径直接用；相对路径要拼应用目录，而应用目录可能还没探测过，
    // 那就先如实显示成「待登录后确定」，不去为了显示而发请求。
    const configured = credentialState.ok && typeof credentialState.remotePath === 'string'
      ? credentialState.remotePath
      : ''
    const subdir = configured !== '' ? configured : DEFAULT_REMOTE_SUBDIR
    const remotePath = credentialState.ok
      ? (subdir.startsWith('/') ? subdir : (appRoot === null ? null : appRoot.replace(/\/+$/, '') + '/' + subdir))
      : null
    return {
      available: this.baiduConfigPath() !== undefined,
      configured: credentialState.ok,
      credentialsPath: this.baiduCredentialsPath() || null,
      credentialsProblem: credentialState.ok ? null : {
        reason: credentialState.reason,
        message: this.baiduReasonText(credentialState)
      },
      loggedIn: loggedIn,
      phase: pending !== null ? 'waiting' : (loggedIn ? 'authorized' : 'idle'),
      pending: pending === null ? null : {
        userCode: pending.userCode,
        verificationUrl: pending.verificationUrl,
        qrcodeUrl: pending.qrcodeUrl,
        expiresAt: pending.expiresAt,
        interval: pending.interval
      },
      account: config.account || null,
      appRoot: appRoot,
      subdir: subdir,
      // 落点是写死的默认值，还是用户在 baiduclound.json 里配的？面板要把这个说清楚，
      // 否则用户改了配置却看到「没变化」，会以为配置没生效。
      remotePathSource: configured !== '' ? 'configured' : 'default',
      remotePath: remotePath,
      localPath: this.exportsLocalPath() || null,
      local: await this.localExportSummary(),
      task: this.baiduTask,
      lastUploadAt: Number(config.lastUploadAt) || null,
      lastDownloadAt: Number(config.lastDownloadAt) || null,
      error: this.baiduLastError
    }
  }

  async baiduStatus() {
    return await this.baiduSnapshot()
  }

  async baiduLoginStart() {
    this.stopBaiduPolling()
    this.baiduPending = null
    this.baiduLastError = null
    if (this.baiduConfigPath() === undefined) {
      this.baiduLastError = '无法确定 DSH_HOME，百度网盘功能不可用'
      return await this.baiduSnapshot()
    }
    const ready = await this.baiduClientReady()
    if (!ready.ok) {
      this.baiduLastError = this.baiduReasonText(ready)
      return await this.baiduSnapshot()
    }
    const client = ready.client
    try {
      const code = await client.requestDeviceCode()
      this.baiduPending = {
        deviceCode: code.deviceCode,
        userCode: code.userCode,
        verificationUrl: code.verificationUrl,
        qrcodeUrl: code.qrcodeUrl,
        expiresAt: Date.now() + code.expiresIn * 1000,
        interval: code.interval
      }
      this.startBaiduPolling(code.interval)
    } catch (e) {
      this.baiduLastError = this.errText(e)
    }
    return await this.baiduSnapshot()
  }

  async baiduLoginCancel() {
    this.baiduPending = null
    this.stopBaiduPolling()
    return await this.baiduSnapshot()
  }

  async baiduLogout() {
    this.baiduPending = null
    this.stopBaiduPolling()
    const config = await this.readBaiduConfig()
    // 只丢凭证，留下 appRoot：下次登录的还是同一个应用，没必要再探一遍。
    const next = { ...config }
    delete next.accessToken
    delete next.refreshToken
    delete next.expiresAt
    delete next.scope
    delete next.account
    await this.writeBaiduConfig(next)
    if (this.baidu !== undefined) this.baidu.accessToken = null
    this.baiduLastError = null
    return await this.baiduSnapshot()
  }

  stopBaiduPolling() {
    if (this.baiduTimer !== null) {
      clearInterval(this.baiduTimer)
      this.baiduTimer = null
    }
  }

  /**
   * 授权是异步完成的：用户得先拿着 user_code 去百度页面点同意。
   * 所以这里在宿主内起一个轮询（而不是让浏览器轮询），关掉面板也不影响授权完成。
   * 官方要求轮询间隔不低于 5 秒，低于这个值会被风控。
   */
  startBaiduPolling(intervalSeconds) {
    this.stopBaiduPolling()
    const seconds = Math.max(Number(intervalSeconds) || 5, 5)
    // setInterval 不会等上一轮结束。网络慢的时候两次轮询会叠在一起，
    // 那正好是百度风控最敏感的行为，所以自己挡一道。
    let inFlight = false
    const tick = async () => {
      if (inFlight) return
      const pending = this.baiduPending
      if (pending === null) {
        this.stopBaiduPolling()
        return
      }
      if (Date.now() > pending.expiresAt) {
        this.baiduPending = null
        this.baiduLastError = '授权码已过期，请重新点「登录百度网盘」'
        this.stopBaiduPolling()
        return
      }
      inFlight = true
      try {
        // 每次轮询都重新确认凭证：用户可能在等待授权期间把 baiduclound.json 删了或改了。
        const ready = await this.baiduClientReady()
        if (!ready.ok) {
          this.baiduPending = null
          this.baiduLastError = this.baiduReasonText(ready)
          this.stopBaiduPolling()
          return
        }
        const client = ready.client
        const result = await client.requestDeviceToken(pending.deviceCode)
        if (result.pending) return
        client.accessToken = result.token.accessToken
        const config = await this.readBaiduConfig()
        await this.writeBaiduConfig({ ...config, ...result.token })
        this.baiduPending = null
        this.baiduLastError = null
        this.stopBaiduPolling()
        // 登录成功后顺手把账号名和应用目录补上；失败也不影响登录本身。
        await this.refreshBaiduIdentity().catch(() => {})
      } catch (e) {
        this.baiduPending = null
        this.baiduLastError = this.errText(e)
        this.stopBaiduPolling()
      } finally {
        inFlight = false
      }
    }
    this.baiduTimer = setInterval(() => { tick() }, seconds * 1000)
    if (typeof this.baiduTimer.unref === 'function') this.baiduTimer.unref()
  }

  async refreshBaiduIdentity() {
    const config = await this.readBaiduConfig()
    const next = { ...config }
    const ready = await this.baiduClientReady()
    if (!ready.ok) {
      await this.writeBaiduConfig(next)
      return next
    }
    const client = ready.client
    try {
      const info = await client.userInfo()
      next.account = {
        baiduName: info.baidu_name || '',
        netdiskName: info.netdisk_name || '',
        vipType: Number(info.vip_type) || 0
      }
    } catch (e) {}
    if (typeof next.appRoot !== 'string' || next.appRoot === '') {
      try {
        next.appRoot = await client.findAppRoot()
      } catch (e) {}
    }
    await this.writeBaiduConfig(next)
    return next
  }

  beginBaiduTask(kind, total, message) {
    this.baiduTask = {
      running: true,
      kind: kind,
      total: total,
      done: 0,
      current: '',
      message: message,
      startedAt: Date.now(),
      finishedAt: null,
      result: null,
      error: null
    }
  }

  finishBaiduTask() {
    const task = this.baiduTask
    if (task === null) return
    task.running = false
    task.finishedAt = Date.now()
    task.current = ''
    task.message = task.error === null || task.error === undefined ? '完成' : '失败'
  }

  async baiduUpload() {
    if (this.baiduTask !== null && this.baiduTask.running) {
      this.baiduLastError = '已经有一个同步任务在进行中，请等它结束'
      return await this.baiduSnapshot()
    }
    const tokenState = await this.ensureBaiduToken()
    if (!tokenState.ok) {
      this.baiduLastError = this.baiduReasonText(tokenState)
      return await this.baiduSnapshot()
    }
    const paths = await this.resolveBaiduPaths(tokenState.config)
    if (!paths.ok) {
      this.baiduLastError = paths.error
      return await this.baiduSnapshot()
    }
    const files = await this.scanLocalExportFiles()
    if (files.length === 0) {
      this.baiduLastError = '本地导出目录是空的，请先点上面的「导出」生成备份'
      return await this.baiduSnapshot()
    }
    this.baiduLastError = null
    this.beginBaiduTask('upload', files.length, '正在准备网盘目录…')
    this.runBaiduUpload(paths, files).catch(() => {})
    return await this.baiduSnapshot()
  }

  async runBaiduUpload(paths, files) {
    const task = this.baiduTask
    // 能走到这里说明 baiduUpload 已经确认过凭证并建好了客户端。
    const client = this.baidu
    // 每个文件的请求/响应摘要，最后落盘。参数位置、返回字段这类问题在界面上
    // 一句话说不清，留一份原始记录比反复猜测有用得多。
    const trace = []
    try {
      task.message = '正在准备网盘目录…'
      await client.createDirTree(paths.remotePath, paths.appRoot)
      // 建完必须确认一次。踩过的坑：create 返回 errno=0（"成功"），目录却根本没建出来，
      // 随后 precreate 到一个不存在的目录，返回了一个看起来像秒传的响应。
      try {
        await client.listDir(paths.remotePath)
      } catch (e) {
        throw new Error('网盘目录 ' + paths.remotePath + ' 创建后仍然列不出来：' + this.errText(e))
      }
      // ① 先看清云端现在有什么。一次调用同时服务三件事：
      //    判断哪些文件不用重传、找出云端多余的东西、以及上传后的核对基线。
      task.message = '正在核对云端内容…'
      const remoteEntries = await client.listAllEntries(paths.remotePath)
      const remoteFiles = new Map()
      const remoteDirs = []
      for (const entry of remoteEntries) {
        const relative = relativeTo(paths.remotePath, entry.path)
        if (relative === null || relative === '') continue
        if (Number(entry.isdir) === 1) remoteDirs.push(relative)
        else remoteFiles.set(relative, entry)
      }

      // ② 决定哪些真的要传。跳过要同时满足三条，缺一条都可能造成假同步：
      //      - 索引记得这份内容传过（remoteHash === hash）
      //      - 云端确实还有这个文件（可能被人手动删了）
      //      - 大小对得上（换过落点、或那个位置被别的内容占了）
      const indexFile = files.find((file) => file.relative === 'index.json') || null
      const skippedNames = []
      const pending = []
      for (const file of files) {
        if (file.relative === 'index.json') continue
        const onRemote = remoteFiles.get(file.relative)
        const alreadyThere = file.tracked === true
          && file.hash !== null
          && file.remoteHash !== null
          && file.remoteHash === file.hash
          && onRemote !== undefined
          && Number(onRemote.size) === file.size
        if (alreadyThere) skippedNames.push(file.relative)
        else pending.push(file)
      }

      const failed = []
      let instant = 0
      let done = 0
      const uploadedRelative = new Set()
      task.total = pending.length + (indexFile === null ? 0 : 1)
      for (const file of pending) {
        task.current = file.relative
        task.message = '正在上传…'
        try {
          const result = await client.uploadFile({
            filePath: file.absolute,
            path: joinRemote(paths.remotePath, file.relative),
            size: file.size,
            ctime: Math.floor(file.ctimeMs / 1000),
            mtime: Math.floor(file.mtimeMs / 1000)
          })
          if (result.instant) instant += 1
          uploadedRelative.add(file.relative)
          trace.push({
            path: file.relative,
            size: file.size,
            instant: result.instant === true,
            uploadedSlices: result.uploadedSlices,
            precreate: result.precreateResponse || null
          })
        } catch (e) {
          // 单个文件失败不中断整批：网盘上留下的是「大部分已同步」，
          // 重跑一次即可补齐，比整批回滚更有用。
          failed.push({ path: file.relative, error: this.errText(e) })
          trace.push({
            path: file.relative,
            size: file.size,
            error: this.errText(e),
            payload: e && e.payload ? e.payload : null
          })
        }
        done += 1
        task.done = done
      }

      // ③ 把成功上传的结果写回本地索引，再传索引本身。
      //    顺序很讲究：先更新 remoteHash、再传 index.json，云端那份索引才会带着正确的
      //    上传状态；反过来做的话，下次「从百度云中获取」拉回来的索引会显得「都没传过」。
      if (indexFile !== null) {
        task.message = '正在更新索引…'
        task.current = 'index.json'
        try {
          const marked = await this.markUploadedInIndex(indexFile.absolute, uploadedRelative)
          trace.push({ index: 'updated', marked: marked })
        } catch (e) {
          trace.push({ index: 'update-failed', error: this.errText(e) })
        }
        task.message = '正在上传索引…'
        try {
          const indexSize = (await stat(indexFile.absolute)).size
          const indexResult = await client.uploadFile({
            filePath: indexFile.absolute,
            path: joinRemote(paths.remotePath, 'index.json'),
            size: indexSize,
            ctime: Math.floor(indexFile.ctimeMs / 1000),
            mtime: Math.floor(indexFile.mtimeMs / 1000)
          })
          if (indexResult.instant) instant += 1
          uploadedRelative.add('index.json')
          trace.push({
            path: 'index.json',
            size: indexSize,
            instant: indexResult.instant === true,
            uploadedSlices: indexResult.uploadedSlices,
            precreate: indexResult.precreateResponse || null
          })
        } catch (e) {
          failed.push({ path: 'index.json', error: this.errText(e) })
          trace.push({ path: 'index.json', error: this.errText(e) })
        }
        done += 1
        task.done = done
      }

      // ④ 删除云端多余的东西——「保持一致」的另一半，以前只有增改没有删。
      //    只动 remotePath 之内的路径：那是用户明确指出归本插件管的地方。
      const localSet = new Set(files.map((file) => file.relative))
      const localDirs = new Set()
      for (const file of files) {
        const parts = file.relative.split('/')
        for (let depth = 1; depth < parts.length; depth++) localDirs.add(parts.slice(0, depth).join('/'))
      }
      const extraDirs = remoteDirs.filter((relative) => !localDirs.has(relative))
      const extraFiles = []
      for (const relative of remoteFiles.keys()) {
        if (localSet.has(relative)) continue
        // 落在「整个目录都要删」的范围里就不必单独点名了：目录删除是递归的。
        if (extraDirs.some((dir) => relative.startsWith(dir + '/'))) continue
        extraFiles.push(relative)
      }
      const toDelete = extraDirs.concat(extraFiles).map((relative) => joinRemote(paths.remotePath, relative))
      let deleted = 0
      const deleteFailed = []
      if (toDelete.length > 0) {
        task.message = '正在清理云端多余内容…'
        try {
          const results = await client.deletePaths(toDelete)
          for (const item of results) {
            if (item.ok) deleted += 1
            else deleteFailed.push({ path: item.path, error: 'errno=' + item.errno })
          }
          trace.push({ deleted: deleted, requested: toDelete.length, results: results.slice(0, 50) })
        } catch (e) {
          deleteFailed.push({ path: '(批量删除)', error: this.errText(e) })
          trace.push({ deleteError: this.errText(e) })
        }
      }

      // ⑤ 核对：云端必须与本地逐文件相同——一个不少，也一个不多。
      task.message = '正在核对结果…'
      let remoteFileCount = null
      let missing = []
      let extra = []
      try {
        const verifyEntries = await client.listAllEntries(paths.remotePath)
        const present = new Set()
        for (const entry of verifyEntries) {
          if (Number(entry.isdir) === 1) continue
          const relative = relativeTo(paths.remotePath, entry.path)
          if (relative !== null && relative !== '') present.add(relative)
        }
        remoteFileCount = present.size
        missing = files.filter((file) => !present.has(file.relative)).map((file) => file.relative)
        extra = Array.from(present).filter((relative) => !localSet.has(relative))
      } catch (e) {
        trace.push({ verifyError: this.errText(e) })
      }

      task.result = {
        uploaded: uploadedRelative.size - failed.length,
        skipped: skippedNames.length,
        skippedItems: skippedNames.slice(0, 20),
        instant: instant,
        deleted: deleted,
        deletedItems: toDelete.slice(0, 20),
        deleteFailed: deleteFailed.slice(0, 20),
        failed: failed.length,
        failedItems: failed.slice(0, 20),
        total: files.length,
        remotePath: paths.remotePath,
        remoteFileCount: remoteFileCount,
        missing: missing.slice(0, 20),
        extra: extra.slice(0, 20)
      }

      const problems = []
      if (failed.length > 0) problems.push('有 ' + failed.length + ' 个文件上传失败')
      if (deleteFailed.length > 0) problems.push('有 ' + deleteFailed.length + ' 项删除失败')
      if (missing.length > 0) problems.push('云端缺少 ' + missing.length + ' 个文件')
      if (extra.length > 0) problems.push('云端多出 ' + extra.length + ' 个文件')
      if (problems.length > 0) {
        task.error = '同步后核对不通过：' + problems.join('、')
      } else {
        task.error = null
        const config = await this.readBaiduConfig()
        await this.writeBaiduConfig({ ...config, lastUploadAt: Date.now(), lastUploadPath: paths.remotePath })
      }
      this.baiduLocalCache = null
    } catch (e) {
      task.error = this.errText(e)
      trace.push({ fatal: this.errText(e) })
    } finally {
      try {
        await this.writeTextEnsured(
          this.dshHomePath('session-migrate', 'baidu-debug.log'),
          JSON.stringify({ at: new Date().toISOString(), kind: 'upload', remotePath: paths.remotePath, trace: trace }, null, 2)
        )
      } catch (e) {}
      this.finishBaiduTask()
    }
  }

  /**
   * 把「这些文件已经成功传到云端了」写回本地 index.json。
   *
   * 只动 remoteHash 一个字段，其余原样保留——索引是导入的依据，不能因为上传
   * 就把它整个重写一遍。返回被标记的条数。
   */
  async markUploadedInIndex(indexPath, uploadedRelative) {
    if (uploadedRelative.size === 0) return 0
    const index = JSON.parse(await this.fsReadText(indexPath))
    const sessions = index !== null && typeof index === 'object' && Array.isArray(index.sessions)
      ? index.sessions
      : []
    let marked = 0
    for (const entry of sessions) {
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.id !== 'string' || typeof entry.fileName !== 'string') continue
      const relative = [
        'sessions',
        this.projSeg(entry.cwd === undefined ? null : entry.cwd),
        this.encodeSegment(entry.id),
        entry.fileName
      ].join('/')
      if (!uploadedRelative.has(relative)) continue
      if (entry.remoteHash !== entry.hash) {
        entry.remoteHash = typeof entry.hash === 'string' ? entry.hash : null
        marked += 1
      }
    }
    if (marked > 0) await this.fsWriteText(indexPath, JSON.stringify(index, null, 2))
    return marked
  }

  async baiduDownload() {
    if (this.baiduTask !== null && this.baiduTask.running) {
      this.baiduLastError = '已经有一个同步任务在进行中，请等它结束'
      return await this.baiduSnapshot()
    }
    const tokenState = await this.ensureBaiduToken()
    if (!tokenState.ok) {
      this.baiduLastError = this.baiduReasonText(tokenState)
      return await this.baiduSnapshot()
    }
    const paths = await this.resolveBaiduPaths(tokenState.config)
    if (!paths.ok) {
      this.baiduLastError = paths.error
      return await this.baiduSnapshot()
    }
    this.baiduLastError = null
    this.beginBaiduTask('download', 0, '正在列出网盘文件…')
    this.runBaiduDownload(paths).catch(() => {})
    return await this.baiduSnapshot()
  }

  async runBaiduDownload(paths) {
    const task = this.baiduTask
    // 同上：凭证与客户端在 baiduDownload 里已经确认过。
    const client = this.baidu
    // 先落到一个临时目录，全部成功才替换本地 exports。
    // 边下边覆盖的话，中途断网会留下"一半新一半旧"的备份——那比不更新更危险。
    const incoming = this.dshHomePath('session-migrate', '.baidu-incoming')
    const trace = []
    try {
      const listing = await client.listAllFiles(paths.remotePath)
      const files = listing.filter((entry) => Number(entry.isdir) !== 1 && typeof entry.path === 'string')
      // fs_id 是 64 位整数，调试日志里必须按字符串记，否则打印出来就已经是错的了。
      trace.push({
        step: 'list',
        count: files.length,
        sample: files.slice(0, 5).map((entry) => ({
          fs_id: String(entry.fs_id),
          fsIdType: typeof entry.fs_id,
          path: entry.path,
          size: entry.size
        }))
      })
      if (files.length === 0) {
        throw new Error('网盘目录 ' + paths.remotePath + ' 里没有任何文件')
      }
      const hasIndex = files.some((entry) => relativeTo(paths.remotePath, entry.path) === 'index.json')
      if (!hasIndex) {
        throw new Error('网盘目录里没有 index.json，这不像是本插件导出的备份')
      }
      task.total = files.length
      task.message = '正在下载…'
      await this.removePath(incoming)
      await mkdir(incoming, { recursive: true })
      const failed = []
      let done = 0
      for (const entry of files) {
        const relative = relativeTo(paths.remotePath, entry.path)
        if (relative === null || relative === '') {
          done += 1
          task.done = done
          continue
        }
        task.current = relative
        try {
          const download = await client.openDownload(entry.fs_id)
          const dest = join(incoming, ...relative.split('/'))
          await mkdir(dirname(dest), { recursive: true })
          await pipeline(Readable.fromWeb(download.response.body), createWriteStream(dest))
        } catch (e) {
          failed.push({ path: relative, error: this.errText(e) })
          trace.push({
            path: relative,
            fs_id: String(entry.fs_id),
            error: this.errText(e),
            payload: e && e.payload ? e.payload : null
          })
        }
        done += 1
        task.done = done
      }
      if (failed.length > 0) {
        task.result = {
          downloaded: files.length - failed.length,
          failed: failed.length,
          failedItems: failed.slice(0, 20),
          localPath: this.exportsLocalPath()
        }
        task.error = '有 ' + failed.length + ' 个文件没能下载，本地导出目录保持原样未改动'
        return
      }
      const exportsBase = this.exportsLocalPath()
      // 本地有、云端没有的东西要在替换时被清掉。先把它们点出来，好如实报告
      // 「清理了多少」——不然用户只会看到数字变了，不知道消失的是什么。
      const remoteRelative = new Set()
      for (const entry of files) {
        const relative = relativeTo(paths.remotePath, entry.path)
        if (relative !== null && relative !== '') remoteRelative.add(relative)
      }
      let extraLocal = []
      try {
        const before = await this.scanLocalExportFiles()
        extraLocal = before.filter((file) => !remoteRelative.has(file.relative)).map((file) => file.relative)
      } catch (e) {}
      await mkdir(exportsBase, { recursive: true })
      // 「获取」的语义是本地完全以云端为准，所以连点文件一起清——
      // 留下云端没有的东西就不叫一致了。
      await this.clearDir(exportsBase, { keepDotFiles: false })
      await this.moveTree(incoming, exportsBase)
      this.baiduLocalCache = null
      const config = await this.readBaiduConfig()
      await this.writeBaiduConfig({ ...config, lastDownloadAt: Date.now() })
      task.result = {
        downloaded: files.length,
        deleted: extraLocal.length,
        deletedItems: extraLocal.slice(0, 20),
        failed: 0,
        failedItems: [],
        localPath: exportsBase,
        remotePath: paths.remotePath
      }
    } catch (e) {
      task.error = this.errText(e)
    } finally {
      try { await this.removePath(incoming) } catch (e) {}
      try {
        await this.writeTextEnsured(
          this.dshHomePath('session-migrate', 'baidu-debug.log'),
          JSON.stringify({ at: new Date().toISOString(), kind: 'download', remotePath: paths.remotePath, trace: trace }, null, 2)
        )
      } catch (e) {}
      this.finishBaiduTask()
    }
  }

  async moveTree(src, dst) {
    let entries = []
    try {
      entries = await readdir(src, { withFileTypes: true })
    } catch (e) {
      return
    }
    for (const entry of entries) {
      const from = join(src, entry.name)
      const to = join(dst, entry.name)
      if (entry.isDirectory()) {
        await mkdir(to, { recursive: true })
        await this.moveTree(from, to)
      } else if (entry.isFile()) {
        await this.moveFile(from, to)
      }
    }
  }
}

export async function apply(ctx) {
  const service = new SessionMigrateService(ctx)
  await markLegacyRemote(service)
  // 启动后补登记一次：会话索引要等宿主装配完才就绪，所以延后几秒再跑，
  // 把重定位过、却还没算进工作区的会话挂回去（正常状态下它无事可做）。
  const timer = setTimeout(() => {
    service.reconcileMembership().catch(() => {})
  }, 4000)
  if (typeof timer.unref === 'function') timer.unref()
  // 百度授权的轮询定时器要在插件卸载时停掉，否则它会拿着一个已经注销的服务继续跑。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { service.stopBaiduPolling() }, 'session-migrate: baidu polling')
  }
}
