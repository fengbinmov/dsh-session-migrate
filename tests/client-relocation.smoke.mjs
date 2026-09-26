// 未关联工作区（重定位）的 UI 交互测试。
//
// 用带状态与重渲染的迷你 React 替身跑真实的 Panel：数据 → UI → 交互 → 远程调用
// 这条链路在没有浏览器的情况下也能验证，避免出现"按钮点了没反应"这类问题。
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

// ── 迷你 React：useState 支持函数式更新并触发重渲染，useEffect 只在首次执行 ────
const hooks = []
const effectRan = []
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
  useEffect(effect) {
    const index = effectIndex++
    if (effectRan[index] !== true) {
      effectRan[index] = true
      pendingEffects.push(effect)
    }
  },
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat() }
  }
}

// ── 虚拟树工具 ────────────────────────────────────────────────────────────────
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  visit(node)
  walk(node.children, visit)
}
/** 找出"直接文本子节点里含某段文字"的节点（即界面上那一行文字本身）。 */
function findText(root, text) {
  const hits = []
  walk(root, (node) => {
    const direct = (node.children || []).filter((child) => typeof child === 'string').join('')
    if (direct.includes(text)) hits.push(node)
  })
  return hits
}
/** 找出满足条件的元素。 */
function findNode(root, predicate) {
  const hits = []
  walk(root, (node) => {
    if (predicate(node)) hits.push(node)
  })
  return hits
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// ── 远程调用替身 ──────────────────────────────────────────────────────────────
const legacyCwd = 'Z:\\AI\\legacy-from-another-machine'
const checkCalls = []
const applyCalls = []
const importCalls = []
const deleteCalls = []
// 一个普通工作区：两个会话，一个已勾选、一个未勾选——删除入口只该出现在后者身上。
const workCwd = 'D:\\work\\demo'
const checkedId = 'session-checked'
const uncheckedId = 'session-unchecked'
const sessionRow = (id, title, archived) => ({
  id, title, createdAt: 1, cwd: workCwd, parentSession: null,
  live: false, persisted: true, status: 'none', size: 100, sizeDelta: null, archived: !!archived
})
const namespace = {
  listGroups: async () => ({
    ok: true,
    value: {
      groups: [{
        key: workCwd, path: workCwd, title: 'demo', sessionCount: 2, archivedCount: 0,
        sessionIds: [checkedId, uncheckedId], hasExport: false, status: 'none'
      }],
      debug: ''
    }
  }),
  listSessions: async () => ({ ok: true, value: { sessions: [sessionRow(checkedId, '已勾选的会话'), sessionRow(uncheckedId, '未勾选的会话')] } }),
  loadSelection: async () => ({ ok: true, value: { selected: [checkedId] } }),
  deleteSession: async (id) => {
    deleteCalls.push(id)
    return { ok: true, value: { ok: true, id: id } }
  },
  listUnlinkedGroups: async () => ({
    ok: true,
    value: {
      groups: [{
        key: legacyCwd,
        cwd: legacyCwd,
        title: legacyCwd,
        sessionCount: 2,
        sessionIds: ['session-a', 'session-b'],
        mappedTo: null,
        targetExists: null,
        sessions: [
          { id: 'session-a', fileName: 'session.v3.jsonl.zstd', projectDir: '--Z-AI-legacy--', sessionSegment: 'session-a', size: 1024, originCwdExists: false },
          { id: 'session-b', fileName: 'session.v3.jsonl.zstd', projectDir: '--Z-AI-legacy--', sessionSegment: 'session-b', size: 2048, originCwdExists: false }
        ]
      }]
    }
  }),
  checkRelocation: async (sourceCwd, targetCwd) => {
    checkCalls.push([sourceCwd, targetCwd])
    return { ok: true, value: { ok: true, problems: [], info: { sourceCwd, targetCwd, sessionCount: 2, willCreate: true } } }
  },
  applyRelocation: async (sourceCwd, targetCwd) => {
    applyCalls.push([sourceCwd, targetCwd])
    return { ok: true, value: { ok: true, moved: 2, attached: 0, failed: [], sourceCwd, targetCwd, mappingSaved: true, pendingRestart: true } }
  },
  import: async (path) => {
    importCalls.push(path)
    return {
      ok: true,
      value: {
        imported: 1,
        overwritten: 0,
        detached: 0,
        deduped: 0,
        skipped: 2,
        skippedItems: [
          { id: 'session-a', reason: '备份目录里找不到这个会话的日志文件' },
          { id: 'session-b', reason: '文件内容与索引记录的哈希不符' }
        ],
        importedIds: [],
        overwrittenIds: [],
        detachedIds: []
      }
    }
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
  // rpc 每次都从 ctx.get('remote.sessionMigrate') 取命名空间，这里必须给出来。
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
  const tree = Panel()
  const effects = pendingEffects
  pendingEffects = []
  for (const effect of effects) effect()
  await tick()
  await tick()
  if (dirty) {
    dirty = false
    return render()
  }
  return tree
}

// ── 断言 ──────────────────────────────────────────────────────────────────────
let tree = await render()

assert.ok(findText(tree, '未关联工作区').length > 0, '面板必须有"未关联工作区"分区')
assert.equal(findText(tree, legacyCwd).length > 0, true, '必须列出未关联工作区的原始 cwd')
assert.ok(findText(tree, '2 个会话').length > 0, '必须显示会话数量')

const inputs = findNode(tree, (node) => node.type === 'input' && String(node.props.placeholder || '').startsWith('目标路径'))
assert.equal(inputs.length, 1, '每个未关联工作区应有一个目标路径输入框')
assert.equal(inputs[0].props.value, '', '没配过映射时输入框应为空')

const checkButton = findText(tree, '检测重定位是否有效')[0]
const applyButton = findText(tree, '应用重定位')[0]
assert.ok(checkButton && applyButton, '必须有两个动作按钮')
assert.equal(checkButton.type, 'button')
assert.equal(applyButton.type, 'button')
assert.equal(checkButton.props.disabled, true, '没填目标路径时"检测"应禁用')

// 填入目标路径 → 再渲染，输入框应带上这个值，按钮应解禁
inputs[0].props.onChange({ target: { value: 'D:/restored/legacy-project' } })
tree = await render()
const filled = findNode(tree, (node) => node.type === 'input' && String(node.props.placeholder || '').startsWith('目标路径'))[0]
assert.equal(filled.props.value, 'D:/restored/legacy-project', '输入框必须受控地反映草稿值')
assert.equal(findText(tree, '检测重定位是否有效')[0].props.disabled, false, '填了目标后"检测"应可用')

// 点"检测" → 必须以 (原cwd, 目标) 调用 checkRelocation
findText(tree, '检测重定位是否有效')[0].props.onClick()
await tick()
await tick()
tree = await render()
assert.deepEqual(checkCalls, [[legacyCwd, 'D:/restored/legacy-project']], '检测必须带上正确的原始 cwd 与目标路径')
assert.ok(findText(tree, '检测通过').length > 0, '检测通过后必须给出正面反馈')
assert.ok(findText(tree, '将创建目标目录').length > 0, '应提示需要创建目标目录')

// 点"应用" → 必须调用 applyRelocation，并显示完成与"重启"提示
findText(tree, '应用重定位')[0].props.onClick()
await tick()
await tick()
tree = await render()
assert.deepEqual(applyCalls, [[legacyCwd, 'D:/restored/legacy-project']], '应用必须带上正确的原始 cwd 与目标路径')
assert.ok(findText(tree, '重定位完成').length > 0, '应用成功后必须给出结果')
assert.ok(findText(tree, '重启 DSH').length > 0, '结果里必须提醒重启 DSH')

// 点"导入" → 被跳过的条目必须显式报出来（同步不全时唯一的线索）
const importButton = findNode(tree, (node) => {
  return node.type === 'button' && (node.children || []).filter((c) => typeof c === 'string').join('') === '导入'
})[0]
assert.ok(importButton, '必须有"导入"按钮')
importButton.props.onClick()
await tick()
await tick()
tree = await render()
assert.equal(importCalls.length, 1, '导入必须真的被调用')
assert.ok(findText(tree, '有 2 个会话被跳过').length > 0, '跳过的数量必须显示出来')
assert.ok(findText(tree, '找不到这个会话的日志文件').length > 0, '每个跳过条目都要给出原因')

// ── 会话行的删除入口：只在未勾选的会话上，且需要二次确认 ──────────────────────
// 点击处理挂在行容器上（标题那个 span 自己没有 onClick），所以要找 sm-ws-row。
const workRow = findNode(tree, (node) => {
  if (!node.props || node.props.className !== 'sm-ws-row' || typeof node.props.onClick !== 'function') return false
  return findText(node, 'demo').length > 0
})[0]
assert.ok(workRow, '应当列出普通工作区')
workRow.props.onClick() // 展开该工作区，加载会话明细
await tick()
await tick()
tree = await render()

// 注：工作区行自己也有一个「删除」，所以不能按总数判断——按"按钮落在哪一行"来判断。
const deleteButtonsIn = (row) => findNode(row, (node) => {
  return node.type === 'button' && (node.children || []).filter((c) => typeof c === 'string').join('') === '删除'
})
const checkedRow = findNode(tree, (node) => (node.children || []).some((c) => c && c.props && c.props.title === '已勾选的会话'))[0]
const uncheckedRow = findNode(tree, (node) => (node.children || []).some((c) => c && c.props && c.props.title === '未勾选的会话'))[0]
assert.ok(checkedRow && uncheckedRow, '两行会话都要渲染出来')
assert.equal(deleteButtonsIn(checkedRow).length, 0, '已勾选的会话不该有删除入口')
assert.equal(deleteButtonsIn(uncheckedRow).length, 1, '未勾选的会话应当有删除入口')

// 第一次点击只是"上膛"，不能真的删。
deleteButtonsIn(uncheckedRow)[0].props.onClick({ stopPropagation: () => {} })
await tick()
tree = await render()
assert.equal(deleteCalls.length, 0, '第一次点击不能立刻删除')
assert.ok(findText(tree, '确认删除?').length > 0, '第一次点击应当变成确认态')

// 第二次点击才真的删。
findText(tree, '确认删除?')[0].props.onClick({ stopPropagation: () => {} })
await tick()
await tick()
tree = await render()
assert.deepEqual(deleteCalls, [uncheckedId], '确认后必须删除那个未勾选的会话')

console.log('未关联工作区 UI 交互测试通过：输入、检测、应用、结果提示、导入跳过提示、会话删除入口均正确。')
