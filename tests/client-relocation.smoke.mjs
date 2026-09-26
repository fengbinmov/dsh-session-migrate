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
// document 上要能挂全局点击监听（删除按钮上膛后点别处取消），所以做成可派发的事件表。
const documentListeners = new Map()
globalThis.document = {
  createElement: () => ({ textContent: '' }),
  head: { appendChild: () => {} },
  addEventListener: (type, handler) => {
    if (!documentListeners.has(type)) documentListeners.set(type, new Set())
    documentListeners.get(type).add(handler)
  },
  removeEventListener: (type, handler) => {
    const set = documentListeners.get(type)
    if (set !== undefined) set.delete(handler)
  }
}
/** 模拟"用户点了页面其他地方"。 */
function fireDocumentClick() {
  const set = documentListeners.get('click')
  if (set === undefined) return
  for (const handler of [...set]) handler()
}
globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => {
      capturedFactory = definition.factory
    }
  }
}

// ── 迷你 React：useState 支持函数式更新并触发重渲染，useEffect 按依赖数组执行 ──
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
  // 依赖数组必须被尊重：否则"confirmDelete 变化时挂/摘全局点击监听"这类 effect
  // 在测试里根本不会重跑，测出来的结论是假的。
  useEffect(effect, deps) {
    const index = effectIndex++
    const prev = effectDeps[index]
    const list = Array.isArray(deps) ? deps : null
    const changed = prev === undefined || list === null || prev === null ||
      list.length !== prev.length || list.some((value, i) => !Object.is(value, prev[i]))
    if (!changed) return
    if (typeof effectCleanups[index] === 'function') {
      try { effectCleanups[index]() } catch (e) {}
    }
    effectDeps[index] = list === null ? null : list.slice()
    effectCleanups[index] = undefined
    pendingEffects.push({ index, effect })
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
// 一个普通工作区：三个会话——已勾选、未勾选、已归档。
// 删除入口只该出现在**未勾选且未归档**的那一个身上。
const workCwd = 'D:\\work\\demo'
const exportedCwd = 'D:\\work\\exported-demo'
const checkedId = 'session-checked'
const uncheckedId = 'session-unchecked'
const archivedId = 'session-archived'
const sessionRow = (id, title, archived) => ({
  id, title, createdAt: 1, cwd: workCwd, parentSession: null,
  live: false, persisted: true, status: 'none', size: 100, sizeDelta: null, archived: !!archived
})
const namespace = {
  listGroups: async () => ({
    ok: true,
    value: {
      groups: [
        {
          key: workCwd, path: workCwd, title: 'demo', sessionCount: 3, archivedCount: 1,
          sessionIds: [checkedId, uncheckedId, archivedId], hasExport: false, status: 'none'
        },
        // 第二个工作区已导出：它的标题该加粗，用来和上面那个未导出的区分开。
        {
          key: exportedCwd, path: exportedCwd, title: 'exported-demo', sessionCount: 0, archivedCount: 0,
          sessionIds: [], hasExport: true, status: 'unchanged'
        }
      ],
      debug: ''
    }
  }),
  listSessions: async () => ({
    ok: true,
    value: {
      sessions: [
        sessionRow(checkedId, '已勾选的会话'),
        sessionRow(uncheckedId, '未勾选的会话'),
        sessionRow(archivedId, '已归档的会话', true)
      ]
    }
  }),
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
  for (const item of effects) {
    const cleanup = item.effect()
    // effect 返回的函数是清理器，交给下一次重跑（或卸载）时调用。
    if (typeof cleanup === 'function') effectCleanups[item.index] = cleanup
  }
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

// 注：工作区行自己也有一个「删除」，所以不能按总数判断——按"按钮落在哪一行、可不可见"判断。
// 不能删的行**仍然渲染按钮**（占位，visibility:hidden），这样尾部列数一致、状态列不会错位。
const isDeleteButton = (node) => {
  return node.type === 'button' && (node.children || []).filter((c) => typeof c === 'string').join('') === '删除'
}
const isHidden = (node) => (node.props.style || {}).visibility === 'hidden'
const deleteButtonsIn = (row) => findNode(row, (node) => isDeleteButton(node) && !isHidden(node))
const deletePlaceholdersIn = (row) => findNode(row, (node) => isDeleteButton(node) && isHidden(node))
const checkedRow = findNode(tree, (node) => (node.children || []).some((c) => c && c.props && c.props.title === '已勾选的会话'))[0]
const uncheckedRow = findNode(tree, (node) => (node.children || []).some((c) => c && c.props && c.props.title === '未勾选的会话'))[0]
assert.ok(checkedRow && uncheckedRow, '两行会话都要渲染出来')
assert.equal(deleteButtonsIn(checkedRow).length, 0, '已勾选的会话不该有可点的删除入口')
assert.equal(deletePlaceholdersIn(checkedRow).length, 1, '但必须留一个隐藏占位，否则状态列会错位')
assert.equal(deleteButtonsIn(uncheckedRow).length, 1, '未勾选的会话应当有删除入口')
assert.equal(deletePlaceholdersIn(uncheckedRow).length, 0, '可删的行不需要占位')

// 已归档的会话在折叠区里，不摆删除入口；展开后同样不该出现。
const archivedToggle = findNode(tree, (node) => {
  return node.props && node.props.className === 'sm-archived-toggle' && typeof node.props.onClick === 'function'
})[0]
assert.ok(archivedToggle, '应当有"已归档"折叠区')
archivedToggle.props.onClick()
await tick()
await tick()
tree = await render()
const archivedRow = findNode(tree, (node) => (node.children || []).some((c) => c && c.props && c.props.title === '已归档的会话'))[0]
assert.ok(archivedRow, '展开后应当能看到已归档的会话')
assert.equal(deleteButtonsIn(archivedRow).length, 0, '已归档的会话不该有可点的删除入口')
assert.equal(deletePlaceholdersIn(archivedRow).length, 1, '已归档的会话同样要留隐藏占位，保证状态列对齐')

// 已归档的行要淡化，且淡化程度必须与「已归档 N 个」那行一致——这就是"颜色一样"。
assert.ok(
  String(archivedRow.props.className).includes('sm-item-archived'),
  '已归档的会话行要带淡化类'
)
assert.equal(
  String(uncheckedRow.props.className).includes('sm-item-archived'),
  false,
  '未归档的会话不该被淡化'
)
const opacityOf = (css) => (/opacity:\s*([.\d]+)/.exec(css) || [])[1]
const archivedItemRule = /\.sm-item-archived\s*\{([^}]*)\}/.exec(source)
const archivedToggleRule = /\.sm-archived-toggle\s*\{([^}]*)\}/.exec(source)
assert.ok(archivedItemRule, '缺少 .sm-item-archived 样式')
assert.ok(archivedToggleRule, '缺少 .sm-archived-toggle 样式')
assert.ok(opacityOf(archivedItemRule[1]), '淡化类必须给出 opacity')
assert.equal(
  opacityOf(archivedItemRule[1]),
  opacityOf(archivedToggleRule[1]),
  '归档会话的淡化程度必须与「已归档 N 个」保持一致'
)

