// host.js 装配冒烟测试。
//
// 固定两条契约：
//   1. 远程端点：服务必须注册，且按宿主 gateway 读取的稳定字符串键写入完整 direct 标记
//      （写不进这个键，gateway 的 collectSrcClaims 就找不到端点，客户端拿到 HTTP 404）。
//   2. 文件层：fingerprint 必须与宿主 fs 服务的 versionOf 同形
//      （dev:ino:size:mtimeNs:ctimeNs），hash 必须是 sha256 大写十六进制——否则已有的
//      export-snapshot.json 会全部失配，旧备份的哈希校验也会失败。
import assert from 'node:assert/strict'
import { writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, inject, name } from '../host.js'

const here = dirname(fileURLToPath(import.meta.url))

assert.equal(name, 'session-migrate')

const expectedMethods = [
  'listGroups', 'listSessions', 'loadSelection', 'saveSelection',
  'unarchive', 'deleteWorkspace', 'export', 'import'
].sort()

// 文件操作改走 node:fs 后，依赖只剩会话查询与工作区注册表（跨平台，不再需要 shell/fs 服务）。
assert.deepEqual(
  [...inject].sort(),
  ['sessionQuery', 'workspaceRegistry'].sort(),
  'host 半边的必需依赖列表发生变化'
)

// 最小 Context 替身：服务现在直接按 Cordis 契约注册，只需 reflect.provide 与 get。
// dshHomePath 是 import/export 的根锚点，这里指向工作区内的临时目录。
const homeDir = join(here, '.tmp-home')
rmSync(homeDir, { recursive: true, force: true })
const provided = new Map()
const ctx = {
  reflect: {
    provide: (key, value) => {
      provided.set(key, value)
      return () => {
        provided.delete(key)
      }
    }
  },
  get: (key) => (key === 'dshHomePath' ? (...segments) => join(homeDir, ...segments) : undefined)
}
await apply(ctx)

const service = provided.get('sessionMigrate')
assert.ok(service, 'sessionMigrate 服务未注册')
assert.equal(service.name, 'sessionMigrate')
assert.equal(service.typertRemote.service, service, 'typertRemote.service 必须指向服务实例本身')
assert.equal(service.typertRemote.serviceKey, 'sessionMigrate')
assert.equal(service.typertRemote.namespace, 'sessionMigrate', 'wire 命名空间必须与客户端描述符一致')

// 宿主 gateway 只认原型上的稳定字符串键描述符。
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
  assert.equal(marker.invocation.kind, 'direct', `${marker.method} 应为 direct 调用`)
  assert.equal(marker.exportName, undefined, `${marker.method} 不应重命名导出`)
}

// ── 文件层契约 ────────────────────────────────────────────────────────────────
const workDir = join(here, '.tmp-fs')
rmSync(workDir, { recursive: true, force: true })

await service.writeTextEnsured(join(workDir, 'a', 'snapshot.json'), JSON.stringify({ ok: true }))
assert.equal(JSON.parse(await service.fsReadText(join(workDir, 'a', 'snapshot.json'))).ok, true)
assert.equal(await service.fsExists(join(workDir, 'a', 'snapshot.json')), true)
assert.equal(await service.fsExists(join(workDir, 'missing.json')), false)

const probe = join(workDir, 'probe.jsonl')
writeFileSync(probe, 'hello')
const info = await service.fileVersion(probe)
assert.match(info.version, /^\d+:\d+:\d+:\d+:\d+$/, 'fingerprint 必须与 dsh-fs-local 的 versionOf 同形')
assert.equal(info.size, 5)

// Get-FileHash 的替代实现：sha256 大写十六进制，与已有 index.json 的哈希可直接比较。
assert.match(await service.hashFile(probe), /^[0-9A-F]{64}$/)

// 拷贝必须自动建父目录（原 PowerShell 版靠 New-Item -Force 做到这一点）。
await service.copyFileEnsured(probe, join(workDir, 'nested', 'deep', 'copy.jsonl'))
assert.equal(await service.fsExists(join(workDir, 'nested', 'deep', 'copy.jsonl')), true)

// clearDir 与原实现同语义：保留点文件，清掉其余条目。
writeFileSync(join(workDir, '.keep'), 'x')
await service.clearDir(workDir)
assert.equal(await service.fsExists(join(workDir, '.keep')), true, 'clearDir 不应删除点文件')
assert.equal(await service.fsExists(probe), false, 'clearDir 应删除普通条目')

await service.removePath(workDir)
assert.equal(await service.fsExists(workDir), false)

// ── 导入必须覆盖已存在的会话 ──────────────────────────────────────────────────
// 回归：import 曾经写的是"目标已存在就 skipped"，于是"恢复"退化成只能补缺失的会话，
// 用户回滚不了任何改动（本机实测：加了新对话再导入，session.v3.jsonl.zstd 根本没被替换）。
const backupRelative = 'sessions/_no-cwd/session-probe-0002/session.v3.jsonl.zstd'
const exportDir = join(homeDir, 'session-migrate', 'exports')
const backupFile = join(exportDir, ...backupRelative.split('/'))
await service.writeTextEnsured(backupFile, 'BACKUP-V1')
const backupHash = await service.hashFile(backupFile)
await service.writeTextEnsured(join(exportDir, 'index.json'), JSON.stringify({
  format: 'dsh-sessions-export',
  version: 2,
  exportedAt: 1,
  errors: [],
  sessions: [{
    id: 'session-probe-0002',
    cwd: null,
    projectDir: '_no-cwd',
    sessionSegment: 'session-probe-0002',
    fileName: 'session.v3.jsonl.zstd',
    relativePath: backupRelative,
    hash: backupHash,
    fingerprint: null,
    size: null,
    archived: false
  }]
}))

// 现场：同 id 的会话已被改动（内容与备份不同）
const liveFile = join(homeDir, 'sessions', '_no-cwd', 'session-probe-0002', 'session.v3.jsonl.zstd')
await service.writeTextEnsured(liveFile, 'LIVE-V2')
assert.equal(await service.fsReadText(liveFile), 'LIVE-V2')

const importResult = await service.import(exportDir)
assert.deepEqual(importResult.errors, [], '导入不应报错')
assert.equal(importResult.imported, 0, '已存在的会话不计入新增')
assert.equal(importResult.overwritten, 1, '已存在的会话必须被覆盖')
assert.equal(await service.fsReadText(liveFile), 'BACKUP-V1', '导入后本地内容必须回到备份版本')

// 再导入一次：此时目标已等于备份，仍应记为覆盖（语义是"以备份为准"，不是"只补缺失"）。
const second = await service.import(exportDir)
assert.equal(second.overwritten, 1)
assert.equal(await service.fsReadText(liveFile), 'BACKUP-V1')

rmSync(homeDir, { recursive: true, force: true })

console.log('host 装配冒烟测试通过：服务注册、字符串键标记、文件层契约、导入覆盖语义均符合宿主要求。')
