// client.js 装配冒烟测试：验证远程命名空间在 $mount 完成前后被正确解析。
//
// 回归目标：apply() 曾在同步阶段取 `ctx.remote.sessionMigrate` 快照，而客户端
// 由 $mount 异步安装 `remote.<namespace>` 服务（且不做惰性代理查找），因此那次
// 快照恒为 undefined，面板会抛 "Cannot read properties of undefined
// (reading 'listGroups')"。本测试固定住"调用前必须等待挂载"这一约定。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

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

// ── react 替身：useEffect 同步执行，useState 记录每次 setter 调用 ──────────────
const setterCalls = []
let stateIndex = 0
const React = {
  useState(initial) {
    const index = stateIndex++
    return [initial, (value) => setterCalls.push({ index, value })]
  },
  useEffect(effect) {
    effect()
  },
  createElement(type, props, children) {
    return { type, props, children }
  }
}

// ── 执行 client.js，取得插件体 ────────────────────────────────────────────────
new Function('window', 'document', source)(globalThis.window, globalThis.document)
assert.equal(typeof capturedFactory, 'function', 'client.js 未通过 __ModuleLoader__ 注册工厂')

const plugin = capturedFactory((id) => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
})
assert.equal(typeof plugin.apply, 'function', '插件体缺少 apply')

// ── cordis 客户端 ctx 替身 ────────────────────────────────────────────────────
const remoteCalls = []
const namespace = {
  listGroups: async () => {
    remoteCalls.push('listGroups')
    return { ok: true, value: { groups: [{ key: 'ws-1' }], debug: 'debug-line' } }
  },
  loadSelection: async () => {
    remoteCalls.push('loadSelection')
    return { ok: true, value: { selected: [] } }
  },
  listUnlinkedGroups: async () => {
    remoteCalls.push('listUnlinkedGroups')
    return { ok: true, value: { groups: [] } }
  },
  baiduStatus: async () => {
    remoteCalls.push('baiduStatus')
    return { ok: true, value: { available: true, loggedIn: false, phase: 'idle', local: null, task: null } }
  }
}

let mounted = false
let contribution
let resolveMount
const mountPromise = new Promise((resolve) => {
  resolveMount = resolve
})

let namespaceLookups = 0
const effects = []
let registered

const ctx = {
  remote: {
    $mount: (value) => {
      contribution = value
      return mountPromise
    }
  },
  get: (key) => {
    if (key !== 'remote.sessionMigrate') return undefined
    namespaceLookups++
    return mounted ? namespace : undefined
  },
  effect: (callback, label) => {
    const disposer = callback()
    effects.push({ label, disposer })
    return disposer
  },
  slots: {
    inject: (name, callback) => callback(),
    register: (spec, component) => {
      registered = { spec, component }
    }
  }
}

plugin.apply(ctx)

// ── 复刻 dsh-typert-registry 的描述符校验（host / client 两侧同形） ────────────
// 规则取自 dsh-typert-registry 的 validateInvocation / validateCodec：描述符缺
// id / service 或 codec 缺 typeSymbol 时，这里读 undefined.length 抛错——正是
// "Cannot read properties of undefined (reading 'length')" 的来源。
function validateNonempty(subject, value) {
  if (value.length === 0) throw new Error('typert: invalid ' + subject + ' — must be nonempty')
}
function validateSegment(subject, value) {
  if (value.length === 0 || value.includes('#')) throw new Error('typert: invalid ' + subject)
}
function validateWireName(subject, value) {
  if (value === '.' || value === '..' || !/^[A-Za-z0-9_$.-]+$/.test(value)) throw new Error('typert: invalid ' + subject)
}
function validateCodec(codec, subject) {
  if (codec.mode === 'src-json') return
  validateNonempty(subject + ' type symbol', codec.typeSymbol)
  if (typeof codec.schema.parse !== 'function') throw new Error('typert: ' + subject + ' strict codec has no parse() method')
}
function validateDescriptor(descriptor) {
  validateNonempty('invocation id', descriptor.id)
  validateSegment('invocation service key', descriptor.service)
  validateWireName('invocation namespace', descriptor.namespace)
  validateWireName('invocation method', descriptor.method)
  validateCodec(descriptor.result, descriptor.id + ' result')
  const wires = new Set()
  for (const parameter of descriptor.parameters) {
    validateWireName('parameter name', parameter.name)
    validateWireName('parameter wire field', parameter.wire)
    if (wires.has(parameter.wire)) throw new Error('typert: ' + descriptor.id + ' repeats wire field ' + parameter.wire)
    wires.add(parameter.wire)
    validateCodec(parameter.codec, descriptor.id + ' parameter ' + parameter.name)
  }
}

