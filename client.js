window.__ModuleLoader__.load({
  id: 'session-migrate',
  factory: (require) => {
    const React = require('react')

    if (typeof document !== 'undefined') {
      const style = document.createElement('style')
      style.textContent = [
        '.sm-wrap { display:flex; flex-direction:column; gap:14px; }',
        '.sm-card { border:1px solid rgba(128,128,128,.35); border-radius:10px; padding:14px; display:flex; flex-direction:column; gap:10px; }',
        '.sm-title { font-size:14px; font-weight:600; margin:0; }',
        '.sm-section-title { font-size:13px; font-weight:600; margin:4px 0 0; }',
        '.sm-hint { font-size:12px; opacity:.65; }',
        '.sm-row { display:flex; align-items:center; gap:8px; }',
        '.sm-ws { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; font-weight:600; }',
        '.sm-ws-row { display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none; }',
        '.sm-divider { border:none; border-top:1px solid rgba(128,128,128,.22); margin:5px 0; }',
        '.sm-ws-caret { width:12px; font-size:11px; opacity:.6; flex-shrink:0; }',
        '.sm-sessions-indent { padding-left:20px; }',
        '.sm-item { display:flex; align-items:center; gap:8px; padding:4px 0; font-size:13px; }',
        '.sm-item-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; }',
        '.sm-item-meta { display:flex; align-items:center; gap:6px; flex-shrink:0; }',
        '.sm-archived-toggle { display:flex; align-items:center; gap:8px; padding:4px 0; font-size:13px; cursor:pointer; opacity:.7; user-select:none; }',
        '.sm-btn { padding:6px 12px; border-radius:6px; border:1px solid rgba(128,128,128,.4); background:transparent; cursor:pointer; font-size:13px; color:inherit; }',
        '.sm-btn:disabled { opacity:.6; cursor:default; }',
        '.sm-btn.primary { background:#3b82f6; border-color:#3b82f6; color:#fff; }',
        '.sm-btn-mini { padding:2px 8px; font-size:12px; }',
        '.sm-btn-danger { color:#dc2626; border-color:rgba(220,38,38,.5); }',
        '.sm-export-btn { position:relative; overflow:hidden; transition:background .15s; }',
        '.sm-input { flex:1; padding:6px 10px; border-radius:6px; border:1px solid rgba(128,128,128,.4); background:transparent; color:inherit; font-size:13px; }',
        '.sm-err { color:#dc2626; font-size:12px; white-space:pre-wrap; }',
        '.sm-ok { color:#16a34a; font-size:12px; white-space:pre-wrap; word-break:break-all; }',
        '.sm-debug { font-size:11px; opacity:.55; white-space:pre-wrap; }',
        '.sm-status { display:inline-block; min-width:44px; text-align:center; font-size:11px; padding:1px 6px; border-radius:4px; white-space:nowrap; box-sizing:border-box; }',
        '.sm-status.none { opacity:.45; }',
        '.sm-status.unchanged { color:#16a34a; }',
        '.sm-status.changed { color:#d97706; }',
        '.sm-status.new { color:#2563eb; }',
        '.sm-status.archived { color:#6b7280; border:1px solid rgba(128,128,128,.4); }',
        '.sm-delta { font-size:11px; opacity:.7; white-space:nowrap; min-width:52px; text-align:right; }'
      ].join('\n')
      document.head.appendChild(style)
    }

    const passSchema = { parse: (v) => v }

    function param(name) {
      return { name: name, wire: name, source: 'json', codec: { mode: 'strict', schema: passSchema } }
    }

    function contribution() {
      return {
        package: 'session-migrate',
        descriptors: [
          { namespace: 'sessionMigrate', method: 'listGroups', invocation: { kind: 'direct' }, parameters: [], result: { mode: 'strict', schema: passSchema } },
          { namespace: 'sessionMigrate', method: 'listSessions', invocation: { kind: 'direct' }, parameters: [param('cwd')], result: { mode: 'strict', schema: passSchema } },
          { namespace: 'sessionMigrate', method: 'loadSelection', invocation: { kind: 'direct' }, parameters: [], result: { mode: 'strict', schema: passSchema } },
          { namespace: 'sessionMigrate', method: 'saveSelection', invocation: { kind: 'direct' }, parameters: [param('sessionIds')], result: { mode: 'strict', schema: passSchema } },
          { namespace: 'sessionMigrate', method: 'unarchive', invocation: { kind: 'direct' }, parameters: [param('id')], result: { mode: 'strict', schema: passSchema } },
          { namespace: 'sessionMigrate', method: 'deleteWorkspace', invocation: { kind: 'direct' }, parameters: [param('path')], result: { mode: 'strict', schema: passSchema } },
          { namespace: 'sessionMigrate', method: 'export', invocation: { kind: 'direct' }, parameters: [param('sessionIds')], result: { mode: 'strict', schema: passSchema } },
          { namespace: 'sessionMigrate', method: 'import', invocation: { kind: 'direct' }, parameters: [param('path')], result: { mode: 'strict', schema: passSchema } }
        ]
      }
    }

    function apply(ctx) {
      const remote = ctx.remote.sessionMigrate

      async function rpc(method, ...args) {
        const result = await remote[method](...args)
        if (!result.ok) {
          const err = result.error
          throw new Error(err && err.message ? err.message : String(err))
        }
        return result.value
      }

      let saveChain = Promise.resolve()

      function Panel() {
        const [groups, setGroups] = React.useState(null)
        const [debug, setDebug] = React.useState(null)
        const [sessionsByKey, setSessionsByKey] = React.useState({})
        const [loadingKey, setLoadingKey] = React.useState(null)
        const [selected, setSelected] = React.useState({})
        const [expanded, setExpanded] = React.useState({})
        const [archivedOpen, setArchivedOpen] = React.useState({})
        const [loadingGroups, setLoadingGroups] = React.useState(false)
        const [exportResult, setExportResult] = React.useState(null)
        const [exporting, setExporting] = React.useState(false)
        const [confirmDelete, setConfirmDelete] = React.useState(null)
        const [importPath, setImportPath] = React.useState('')
        const [importResult, setImportResult] = React.useState(null)
        const [error, setError] = React.useState(null)

        function errText(e) {
          if (e && e.message) return e.message
          return String(e)
        }

        function formatSize(bytes) {
          if (bytes == null) return ''
          if (bytes < 1024) return bytes + ' B'
          if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
          return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
        }

        function persist(next) {
          const ids = Object.keys(next).filter(function (id) { return next[id] })
          saveChain = saveChain.then(function () {
            return rpc('saveSelection', ids)
          }).catch(function () {})
        }

        function setSelectedPersist(next) {
          setSelected(next)
          persist(next)
        }

        async function loadGroups() {
          setLoadingGroups(true)
          setError(null)
          try {
            const data = await rpc('listGroups')
            setGroups((data && data.groups) || [])
            setDebug((data && data.debug) || null)
            setSessionsByKey({})
          } catch (e) {
            setError(errText(e))
          } finally {
            setLoadingGroups(false)
          }
        }

        async function loadSelection() {
          try {
            const data = await rpc('loadSelection')
            const sel = {}
            for (const id of ((data && data.selected) || [])) sel[id] = true
            setSelected(sel)
          } catch (e) {}
        }

        React.useEffect(function () {
          loadGroups()
          loadSelection()
        }, [])

        function toggleGroup(key) {
          setExpanded(function (prev) {
            const n = {}
            for (const k in prev) n[k] = prev[k]
            n[key] = !n[key]
            return n
          })
        }

        function toggleArchived(key) {
          setArchivedOpen(function (prev) {
            const n = {}
            for (const k in prev) n[k] = prev[k]
            n[key] = !n[key]
            return n
          })
        }

        async function ensureSessions(group) {
          if (sessionsByKey[group.key] !== undefined) return sessionsByKey[group.key]
          setLoadingKey(group.key)
          try {
            const data = await rpc('listSessions', group.path)
            const list = (data && data.sessions) || []
            setSessionsByKey(function (prev) {
              const n = {}
              for (const k in prev) n[k] = prev[k]
              n[group.key] = list
              return n
            })
            return list
          } catch (e) {
            setError(errText(e))
            return []
          } finally {
            setLoadingKey(null)
          }
        }

        function onToggleGroup(group) {
          const willOpen = !expanded[group.key]
          toggleGroup(group.key)
          if (willOpen) ensureSessions(group)
        }

        function toggle(id) {
          const n = {}
          for (const k in selected) n[k] = selected[k]
          n[id] = !n[id]
          setSelectedPersist(n)
        }

        function clearSelection() {
          setSelectedPersist({})
        }

        function countSelected() {
          let n = 0
          for (const k in selected) if (selected[k]) n++
          return n
        }

        function countSelectedWorkspaces() {
          if (!groups) return 0
          let n = 0
          for (const group of groups) {
            const ids = group.sessionIds || []
            if (ids.some(function (id) { return selected[id] })) n++
          }
          return n
        }

        async function doUnarchive(id, groupKey) {
          setError(null)
          try {
            const r = await rpc('unarchive', id)
            if (r && r.error) { setError(r.error); return }
            const cwd = groupKey === '__orphan__' ? null : groupKey
            const data = await rpc('listSessions', cwd)
            setSessionsByKey(function (prev) {
              const n = {}
              for (const k in prev) n[k] = prev[k]
              n[groupKey] = (data && data.sessions) || []
              return n
            })
            await loadGroups()
          } catch (e) {
            setError(errText(e))
          }
        }

        async function doDeleteWorkspace(group) {
          setError(null)
          try {
            const r = await rpc('deleteWorkspace', group.path)
            if (r && r.error) { setError(r.error); return }
            await loadGroups()
            await loadSelection()
          } catch (e) {
            setError(errText(e))
          }
        }

        async function doExport() {
          setError(null)
          setExportResult(null)
          const ids = Object.keys(selected).filter(function (id) { return selected[id] })
          if (ids.length === 0) {
            setError('未选择任何会话')
            return
          }
          setExporting(true)
          try {
            const r = await rpc('export', ids)
            setExportResult(r)
            await loadGroups()
          } catch (e) {
            setError(errText(e))
          } finally {
            setExporting(false)
          }
        }

        async function doImport() {
          setError(null)
          setImportResult(null)
          const p = importPath.trim()
          try {
            const r = await rpc('import', p)
            setImportResult(r)
            await loadGroups()
          } catch (e) {
            setError(errText(e))
          }
        }

        const h = React.createElement

        function groupStatusView(group) {
          if (!group.hasExport) return h('span', { className: 'sm-status none' }, '未导出')
          if (group.status === 'unchanged') return h('span', { className: 'sm-status unchanged' }, '已导出')
          return h('span', { className: 'sm-status changed' }, '有变化')
        }

        function sessionStatusView(s) {
          if (s.status === 'changed') return h('span', { className: 'sm-status changed' }, '有变化')
          if (s.status === 'new') return h('span', { className: 'sm-status new' }, '新增')
          if (s.status === 'unchanged') return h('span', { className: 'sm-status unchanged' }, '无变化')
          return h('span', { className: 'sm-status none' }, '未导出')
        }

        function sizeDeltaView(s) {
          if (s.status === 'new' && s.size != null) {
            return h('span', { className: 'sm-delta' }, formatSize(s.size))
          }
          if (s.status === 'changed' && s.sizeDelta != null) {
            if (s.sizeDelta === 0) return h('span', { className: 'sm-delta' }, '±0')
            const sign = s.sizeDelta > 0 ? '+' : '-'
            return h('span', { className: 'sm-delta' }, sign + formatSize(Math.abs(s.sizeDelta)))
          }
          return h('span', { className: 'sm-delta' }, '')
        }

        function sessionItem(s, groupKey) {
          return h('div', { key: s.id, className: 'sm-item' }, [
            h('input', { type: 'checkbox', checked: !!selected[s.id], onChange: function () { toggle(s.id) } }),
            h('span', { className: 'sm-item-title', title: s.title, onClick: function () { toggle(s.id) } }, s.title),
            h('div', { className: 'sm-item-meta' }, [
              sessionStatusView(s),
              sizeDeltaView(s),
              s.archived ? h('button', {
                className: 'sm-btn sm-btn-mini',
                onClick: function () { doUnarchive(s.id, groupKey) }
              }, '不归档') : null
            ])
          ])
        }

        function renderSessions(group) {
          const items = sessionsByKey[group.key]
          if (!items) return null
          const active = []
          const archived = []
          for (const s of items) {
            if (s.archived) archived.push(s)
            else active.push(s)
          }
          const rows = active.map(function (s) { return sessionItem(s, group.key) })
          if (archived.length > 0) {
            const isOpen = !!archivedOpen[group.key]
            rows.push(h('div', { key: '__archived__', className: 'sm-archived-toggle', onClick: function () { toggleArchived(group.key) } }, [
              h('span', { className: 'sm-ws-caret' }, isOpen ? '▾' : '▸'),
              h('span', null, '已归档 ' + archived.length + ' 个')
            ]))
            if (isOpen) {
              for (const s of archived) rows.push(sessionItem(s, group.key))
            }
          }
          return h('div', { className: 'sm-sessions-indent' }, rows)
        }

        function renderGroups() {
          if (!groups) {
            return loadingGroups ? h('div', { className: 'sm-hint' }, '加载中…') : null
          }
          if (groups.length === 0) {
            return h('div', { className: 'sm-hint' }, '没有找到任何工作区或会话')
          }
          return groups.map(function (group, index) {
            const key = group.key
            const isOpen = !!expanded[key]
            const items = sessionsByKey[key]
            const isLoading = loadingKey === key
            const title = group.title || group.path || '未关联工作区'
            const archivedCount = group.archivedCount || 0
            const activeCount = group.sessionCount - archivedCount
            const countLabel = archivedCount > 0 ? (activeCount + ' | ' + archivedCount) : String(activeCount)
            return h('div', { key: String(key) }, [
              index > 0 ? h('hr', { className: 'sm-divider' }) : null,
              h('div', { className: 'sm-ws-row', onClick: function () { onToggleGroup(group) } }, [
                h('span', { className: 'sm-ws-caret' }, isOpen ? '▾' : '▸'),
                h('span', { className: 'sm-ws' }, title),
                h('span', { className: 'sm-hint' }, countLabel),
                groupStatusView(group),
                group.path ? h('button', {
                  className: 'sm-btn sm-btn-mini sm-btn-danger',
                  onClick: function (e) {
                    e.stopPropagation()
                    if (confirmDelete === key) {
                      setConfirmDelete(null)
                      doDeleteWorkspace(group)
                    } else {
                      setConfirmDelete(key)
                    }
                  }
                }, confirmDelete === key ? '确认删除?' : '删除') : null
              ]),
              isOpen ? (
                isLoading ? h('div', { className: 'sm-hint' }, '加载中…') :
                renderSessions(group)
              ) : null
            ])
          })
        }

        const exportBtnStyle = exporting ? {
          background: 'rgba(128,128,128,.25)',
          borderColor: 'transparent',
          color: '#fff'
        } : null

        return h('div', { className: 'sm-wrap' }, [
          h('div', { className: 'sm-title' }, '会话迁移'),
          h('p', { className: 'sm-hint', style: { margin: 0 } }, '将工作区中的会话内容与状态导出为备份目录，或从备份目录恢复。'),
          debug ? h('div', { className: 'sm-debug' }, debug) : null,
          h('div', { className: 'sm-card' }, [
            h('div', { className: 'sm-row' }, [
              h('button', { className: 'sm-btn', onClick: loadGroups, disabled: loadingGroups }, loadingGroups ? '加载中…' : '刷新列表'),
              h('button', { className: 'sm-btn', onClick: clearSelection, disabled: countSelected() === 0 }, '清空已选'),
              h('span', { className: 'sm-hint' }, '已选 ' + countSelected() + ' 个会话')
            ]),
            h('div', { className: 'sm-section-title' }, '工作区状态'),
            renderGroups(),
            h('button', {
              className: 'sm-btn primary sm-export-btn',
              onClick: doExport,
              disabled: exporting || countSelected() === 0,
              style: exportBtnStyle
            }, exporting ? '导出中…' : ('导出 ' + countSelectedWorkspaces() + ' 个工作区')),
            exportResult ? h('div', null, [
              h('div', { className: 'sm-ok' }, '已导出 ' + exportResult.sessionCount + ' 个会话 → ' + exportResult.path),
              exportResult.indexWriteError ? h('div', { className: 'sm-err' }, '写索引失败: ' + exportResult.indexWriteError) : null,
              exportResult.errors && exportResult.errors.length ? h('div', { className: 'sm-err' }, JSON.stringify(exportResult.errors, null, 2)) : null
            ]) : null
          ]),
          h('div', { className: 'sm-card' }, [
            h('div', { className: 'sm-title' }, '从备份目录导入'),
            h('div', { className: 'sm-row' }, [
              h('input', { className: 'sm-input', placeholder: '留空则导入默认导出目录', value: importPath, onChange: function (e) { setImportPath(e.target.value) } }),
              h('button', { className: 'sm-btn primary', onClick: doImport }, '导入')
            ]),
            importResult ? h('div', { className: 'sm-ok' }, '导入 ' + importResult.imported + ' 个，跳过 ' + importResult.skipped + ' 个' + (importResult.errors && importResult.errors.length ? ('，' + importResult.errors.length + ' 个错误') : '')) : null,
            importResult && importResult.errors && importResult.errors.length ? h('div', { className: 'sm-err' }, JSON.stringify(importResult.errors, null, 2)) : null
          ]),
          error ? h('div', { className: 'sm-err' }, error) : null
        ])
      }

      ctx.effect(() => ctx.remote.$mount(contribution()))
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: 'session-migrate', order: 50, label: '会话迁移' },
          function () { return React.createElement(Panel) }
        )
      })
    }

    return { apply, inject: ['slots', 'remote'] }
  }
})