// 会话行尾部的顺序必须与工作区行一致（固定宽 → 状态 → 删除按钮），
// 否则两行的「状态」不在同一竖直列上。
const metaOrder = findNode(tree, (node) => node.props && node.props.className === 'sm-item-meta')[0]
assert.ok(metaOrder, '会话行应当有 meta 容器')
const classes = (metaOrder.children || []).map((child) => String((child && child.props && child.props.className) || ''))
assert.ok(classes[0].includes('sm-delta'), '第一列是尺寸增量（与工作区的会话个数同宽占位）')
assert.ok(classes[1].includes('sm-status'), '第二列才是状态，这样它才和工作区行的状态对齐')

// 第一次点击只是"上膛"，不能真的删。
deleteButtonsIn(uncheckedRow)[0].props.onClick({ stopPropagation: () => {} })
await tick()
tree = await render()
assert.equal(deleteCalls.length, 0, '第一次点击不能立刻删除')
assert.ok(findText(tree, '确认').length > 0, '第一次点击应当变成确认态')

// 上膛后点页面其他地方 → 自动取消，退回「删除」。这是避免确认态一直挂着的关键。
fireDocumentClick()
await tick()
tree = await render()
assert.equal(findText(tree, '确认').length, 0, '点其他地方应当退回「删除」')
assert.equal(deleteCalls.length, 0, '取消不能触发删除')

