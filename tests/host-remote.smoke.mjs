// host.js 装配冒烟测试。
//
// 固定两条契约：
//   1. 远程端点：服务必须注册，且按宿主 gateway 读取的稳定字符串键写入完整 direct 标记
//      （写不进这个键，gateway 的 collectSrcClaims 就找不到端点，客户端拿到 HTTP 404）。
//   2. 文件层：fingerprint 必须与宿主 fs 服务的 versionOf 同形
//      （dev:ino:size:mtimeNs:ctimeNs），hash 必须是 sha256 大写十六进制——否则已有的
//      export-snapshot.json 会全部失配，旧备份的哈希校验也会失败。
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { apply, inject, name } from '../host.js'

const here = dirname(fileURLToPath(import.meta.url))

assert.equal(name, 'session-migrate')

const expectedMethods = [
  'listGroups', 'listSessions', 'loadSelection', 'saveSelection',
  'unarchive', 'deleteWorkspace', 'export', 'import',
  'listUnlinkedGroups', 'checkRelocation', 'applyRelocation', 'reconcileMembership'
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
const wsList = []
// 工作区注册表替身：create() 像真实实现那样要求路径是已存在的目录
// （真实实现走 realpathNormalize + stat().isDirectory()），
// 这样"目标机器上还没有这个工作区目录"的分支才会被真正走到。
const workspaceRegistry = {
  archivedSessionIds: [],
  list: () => wsList,
  create: async (path) => {
    const info = await stat(path).catch(() => null)
    if (info === null || !info.isDirectory()) {
      createCalls.push({ path, ok: false })
      throw new Error(`cannot create a workspace at '${path}': path is not a directory`)
    }
    createCalls.push({ path, ok: true })
    // 模拟真实注册表：注册成功后该工作区会出现在 list() 里（"未关联"判定要依赖这一点）。
    if (!wsList.some((entry) => entry.path === path)) {
      wsList.push({ path, title: path, sessionIds: [] })
    }
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

// ── 读会话 header：重定位功能的地基 ───────────────────────────────────────────
// 会话日志是「一帧一段 JSONL」的多帧 zstd，header 单独占第一帧，所以只解第一帧
// 就能拿到 id / cwd——不必解开后面的事件内容，也不依赖会话查询服务。
const hdrCwd = 'E:\\AI\\probe-workspace'
const hdrId = 'session-probe-hdr'
const hdrDir = join(homeDir, 'sessions', service.projSeg(hdrCwd), hdrId)
mkdirSync(hdrDir, { recursive: true })
const hdrFile = join(hdrDir, 'session.v3.jsonl.zstd')
writeFileSync(hdrFile, Buffer.concat([
  zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 3, id: hdrId, cwd: hdrCwd }) + '\n')),
  zstdCompressSync(Buffer.from(JSON.stringify({ type: 'message', text: 'hello' }) + '\n'))
]))
assert.deepEqual(
  await service.readSessionHeader(hdrFile),
  { id: hdrId, cwd: hdrCwd },
  '必须能从第一帧读出 header 的 id 与 cwd（第二帧不参与）'
)

// 容错：非法帧、缺失文件都只返回 null，绝不抛错。
const brokenFile = join(hdrDir, 'broken.jsonl.zstd')
writeFileSync(brokenFile, Buffer.from('this is definitely not a zstd frame'))
assert.equal(await service.readSessionHeader(brokenFile), null, '非法帧必须返回 null')
assert.equal(await service.readSessionHeader(join(hdrDir, 'missing.jsonl.zstd')), null, '缺失文件必须返回 null')

// 无 cwd 的会话（DSH 自己的 orphan）要能读出，并把 cwd 归一成 null。
const noCwdId = 'session-probe-hdr-nocwd'
const noCwdFile = join(homeDir, 'sessions', '_no-cwd', noCwdId, 'session.v3.jsonl.zstd')
mkdirSync(dirname(noCwdFile), { recursive: true })
writeFileSync(noCwdFile, zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 3, id: noCwdId }) + '\n')))
assert.deepEqual(await service.readSessionHeader(noCwdFile), { id: noCwdId, cwd: null }, '无 cwd 的会话应返回 cwd: null')

