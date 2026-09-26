// 百度网盘面板的 UI 交互测试。
//
// 重点钉住三件事：
//   1. 两个同步按钮必须禁用得「有道理」——没登录、或已有任务在跑时都不能点
//   2. 授权是要用户去浏览器里操作的异步过程，界面必须把 user_code 与验证地址摊开，
//      并在授权完成后自己变成已登录（用户不需要手动刷新）
//   3. 「上传到百度云」「从百度云中获取」必须位于面板最底部
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

// ── 浏览器环境替身 ────────────────────────────────────────────────────────────
let capturedFactory
globalThis.document = {
  createElement: () => ({ textContent: '' }),
  head: { appendChild: () => {} }
}
globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => {
      capturedFactory = definition.factory
    }
  }
}

// ── 迷你 React：useState 支持函数式更新并触发重渲染；useEffect 认依赖数组 ──────
// 依赖感知是必须的：面板靠一个 [phase, running] 的 effect 起轮询来发现「用户已经
// 在浏览器里授权完成」，替身要是不重跑它，这条状态流转就永远测不到。
const hooks = []
const effectDeps = []
const effectCleanups = []
let stateIndex = 0
let effectIndex = 0
let dirty = false
let pendingEffects = []

const React = {
  useState(initial) {
    const index = stateIndex++
    if (hooks.length <= index) hooks[index] = typeof initial === 'function' ? initial() : initial
    return [hooks[index], (value) => {
      hooks[index] = typeof value === 'function' ? value(hooks[index]) : value
      dirty = true
    }]
  },
  useEffect(effect, deps) {
    const index = effectIndex++
    const prev = effectDeps[index]
    let changed
    if (deps === undefined) {
      // 没有依赖数组的 effect 在真实 React 里每次渲染都跑；本面板的 effect 都显式
      // 传了依赖数组，走下面的分支。这里保留「只跑一次」以免替身陷入无限渲染。
      changed = effectDeps[index] !== 'ran'
    } else {
      changed = prev === undefined || prev === 'ran'
        || prev.length !== deps.length
        || deps.some((value, i) => !Object.is(value, prev[i]))
    }
    effectDeps[index] = deps === undefined ? 'ran' : deps
    if (changed) pendingEffects.push({ index, effect })
  },
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat(Infinity) }
  }
}

// ── 虚拟树工具 ────────────────────────────────────────────────────────────────
function flatten(root) {
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    out.push(node)
    walk(node.children)
  }
  walk(root)
  return out
}
/** 找出"直接文本子节点里含某段文字"的节点（即界面上那一行文字本身）。 */
function findText(root, text) {
  return flatten(root).filter((node) => {
    const direct = (node.children || []).filter((child) => typeof child === 'string').join('')
    return direct.includes(text)
  })
}
function findButton(root, label) {
  return flatten(root).filter((node) => {
    return node.type === 'button' && (node.children || []).filter((c) => typeof c === 'string').join('') === label
  })[0]
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// ── 远程调用替身 ──────────────────────────────────────────────────────────────
const calls = []
const localPath = 'D:\\DSH\\session-migrate\\exports'
const remotePath = '/apps/myapp/AI/exports'

function baseState() {
  return {
    available: true,
    // 凭证来自用户自己维护的 baiduclound.json；协议层与宿主都没有内置默认值。
    configured: true,
    credentialsPath: 'C:\\Users\\me\\.dsh\\session-migrate\\baiduclound.json',
    credentialsProblem: null,
    loggedIn: false,
    phase: 'idle',
    pending: null,
    account: null,
    appRoot: null,
    subdir: 'AI/exports',
    remotePath: null,
    localPath: localPath,
    local: { exists: true, fileCount: 3, totalSize: 2048, exportedAt: 1700000000000, sessionCount: 2 },
    task: null,
    error: null
  }
}

let state = baseState()

const namespace = {
  listGroups: async () => ({ ok: true, value: { groups: [], debug: '' } }),
  loadSelection: async () => ({ ok: true, value: { selected: [] } }),
  listUnlinkedGroups: async () => ({ ok: true, value: { groups: [] } }),
  baiduStatus: async () => {
    calls.push('baiduStatus')
    return { ok: true, value: state }
  },
  baiduLoginStart: async () => {
    calls.push('baiduLoginStart')
    state = {
      ...state,
      phase: 'waiting',
      pending: {
        userCode: 'u8sk425x',
        verificationUrl: 'https://openapi.baidu.com/device',
        qrcodeUrl: '',
        expiresAt: Date.now() + 300000,
        interval: 5
      }
    }
    return { ok: true, value: state }
  },
  baiduLoginCancel: async () => {
    calls.push('baiduLoginCancel')
    state = { ...state, phase: 'idle', pending: null }
    return { ok: true, value: state }
  },
  baiduLogout: async () => {
    calls.push('baiduLogout')
    state = baseState()
    return { ok: true, value: state }
  },
  baiduUpload: async () => {
    calls.push('baiduUpload')
    // 宿主是「启动任务后立刻返回」：这一刻界面该进入忙碌态。
    state = {
      ...state,
      task: { running: true, kind: 'upload', total: 10, done: 0, current: '', message: '正在准备网盘目录…', result: null, error: null }
    }
    return { ok: true, value: state }
  },
  baiduDownload: async () => {
    calls.push('baiduDownload')
    state = {
      ...state,
      task: { running: true, kind: 'download', total: 4, done: 0, current: '', message: '正在列出网盘文件…', result: null, error: null }
    }
    return { ok: true, value: state }
  }
}

// ── 装配插件 ──────────────────────────────────────────────────────────────────
new Function('window', 'document', source)(globalThis.window, globalThis.document)
const plugin = capturedFactory((id) => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
})