// 确认态的文字必须与「删除」等宽（都是 2 个字），否则按钮宽度变化会顶动状态列。
assert.ok(findText(tree, '删除').length > 0, '取消后按钮回到「删除」')

// 重新上膛，这一次点「确认」才真的删。
deleteButtonsIn(uncheckedRow)[0].props.onClick({ stopPropagation: () => {} })
await tick()
tree = await render()
findText(tree, '确认')[0].props.onClick({ stopPropagation: () => {} })
await tick()
await tick()
tree = await render()
assert.deepEqual(deleteCalls, [uncheckedId], '确认后必须删除那个未勾选的会话')

// ── 已导出的工作区标题要加粗，未导出的不加粗 ──────────────────────────────────
const wsTitleOf = (label) => findNode(tree, (node) => {
  const cls = String((node.props && node.props.className) || '')
  if (node.type !== 'span') return false
  // 标题 span 的类名是 'sm-ws' 或 'sm-ws sm-ws-exported'；
  // 这样能把 sm-ws-row（div）和 sm-ws-caret 排除掉。
  if (!cls.split(' ').includes('sm-ws')) return false
  return (node.children || []).includes(label)
})[0]
const plainTitle = wsTitleOf('demo')
const exportedTitle = wsTitleOf('exported-demo')
assert.ok(plainTitle, '未导出的工作区标题应当存在')
assert.ok(exportedTitle, '已导出的工作区标题应当存在')
assert.equal(
  String(plainTitle.props.className).includes('sm-ws-exported'),
  false,
  '未导出的工作区标题不该加粗'
)
assert.ok(
  String(exportedTitle.props.className).includes('sm-ws-exported'),
  '已导出的工作区标题必须加粗'
)
// 加粗与否最终由字重决定：验证样式里确实把两者拉开了。
const weightOf = (css) => Number((/font-weight:\s*(\d+)/.exec(css) || [])[1])
const plainWsRule = /\.sm-ws\s*\{([^}]*)\}/.exec(source)
const exportedWsRule = /\.sm-ws-exported\s*\{([^}]*)\}/.exec(source)
assert.ok(plainWsRule, '缺少 .sm-ws 样式')
assert.ok(exportedWsRule, '缺少 .sm-ws-exported 样式')
assert.ok(
  weightOf(exportedWsRule[1]) > weightOf(plainWsRule[1]),
  '已导出的字重必须大于未导出的，否则看不出区别'
)

// ── 卡片标题必须统一：同一个类，字号/字重一致 ────────────────────────────────
// 曾经「工作区状态」用的是另一个类（font-size 13px），和「未关联工作区」的 14px 不一致。
const cardTitles = findNode(tree, (node) => {
  const cls = String((node.props && node.props.className) || '')
  return cls === 'sm-title' || cls === 'sm-section-title'
})
assert.ok(cardTitles.length >= 4, '应当有多个卡片标题')
assert.equal(
  new Set(cardTitles.map((node) => String(node.props.className))).size,
  1,
  '所有卡片标题必须用同一个类，否则字体风格会不一致'
)
assert.ok(findText(tree, '工作控制区').length > 0, '第一个区块的标题应为「工作控制区」')
assert.equal(source.includes('sm-section-title'), false, '那个字号不一致的标题类应当已经删除')

// ── 勾选数量并入导出按钮，不再单独占一行 ──────────────────────────────────────
const exportButton = findNode(tree, (node) => {
  return node.type === 'button' && String((node.props && node.props.className) || '').includes('sm-export-btn')
})[0]
assert.ok(exportButton, '应当有导出按钮')
const exportLabel = (exportButton.children || []).filter((c) => typeof c === 'string').join('')
assert.ok(/（\d+ 个对话）/.test(exportLabel), '导出按钮上要带上勾选的对话数：' + exportLabel)
assert.ok(exportLabel.includes('个工作区'), '导出按钮仍要说明涉及几个工作区：' + exportLabel)
assert.equal(findText(tree, '已选 ').length, 0, '原来那行「已选 N 个会话」提示应当已经移除')