// ── 勾选会话时，记录里的 cwd 必须被显式写下来 ─────────────────────────────────
// 回归：cwd 曾经只在"配过重映射"时才有值，平时是 null——那样导入时就没有依据可读，
// 只能靠"会话自己的 header"去推断。cwd 记的应该是"这组会话该落到哪个工作区路径"。
const groupSelectionPath = join(homeDir, 'session-migrate', 'selection.json')
await service.saveSelection([hdrId])
const savedSelection = JSON.parse(await service.fsReadText(groupSelectionPath))
assert.equal(savedSelection.groups.length, 1, '一个工作区一条记录')
assert.equal(savedSelection.groups[0].cwd, hdrCwd, '勾选后必须把该组的目标路径显式存进 cwd')
assert.deepEqual(savedSelection.groups[0].sessionIds, [hdrId], '会话要记在同一条记录里')

// 没配重映射时，cwd 就是会话自己的 cwd；配过之后才变成目标路径。
await service.setRelocationFor([hdrId], 'D:\\relocated\\probe-workspace')
const relocatedSelection = JSON.parse(await service.fsReadText(groupSelectionPath))
assert.equal(relocatedSelection.groups[0].cwd, 'D:\\relocated\\probe-workspace', '配过重映射后 cwd 应变成目标路径')

// ── 同一个 cwd 的会话必须归在同一条记录里 ────────────────────────────────────
// 回归：曾经对"从旧记录继承来的目标"和"按真实 cwd 归组"用了不同的分组键前缀，
// 于是同一个 cwd 裂成两条记录（cwd 值一模一样、只是来源不同），导入时按 id 查目标
// 也会对不上。这里刻意让第一个会话先建立记录、第二个后加入。
const hdrId2 = 'session-probe-hdr-2'
const hdrDir2 = join(homeDir, 'sessions', service.projSeg(hdrCwd), hdrId2)
mkdirSync(hdrDir2, { recursive: true })
writeFileSync(
  join(hdrDir2, 'session.v3.jsonl.zstd'),
  zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 3, id: hdrId2, cwd: hdrCwd }) + '\n'))
)
// 先把可能残留的重映射清掉，让两个会话都按真实 cwd 归组。
await service.setRelocationFor([hdrId], '')
await service.saveSelection([hdrId])
await service.saveSelection([hdrId, hdrId2])
const sameCwdSelection = JSON.parse(await service.fsReadText(join(homeDir, 'session-migrate', 'selection.json')))
assert.equal(sameCwdSelection.groups.length, 1, '同一个 cwd 的会话必须合并成一条记录')
assert.equal(sameCwdSelection.groups[0].cwd, hdrCwd)
assert.deepEqual(sameCwdSelection.groups[0].sessionIds.slice().sort(), [hdrId, hdrId2].sort())

// 重新配上一个重映射：还没应用时它仍属于"未关联工作区"，但必须能读回已配的目标。
await service.setRelocationFor([hdrId], 'D:\\relocated\\probe-workspace')
const unlinkedAfterRelocate = await service.listUnlinkedGroups()
const probeGroup = unlinkedAfterRelocate.groups.find((group) => group.cwd === hdrCwd)
assert.ok(probeGroup, '配了重映射但尚未应用的会话仍属于未关联工作区')
assert.equal(probeGroup.mappedTo, 'D:\\relocated\\probe-workspace', '未关联区必须能读出已配的重映射目标')

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
const freshProject = service.projSeg(null)
const freshRelative = 'sessions/' + freshProject + '/session-probe-0003/session.v3.jsonl.zstd'
const freshBackup = join(exportDir, ...freshRelative.split('/'))
await service.writeTextEnsured(freshBackup, 'FRESH-BACKUP')
const freshHash = await service.hashFile(freshBackup)
// v3 索引：不再有 projectDir / sessionSegment / relativePath，落位必须现算出来。
await service.writeTextEnsured(join(exportDir, 'index.json'), JSON.stringify({
  format: 'dsh-sessions-export',
  version: 3,
  exportedAt: 1,
  sessions: [{
    id: 'session-probe-0003',
    cwd: null,
    fileName: 'session.v3.jsonl.zstd',
    hash: freshHash,
    fingerprint: null,
    archived: false
  }]
}))