let registered
const ctx = {
  remote: { $mount: () => Promise.resolve(async () => {}) },
  // rpc 每次都从 ctx.get('remote.sessionMigrate') 取命名空间。
  get: (key) => (key === 'remote.sessionMigrate' ? namespace : undefined),
  effect: (callback) => callback(),
  slots: {
    inject: (name, callback) => callback(),
    register: (spec, component) => {
      registered = { spec, component }
    }
  }
}
plugin.apply(ctx)

const Panel = registered.component().type
async function render() {
  stateIndex = 0
  effectIndex = 0
  pendingEffects = []
  dirty = false
  const tree = Panel()
  const effects = pendingEffects
  pendingEffects = []
  for (const entry of effects) {
    // 重跑之前先执行上一轮的清理，否则每次依赖变化都会多留一个 setInterval 下来。
    if (typeof effectCleanups[entry.index] === 'function') effectCleanups[entry.index]()
    effectCleanups[entry.index] = entry.effect()
  }
  await tick()
  await tick()
  if (dirty) {
    dirty = false
    return render()
  }
  return tree
}

/** 等面板自己的轮询把新状态取回来（授权完成就是这么被发现的）。 */
const waitPoll = () => new Promise((resolve) => setTimeout(resolve, 1700))

/**
 * 让面板重新拉一次数据。
 * 真实界面靠轮询（任务进行中 700ms 一次），测试里没必要陪着等——把「初始加载」
 * 那个 effect 标回未执行，下一次渲染就会重走一遍 loadBaidu。
 */
async function reload() {
  effectDeps[0] = undefined
  return await render()
}

// ── 凭证没配好：把引导摊开，别让用户对着一个点不动的按钮猜 ────────────────────
state = {
  ...baseState(),
  configured: false,
  credentialsProblem: {
    reason: 'missing',
    message: '还没有配置百度网盘应用凭证：请创建 ' + 'C:\\Users\\me\\.dsh\\session-migrate\\baiduclound.json'
  }
}
let tree = await render()
assert.ok(findText(tree, '还没有配置百度网盘应用凭证').length > 0, '缺凭证时必须说明白')
assert.ok(findText(tree, 'baiduclound.json').length > 0, '必须把期望的文件路径显示出来')
assert.ok(findText(tree, 'secretKey').length > 0, '必须给出文件格式模板')
assert.equal(findButton(tree, '登录百度网盘'), undefined, '缺凭证时不该出现登录按钮')
assert.equal(findButton(tree, '上传到百度云'), undefined, '缺凭证时不该出现同步按钮')

// 凭证补齐后回到正常状态，继续测登录流程。
state = baseState()
tree = await reload()

// ── 未登录：把两个动作都挡掉，并给出登录入口 ──────────────────────────────────
assert.ok(findText(tree, '百度网盘').length > 0, '面板必须有「百度网盘」分区')

