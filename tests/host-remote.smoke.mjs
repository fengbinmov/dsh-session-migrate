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
import { stat } from 'node:fs/promises'
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
// 会话查询替身：会话记录（header.id / header.cwd）由测试直接控制，这样才能构造
// 「查询里还有这条记录、但磁盘上的日志文件已经没了」这种需要被清理掉的状态。
const homeDir = join(here, '.tmp-home')
rmSync(homeDir, { recursive: true, force: true })
const sessions = new Map()
const provided = new Map()
const attached = []
const createCalls = []
// 工作区注册表替身：create() 像真实实现那样要求路径是已存在的目录
// （真实实现走 realpathNormalize + stat().isDirectory()），
// 这样"目标机器上还没有这个工作区目录"的分支才会被真正走到。
const workspaceRegistry = {
  archivedSessionIds: [],
  list: () => [],
  create: async (path) => {
    const info = await stat(path).catch(() => null)
    if (info === null || !info.isDirectory()) {
      createCalls.push({ path, ok: false })
      throw new Error(`cannot create a workspace at '${path}': path is not a directory`)
    }
    createCalls.push({ path, ok: true })
    return {
      attachSession: async (id) => {
        attached.push(id)
      }
    }
  }
}
const ctx = {
  reflect: {
    provide: (key, value) => {
      provided.set(key, value)
      return () => {
        provided.delete(key)
      }
    }
  },
  get: (key) => {
    if (key === 'dshHomePath') return (...segments) => join(homeDir, ...segments)
    if (key === 'sessionQuery') return { listSessions: async () => [...sessions.values()] }
    if (key === 'workspaceRegistry') return workspaceRegistry
    return undefined
  }
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
assert.equal(importResult.imported, 0, '已存在的会话不计入新增')
assert.equal(importResult.overwritten, 1, '已存在的会话必须被覆盖')
assert.equal(await service.fsReadText(liveFile), 'BACKUP-V1', '导入后本地内容必须回到备份版本')

// 再导入一次：此时目标已等于备份，仍应记为覆盖（语义是"以备份为准"，不是"只补缺失"）。
const second = await service.import(exportDir)
assert.equal(second.overwritten, 1)
assert.equal(await service.fsReadText(liveFile), 'BACKUP-V1')

// ── 目标机器上完全没有这些目录区域时，导入必须把它们建出来 ─────────────────────
// 这是"从备份恢复"最核心的场景：DSH 目录里根本没有 sessions/<projectDir>/<segment>/，
// 正是要靠导入把它恢复出来。
const freshRelative = 'sessions/--fresh-project--/session-probe-0003/session.v3.jsonl.zstd'
const freshBackup = join(exportDir, ...freshRelative.split('/'))
await service.writeTextEnsured(freshBackup, 'FRESH-BACKUP')
const freshHash = await service.hashFile(freshBackup)
await service.writeTextEnsured(join(exportDir, 'index.json'), JSON.stringify({
  format: 'dsh-sessions-export',
  version: 2,
  exportedAt: 1,
  sessions: [{
    id: 'session-probe-0003',
    cwd: null,
    projectDir: '--fresh-project--',
    sessionSegment: 'session-probe-0003',
    fileName: 'session.v3.jsonl.zstd',
    relativePath: freshRelative,
    hash: freshHash,
    fingerprint: null,
    size: null,
    archived: false
  }]
}))

const freshLive = join(homeDir, 'sessions', '--fresh-project--', 'session-probe-0003', 'session.v3.jsonl.zstd')
assert.equal(await service.fsExists(freshLive), false, '前置条件：目标目录区域不存在')
const freshResult = await service.import(exportDir)
assert.equal(freshResult.imported, 1, '目录区域不存在也必须恢复成功')
assert.equal(freshResult.detached, 0)
assert.equal(await service.fsReadText(freshLive), 'FRESH-BACKUP', '导入必须创建目录区域并写回文件')

// 会话带 cwd，而目标机器上这个工作区目录还不存在：必须先补建目录，再注册归属。
const wsCwd = join(homeDir, 'fresh-workspace')
const wsProject = service.projSeg(wsCwd)
const wsRelative = 'sessions/' + wsProject + '/session-probe-0004/session.v3.jsonl.zstd'
const wsBackup = join(exportDir, ...wsRelative.split('/'))
await service.writeTextEnsured(wsBackup, 'WS-BACKUP')
const wsHash = await service.hashFile(wsBackup)
await service.writeTextEnsured(join(exportDir, 'index.json'), JSON.stringify({
  format: 'dsh-sessions-export',
  version: 2,
  exportedAt: 1,
  sessions: [{
    id: 'session-probe-0004',
    cwd: wsCwd,
    projectDir: wsProject,
    sessionSegment: 'session-probe-0004',
    fileName: 'session.v3.jsonl.zstd',
    relativePath: wsRelative,
    hash: wsHash,
    fingerprint: null,
    size: null,
    archived: false
  }]
}))

assert.equal(await service.fsExists(wsCwd), false, '前置条件：工作区目录不存在')
const wsResult = await service.import(exportDir)
assert.equal(wsResult.imported, 1)
assert.equal(wsResult.detached, 0, '工作区目录应当被补建出来，归属恢复不该失败')
assert.deepEqual(attached, ['session-probe-0004'], '会话必须挂到补建出来的工作区上')
assert.equal(await service.fsExists(wsCwd), true, '工作区目录必须被创建')
assert.equal(
  await service.fsReadText(join(homeDir, 'sessions', wsProject, 'session-probe-0004', 'session.v3.jsonl.zstd')),
  'WS-BACKUP'
)
// 证明"补建目录"这条分支确实被走到：第一次注册因目录不存在失败，补建后成功。
assert.equal(createCalls.filter((call) => !call.ok).length, 1, '第一次注册应因目录不存在而失败')
assert.equal(createCalls.filter((call) => call.ok).length, 1, '补建目录后应注册成功')

// ── 导入出来的会话必须自动进入勾选状态 ────────────────────────────────────────
// 备份本身就是从一份勾选列表导出的，恢复之后却显示成未勾选，用户还得回去逐个勾。
const selectionAfterImport = JSON.parse(await service.fsReadText(join(homeDir, 'session-migrate', 'selection.json')))
for (const id of ['session-probe-0002', 'session-probe-0003', 'session-probe-0004']) {
  assert.ok(selectionAfterImport.selected.includes(id), `导入的会话 ${id} 必须被自动勾选`)
}
// 关键：这几个会话都不在会话查询结果里（模拟"刚导入还没进索引"），
// loadSelection 必须按磁盘文件判定而保留它们，否则刚勾上的立刻又被清空。
const selectionViaLoad = await service.loadSelection()
for (const id of ['session-probe-0002', 'session-probe-0003', 'session-probe-0004']) {
  assert.ok(selectionViaLoad.selected.includes(id), `刚导入的 ${id} 不得被判为无效而清理`)
}
// 并入而不是覆盖：用户原本勾选的其他会话不该被导入清掉。
await service.saveSelection(['session-keep-me', 'session-probe-0004'])
await service.import(exportDir)
const mergedSelection = JSON.parse(await service.fsReadText(join(homeDir, 'session-migrate', 'selection.json')))
assert.ok(mergedSelection.selected.includes('session-keep-me'), '导入不得清掉用户原有的勾选')
assert.ok(mergedSelection.selected.includes('session-probe-0004'), '导入的会话仍在勾选里')

// ── 读取配置时的防御性清理 ────────────────────────────────────────────────────
// 配置里引用的会话如果已经不在磁盘上，读取时就该把它删掉并写回配置文件，
// 而不是留着让列表去呈现一个读不到状态的条目，也不该因此报错。
const goodId = 'session-probe-good'
const ghostId = 'session-probe-ghost'
await service.writeTextEnsured(join(homeDir, 'sessions', '_no-cwd', goodId, 'session.v3.jsonl.zstd'), 'GOOD')
sessions.set(goodId, { header: { id: goodId, cwd: null } })
sessions.set(ghostId, { header: { id: ghostId, cwd: null } }) // 记录在，但磁盘上没有日志文件

const snapshotPath = join(homeDir, 'session-migrate', 'export-snapshot.json')
await service.writeTextEnsured(snapshotPath, JSON.stringify({
  exportedAt: 1,
  exportDir: 'exports',
  byWorkspace: {
    __orphan__: {
      sessionIds: [goodId, ghostId],
      fingerprints: { [goodId]: 'v1', [ghostId]: 'v2' },
      sizes: { [goodId]: 1, [ghostId]: 2 }
    }
  }
}))

const snapshot = await service.readSnapshot()
assert.deepEqual(snapshot.byWorkspace.__orphan__.sessionIds, [goodId], '磁盘上已消失的会话必须从快照里剔除')
assert.equal(snapshot.byWorkspace.__orphan__.fingerprints[ghostId], undefined)
assert.equal(snapshot.byWorkspace.__orphan__.sizes[ghostId], undefined)
const persistedSnapshot = JSON.parse(await service.fsReadText(snapshotPath))
assert.deepEqual(persistedSnapshot.byWorkspace.__orphan__.sessionIds, [goodId], '清理结果必须写回快照文件')

// 工作区不在注册表里（典型：刚从备份导入、注册尚未重建）时，只要会话文件确实还在，
// 这条记录就必须保留——否则刚恢复完的会话会立刻显示成"未导出"。
const recoveredWs = join(homeDir, 'recovered-workspace')
const recoveredProj = service.projSeg(recoveredWs)
const recoveredId = 'session-probe-0005'
sessions.set(recoveredId, { header: { id: recoveredId, cwd: recoveredWs } })
await service.writeTextEnsured(join(homeDir, 'sessions', recoveredProj, recoveredId, 'session.v3.jsonl.zstd'), 'RECOVERED')
await service.writeTextEnsured(snapshotPath, JSON.stringify({
  exportedAt: 1,
  exportDir: 'exports',
  byWorkspace: {
    [recoveredWs]: {
      sessionIds: [recoveredId],
      fingerprints: { [recoveredId]: 'v9' },
      sizes: { [recoveredId]: 8 }
    }
  }
}))
const recovered = await service.readSnapshot()
assert.deepEqual(
  recovered.byWorkspace[recoveredWs].sessionIds,
  [recoveredId],
  '工作区未注册但会话文件仍在时，快照记录必须保留'
)
assert.equal(recovered.byWorkspace[recoveredWs].fingerprints[recoveredId], 'v9')

const selectionPath = join(homeDir, 'session-migrate', 'selection.json')
await service.writeTextEnsured(selectionPath, JSON.stringify({ selected: [goodId, ghostId] }))
const selection = await service.loadSelection()
assert.deepEqual(selection.selected, [goodId], '已消失的会话必须从选择里剔除')
const persistedSelection = JSON.parse(await service.fsReadText(selectionPath))
assert.deepEqual(persistedSelection.selected, [goodId], '清理结果必须写回选择文件')

// 导出时的无效选中项静默跳过，索引里不出现任何错误条目。
const exportResult = await service.export([goodId, ghostId, 'session-not-exist-at-all'])
assert.equal(exportResult.sessionCount, 1, '只有真实存在的会话会被导出')
assert.equal(exportResult.errors, undefined, '导出结果不应带 errors 字段')
const exportedIndex = JSON.parse(await service.fsReadText(join(exportDir, 'index.json')))
assert.equal(exportedIndex.errors, undefined, '索引用不应写 errors 字段')
assert.deepEqual(exportedIndex.sessions.map((s) => s.id), [goodId])

rmSync(homeDir, { recursive: true, force: true })

console.log('host 装配冒烟测试通过：服务注册、字符串键标记、文件层契约、导入覆盖语义、配置清理均符合宿主要求。')