// ── 标题行：刷新图标紧挨着「工作控制区」，不再有独立的按钮行 ──────────────────
const titleRow = findNode(tree, (node) => {
  return String((node.props && node.props.className) || '') === 'sm-title-row'
})[0]
assert.ok(titleRow, '标题应当放在 title-row 里')
const titleRowClasses = (titleRow.children || []).map((c) => String((c && c.props && c.props.className) || ''))
assert.ok(titleRowClasses.includes('sm-title'), '标题行里要有标题')
assert.ok(titleRowClasses.some((c) => c.includes('sm-btn-icon')), '标题行里要有紧挨着的图标按钮')

const iconButton = findNode(tree, (node) => {
  return node.type === 'button' && String((node.props && node.props.className) || '').includes('sm-btn-icon')
})[0]
assert.ok(iconButton, '应当有刷新图标按钮')
assert.equal((iconButton.children || []).join(''), '↻', '按钮上只放图标，不放文字')
assert.equal(iconButton.props.title, '刷新列表', '图标按钮要有 title 说明用途')
assert.equal(iconButton.props['aria-label'], '刷新列表', '图标按钮要有无障碍名称')
// 图标按钮不要边框：细边框配小图标显得脏。
const iconRule = /\.sm-btn-icon\s*\{([^}]*)\}/.exec(source)
assert.ok(iconRule, '缺少 .sm-btn-icon 样式')
assert.ok(/border:\s*none/.test(iconRule[1]), '刷新图标不该有边框')
// 要融入背景：默认必须比正常字淡，且不能带 .sm-btn（否则会继承按钮那套边框/圆角/内边距）。
assert.ok(/opacity:\s*(0?\.\d+)/.test(iconRule[1]), '刷新图标默认要淡下去才谈得上融入背景')
assert.equal(
  String(iconButton.props.className).includes('sm-btn '),
  false,
  '刷新图标不该带 .sm-btn 类'
)
assert.ok(
  /\.sm-btn-icon:hover[^{]*\{[^}]*opacity:\s*1/.test(source),
  '悬停时才浮出来'
)

// 「清空已选」整条移除，处理函数也不留成死代码。
assert.equal(findText(tree, '清空已选').length, 0, '「清空已选」按钮应当已删除')
assert.equal(source.includes('clearSelection'), false, '它的处理函数应当一并删除')

// ── 样式层面的两条约束 ────────────────────────────────────────────────────────
// 1) 删除按钮默认是灰的，只有悬停才变红（面板上会话多，一排红按钮太扎眼）。
const dangerBase = /\.sm-btn-danger\s*\{([^}]*)\}/.exec(source)
assert.ok(dangerBase, '缺少 .sm-btn-danger 的默认样式')
assert.equal(/#dc2626/.test(dangerBase[1]), false, '删除按钮默认不能是红色')
assert.ok(/min-width:\s*44px/.test(dangerBase[1]), '删除按钮要有收窄的固定宽度')
assert.ok(/\.sm-btn-danger:hover\s*\{[^}]*#dc2626/.test(source), '悬停时才变红')
// 确认态的文字不能比「删除」长，否则按钮会被撑宽、状态列跟着跳——两态都该是 2 个字。
assert.equal(source.includes('确认删除?'), false, '确认态文字必须与「删除」等宽（用「确认」）')

// 2) 工作区行的「会话个数」与会话行的「尺寸增量」必须同宽：两行尾部都是
//    「固定宽 → 状态 → 固定宽删除按钮」，状态才会落在同一竖直列上。
const widthOf = (css) => (/min-width:\s*(\d+)px/.exec(css) || [])[1]
const countRule = /\.sm-count\s*\{([^}]*)\}/.exec(source)
const deltaRule = /\.sm-delta\s*\{([^}]*)\}/.exec(source)
assert.ok(countRule, '缺少 .sm-count 样式')
assert.ok(deltaRule, '缺少 .sm-delta 样式')
assert.equal(widthOf(countRule[1]), widthOf(deltaRule[1]), '会话个数与尺寸增量必须同宽，否则状态列会错位')
assert.ok(widthOf(countRule[1]), '两者都要有明确的 min-width')

console.log('未关联工作区 UI 交互测试通过：输入、检测、应用、结果提示、导入跳过提示、会话删除入口与列对齐均正确。')