const freshLive = join(homeDir, 'sessions', freshProject, 'session-probe-0003', 'session.v3.jsonl.zstd')
assert.equal(await service.fsExists(freshLive), false, '前置条件：目标目录区域不存在')
const freshResult = await service.import(exportDir)
assert.equal(freshResult.imported, 1, '目录区域不存在也必须恢复成功')
assert.equal(freshResult.detached, 0)
assert.equal(await service.fsReadText(freshLive), 'FRESH-BACKUP', '导入必须创建目录区域并写回文件')

// v2 备份带着导出时的目录名，可能与现算的不同（旧规则放的）——必须靠按键名扫一遍兜底。
// 落位仍然按当前规则现算，因为 DSH 自己就是按当前规则校验"日志与路径是否相符"的。
const legacyProject = '--legacy-layout--'
const legacyRelative = 'sessions/' + legacyProject + '/session-probe-0006/session.v3.jsonl.zstd'
const legacyBackup = join(exportDir, ...legacyRelative.split('/'))
await service.writeTextEnsured(legacyBackup, 'LEGACY-BACKUP')
const legacyHash = await service.hashFile(legacyBackup)
await service.writeTextEnsured(join(exportDir, 'index.json'), JSON.stringify({
  format: 'dsh-sessions-export',
  version: 2,
  exportedAt: 1,
  sessions: [{
    id: 'session-probe-0006',
    cwd: null,
    projectDir: legacyProject,
    sessionSegment: 'session-probe-0006',
    fileName: 'session.v3.jsonl.zstd',
    relativePath: legacyRelative,
    hash: legacyHash,
    fingerprint: null,
    archived: false
  }]
}))
const legacyResult = await service.import(exportDir)
assert.equal(legacyResult.imported, 1, 'v2 备份必须仍然能导入')
const legacyLive = join(homeDir, 'sessions', service.projSeg(null), 'session-probe-0006', 'session.v3.jsonl.zstd')
assert.equal(
  await service.fsReadText(legacyLive),
  'LEGACY-BACKUP',
  'v2 备份的源文件要能被兜底扫描找到，落位按当前规则现算'
)

// ── 被跳过的条目必须报出来 ────────────────────────────────────────────────────
// 跨机器同步备份时最常见的失手：只同步了 index.json 而漏掉 sessions/。
// 以前它表现为"导入成功但一个会话都没进来"，用户完全不知道原因。
const skipProject = service.projSeg(null)
await service.writeTextEnsured(
  join(exportDir, 'sessions', skipProject, 'session-skip-1', 'session.v3.jsonl.zstd'), 'PRESENT'
)
await service.writeTextEnsured(
  join(exportDir, 'sessions', skipProject, 'session-skip-bad', 'session.v3.jsonl.zstd'), 'BAD-HASH'
)
const entry = (id, hash) => ({ id: id, cwd: null, fileName: 'session.v3.jsonl.zstd', hash: hash, fingerprint: null, archived: false })
await service.writeTextEnsured(join(exportDir, 'index.json'), JSON.stringify({
  format: 'dsh-sessions-export',
  version: 3,
  exportedAt: 1,
  sessions: [
    entry('session-skip-1', null), // 文件在，正常导入
    entry('session-skip-2', null), // 索引里有，备份里没有文件
    entry('session-skip-bad', 'DEADBEEF') // 文件在，但哈希对不上
  ]
}))
const skipResult = await service.import(exportDir)
assert.equal(skipResult.imported, 1, '文件齐备的那个要正常导入')
assert.equal(skipResult.skipped, 2, '找不到文件的与哈希不符的都要计入 skipped')
assert.equal(skipResult.skippedItems.length, 2, '跳过明细要一并返回')
const skipReasons = skipResult.skippedItems.map((item) => item.reason).join(' | ')
assert.ok(skipReasons.includes('找不到'), '要说明是备份里找不到文件')
assert.ok(skipReasons.includes('哈希'), '要说明是内容与哈希不符')

