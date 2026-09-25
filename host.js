import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export const name = 'session-migrate'

export const inject = ['sessionQuery', 'fs', 'shell', 'workspaceRegistry', 'sandboxPolicy']

const REMOTE_METHODS = ['listGroups', 'listSessions', 'loadSelection', 'saveSelection', 'unarchive', 'deleteWorkspace', 'export', 'import']

class SessionMigrateService extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, 'sessionMigrate', { namespace: 'sessionMigrate' })
    this.ctx = ctx
    this.sessionQuery = ctx.get('sessionQuery')
    this.fs = ctx.get('fs')
    this.shell = ctx.get('shell')
    this.workspaceRegistry = ctx.get('workspaceRegistry')
    this.sandboxPolicy = ctx.get('sandboxPolicy')
    this.dshHomePath = ctx.get('dshHomePath')
    this.sessionPersistence = ctx.get('sessionPersistence')
    const instance = this
    for (const method of REMOTE_METHODS) {
      Remote(method)(null, {
        name: method,
        private: false,
        static: false,
        addInitializer: (initializer) => initializer.call(instance)
      })
    }
  }

  errText(e) {
    if (e && e.message) return e.message
    return String(e)
  }

  fullAccessPolicy() {
    if (this.sandboxPolicy === undefined) return undefined
    return this.sandboxPolicy.resolve({ mode: 'danger-full-access' })
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

  psQuote(s) {
    return "'" + String(s).replace(/'/g, "''") + "'"
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

  async allSessionIds() {
    const ids = new Set()
    try {
      const records = await this.sessionQuery.listSessions()
      for (const r of records) ids.add(String(r.header.id))
    } catch (e) {}
    return ids
  }

  async flushAll() {
    if (this.sessionPersistence !== undefined) {
      try { await this.sessionPersistence.flush() } catch (e) {}
    }
  }

  async shellRun(cmd) {
    if (this.shell === undefined) throw new Error('shell 服务不可用')
    const spec = this.shell.resolve({ command: cmd, sandboxPolicy: this.fullAccessPolicy() })
    const r = await this.shell.run(spec)
    if (r.exitCode !== 0) {
      throw new Error((r.stderr && r.stderr.text ? r.stderr.text.trim() : '') || ('exit ' + r.exitCode))
    }
    return (r.stdout && r.stdout.text) || ''
  }

  async shellClearDir(path) {
    const cmd = 'if (Test-Path -LiteralPath ' + this.psQuote(path) + ') { Get-ChildItem -LiteralPath ' + this.psQuote(path) + ' -Force | Where-Object { $_.Name -notlike ' + this.psQuote('.*') + ' } | Remove-Item -Recurse -Force }'
    await this.shellRun(cmd)
  }

  async shellRemovePath(path) {
    const cmd = 'if (Test-Path -LiteralPath ' + this.psQuote(path) + ') { Remove-Item -Recurse -Force -LiteralPath ' + this.psQuote(path) + ' }'
    await this.shellRun(cmd)
  }

  async shellBatchCopyHash(items) {
    const lines = []
    for (const item of items) {
      lines.push('New-Item -ItemType Directory -Force -Path (Split-Path -Parent ' + this.psQuote(item.dst) + ') | Out-Null')
      lines.push('Copy-Item -LiteralPath ' + this.psQuote(item.src) + ' -Destination ' + this.psQuote(item.dst) + ' -Force')
    }
    lines.push('$results = @{}')
    for (const item of items) {
      lines.push('$results[' + this.psQuote(item.id) + '] = (Get-FileHash -LiteralPath ' + this.psQuote(item.src) + ' -Algorithm SHA256).Hash')
    }
    lines.push('$results | ConvertTo-Json -Compress')
    const cmd = lines.join('; ')
    const out = await this.shellRun(cmd)
    try {
      const parsed = JSON.parse(out)
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {}
    } catch (e) {
      return {}
    }
  }

  async shellHash(path) {
    const out = await this.shellRun('(Get-FileHash -LiteralPath ' + this.psQuote(path) + ' -Algorithm SHA256).Hash')
    return out.trim()
  }

  async shellCopy(src, dst) {
    const cmd = 'New-Item -ItemType Directory -Force -Path (Split-Path -Parent ' + this.psQuote(dst) + ') | Out-Null; Copy-Item -LiteralPath ' + this.psQuote(src) + ' -Destination ' + this.psQuote(dst) + ' -Force'
    await this.shellRun(cmd)
  }

  async findLogFileName(cwd, id) {
    if (typeof this.dshHomePath !== 'function') return undefined
    const dir = this.dshHomePath('sessions', this.projSeg(cwd), this.encodeSegment(id))
    const target = await this.fs.resolve(dir)
    const entries = await this.fs.listDir(target)
    for (const e of entries) {
      if (e.type === 'file' && /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(e.name)) return e.name
    }
    return undefined
  }

  async sessionStat(cwd, id) {
    try {
      const fileName = await this.findLogFileName(cwd, id)
      if (!fileName) return null
      const path = this.dshHomePath('sessions', this.projSeg(cwd), this.encodeSegment(id), fileName)
      const target = await this.fs.resolve(path)
      const info = await this.fs.stat(target)
      if (!info) return null
      return { version: info.version, size: info.size || 0 }
    } catch (e) {
      return null
    }
  }

  async fsWriteText(path, content) {
    const target = await this.fs.resolve(path)
    await this.fs.writeText(target, content, undefined, undefined, this.fullAccessPolicy())
  }

  async fsReadText(path) {
    const target = await this.fs.resolve(path)
    return await this.fs.readText(target)
  }

  async fsExists(path) {
    try {
      const target = await this.fs.resolve(path)
      return (await this.fs.stat(target)) !== undefined
    } catch (e) {
      return false
    }
  }

  async cleanSnapshot(snapshot) {
    if (!snapshot || !snapshot.byWorkspace) return snapshot
    const validIds = await this.allSessionIds()
    const validPaths = new Set()
    if (this.workspaceRegistry !== undefined) {
      for (const w of this.workspaceRegistry.list()) validPaths.add(this.normKey(w.path))
    }
    validPaths.add(this.normKey('__orphan__'))
    const byWorkspace = {}
    let changed = false
    for (const key in snapshot.byWorkspace) {
      const ws = snapshot.byWorkspace[key]
      if (!ws) { changed = true; continue }
      const nk = this.normKey(key)
      if (nk !== this.normKey('__orphan__') && !validPaths.has(nk)) {
        changed = true
        continue
      }
      const rawIds = ws.sessionIds || []
      const keptIds = rawIds.filter((id) => validIds.has(String(id)))
      if (keptIds.length !== rawIds.length) changed = true
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
    try {
      const text = await this.fsReadText(configPath)
      const data = JSON.parse(text)
      const selected = (data && data.selected) || []
      const validIds = await this.allSessionIds()
      const cleaned = selected.filter((id) => validIds.has(String(id)))
      if (cleaned.length !== selected.length) {
        try { await this.fsWriteText(configPath, JSON.stringify({ selected: cleaned, updatedAt: Date.now() })) } catch (e) {}
      }
      return { selected: cleaned }
    } catch (e) {
      return { selected: [] }
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
    if (this.shell === undefined) return { error: 'shell 服务不可用' }
    if (this.workspaceRegistry === undefined) return { error: 'workspaceRegistry 服务不可用' }
    let targetWs = null
    for (const w of this.workspaceRegistry.list()) {
      if (this.normKey(w.path) === this.normKey(path)) { targetWs = w; break }
    }
    if (!targetWs) return { error: '未找到工作区' }
    const sessionIds = Array.from(targetWs.sessionIds).map(String)
    const proj = this.projSeg(targetWs.path)
    const projectDir = this.dshHomePath('sessions', proj)
    try { await this.shellRemovePath(projectDir) } catch (e) {}
    for (const id of sessionIds) {
      const cachePath = this.dshHomePath('storages', 'session_projcache', 'sessions', id + '.json')
      try { await this.shellRemovePath(cachePath) } catch (e) {}
    }
    try { await this.workspaceRegistry.delete(targetWs.id) } catch (e) {}
    return { ok: true, deletedSessions: sessionIds.length }
  }

  async export(sessionIds) {
    const ids = sessionIds || []
    if (typeof this.dshHomePath !== 'function') return { error: '无法确定 DSH_HOME 路径' }
    if (this.shell === undefined) return { error: 'shell 服务不可用' }
    await this.flushAll()
    const exportBase = this.dshHomePath('session-migrate', 'exports')
    try { await this.shellClearDir(exportBase) } catch (e) {}
    const archived = new Set(this.archivedIds().map(String))
    const headerById = {}
    try {
      const records = await this.sessionQuery.listSessions()
      for (const r of records) headerById[r.header.id] = r
    } catch (e) {}
    const items = []
    const errors = []
    for (const id of ids) {
      const rec = headerById[id]
      if (!rec) { errors.push({ id: id, error: '未找到会话记录' }); continue }
      const header = rec.header
      const cwd = header.cwd
      let fileName
      try {
        fileName = await this.findLogFileName(cwd, id)
      } catch (e) {
        errors.push({ id: id, error: this.errText(e) }); continue
      }
      if (!fileName) { errors.push({ id: id, error: '未找到日志文件' }); continue }
      const seg = this.encodeSegment(id)
      const proj = this.projSeg(cwd)
      const src = this.dshHomePath('sessions', proj, seg, fileName)
      const dst = this.dshHomePath('session-migrate', 'exports', 'sessions', proj, seg, fileName)
      items.push({ id: id, src: src, dst: dst, cwd: cwd || null, proj: proj, seg: seg, fileName: fileName, header: header })
    }
    let hashMap = {}
    if (items.length > 0) {
      try {
        hashMap = await this.shellBatchCopyHash(items)
      } catch (e) {
        errors.push({ error: '批量拷贝/哈希失败: ' + this.errText(e) })
      }
    }
    const entries = []
    for (const item of items) {
      const hash = hashMap[item.id]
      if (!hash) { errors.push({ id: item.id, error: '哈希失败' }); continue }
      let fingerprint = null
      let size = null
      try {
        const srcTarget = await this.fs.resolve(item.src)
        const info = await this.fs.stat(srcTarget)
        fingerprint = info ? info.version : null
        size = info ? (info.size || 0) : null
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
      sessions: entries,
      errors: errors
    }
    let indexWriteError = null
    try {
      await this.fsWriteText(this.dshHomePath('session-migrate', 'exports', 'index.json'), JSON.stringify(index, null, 2))
    } catch (e) {
      indexWriteError = this.errText(e)
    }
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
      sessionCount: entries.length,
      indexWriteError: indexWriteError,
      errors: errors.slice(0, 20)
    }
  }

  async import(path) {
    if (typeof this.dshHomePath !== 'function') return { error: '无法确定 DSH_HOME 路径' }
    if (this.shell === undefined) return { error: 'shell 服务不可用，无法拷贝文件' }
    let p = path || ''
    if (typeof p !== 'string' || p.trim() === '') {
      p = this.dshHomePath('session-migrate', 'exports')
    }
    let base = String(p).replace(/[\\/]+$/, '')
    if (!/index\.json$/.test(base)) base = base + '\\index.json'
    const index = JSON.parse(await this.fsReadText(base))
    const exportBase = base.replace(/index\.json$/, '')
    const list = (index && index.sessions) || []
    const imported = []
    const skipped = []
    const errors = []
    for (const s of list) {
      try {
        if (!s.id || !s.projectDir || !s.sessionSegment || !s.fileName) {
          errors.push({ id: s.id, error: '索引条目字段缺失' })
          continue
        }
        const src = exportBase + s.relativePath.replace(/\//g, '\\')
        const dst = this.dshHomePath('sessions', s.projectDir, s.sessionSegment, s.fileName)
        const exists = await this.fsExists(dst)
        if (!exists) {
          if (s.hash) {
            const srcHash = await this.shellHash(src)
            if (srcHash.toLowerCase() !== String(s.hash).toLowerCase()) {
              errors.push({ id: s.id, error: 'hash 校验不匹配' })
              continue
            }
          }
          await this.shellCopy(src, dst)
        } else {
          skipped.push(s.id)
        }
        if (s.cwd && this.workspaceRegistry !== undefined) {
          try {
            const ws = await this.workspaceRegistry.create(s.cwd)
            await ws.attachSession(s.id)
          } catch (e) {
            errors.push({ id: s.id, error: '恢复工作区归属失败: ' + this.errText(e) })
          }
        }
        if (s.archived && this.workspaceRegistry !== undefined) {
          try {
            await this.workspaceRegistry.archiveSession(s.id)
          } catch (e) {
            errors.push({ id: s.id, error: '归档恢复失败（可能需重启后生效）: ' + this.errText(e) })
          }
        }
        imported.push(s.id)
      } catch (e) {
        errors.push({ id: s.id, error: this.errText(e) })
      }
    }
    const restored = new Set()
    for (const id of imported) restored.add(String(id))
    for (const id of skipped) restored.add(String(id))
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
    return {
      imported: imported.length,
      skipped: skipped.length,
      errors: errors.slice(0, 30),
      importedIds: imported,
      skippedIds: skipped
    }
  }
}

export function apply(ctx) {
  new SessionMigrateService(ctx)
}
