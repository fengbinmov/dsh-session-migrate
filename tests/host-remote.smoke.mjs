// host.js 装配冒烟测试：验证 host 半边在当前 typert-protocol 版本下确实注册了
// sessionMigrate 服务，并且 Remote 装饰器 shim 在原型上留下了完整的 direct 标记。
//
// 回归目标：host.js 用 `Remote(method)(null, {...})` 手工模拟 stage-3 装饰器。
// 协议包升级后若描述符版本或校验规则变化，标记会静默丢失，客户端就会看到
// 一个没有方法的命名空间。
import assert from 'node:assert/strict'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { apply, inject, name } from '../host.js'

assert.equal(name, 'session-migrate')

const expectedMethods = [
  'listGroups', 'listSessions', 'loadSelection', 'saveSelection',
  'unarchive', 'deleteWorkspace', 'export', 'import'
].sort()

// 必需依赖：Cordis 会等到这些服务全部就绪才启动插件体。
assert.deepEqual(
  [...inject].sort(),
  ['fs', 'sandboxPolicy', 'sessionQuery', 'shell', 'workspaceRegistry'].sort(),
  'host 半边的必需依赖列表发生变化'
)

// 最小 Context 替身：Service 基类在构造时只要求 reflect.provide 可用；其余依赖
// 服务缺失只会让可选字段保持 undefined，不影响 Remote 标记。
const provided = new Map()
const ctx = {
  reflect: {
    provide: (key, value) => {
      provided.set(key, value)
    }
  },
  get: () => undefined
}
apply(ctx)

const service = provided.get('sessionMigrate')
assert.ok(service, 'sessionMigrate 服务未注册')
assert.equal(service.name, 'sessionMigrate')
assert.equal(service.typertRemote.namespace, 'sessionMigrate', 'wire 命名空间必须与客户端描述符一致')
assert.equal(service.typertRemote.serviceKey, 'sessionMigrate')

const markers = remoteMethods(service)
assert.deepEqual(
  markers.map((marker) => marker.method).sort(),
  expectedMethods,
  'Remote 标记缺失或多余'
)
for (const marker of markers) {
  assert.equal(marker.invocation.kind, 'direct', `${marker.method} 应为 direct 调用`)
  assert.equal(marker.exportName, undefined, `${marker.method} 不应重命名导出`)
}

// 宿主 gateway（typert-protocol 0.1.5）只认原型上的稳定字符串键描述符：
// collectSrcClaims() 用它决定 /api/<namespace>/<method> 是否被认领，读不到就是 HTTP 404。
// 而本仓库解析到的副本可能是 0.1.0-rc.6（标记存模块私有 WeakMap，宿主读不到），
// 所以 host.js 必须同时写出这份描述符——这里把该契约固定下来。
const DESCRIPTOR_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'
const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service), DESCRIPTOR_KEY)
assert.ok(descriptor, '原型上缺少宿主 gateway 读取的稳定字符串键描述符')
assert.equal(descriptor.value.version, 1, '描述符版本必须为 1')
assert.deepEqual(
  descriptor.value.methods.map((marker) => marker.method).sort(),
  expectedMethods,
  '字符串键描述符中的方法集合不完整'
)
for (const marker of descriptor.value.methods) {
  assert.equal(marker.invocation.kind, 'direct', `${marker.method} 在字符串键描述符中应为 direct`)
}

console.log('host 装配冒烟测试通过：8 个 direct 远程方法已同时写入两代标记契约。')