// ── 同一工作区里"新出现的会话"要跟着已配过的落位自动走 ────────────────────────
// 场景：在另一台机器上于**已有工作区**里开了新对话。备份里两个会话共享同一个 cwd，
// 老会话在本机已配过落位（selection.json 有记录），新会话是新 id、本机没有记录——
// 它应该直接落到同一个本机目标，而不是再进"未关联"让用户重配一遍映射。
// 本段用自己的备份目录，并在结束时恢复 selection.json——后面的用例依赖这里攒下的勾选。
const sharedExportDir = join(homeDir, 'shared-export')
const selectionSnapshotPath = join(homeDir, 'session-migrate', 'selection.json')
const selectionBackup = await service.fsExists(selectionSnapshotPath)
  ? await service.fsReadText(selectionSnapshotPath)
  : null
const sharedMacCwd = '/Users/fengb/Codes/AI/shared-proj'
const sharedWinCwd = join(homeDir, 'shared-proj')
mkdirSync(sharedWinCwd, { recursive: true })
const knownId = 'session-shared-old'
const freshSharedId = 'session-shared-new'
const sharedWinProj = service.projSeg(sharedWinCwd)
await service.writeTextEnsured(join(homeDir, 'sessions', sharedWinProj, knownId, 'session.v3.jsonl.zstd'), 'OLD')
await service.writeTextEnsured(join(homeDir, 'session-migrate', 'selection.json'), JSON.stringify({
  groups: [{ cwd: sharedWinCwd, sessionIds: [knownId] }]
}))
const sharedMacProj = service.projSeg(sharedMacCwd)
for (const id of [knownId, freshSharedId]) {
  await service.writeTextEnsured(
    join(sharedExportDir, 'sessions', sharedMacProj, id, 'session.v3.jsonl.zstd'), 'CONTENT-' + id
  )
}
const sharedEntry = (id) => ({ id: id, cwd: sharedMacCwd, fileName: 'session.v3.jsonl.zstd', hash: null, fingerprint: null, archived: false })
await service.writeTextEnsured(join(sharedExportDir, 'index.json'), JSON.stringify({
  format: 'dsh-sessions-export',
  version: 3,
  exportedAt: 1,
  sessions: [sharedEntry(knownId), sharedEntry(freshSharedId)]
}))
const sharedResult = await service.import(sharedExportDir)
assert.equal(sharedResult.imported, 1, '新会话应当被导入')
assert.equal(sharedResult.overwritten, 1, '老会话应当被覆盖')
assert.equal(sharedResult.detached, 0, '新会话必须跟着同工作区已配过的落位走，不能掉进未关联')
assert.equal(
  await service.fsExists(join(homeDir, 'sessions', sharedWinProj, freshSharedId, 'session.v3.jsonl.zstd')),
  true,
  '新会话必须落在与老会话相同的本机工作区下'
)
assert.equal(
  await service.fsExists(join(homeDir, 'sessions', sharedMacProj, freshSharedId, 'session.v3.jsonl.zstd')),
  false,
  '不应按备份里的 Mac 路径落位'
)
if (selectionBackup !== null) {
  await service.writeTextEnsured(selectionSnapshotPath, selectionBackup)
}

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