const uploadButton = findButton(tree, '上传到百度云')
const downloadButton = findButton(tree, '从百度云中获取')
assert.ok(uploadButton, '必须有「上传到百度云」按钮')
assert.ok(downloadButton, '必须有「从百度云中获取」按钮')
assert.equal(uploadButton.props.disabled, true, '未登录时「上传到百度云」必须禁用')
assert.equal(downloadButton.props.disabled, true, '未登录时「从百度云中获取」必须禁用')

// 用户明确要求这两个按钮在最底下：它们必须排在「从备份目录导入」卡片之后。
const order = flatten(tree)
const importTitleIndex = order.findIndex((node) => {
  return (node.children || []).filter((c) => typeof c === 'string').join('') === '从备份目录导入'
})
assert.ok(importTitleIndex >= 0, '应有「从备份目录导入」分区')
assert.ok(order.indexOf(uploadButton) > importTitleIndex, '「上传到百度云」必须排在导入分区之后')
assert.ok(order.indexOf(downloadButton) > importTitleIndex, '「从百度云中获取」必须排在导入分区之后')

// 登录前的提示信息必须出现，用户得知道按钮为什么点不动。
assert.ok(findText(tree, '还没有导出内容').length === 0, '本地有内容时不该提示「还没有导出内容」')
assert.ok(findText(tree, '本地位置').length > 0, '必须显示本地位置')

// ── 点登录 → 进入等待授权，展示用户码与验证地址 ────────────────────────────────
findButton(tree, '登录百度网盘').props.onClick()
await tick()
await tick()
tree = await render()
assert.deepEqual(calls.filter((c) => c === 'baiduLoginStart').length, 1, '必须真的调用 baiduLoginStart')
assert.ok(findText(tree, 'u8sk425x').length > 0, '等待授权时必须展示 user_code')
assert.ok(findText(tree, 'https://openapi.baidu.com/device').length > 0, '必须展示验证地址')
assert.ok(findButton(tree, '取消'), '等待授权时应能取消')
assert.equal(findButton(tree, '上传到百度云').props.disabled, true, '等待授权时同步按钮仍应禁用')

// ── 授权完成：界面自己变成已登录（不靠用户手动刷新，靠面板自己的轮询发现） ────
state = {
  ...state,
  loggedIn: true,
  phase: 'authorized',
  pending: null,
  account: { baiduName: 'fengb', netdiskName: '我的网盘', vipType: 0 },
  appRoot: '/apps/myapp',
  remotePath: remotePath
}
await waitPoll()
tree = await render()
assert.ok(findText(tree, '已登录').length > 0, '授权完成后应显示已登录')
assert.ok(findText(tree, '我的网盘').length > 0, '应显示网盘账号名')
assert.ok(findText(tree, remotePath).length > 0, '必须把真实的网盘落点摊开显示')
assert.equal(findButton(tree, '上传到百度云').props.disabled, false, '已登录后「上传到百度云」应可用')
assert.equal(findButton(tree, '从百度云中获取').props.disabled, false, '已登录后「从百度云中获取」应可用')

// ── 点上传 → 调用宿主，并进入进行中状态 ───────────────────────────────────────
findButton(tree, '上传到百度云').props.onClick()
await tick()
await tick()
tree = await render()
assert.equal(calls.filter((c) => c === 'baiduUpload').length, 1, '必须真的调用 baiduUpload')
assert.ok(findText(tree, '正在准备网盘目录').length > 0, '任务启动后应展示阶段信息')
assert.equal(findButton(tree, '上传到百度云').props.disabled, true, '任务进行中不允许重复点击')
assert.equal(findButton(tree, '从百度云中获取').props.disabled, true, '任务进行中不允许切换方向')

// ── 进度与完成结果 ────────────────────────────────────────────────────────────
state = {
  ...state,
  task: {
    running: true, kind: 'upload', total: 10, done: 3,
    current: 'sessions/--proj--/session-a/session.v3.jsonl.zstd',
    message: '正在上传…', result: null, error: null
  }
}
tree = await reload()
assert.ok(findText(tree, '（3/10）').length > 0, '必须显示进度计数')
assert.ok(findText(tree, 'session-a').length > 0, '必须显示当前正在传的文件')
const bars = flatten(tree).filter((node) => String(node.props.className || '').includes('sm-progress-fill'))
assert.equal(bars.length, 1, '进行中应有一条进度条')
assert.equal(bars[0].props.style.width, '30%', '进度条宽度应与 done/total 一致')

