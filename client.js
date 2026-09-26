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
        '.sm-unlinked { border:1px solid rgba(128,128,128,.25); border-radius:8px; padding:8px; margin-top:8px; display:flex; flex-direction:column; gap:6px; }',
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

    // typert 的 strict codec 必须携带非空 typeSymbol：注册表的 validateCodec 会读
    // 它的 length，缺失时就是那句 "Cannot read properties of undefined (reading
    // 'length')"。schema 用 parse 直通即可（严格校验由服务端承担），并同时带上
    // create() 以满足两代 harness 契约——旧版读 schema.parse()，新版读
    // create().parse()，两侧都只做 typeof 检查，因此一个对象即可覆盖。
    function codecOf(typeSymbol) {
      return {
        mode: 'strict',
        typeSymbol: typeSymbol,
        schema: passSchema,
        create: function () { return passSchema }
      }
    }

    function param(name) {
      return { name: name, wire: name, source: 'json', codec: codecOf('session-migrate#param/' + name) }
    }

    // 描述符的 id / service / namespace / method 都是注册表校验的必填段，缺任何一项
    // 都会在 validateNonempty / validateSegment 里读 undefined.length 抛错。
    function descriptor(method, parameters) {
      return {
        id: 'session-migrate#sessionMigrate/' + method,
        service: 'sessionMigrate',
        namespace: 'sessionMigrate',
        method: method,
        invocation: { kind: 'direct' },
        parameters: parameters,
        result: codecOf('session-migrate#sessionMigrate/' + method)
      }
    }

    function contribution() {
      return {
        package: 'session-migrate',
        descriptors: [
          descriptor('listGroups', []),
          descriptor('listSessions', [param('cwd')]),
          descriptor('loadSelection', []),
          descriptor('saveSelection', [param('sessionIds')]),
          descriptor('unarchive', [param('id')]),
          descriptor('deleteWorkspace', [param('path')]),
          descriptor('export', [param('sessionIds')]),
          descriptor('import', [param('path')]),
          descriptor('listUnlinkedGroups', []),
          descriptor('checkRelocation', [param('sourceCwd'), param('targetCwd')]),
          descriptor('applyRelocation', [param('sourceCwd'), param('targetCwd')]),
          descriptor('reconcileMembership', [])
        ]
      }
    }

    function apply(ctx) {
      // 远程命名空间服务由 $mount 异步安装，客户端不做惰性代理查找：挂载完成前
      // ctx.remote.sessionMigrate 恒为 undefined。因此这里先保存挂载句柄，每次
      // 调用时再解析命名空间，而不是在 apply 同步阶段取快照。
      const mount = ctx.remote.$mount(contribution())

      async function rpc(method, ...args) {
        await mount
        const remote = ctx.get('remote.sessionMigrate')
        if (remote === undefined) throw new Error('会话迁移服务尚未就绪，请稍后重试')
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
        // ── 未关联工作区 / 重定位 ──────────────────────────────────────────────
        const [unlinked, setUnlinked] = React.useState(null)
        const [unlinkedOpen, setUnlinkedOpen] = React.useState({})
        const [mappingDrafts, setMappingDrafts] = React.useState({})
        const [checks, setChecks] = React.useState({})
        const [relocationBusy, setRelocationBusy] = React.useState(null)
        const [relocationSummary, setRelocationSummary] = React.useState(null)

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
            // 刻意不清空 sessionsByKey：刷新分组信息（计数、状态）不该把用户展开着的
            // 会话列表一并清掉——那看起来就像"点了按钮之后列表自己折叠了"。
            // 会话明细由 ensureSessions 按需拉取，折叠时丢弃、下次展开重新拉。
          } catch (e) {
            setError(errText(e))
          } finally {
            setLoadingGroups(false)
          }
        }

        // 未关联工作区：cwd 在本机不存在（或未注册）的会话。它们不属于任何工作区，
        // 在 DSH 侧栏里是隐身的——必须单独列出来，配映射做重定位。
        async function loadUnlinked() {
          try {
            const data = await rpc('listUnlinkedGroups')
            const list = (data && data.groups) || []
            setUnlinked(list)
            // 已存过映射的预填进输入框；用户已经改过的草稿不覆盖。
            setMappingDrafts(function (prev) {
              const next = {}
              for (const group of list) {
                next[group.cwd] = prev[group.cwd] !== undefined ? prev[group.cwd] : (group.mappedTo || '')
              }
              return next
            })
          } catch (e) {
            setUnlinked([])
          }
        }

        async function doCheckRelocation(cwd) {
          const target = String(mappingDrafts[cwd] || '').trim()
          setError(null)
          setRelocationBusy(cwd)
          try {
            const result = await rpc('checkRelocation', cwd, target)
            setChecks(function (prev) {
              const next = {}
              for (const key in prev) next[key] = prev[key]
              next[cwd] = result
              return next
            })
          } catch (e) {
            setError(errText(e))
          } finally {
            setRelocationBusy(null)
          }
        }

        async function doApplyRelocation(cwd) {
          const target = String(mappingDrafts[cwd] || '').trim()
          setError(null)
          setRelocationBusy(cwd)
          setRelocationSummary(null)
          try {
            const result = await rpc('applyRelocation', cwd, target)
            if (result && result.ok === false) {
              // 检测不通过：把问题摊在输入框下面，而不是丢一个笼统错误。
              setChecks(function (prev) {
                const next = {}
                for (const key in prev) next[key] = prev[key]
                next[cwd] = result
                return next
              })
              return
            }
            // 成功后这一组会从未关联里消失，所以结果要放在区域顶部才看得到。
            setRelocationSummary(result)
            setChecks(function (prev) {
              const next = {}
              for (const key in prev) next[key] = prev[key]
              delete next[cwd]
              return next
            })
            await loadUnlinked()
            await loadGroups()
          } catch (e) {
            setError(errText(e))
          } finally {
            setRelocationBusy(null)
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
          loadUnlinked()
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

        function toggleUnlinked(cwd) {
          setUnlinkedOpen(function (prev) {
            const n = {}
            for (const k in prev) n[k] = prev[k]
            n[cwd] = !n[cwd]
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
          if (willOpen) {
            ensureSessions(group)
            return
          }
          // 折叠时丢掉该组的明细缓存：下次展开会重新拉，数据总是新鲜的。
          setSessionsByKey(function (prev) {
            const next = {}
            for (const key in prev) if (key !== group.key) next[key] = prev[key]
            return next
          })
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
            // 顺序要紧：先刷新分组（它会保留明细缓存），再回填这一组的明细。
            // 反过来做的话，loadGroups 会把刚拉回来的明细一起清掉，列表当场"自己折叠"。
            await loadGroups()
            const data = await rpc('listSessions', cwd)
            setSessionsByKey(function (prev) {
              const n = {}
              for (const k in prev) n[k] = prev[k]
              n[groupKey] = (data && data.sessions) || []
              return n
            })
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
            // 导入会把恢复出来的会话并入勾选列表，这里必须同步刷新，否则界面
            // 仍然显示成未勾选，看起来像"恢复了却没被选上"。
            await loadSelection()
            // 导入也可能带出新的未关联工作区（cwd 在本机不存在的那批）。
            await loadUnlinked()
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
            const title = group.title || group.path || '无工作区会话'
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

        // 未关联工作区：一组一张卡片，带目标路径输入框和"检测 / 应用"两个动作。
        function renderUnlinked() {
          if (unlinked === null) return h('div', { className: 'sm-hint' }, '加载中…')
          if (unlinked.length === 0) return h('div', { className: 'sm-hint' }, '没有未关联的工作区')
          return unlinked.map(function (group) {
            const cwd = group.cwd
            const isOpen = !!unlinkedOpen[cwd]
            const draft = mappingDrafts[cwd] !== undefined ? mappingDrafts[cwd] : (group.mappedTo || '')
            const check = checks[cwd]
            const busy = relocationBusy === cwd
            const blocked = busy || String(draft).trim() === ''
            const sessions = group.sessions || []
            return h('div', { key: cwd, className: 'sm-unlinked' }, [
              h('div', { className: 'sm-ws-row', onClick: function () { toggleUnlinked(cwd) } }, [
                h('span', { className: 'sm-ws-caret' }, isOpen ? '▾' : '▸'),
                h('span', { className: 'sm-ws', title: cwd }, cwd),
                h('span', { className: 'sm-hint' }, String(group.sessionCount) + ' 个会话'),
                h('span', { className: 'sm-status none' }, group.targetExists ? '目标已存在' : '待重定位')
              ]),
              isOpen ? h('div', { className: 'sm-sessions-indent' }, sessions.map(function (s) {
                return h('div', { key: s.id, className: 'sm-item' }, [
                  h('span', { className: 'sm-item-title', title: s.id }, s.id),
                  h('div', { className: 'sm-item-meta' }, [
                    h('span', { className: 'sm-delta' }, formatSize(s.size))
                  ])
                ])
              })) : null,
              h('div', { className: 'sm-row' }, [
                h('input', {
                  className: 'sm-input',
                  placeholder: '目标路径，例如 D:\\Projects\\my-project',
                  value: draft,
                  onChange: function (e) {
                    const value = e.target.value
                    setMappingDrafts(function (prev) {
                      const n = {}
                      for (const k in prev) n[k] = prev[k]
                      n[cwd] = value
                      return n
                    })
                  }
                }),
                h('button', {
                  className: 'sm-btn sm-btn-mini',
                  disabled: blocked,
                  onClick: function () { doCheckRelocation(cwd) }
                }, busy ? '处理中…' : '检测重定位是否有效'),
                h('button', {
                  className: 'sm-btn sm-btn-mini primary',
                  disabled: blocked || (check !== undefined && check.ok === false),
                  onClick: function () { doApplyRelocation(cwd) }
                }, '应用重定位')
              ]),
              check === undefined ? null : (check.ok
                ? h('div', { className: 'sm-ok' }, '检测通过：可重定位 ' + (check.info ? check.info.sessionCount : 0) + ' 个会话'
                    + (check.info && check.info.willCreate ? '（将创建目标目录）' : ''))
                : h('div', { className: 'sm-err' }, check.problems.map(function (problem) { return '· ' + problem.message }).join('\n')))
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
            exportResult ? h('div', { className: 'sm-ok' }, '已导出 ' + exportResult.sessionCount + ' 个会话 → ' + exportResult.path) : null
          ]),
          h('div', { className: 'sm-card' }, [
            h('div', { className: 'sm-title' }, '未关联工作区'),
            h('p', { className: 'sm-hint', style: { margin: 0 } }, '这些会话的原始工作区目录在本机不存在，所以它们不属于任何工作区、在侧栏里看不到。填一个目标路径就能把它们迁过来；映射会被记住，下次导入自动套用。'),
            relocationSummary ? h('div', { className: 'sm-ok' }, '重定位完成：迁移 ' + relocationSummary.moved + ' 个会话 → ' + relocationSummary.targetCwd + (relocationSummary.pendingRestart ? '\n重启 DSH 之后这些工作区才会出现在侧栏。' : '')) : null,
            relocationSummary && relocationSummary.failed && relocationSummary.failed.length
              ? h('div', { className: 'sm-err' }, relocationSummary.failed.map(function (item) { return '· ' + item.id + '：' + item.error }).join('\n'))
              : null,
            renderUnlinked()
          ]),
          h('div', { className: 'sm-card' }, [
            h('div', { className: 'sm-title' }, '从备份目录导入'),
            h('p', { className: 'sm-hint', style: { margin: 0 } }, '备份会覆盖相同会话的现有数据（即回滚到导出时的状态）。'),
            h('div', { className: 'sm-row' }, [
              h('input', { className: 'sm-input', placeholder: '留空则导入默认导出目录', value: importPath, onChange: function (e) { setImportPath(e.target.value) } }),
              h('button', { className: 'sm-btn primary', onClick: doImport }, '导入')
            ]),
            importResult ? h('div', { className: 'sm-ok' }, '导入完成：新增 ' + importResult.imported + ' 个，覆盖 ' + importResult.overwritten + ' 个') : null,
            importResult && importResult.detached > 0 ? h('div', { className: 'sm-hint' }, '其中 ' + importResult.detached + ' 个已写回磁盘，但未挂到工作区（原工作区目录在当前机器上不可用）；若该目录可用，重启 DSH 后会自动归位。') : null,
            // 跳过的条目一定要说出来：跨机器同步备份时最常见的失手就是只同步了
            // index.json 而漏掉 sessions/，那时整体都会跳过，不说就变成"导入成功但没数据"。
            importResult && importResult.skipped > 0
              ? h('div', { className: 'sm-err' }, '有 ' + importResult.skipped + ' 个会话被跳过（未写入）：\n'
                  + (importResult.skippedItems || []).map(function (item) {
                    return '· ' + (item.id || '(条目无 id)') + '：' + item.reason
                  }).join('\n'))
              : null
          ]),
          error ? h('div', { className: 'sm-err' }, error) : null
        ])
      }

      ctx.effect(() => {
        let cancelled = false
        let dispose
        mount.then(function (d) {
          if (cancelled) d()
          else dispose = d
        }, function () {})
        return function () {
          cancelled = true
          if (dispose !== undefined) dispose()
        }
      }, 'session-migrate: remote contribution')
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