// 每条用例自己清掉累计的调用记录，这样断言只需关心本段触发的调用。
attached.length = 0
createCalls.length = 0
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
// selection.json 现在是 { groups: [{ cwd, sessionIds }] }（没有工作区主键），
// 用 loadSelection 取扁平列表即可——它的接口刻意没变。
const selectionAfterImport = await service.loadSelection()
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
// 这里必须用真实存在的会话文件——假 id 会被"配置自我收敛"正确地清掉（那是另一条行为）。
const keepId = 'session-probe-keep'
await service.writeTextEnsured(join(homeDir, 'sessions', '_no-cwd', keepId, 'session.v3.jsonl.zstd'), 'KEEP')
await service.saveSelection([keepId, 'session-probe-0004'])
await service.import(exportDir)
const mergedSelection = await service.loadSelection()
assert.ok(mergedSelection.selected.includes(keepId), '导入不得清掉用户原有的勾选')
assert.ok(mergedSelection.selected.includes('session-probe-0004'), '导入的会话仍在勾选里')

// ── 读取配置时的防御性清理 ────────────────────────────────────────────────────
// 配置里引用的会话如果已经不在磁盘上，读取时就该把它删掉并写回配置文件，
// 而不是留着让列表去呈现一个读不到状态的条目，也不该因此报错。
const goodId = 'session-probe-good'
const ghostId = 'session-probe-ghost'
await service.writeTextEnsured(join(homeDir, 'sessions', '_no-cwd', goodId, 'session.v3.jsonl.zstd'), 'GOOD')
sessions.set(goodId, { header: { id: goodId, cwd: null } })
sessions.set(ghostId, { header: { id: ghostId, cwd: null } }) // 记录在，但磁盘上没有日志文件

const selectionPath = join(homeDir, 'session-migrate', 'selection.json')
await service.writeTextEnsured(selectionPath, JSON.stringify({ selected: [goodId, ghostId] }))
const selection = await service.loadSelection()
assert.deepEqual(selection.selected, [goodId], '已消失的会话必须从选择里剔除')
const persistedSelection = JSON.parse(await service.fsReadText(selectionPath))
const persistedIds = persistedSelection.groups.flatMap((group) => group.sessionIds)
assert.deepEqual(persistedIds, [goodId], '清理结果必须写回选择文件')

// 导出时的无效选中项静默跳过，索引里不出现任何错误条目。
const exportResult = await service.export([goodId, ghostId, 'session-not-exist-at-all'])
assert.equal(exportResult.sessionCount, 1, '只有真实存在的会话会被导出')
assert.equal(exportResult.errors, undefined, '导出结果不应带 errors 字段')
const exportedIndex = JSON.parse(await service.fsReadText(join(exportDir, 'index.json')))
assert.equal(exportedIndex.errors, undefined, '索引用不应写 errors 字段')
assert.deepEqual(exportedIndex.sessions.map((s) => s.id), [goodId])
// 索引里不再重复存 size——fingerprint 的第 3 段就是它。
assert.equal(exportedIndex.sessions[0].size, undefined, '索引里不应再单独存 size（fingerprint 已含）')
assert.equal(
  await service.fsExists(join(homeDir, 'session-migrate', 'export-snapshot.json')),
  false,
  '不应再产生重复的 export-snapshot.json'
)

// ── 导出索引只保留"不可派生"的字段 ────────────────────────────────────────────
// sessionSegment 对 session-<uuid> 恒等于 id；relativePath 由 projectDir + 段 + 文件名
// 拼得出来；createdAt 等元数据会话 header 里本来就有。这些都不该再抄一遍。
assert.equal(exportedIndex.version, 3, '导出索引格式版本应为 3')
assert.deepEqual(
  Object.keys(exportedIndex.sessions[0]).sort(),
  ['archived', 'cwd', 'fileName', 'fingerprint', 'hash', 'id'],
  '索引只写不可派生的字段（目录名一律现算）'
)