state = {
  ...state,
  task: {
    running: false, kind: 'upload', total: 10, done: 10, current: '', message: '完成', error: null,
    result: {
      uploaded: 10, skipped: 42, instant: 8, deleted: 3,
      deletedItems: ['sessions/--old--/session-x/session.v3.jsonl.zstd'],
      failed: 0, failedItems: [], total: 55,
      remotePath: remotePath, remoteFileCount: 12
    }
  }
}
tree = await reload()
assert.ok(findText(tree, '已上传 10 个文件').length > 0, '完成后要报告上传数量')
assert.ok(findText(tree, '秒传').length > 0, '命中秒传时必须说出来，否则用户会以为没传上去')
assert.ok(findText(tree, '跳过 42 个未变化的文件').length > 0, '跳过多少必须说明，否则「瞬间完成」看着像什么都没做')
assert.ok(findText(tree, '清理云端多余 3 项').length > 0, '删了云端什么必须说出来')
assert.ok(findText(tree, '云端现在有 12 个文件').length > 0, '秒传不产生传输，必须报出云端实际文件数作为凭据')
assert.equal(findButton(tree, '上传到百度云').props.disabled, false, '任务结束后按钮应恢复可用')

// ── 失败明细 ──────────────────────────────────────────────────────────────────
state = {
  ...state,
  task: {
    running: false, kind: 'upload', total: 2, done: 2, current: '', message: '完成', error: '有 1 个文件上传失败',
    result: {
      uploaded: 1, instant: 0, failed: 1,
      failedItems: [{ path: 'sessions/x/session.v3.jsonl.zstd', error: '云盘容量不足' }],
      total: 2, remotePath: remotePath
    }
  }
}
tree = await reload()
assert.ok(findText(tree, '有 1 个文件失败').length > 0, '失败数量必须显示')
assert.ok(findText(tree, '云盘容量不足').length > 0, '每个失败条目都要给出原因')

// ── 上传后核对失败：必须点名缺哪些文件 ────────────────────────────────────────
// 回归：真实环境里出现过「已上传 5 个文件（其中 5 个命中秒传）」+「网盘上现在有
// 0 个文件」却显示成绿色成功的自相矛盾结果。核对失败必须盖过那行成功提示。
state = {
  ...state,
  task: {
    running: false, kind: 'upload', total: 2, done: 2, current: '', message: '失败',
    error: '上传后核对失败：网盘上缺少 2 个文件（本次共 2 个），说明上传并没有真正生效',
    result: {
      uploaded: 2, instant: 2, failed: 0, failedItems: [], total: 2,
      remotePath: remotePath, remoteFileCount: 0,
      missing: ['index.json', 'sessions/--p--/session-a/session.v3.jsonl.zstd']
    }
  }
}
tree = await reload()
assert.ok(findText(tree, '这些文件在网盘上并不存在').length > 0, '核对失败必须点名缺哪些文件')
assert.ok(findText(tree, '上传后核对失败').length > 0, '必须说明上传没有真正生效')
assert.ok(findText(tree, 'index.json').length > 0, '缺失清单要具体到文件名')

// ── 下载方向 ──────────────────────────────────────────────────────────────────
state = { ...baseState(), loggedIn: true, phase: 'authorized', remotePath: remotePath }
tree = await reload()
findButton(tree, '从百度云中获取').props.onClick()
await tick()
await tick()
tree = await render()
assert.equal(calls.filter((c) => c === 'baiduDownload').length, 1, '必须真的调用 baiduDownload')
assert.ok(findText(tree, '正在列出网盘文件').length > 0, '下载启动后应展示阶段信息')

state = {
  ...state,
  task: {
    running: false, kind: 'download', total: 4, done: 4, current: '', message: '完成', error: null,
    result: { downloaded: 4, failed: 0, failedItems: [], localPath: localPath }
  }
}
tree = await reload()
assert.ok(findText(tree, '已获取 4 个文件').length > 0, '下载完成后要报告数量与落点')

// ── 退出登录 ──────────────────────────────────────────────────────────────────
findButton(tree, '退出登录').props.onClick()
await tick()
await tick()
tree = await render()
assert.equal(calls.filter((c) => c === 'baiduLogout').length, 1, '必须真的调用 baiduLogout')
assert.equal(findButton(tree, '上传到百度云').props.disabled, true, '退出后同步按钮应重新禁用')

console.log('百度网盘面板 UI 测试通过：登录引导、授权状态流转、进度与结果、两个按钮位于面板最底部。')
