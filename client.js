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
        '.sm-delta { font-size:11px; opacity:.7; white-space:nowrap; min-width:52px; text-align:right; }',
        '.sm-baidu-code { font-size:20px; font-weight:700; letter-spacing:3px; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; user-select:all; }',
        '.sm-baidu-box { border:1px solid rgba(128,128,128,.25); border-radius:8px; padding:10px; display:flex; flex-direction:column; gap:8px; align-items:flex-start; }',
        '.sm-link { color:#3b82f6; font-size:12px; word-break:break-all; }',
        '.sm-qr { width:132px; height:132px; border-radius:6px; background:#fff; padding:4px; box-sizing:border-box; }',
        '.sm-progress { width:100%; height:6px; border-radius:3px; background:rgba(128,128,128,.25); overflow:hidden; }',
        '.sm-progress-fill { height:100%; background:#3b82f6; transition:width .2s; }',
        '.sm-kv { font-size:12px; opacity:.75; word-break:break-all; }',
        '.sm-code { font-size:11px; background:rgba(128,128,128,.12); border-radius:6px; padding:8px; margin:0; overflow:auto; white-space:pre; user-select:all; }'
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
        descriptor('deleteSession', [param('id')]),
          descriptor('export', [param('sessionIds')]),
          descriptor('import', [param('path')]),
          descriptor('listUnlinkedGroups', []),
          descriptor('checkRelocation', [param('sourceCwd'), param('targetCwd')]),
          descriptor('applyRelocation', [param('sourceCwd'), param('targetCwd')]),
          descriptor('reconcileMembership', []),
          descriptor('baiduStatus', []),
          descriptor('baiduLoginStart', []),
          descriptor('baiduLoginCancel', []),
          descriptor('baiduLogout', []),
          descriptor('baiduUpload', []),
          descriptor('baiduDownload', [])
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
        // ── 百度网盘 ──────────────────────────────────────────────────────────
        const [baidu, setBaidu] = React.useState(null)
        const [baiduBusy, setBaiduBusy] = React.useState(null)

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
          loadBaidu()
        }, [])

        // 只有「等授权」和「任务进行中」两种状态才需要持续刷新，其余时候完全不轮询——
        // 面板可能长期开着，无谓的轮询既费电又会把宿主的日志刷满。
        const baiduPhase = baidu ? baidu.phase : null
        const baiduRunning = !!(baidu && baidu.task && baidu.task.running)
        React.useEffect(function () {
          if (baiduPhase !== 'waiting' && !baiduRunning) return undefined
          const timer = setInterval(function () { loadBaidu() }, baiduRunning ? 700 : 1500)
          return function () { clearInterval(timer) }
        }, [baiduPhase, baiduRunning])

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

        // 重新拉某一组的会话明细。删除之后必须重拉：否则 renderSessions 拿到的是
        // 被清掉的缓存，整组会显示成空白，而不是"少了一行"。
        async function reloadSessionList(groupKey) {
          const cwd = groupKey === '__orphan__' ? null : groupKey
          try {
            const data = await rpc('listSessions', cwd)
            setSessionsByKey(function (prev) {
              const next = {}
              for (const k in prev) next[k] = prev[k]
              next[groupKey] = (data && data.sessions) || []
              return next
            })
          } catch (e) {}
        }

        // 删除单个会话的数据。入口只出现在未勾选的会话上（勾选代表"要保留/导出"）。
        async function doDeleteSession(id, groupKey) {
          setError(null)
          try {
            const r = await rpc('deleteSession', id)
            // 宿主的约定是「状态对象里带 error 字段」而不是抛错，两种都要接住。
            if (r && r.error) { setError(r.error); return }
            await loadGroups()
            // 宿主已经把它从 selection.json 里摘掉了，界面上的勾选也要跟着同步。
            await loadSelection()
            await reloadSessionList(groupKey)
          } catch (e) {
            setError(errText(e))
          }
        }

        // ── 百度网盘 ──────────────────────────────────────────────────────────

        async function loadBaidu() {
          try {
            setBaidu(await rpc('baiduStatus'))
          } catch (e) {
            // 状态拉取失败就保持上一次的样子：面板上原有的勾选与展开状态不该被牵动。
          }
        }

        // 百度相关的动作统一走这里。宿主的约定是「状态对象里带 error 字段」而不是抛错，
        // 所以两种失败都要落到同一个错误位上。
        async function runBaidu(action, method) {
          setError(null)
          setBaiduBusy(action)
          try {
            setBaidu(await rpc(method))
          } catch (e) {
            setError(errText(e))
          } finally {
            setBaiduBusy(null)
          }
        }

        function doBaiduLogin() { return runBaidu('login', 'baiduLoginStart') }
        function doBaiduCancel() { return runBaidu('cancel', 'baiduLoginCancel') }
        function doBaiduLogout() { return runBaidu('logout', 'baiduLogout') }
        function doBaiduUpload() { return runBaidu('upload', 'baiduUpload') }
        function doBaiduDownload() { return runBaidu('download', 'baiduDownload') }

        function formatTime(ms) {
          if (!ms) return ''
          try {
            return new Date(ms).toLocaleString()
          } catch (e) {
            return String(ms)
          }
        }

        function renderBaidu() {
          if (baidu === null) return h('div', { className: 'sm-hint' }, '加载中…')
          if (baidu.available === false) {
            return h('div', { className: 'sm-hint' }, '百度网盘功能不可用：无法确定 DSH_HOME。')
          }
          // 凭证是用户自己维护的私密文件，插件只读不写。缺了就把路径和格式摊开，
          // 而不是丢一句「未配置」让他去猜。
          if (baidu.configured === false) {
            const problem = baidu.credentialsProblem || {}
            return h('div', { className: 'sm-baidu-box' }, [
              h('div', { className: 'sm-err' }, problem.message || '还没有配置百度网盘应用凭证'),
              h('div', { className: 'sm-hint' }, '把应用凭证写进下面这个文件（插件只读，不会生成或覆盖它）：'),
              h('div', { className: 'sm-kv' }, baidu.credentialsPath || 'panbaidu.json'),
              h('pre', { className: 'sm-code' }, [
                '{',
                '  "appId": "应用 ID",',
                '  "appKey": "AppKey",',
                '  "secretKey": "SecretKey",',
                '  "signKey": "SignKey"',
                '}'
              ].join('\n')),
              h('div', { className: 'sm-hint' }, 'appKey 与 secretKey 必填；appId 与 signKey 用不到，可以留空。改完这里会自动重新读取，不必重启。')
            ])
          }
          const task = baidu.task
          const running = !!(task && task.running)
          const rows = []

          // 落点必须摊开写：开放平台只允许应用写它自己的 /apps/<应用名>/，
          // 这一截绕不过去，不说清楚用户会去网盘根目录里找一个不存在的 AI/exports。
          // 同时标明这个值来自配置还是默认——不然用户改完 RemotePath 看到路径没变，
          // 会以为是配置没生效。
          rows.push(h('div', { key: 'remote', className: 'sm-kv' },
            '网盘位置：' + (baidu.remotePath || '（登录后自动探测）')
            + (baidu.remotePathSource === 'configured'
              ? '（来自 panbaidu.json 的 RemotePath）'
              : '（默认值，可在 panbaidu.json 里用 RemotePath 改）')))
          rows.push(h('div', { key: 'local', className: 'sm-kv' },
            '本地位置：' + (baidu.localPath || '未知')
            + (baidu.local && baidu.local.exists
              ? '（' + baidu.local.fileCount + ' 个文件，' + formatSize(baidu.local.totalSize)
                + (baidu.local.sessionCount != null ? '，' + baidu.local.sessionCount + ' 个会话' : '')
                + (baidu.local.exportedAt ? '，导出于 ' + formatTime(baidu.local.exportedAt) : '') + '）'
              : '（还没有导出内容，请先在下面导出）')))

          if (baidu.phase === 'waiting' && baidu.pending) {
            const pending = baidu.pending
            rows.push(h('div', { key: 'auth', className: 'sm-baidu-box' }, [
              h('div', { className: 'sm-hint' }, '打开下面的地址，用百度账号登录后输入这个用户码：'),
              h('div', { className: 'sm-baidu-code' }, pending.userCode),
              h('a', {
                className: 'sm-link',
                href: pending.verificationUrl,
                target: '_blank',
                rel: 'noreferrer'
              }, pending.verificationUrl),
              pending.qrcodeUrl ? h('img', { className: 'sm-qr', src: pending.qrcodeUrl, alt: '扫码授权' }) : null,
              h('div', { className: 'sm-hint' },
                '也可以直接扫上面的二维码。' + (pending.expiresAt ? '有效期至 ' + formatTime(pending.expiresAt) + '。' : '')
                + '授权完成后这里会自动变成已登录，不用手动刷新。'),
              h('button', {
                className: 'sm-btn sm-btn-mini',
                onClick: doBaiduCancel,
                disabled: baiduBusy !== null
              }, '取消')
            ]))
          } else if (baidu.loggedIn) {
            const name = baidu.account ? (baidu.account.netdiskName || baidu.account.baiduName) : ''
            rows.push(h('div', { key: 'account', className: 'sm-row' }, [
              h('span', { className: 'sm-ok' }, '已登录' + (name ? '：' + name : '')),
              h('button', {
                className: 'sm-btn sm-btn-mini',
                onClick: doBaiduLogout,
                disabled: baiduBusy !== null || running
              }, '退出登录')
            ]))
          } else {
            rows.push(h('div', { key: 'login', className: 'sm-row' }, [
              h('button', {
                className: 'sm-btn',
                onClick: doBaiduLogin,
                disabled: baiduBusy !== null
              }, baiduBusy === 'login' ? '获取授权码…' : '登录百度网盘'),
              h('span', { className: 'sm-hint' }, '走设备码授权，不需要回调地址。')
            ]))
          }

          if (task && running) {
            const percent = task.total > 0 ? Math.round(task.done / task.total * 100) : 0
            rows.push(h('div', { key: 'task', className: 'sm-baidu-box' }, [
              h('div', { className: 'sm-hint' },
                (task.kind === 'upload' ? '上传' : '下载') + '：' + (task.message || '处理中…')
                + (task.total > 0 ? '（' + task.done + '/' + task.total + '）' : '')),
              h('div', { className: 'sm-progress' }, h('div', { className: 'sm-progress-fill', style: { width: percent + '%' } })),
              task.current ? h('div', { className: 'sm-kv' }, task.current) : null
            ]))
          }

          if (task && task.result) {
            const result = task.result
            if (task.kind === 'upload') {
              const lines = ['已上传 ' + result.uploaded + ' 个文件 → ' + result.remotePath]
              // 跳过多少要说出来：不然「点了上传却几乎瞬间结束」会让人以为什么都没做。
              if (result.skipped > 0) lines.push('跳过 ' + result.skipped + ' 个未变化的文件（云端已是同一份内容）')
              if (result.instant > 0) lines.push('其中 ' + result.instant + ' 个命中秒传，未重复传输')
              if (result.deleted > 0) lines.push('清理云端多余 ' + result.deleted + ' 项（本地已没有）')
              // 秒传不产生任何传输，所以要单独报一句云端实际文件数，否则「成功」二字无从证伪。
              if (result.remoteFileCount != null) lines.push('云端现在有 ' + result.remoteFileCount + ' 个文件')
              rows.push(h('div', { key: 'result', className: 'sm-ok' }, lines.join('\n')))
            } else {
              rows.push(h('div', { key: 'result', className: 'sm-ok' },
                '已获取 ' + result.downloaded + ' 个文件 → ' + result.localPath
                + (result.deleted > 0 ? '\n清理本地多余 ' + result.deleted + ' 项（云端已没有）' : '')))
            }
          }
          if (task && task.result && task.result.failed > 0) {
            rows.push(h('div', { key: 'failed', className: 'sm-err' },
              '有 ' + task.result.failed + ' 个文件失败：\n'
              + (task.result.failedItems || []).map(function (item) {
                return '· ' + item.path + '：' + item.error
              }).join('\n')))
          }
          if (task && task.result && task.result.deleteFailed && task.result.deleteFailed.length > 0) {
            rows.push(h('div', { key: 'delfailed', className: 'sm-err' },
              '这些云端内容没能删掉：\n'
              + task.result.deleteFailed.map(function (item) {
                return '· ' + item.path + '：' + item.error
              }).join('\n')))
          }
          // 上传后核对发现网盘上少文件：这是「假成功」唯一的暴露方式，必须点名。
          if (task && task.result && task.result.missing && task.result.missing.length > 0) {
            rows.push(h('div', { key: 'missing', className: 'sm-err' },
              '这些文件在网盘上并不存在：\n'
              + task.result.missing.map(function (item) { return '· ' + item }).join('\n')))
          }
          if (task && task.result && task.result.extra && task.result.extra.length > 0) {
            rows.push(h('div', { key: 'extra', className: 'sm-err' },
              '云端多出这些文件（本地没有，清理没成功）：\n'
              + task.result.extra.map(function (item) { return '· ' + item }).join('\n')))
          }
          // 任务在「准备阶段」就失败时（建目录、列目录、拿 token）根本没有 result，
          // 只把错误挂在 task 上——不说出来用户就只看到进度条消失了。
          if (task && !running && task.error && !(task.result && task.result.failed > 0)) {
            rows.push(h('div', { key: 'taskerror', className: 'sm-err' }, task.error))
          }

          const blocked = !baidu.loggedIn || running || baiduBusy !== null
          rows.push(h('div', { key: 'actions', className: 'sm-row', style: { marginTop: 2 } }, [
            h('button', {
              className: 'sm-btn primary',
              onClick: doBaiduUpload,
              disabled: blocked
            }, baiduBusy === 'upload' ? '启动中…' : '上传到百度云'),
            h('button', {
              className: 'sm-btn',
              onClick: doBaiduDownload,
              disabled: blocked
            }, baiduBusy === 'download' ? '启动中…' : '从百度云中获取')
          ]))

          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, rows)
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
          // 删除只给**未勾选**的会话：勾选代表"要保留/导出"，那一批不该摆着删除入口。
          const confirmKey = 'session:' + s.id
          const armed = confirmDelete === confirmKey
          return h('div', { key: s.id, className: 'sm-item' }, [
            h('input', { type: 'checkbox', checked: !!selected[s.id], onChange: function () { toggle(s.id) } }),
            h('span', { className: 'sm-item-title', title: s.title, onClick: function () { toggle(s.id) } }, s.title),
            h('div', { className: 'sm-item-meta' }, [
              sessionStatusView(s),
              sizeDeltaView(s),
              selected[s.id] ? null : h('button', {
                className: 'sm-btn sm-btn-mini sm-btn-danger',
                onClick: function (e) {
                  e.stopPropagation()
                  if (armed) {
                    setConfirmDelete(null)
                    doDeleteSession(s.id, groupKey)
                  } else {
                    setConfirmDelete(confirmKey)
                  }
                }
              }, armed ? '确认删除?' : '删除'),
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
          h('div', { className: 'sm-card' }, [
            h('div', { className: 'sm-title' }, '百度网盘'),
            h('p', { className: 'sm-hint', style: { margin: 0 } },
              '把本地导出目录与网盘上的 ' + (baidu && baidu.subdir ? baidu.subdir : 'AI/exports')
              + ' 双向同步：上传是把本地这份备份推上去，获取是把网盘那份拉回来覆盖本地。'),
            baidu && baidu.error ? h('div', { className: 'sm-err' }, baidu.error) : null,
            renderBaidu()
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