// v3 索引没有 sessionSegment / relativePath，导入时必须能自己算出落位。
const roundTripFile = join(homeDir, 'sessions', '_no-cwd', goodId, 'session.v3.jsonl.zstd')
assert.equal(await service.fsExists(roundTripFile), true, '前置条件：本地会话文件存在')
await service.removePath(roundTripFile)
assert.equal(await service.fsExists(roundTripFile), false, '前置条件：已删掉本地会话文件')
await service.import()
assert.equal(await service.fsExists(roundTripFile), true, 'v3 备份必须能自己算出正确落位并恢复回来')

// ── 排序：未导出的整组沉底，同类内部按名称字母排序 ────────────────────────────
const wsExpAlpha = join(homeDir, 'ws-exp-alpha')
const wsExpZeta = join(homeDir, 'ws-exp-zeta')
const wsNoneA = join(homeDir, 'ws-none-a')
const wsNoneB = join(homeDir, 'ws-none-b')
const sortIdA = 'session-probe-sort-a'
const sortIdB = 'session-probe-sort-b'
await service.writeTextEnsured(
  join(homeDir, 'sessions', service.projSeg(wsExpAlpha), sortIdA, 'session.v3.jsonl.zstd'),
  'A'
)
await service.writeTextEnsured(
  join(homeDir, 'sessions', service.projSeg(wsExpZeta), sortIdB, 'session.v3.jsonl.zstd'),
  'B'
)
// 把这两个工作区标记成"已导出"：直接写导出索引——状态判定就是从它派生的。
await service.writeTextEnsured(join(exportDir, 'index.json'), JSON.stringify({
  format: 'dsh-sessions-export',
  version: 2,
  exportedAt: 1,
  sessions: [
    { id: sortIdA, cwd: wsExpAlpha, fileName: 'session.v3.jsonl.zstd', fingerprint: null },
    { id: sortIdB, cwd: wsExpZeta, fileName: 'session.v3.jsonl.zstd', fingerprint: null }
  ]
}))
// 注册表顺序刻意打乱：未导出的一头一尾、组内字母倒序——这样两级排序都必须真的
// 生效才能得到期望结果，不会因为"碰巧原顺序就对"而蒙混过关。
wsList.length = 0 // 前面的归属恢复测试也会注册工作区，这里只留本用例要验证的四个
wsList.push(
  { path: wsNoneB, title: 'none-b', sessionIds: [] },
  { path: wsExpZeta, title: 'zeta-exported', sessionIds: [sortIdB] },
  { path: wsNoneA, title: 'none-a', sessionIds: [] },
  { path: wsExpAlpha, title: 'alpha-exported', sessionIds: [sortIdA] }
)
const groupsResult = await service.listGroups()
assert.deepEqual(
  groupsResult.groups.map((group) => group.title),
  ['alpha-exported', 'zeta-exported', 'none-a', 'none-b'],
  '未导出的整组沉底，同类内部按名称字母排序'
)

// ── 重定位：未关联工作区 → 检测 → 应用 → 映射持久化 ────────────────────────────
// 场景：备份来自另一台机器（cwd 指向 E:\AI\legacy-project），本机没有那个目录，
// 于是这些会话不属于任何工作区、在 DSH 侧栏里是隐身的。这就是"未关联工作区"。
const legacyCwd = 'E:\\AI\\legacy-project'
const legacyId = 'session-probe-relocate'
const legacyDir = join(homeDir, 'sessions', service.projSeg(legacyCwd), legacyId)
mkdirSync(legacyDir, { recursive: true })
const legacyFile = join(legacyDir, 'session.v3.jsonl.zstd')
const legacySecondFrame = zstdCompressSync(Buffer.from(JSON.stringify({ type: 'message', text: 'payload stays untouched' }) + '\n'))
writeFileSync(legacyFile, Buffer.concat([
  zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 3, id: legacyId, cwd: legacyCwd }) + '\n')),
  legacySecondFrame
]))

// 1) 未关联分组必须列出它，并带上映射状态
const unlinked = await service.listUnlinkedGroups()
const legacyGroup = unlinked.groups.find((group) => group.cwd === legacyCwd)
assert.ok(legacyGroup, 'cwd 未注册的会话必须出现在未关联工作区里')
assert.equal(legacyGroup.sessionCount, 1)
assert.equal(legacyGroup.mappedTo, null, '还没配映射')
assert.equal(legacyGroup.sessions[0].originCwdExists, false, '原 cwd 在本机不存在（E: 盘）')