// 校验器自检：缺 id 或缺 typeSymbol 的描述符必须被拒绝，否则上面的断言形同虚设
const minimalResult = { mode: 'strict', schema: { parse: (value) => value } }
assert.throws(() => validateDescriptor({
  service: 'sessionMigrate', namespace: 'sessionMigrate', method: 'probe',
  invocation: { kind: 'direct' }, parameters: [], result: minimalResult
}), '缺 id 的描述符应被拒绝')
assert.throws(() => validateDescriptor({
  id: 'session-migrate#probe', service: 'sessionMigrate', namespace: 'sessionMigrate', method: 'probe',
  invocation: { kind: 'direct' }, parameters: [], result: minimalResult
}), '缺 typeSymbol 的 codec 应被拒绝')

// 挂载贡献：8 个 direct 方法，命名空间 sessionMigrate，且必须通过注册表校验
assert.ok(contribution, '$mount 未被调用')
assert.equal(contribution.package, 'session-migrate')
assert.equal(contribution.descriptors.length, 19, '远程描述符数量应为 19')
for (const descriptor of contribution.descriptors) {
  assert.equal(descriptor.namespace, 'sessionMigrate')
  assert.equal(descriptor.service, 'sessionMigrate')
  assert.equal(descriptor.invocation.kind, 'direct')
  assert.doesNotThrow(() => validateDescriptor(descriptor), descriptor.method + ' 的描述符未通过 typert 注册表校验')
}

// 服务端 SRC 模式按 host 方法签名派生 wire 名，客户端的参数必须逐位一致
const hostSource = readFileSync(join(here, '..', 'host.js'), 'utf8')
const expectedWires = {
  listGroups: [], listSessions: ['cwd'], loadSelection: [], saveSelection: ['sessionIds'],
  unarchive: ['id'], deleteWorkspace: ['path'], deleteSession: ['id'], export: ['sessionIds'], import: ['path'],
  listUnlinkedGroups: [], checkRelocation: ['sourceCwd', 'targetCwd'], applyRelocation: ['sourceCwd', 'targetCwd'],
  reconcileMembership: [],
  baiduStatus: [], baiduLoginStart: [], baiduLoginCancel: [], baiduLogout: [],
  baiduUpload: [], baiduDownload: []
}
for (const descriptor of contribution.descriptors) {
  const match = new RegExp('\\n  async ' + descriptor.method + '\\(([^)]*)\\)').exec(hostSource)
  assert.ok(match, 'host.js 缺少方法 ' + descriptor.method)
  const names = match[1].split(',').map((entry) => entry.trim()).filter(Boolean)
  assert.deepEqual(names, expectedWires[descriptor.method], descriptor.method + ' 的 host 方法签名与预期不符')
  assert.deepEqual(descriptor.parameters.map((parameter) => parameter.wire), names,
    descriptor.method + ' 的客户端 wire 名与 host 方法签名不一致')
}
assert.equal(effects.length, 1, '应为挂载句柄注册一个 effect')
assert.equal(effects[0].label, 'session-migrate: remote contribution')
assert.equal(registered.spec.name, 'settings.section')

// ── 渲染面板：挂载完成前，远程调用必须挂起而不是抛错 ──────────────────────────
stateIndex = 0
const Panel = registered.component().type
assert.equal(typeof Panel, 'function', '未取得面板组件')
Panel()

await new Promise((resolve) => setTimeout(resolve, 0))
assert.deepEqual(remoteCalls, [], '挂载完成前不应发出远程调用')
assert.equal(namespaceLookups, 0, '挂载完成前不应解析命名空间')

// ── 完成挂载：挂起的调用应当继续，并把结果交给 React 状态 ─────────────────────
mounted = true
resolveMount(async () => {})
await new Promise((resolve) => setTimeout(resolve, 0))
await new Promise((resolve) => setTimeout(resolve, 0))

assert.deepEqual(
  remoteCalls.sort(),
  ['baiduStatus', 'listGroups', 'listUnlinkedGroups', 'loadSelection'],
  '挂载完成后应发出四个初始调用'
)
const groupsWrite = setterCalls.find((call) => call.index === 0)
assert.ok(groupsWrite, 'groups 状态未被写入')
assert.deepEqual(groupsWrite.value, [{ key: 'ws-1' }], 'groups 状态应收到工作区分组')

// ── 卸载：effect 清理函数应释放挂载 ──────────────────────────────────────────
assert.equal(typeof effects[0].disposer, 'function', 'effect 未返回清理函数')
effects[0].disposer()

console.log('client 装配冒烟测试通过：远程命名空间在挂载完成后才被解析。')

