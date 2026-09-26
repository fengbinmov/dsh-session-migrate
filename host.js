import { createHash } from 'node:crypto'
import { copyFile, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

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

const REMOTE_METHODS = ['listGroups', 'listSessions', 'loadSelection', 'saveSelection', 'unarchive', 'deleteWorkspace', 'export', 'import', 'listUnlinkedGroups', 'checkRelocation', 'applyRelocation', 'reconcileMembership']

// selection.json 里表示"无工作区会话"那一组的键（cwd 为空的会话）。
const ORPHAN_KEY = '__orphan__'

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

  // 与原 PowerShell 实现同语义：只清空非隐藏条目，保留点文件。
  async clearDir(path) {
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch (e) {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
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
      const orphans = await this.sessionQuery.filterSessions([{ kind: 'cwd', values: [null] }])
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

  async export(sessionIds) {
    const ids = sessionIds || []
    if (typeof this.dshHomePath !== 'function') return { error: '无法确定 DSH_HOME 路径' }
    await this.flushAll()
    this.sessionLogCache.clear()
    const exportBase = this.dshHomePath('session-migrate', 'exports')
    try { await this.clearDir(exportBase) } catch (e) {}
    const archived = new Set(this.archivedIds().map(String))
    const headerById = {}
    try {
      const records = await this.sessionQuery.listSessions()
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
      // 只写"不可派生"的东西。目录名一律不存：projectKey 是有损编码（D:\a-b\c 和
      // D:\a\b-c 会编成同一个 --D-a-b-c--，超长还会被截断），既反解不回 cwd，也不该
      // 被当成权威——DSH 自己就是按当前规则校验"日志与路径是否相符"的。
      entries.push({
        id: item.id,
        cwd: item.cwd,
        fileName: item.fileName,
        hash: hash,
        fingerprint: fingerprint,
        archived: archived.has(String(item.id))
      })
    }
    const index = {
      format: 'dsh-sessions-export',
      // v3：去掉了可派生的 sessionSegment / relativePath，以及从没被读过、header 里
      // 本来就有 的 createdAt / parentSession / agentPreset / origin。读取兼容 v2。
      version: 3,
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
            // 先清掉该会话可能残留的旧 header 缓存，让归属能当场恢复而不是等重启。
            this.forgetCachedHeaders([s.id])
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
      // 明细最多给 20 条：整批都对不上时（典型：只同步了 index.json 没同步 sessions/）
      // 不必把上千条错误塞回界面，有总数和几个样本足够判断原因。
      skippedItems: skipped.slice(0, 20),
      importedIds: imported,
      overwrittenIds: overwritten,
      detachedIds: detached
    }
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
        // 先让 DSH 忘掉这些会话的旧 header 缓存，否则 attachSession 会拿搬家前的
        // cwd 去校验、必然失败（这就是"必须重启"的根因）。
        this.forgetCachedHeaders(moved)
        for (const id of moved) {
          try {
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

  // 让 DSH 忘掉这些会话的 header 索引缓存。
  // workspaceRegistry 把每个会话的 header 缓存在内存里；文件搬家后缓存里的 cwd 还是旧的，
  // attachSession 会拿旧 cwd 去校验、必然失败——这就是"重定位后必须重启"的真正根因。
  // 清掉之后 attachSession 会重新扫描磁盘读到新 header，于是当场就能归位。
  // 这些字段没有公开 API，所以全程 best-effort：拿不到就退化成"需要重启"。
  forgetCachedHeaders(ids) {
    const registry = this.workspaceRegistry
    if (registry === undefined) return 0
    let cleared = 0
    for (const id of ids) {
      const key = String(id)
      for (const field of ['headers', 'sessionPaths', 'invalidSessionPaths']) {
        try {
          const cache = registry[field]
          if (cache !== undefined && typeof cache.delete === 'function') {
            if (cache.delete(key)) cleared += 1
          }
        } catch (e) {}
      }
    }
    return cleared
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
}