// 2) 检测：空目标被拒；可创建的目标通过；撞到同名文件被拒
const emptyCheck = await service.checkRelocation(legacyCwd, '')
assert.equal(emptyCheck.ok, false)
assert.equal(emptyCheck.problems[0].code, 'empty-target')

const targetDir = join(homeDir, 'relocated', 'legacy-project')
const okCheck = await service.checkRelocation(legacyCwd, targetDir)
assert.equal(okCheck.ok, true, '目标不存在但上级可建，应当通过：' + JSON.stringify(okCheck.problems))
assert.equal(okCheck.info.willCreate, true)
assert.equal(okCheck.info.sessionCount, 1)

const fileTarget = join(homeDir, 'relocated', 'a-file')
mkdirSync(dirname(fileTarget), { recursive: true })
writeFileSync(fileTarget, 'x')
const fileCheck = await service.checkRelocation(legacyCwd, fileTarget)
assert.equal(fileCheck.ok, false)
assert.ok(fileCheck.problems.some((problem) => problem.code === 'target-is-file'), '目标撞到同名文件必须被拒')

// 3) 应用：建目录 → 移文件 → 改 header → 注册归属 → 记住映射
const applied = await service.applyRelocation(legacyCwd, targetDir)
assert.equal(applied.ok, true, JSON.stringify(applied.problems))
assert.equal(applied.moved, 1)
assert.equal(applied.mappingSaved, true)

const newFile = join(homeDir, 'sessions', service.projSeg(applied.targetCwd), legacyId, 'session.v3.jsonl.zstd')
assert.equal(await service.fsExists(targetDir), true, '目标工作区目录必须被创建')
assert.equal(await service.fsExists(newFile), true, '会话必须被移到新位置')
assert.equal(await service.fsExists(legacyFile), false, '旧位置必须不再有它')
assert.deepEqual(
  await service.readSessionHeader(newFile),
  { id: legacyId, cwd: applied.targetCwd },
  'header 的 cwd 必须同步改写成目标路径，否则 DSH 会判"日志与路径不符"'
)
// 改写只碰第一帧：第二帧必须逐字节保留
assert.ok(readFileSync(newFile).includes(legacySecondFrame), '除 header 外的帧必须逐字节保留')

// 4) 重映射被持久化，下次导入可以自动套用
// selection.json 现在是 { groups: [{ cwd, sessionIds }] }——没有工作区主键，
// 目标路径直接记在"这批会话"所在的那条记录上。
const storedState = JSON.parse(await service.fsReadText(join(homeDir, 'session-migrate', 'selection.json')))
const relocatedGroup = storedState.groups.find((group) => group.cwd !== null)
assert.ok(relocatedGroup, '重映射必须写进 selection.json')
assert.equal(relocatedGroup.cwd, applied.targetCwd, '目标路径必须是重定位后的规范路径')
assert.equal(
  relocatedGroup.sessionIds.includes(legacyId),
  true,
  '该会话必须和目标路径记在同一条记录里（这样按 id 就能查到它该落到哪儿）'
)
assert.equal(
  await service.fsExists(join(homeDir, 'session-migrate', 'relocations.json')),
  false,
  '不应再产生独立的 relocations.json'
)

// 5) 重定位之后它不再是"未关联"，而是正常注册的工作区
const afterApply = await service.listUnlinkedGroups()
assert.equal(
  afterApply.groups.some((group) => group.cwd === legacyCwd),
  false,
  '重定位后不应再出现在未关联里'
)

rmSync(homeDir, { recursive: true, force: true })

console.log('host 装配冒烟测试通过：服务注册、字符串键标记、文件层契约、导入覆盖语义、配置清理、工作区排序均符合宿主要求。')

