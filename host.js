import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const name = 'session-migrate'

// 文件操作全部走 node:fs，因此不再需要 fs / shell / sandboxPolicy 三个宿主服务：
// 这套实现跨平台（Windows 与 macOS 行为一致），也没有 PowerShell 的进程启动开销。
export const inject = ['sessionQuery', 'workspaceRegistry']

const REMOTE_METHODS = ['listGroups', 'listSessions', 'loadSelection', 'saveSelection', 'unarchive', 'deleteWorkspace', 'export', 'import']

// 宿主 gateway 发现“源码模式”远程端点的唯一依据，是服务原型上这个稳定字符串键
// 描述符——新版协议改用原型属性，正是为了让另一个已安装副本也能读到。
const REMOTE_METHODS_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'

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

  snapshotPath() {
    if (typeof this.dshHomePath !== 'function') return undefined
    return this.dshHomePath('session-migrate', 'export-snapshot.json')
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

  async cleanSnapshot(snapshot) {
    if (!snapshot || !snapshot.byWorkspace) return snapshot
    // 用工作区注册表里的规范路径（而不是快照里的 key）去定位日志文件：key 是导出时
    // 记下的原值，大小写或斜杠写法可能不一致，拿它拼目录会算出错误的项目目录，
    // 把本来有效的条目误判成"文件不存在"。
    const orphanNorm = this.normKey('__orphan__')
    const pathByNorm = new Map()
    if (this.workspaceRegistry !== undefined) {
      for (const w of this.workspaceRegistry.list()) pathByNorm.set(this.normKey(w.path), w.path)
    }
    const byWorkspace = {}
    let changed = false
    for (const key in snapshot.byWorkspace) {
      const ws = snapshot.byWorkspace[key]
      if (!ws) { changed = true; continue }
      const nk = this.normKey(key)
      const isOrphan = nk === orphanNorm
      // 工作区不在注册表里（典型情形：刚从备份导入，注册还没重建）不能单独作为
      // 删除理由——回退到快照自己的 key 去定位，只要会话文件确实还在就保留这条记录。
      const cwd = isOrphan ? null : (pathByNorm.get(nk) ?? key)
      const rawIds = ws.sessionIds || []
      // 防御性清理：只按"磁盘上还有没有日志文件"判断。会话记录暂时查不到
      // （刚导入、索引还没重建）不代表它无效，不能拿查询可见性当删除理由。
      const keptIds = []
      for (const id of rawIds) {
        if (await this.sessionStat(cwd, id) === null) { changed = true; continue }
        keptIds.push(id)
      }
      if (keptIds.length === 0) { changed = true; continue }
      const fingerprints = {}
      const sizes = {}
      const oldFp = ws.fingerprints || {}
      const oldSz = ws.sizes || {}
      for (const id of keptIds) {
        if (oldFp[id] != null) fingerprints[id] = oldFp[id]
        if (oldSz[id] != null) sizes[id] = oldSz[id]
      }
      if (Object.keys(fingerprints).length !== Object.keys(oldFp).length || Object.keys(sizes).length !== Object.keys(oldSz).length) changed = true
      byWorkspace[key] = { sessionIds: keptIds, fingerprints: fingerprints, sizes: sizes }
    }
    if (changed) {
      snapshot.byWorkspace = byWorkspace
      const sp = this.snapshotPath()
      if (sp) {
        try { await this.fsWriteText(sp, JSON.stringify(snapshot, null, 2)) } catch (e) {}
      }
    }
    return snapshot
  }

  async readSnapshot() {
    const p = this.snapshotPath()
    if (!p) return null
    try {
      const snapshot = JSON.parse(await this.fsReadText(p))
      return await this.cleanSnapshot(snapshot)
    } catch (e) {
      return null
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
    const snapshot = await this.readSnapshot()
    const byWorkspace = (snapshot && snapshot.byWorkspace) || {}
    const normByWorkspace = {}
    const snapshotKeys = []
    for (const k in byWorkspace) {
      normByWorkspace[this.normKey(k)] = byWorkspace[k]
      snapshotKeys.push(k)
    }
    const archivedSet = new Set(this.archivedIds().map(String))
    const groups = []
    if (this.workspaceRegistry !== undefined) {
      for (const w of this.workspaceRegistry.list()) {
        const snap = normByWorkspace[this.normKey(w.path)]
        let hasExport = false
        let status = 'none'
        if (snap && snap.sessionIds) {
          hasExport = true
          const cur = Array.from(w.sessionIds).map(String).sort()
          const exp = (snap.sessionIds || []).map(String).sort()
          const sameSet = cur.length === exp.length && cur.every(function (v, i) { return v === exp[i] })
          let sameContent = sameSet
          if (sameSet && snap.fingerprints) {
            for (const id of exp) {
              const fp = snap.fingerprints[id]
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
        const snap = normByWorkspace[this.normKey('__orphan__')]
        let hasExport = false
        let status = 'none'
        if (snap && snap.sessionIds) {
          hasExport = true
          const cur = orphans.map((o) => o.header.id).map(String).sort()
          const exp = (snap.sessionIds || []).map(String).sort()
          const sameSet = cur.length === exp.length && cur.every(function (v, i) { return v === exp[i] })
          let sameContent = sameSet
          if (sameSet && snap.fingerprints) {
            for (const id of exp) {
              const fp = snap.fingerprints[id]
              if (fp == null) continue
              const st = await this.sessionStat(null, id)
              if (st != null && st.version !== fp) { sameContent = false; break }
            }
          }
          status = (sameSet && sameContent) ? 'unchanged' : 'changed'
        }
        const orphanIds = orphans.map((o) => o.header.id).map(String)
        const archivedCount = orphanIds.filter((id) => archivedSet.has(id)).length
        groups.push({ key: '__orphan__', path: null, title: '未关联工作区', sessionCount: orphanIds.length, archivedCount: archivedCount, sessionIds: orphanIds, hasExport: hasExport, status: status })
      }
    } catch (e) {}
    const debug = '快照工作区: ' + snapshotKeys.join(' | ') + '\n工作区数: ' + groups.length + '，已导出: ' + groups.filter((g) => g.hasExport).length
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
    const snapshot = await this.readSnapshot()
    const snapKey = cwd == null ? '__orphan__' : cwd
    const snap = (snapshot && snapshot.byWorkspace) ? snapshot.byWorkspace[snapKey] : undefined
    const hasExport = !!(snap && snap.sessionIds)
    const fingerprints = (snap && snap.fingerprints) || {}
    const sizes = (snap && snap.sizes) || {}
    const exportedSet = new Set()
    if (snap && snap.sessionIds) {
      for (const sid of snap.sessionIds) exportedSet.add(String(sid))
    }
    const sessionsOut = []
    for (const r of records) {
      const view = this.sessionView(r, titleMap)
      let status = 'none'
      let size = null
      let sizeDelta = null
      if (hasExport) {
        const st = await this.sessionStat(cwd, r.header.id)
        size = st ? st.size : null
        if (!exportedSet.has(String(r.header.id))) {
          status = 'new'
        } else {
          const fp = fingerprints[r.header.id]
          const baseSize = sizes[r.header.id]
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

  async loadSelection() {
    const configPath = this.selectionConfigPath()
    if (!configPath) return { selected: [] }
    this.sessionLogCache.clear()
    try {
      const text = await this.fsReadText(configPath)
      const data = JSON.parse(text)
      const selected = (data && data.selected) || []
      // 判据同样是"磁盘上还有没有这个会话的日志文件"。刚导入的会话可能还没进入
      // 查询索引，若用查询可见性判断，会把刚恢复出来的勾选项立刻删掉。
      const logs = await this.scanSessionLogs()
      const cleaned = selected.filter((id) => logs.has(this.encodeSegment(String(id))))
      if (cleaned.length !== selected.length) {
        try { await this.fsWriteText(configPath, JSON.stringify({ selected: cleaned, updatedAt: Date.now() })) } catch (e) {}
      }
      return { selected: cleaned }
    } catch (e) {
      return { selected: [] }
    }
  }

  // 只读地取出当前勾选，不做任何清理（清理版是 loadSelection）。
  async readSelectedIds() {
    const configPath = this.selectionConfigPath()
    if (!configPath) return []
    try {
      const data = JSON.parse(await this.fsReadText(configPath))
      const selected = data && data.selected
      return Array.isArray(selected) ? selected.map(String) : []
    } catch (e) {
      return []
    }
  }

  async saveSelection(sessionIds) {
    const ids = sessionIds || []
    const configPath = this.selectionConfigPath()
    if (!configPath) return { ok: false, error: '无法确定配置文件路径' }
    try {
      await this.fsWriteText(configPath, JSON.stringify({ selected: ids, updatedAt: Date.now() }))
      return { ok: true, path: configPath }
    } catch (e) {
      return { ok: false, error: this.errText(e) }
    }
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
      let fingerprint = null
      let size = null
      try {
        const info = await this.fileVersion(item.src)
        fingerprint = info.version
        size = info.size
      } catch (e) {}
      entries.push({
        id: item.id,
        cwd: item.cwd,
        projectDir: item.proj,
        sessionSegment: item.seg,
        fileName: item.fileName,
        relativePath: 'sessions/' + item.proj + '/' + item.seg + '/' + item.fileName,
        hash: hash,
        fingerprint: fingerprint,
        size: size,
        archived: archived.has(String(item.id)),
        createdAt: item.header.createdAt,
        parentSession: item.header.parentSession || null,
        agentPreset: item.header.agentPreset || null,
        origin: item.header.origin || null
      })
    }
    const index = {
      format: 'dsh-sessions-export',
      version: 2,
      exportedAt: Date.now(),
      sessions: entries
    }
    try {
      await this.fsWriteText(this.dshHomePath('session-migrate', 'exports', 'index.json'), JSON.stringify(index, null, 2))
    } catch (e) {}
    const byWorkspace = {}
    for (const entry of entries) {
      const key = entry.cwd || '__orphan__'
      if (!byWorkspace[key]) byWorkspace[key] = { sessionIds: [], fingerprints: {}, sizes: {} }
      byWorkspace[key].sessionIds.push(entry.id)
      if (entry.fingerprint != null) byWorkspace[key].fingerprints[entry.id] = entry.fingerprint
      if (entry.size != null) byWorkspace[key].sizes[entry.id] = entry.size
    }
    const snapshot = { exportedAt: Date.now(), exportDir: 'exports', byWorkspace: byWorkspace }
    const sp = this.snapshotPath()
    if (sp) {
      try { await this.fsWriteText(sp, JSON.stringify(snapshot, null, 2)) } catch (e) {}
    }
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
    for (const s of list) {
      // 防御性：索引条目缺字段、备份文件校验不过、或归属恢复失败，都只跳过这一条，
      // 继续处理其余条目——单条问题不中断整次导入，也不写进任何配置文件。
      try {
        if (!s.id || !s.projectDir || !s.sessionSegment || !s.fileName) continue
        const src = join(exportBase, ...String(s.relativePath || '').split('/'))
        const dst = this.dshHomePath('sessions', s.projectDir, s.sessionSegment, s.fileName)
        if (s.hash) {
          const srcHash = await this.hashFile(src)
          if (srcHash.toLowerCase() !== String(s.hash).toLowerCase()) continue
        }
        // 恢复语义：目标已存在也必须用备份替换，否则"恢复"退化成只能补缺失的会话，
        // 用户回滚不了任何改动。替换后清掉派生的投影缓存，让宿主按新内容重建。
        const exists = await this.fsExists(dst)
        await this.copyFileEnsured(src, dst)
        if (exists) {
          overwritten.push(s.id)
          try { await this.removePath(this.dshHomePath('storages', 'session_projcache', 'sessions', s.id + '.json')) } catch (e) {}
        } else {
          imported.push(s.id)
        }
        // 恢复工作区归属。目标机器上很可能还没有这个工作区目录——这恰恰是要从备份
        // 恢复的情形，而 registry.create / attachSession 都要求路径是已存在的真实目录。
        // 所以先补建目录再注册；两步都失败才记入 detached（如实报告，不假装成功）。
        if (s.cwd && this.workspaceRegistry !== undefined) {
          try {
            const ws = await this.workspaceRegistry.create(s.cwd)
            await ws.attachSession(s.id)
          } catch (e) {
            try {
              await mkdir(s.cwd, { recursive: true })
              const ws = await this.workspaceRegistry.create(s.cwd)
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
    const restored = new Set()
    for (const id of imported) restored.add(String(id))
    for (const id of overwritten) restored.add(String(id))
    const byWorkspace = {}
    for (const s of list) {
      if (!restored.has(String(s.id))) continue
      const key = s.cwd || '__orphan__'
      if (!byWorkspace[key]) byWorkspace[key] = { sessionIds: [], fingerprints: {}, sizes: {} }
      byWorkspace[key].sessionIds.push(s.id)
      const st = await this.sessionStat(s.cwd, s.id)
      if (st) {
        byWorkspace[key].fingerprints[s.id] = st.version
        byWorkspace[key].sizes[s.id] = st.size
      }
    }
    const snapshot = { exportedAt: Date.now(), exportDir: 'exports', byWorkspace: byWorkspace }
    const sp = this.snapshotPath()
    if (sp) {
      try { await this.fsWriteText(sp, JSON.stringify(snapshot, null, 2)) } catch (e) {}
    }
    // 把刚恢复的会话并入当前勾选：它们是这次操作的对象，默认勾上比让用户回去
    // 逐个勾更合理（备份本来也是从一份勾选列表导出来的）。
    const merged = Array.from(new Set([
      ...await this.readSelectedIds(),
      ...imported.map(String),
      ...overwritten.map(String),
      ...detached.map(String)
    ]))
    if (merged.length > 0) await this.saveSelection(merged)
    return {
      imported: imported.length,
      overwritten: overwritten.length,
      detached: detached.length,
      importedIds: imported,
      overwrittenIds: overwritten,
      detachedIds: detached
    }
  }
}

export async function apply(ctx) {
  const service = new SessionMigrateService(ctx)
  await markLegacyRemote(service)
}
