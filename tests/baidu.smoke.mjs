// 百度网盘功能的冒烟测试。
//
// 这一层全部用假的 fetch 驱动，好处是可以把「协议上必须成立、但真实环境里很难复现」
// 的约束钉死：
//   1. 每个请求都必须带 User-Agent: pan.baidu.com（少了一律被百度拒绝）
//   2. 轮询间隔不得低于 5 秒（太快会被风控封应用）
//   3. 上传是「预上传 → 补传缺失分片 → 创建文件」三步，path/size/block_list 三处一致
//   4. 秒传命中时一个分片都不该传
//   5. create 的 block_list 必须用分片上传返回的 MD5，而不是本地算的那份
//   6. 下载必须先 filemetas 拿 dlink，再带 access_token 去 GET
//   7. 网盘上的路径是外部数据，不能穿越到本地目录之外
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BaiduApiError,
  BaiduPanClient,
  DEFAULT_REMOTE_SUBDIR,
  SLICE_SIZE,
  fileSliceMd5,
  joinRemote,
  normalizeRemotePath,
  relativeTo,
  sliceCount
} from '../baidu.js'
import { apply as applyHost } from '../host.js'

const here = dirname(fileURLToPath(import.meta.url))
const workDir = join(here, '.tmp-baidu')
rmSync(workDir, { recursive: true, force: true })
mkdirSync(workDir, { recursive: true })

// ── 假 fetch ──────────────────────────────────────────────────────────────────
// 把 query 与 form body 合成一个 params 对象，handler 只看 params 就能路由，
// 不必关心这个接口到底是用 GET 还是 POST 传参。
function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init = {}) => {
    const parsed = new URL(url)
    const query = Object.fromEntries(parsed.searchParams)
    const body = {}
    if (typeof init.body === 'string') {
      for (const [key, value] of new URLSearchParams(init.body)) body[key] = value
    }
    const params = { ...query, ...body }
    const headers = init.headers || {}
    // query 与 body 分开留档：参数到底被放在哪儿，是这里最容易出事的地方。
    const call = {
      url,
      path: parsed.pathname,
      query,
      body,
      params,
      method: init.method || 'GET',
      headers,
      form: init.body instanceof FormData ? init.body : null
    }
    calls.push(call)
    const spec = await handler(call, calls)
    if (spec instanceof Response) return spec
    if (spec && spec.__raw !== undefined) {
      return new Response(spec.__raw, { status: spec.status || 200 })
    }
    return new Response(JSON.stringify(spec), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  impl.calls = calls
  return impl
}

function assertUserAgent(calls) {
  for (const call of calls) {
    const agent = call.headers['User-Agent'] || call.headers['user-agent'] || ''
    assert.ok(agent.includes('pan.baidu.com'), '请求必须带 pan.baidu.com 的 User-Agent：' + call.url)
  }
}

/**
 * 一个会记住状态的「假网盘」。
 *
 * 增量与删除这类语义只有一个持续存在的云端状态才测得出来：上传完再看第二次会不会
 * 跳过、本地删了之后云端会不会跟着删。之前的假 fetch 每次都是空白状态，
 * 根本无从验证这两件事。
 */
function makeFakePan() {
  const files = new Map() // 绝对路径 -> { isdir, size }
  const uploads = []
  const deletions = []

  const ensureParents = (path) => {
    const parts = String(path).split('/').filter((part) => part !== '')
    let current = ''
    for (let index = 0; index < parts.length - 1; index++) {
      current += '/' + parts[index]
      if (!files.has(current)) files.set(current, { isdir: 1, size: 0 })
    }
  }

  const impl = fakeFetch(async (call) => {
    const params = call.params
    if (params.method === 'create' && String(params.isdir) === '1') {
      files.set(params.path, { isdir: 1, size: 0 })
      return { errno: 0 }
    }
    if (params.method === 'precreate') {
      uploads.push(params.path)
      return { errno: 0, uploadid: 'UP-' + uploads.length, block_list: [] }
    }
    if (params.method === 'create' && String(params.isdir) === '0') {
      ensureParents(params.path)
      files.set(params.path, { isdir: 0, size: Number(params.size) })
      return { errno: 0, fs_id: files.size }
    }
    if (params.method === 'list') return { errno: 0, list: [] }
    if (params.method === 'listall') {
      return {
        errno: 0,
        has_more: 0,
        list: Array.from(files.entries()).map(([path, meta], index) => ({
          fs_id: index,
          path: path,
          isdir: meta.isdir,
          size: meta.size
        }))
      }
    }
    if (params.method === 'filemanager' && params.opera === 'delete') {
      const targets = JSON.parse(params.filelist)
      const info = targets.map((path) => {
        deletions.push(path)
        // 真实的删除对目录是递归的，这里也照做。
        let removed = false
        for (const key of Array.from(files.keys())) {
          if (key === path || key.startsWith(path + '/')) {
            files.delete(key)
            removed = true
          }
        }
        return { errno: removed ? 0 : -9, path: path }
      })
      return { errno: 0, info: info }
    }
    throw new Error('不该发生的请求：' + call.url + ' ' + JSON.stringify(params))
  })

  return { impl: impl, files: files, uploads: uploads, deletions: deletions }
}

// 凭证一律由外部传入——协议层没有任何内置默认值（那是刻意的：凭证等同账号身份，
// 写进源码就会跟着仓库走）。所以每个用例都得自己带一份。
const TEST_CREDENTIALS = {
  appId: '124380810',
  appKey: 'test-app-key',
  secretKey: 'test-secret-key',
  signKey: 'test-sign-key'
}

// ── 凭证规范化 ────────────────────────────────────────────────────────────────
{
  // 缺任一必填项都要当场失败，而不是等到授权阶段给一个含糊的错误。
  assert.throws(() => new BaiduPanClient({ credentials: {} }), /缺少必填项.*appKey/, '缺 appKey 应当场拒绝')
  assert.throws(() => new BaiduPanClient({ credentials: { appKey: 'k' } }), /缺少必填项.*secretKey/, '缺 secretKey 应当场拒绝')
  assert.throws(() => new BaiduPanClient({ credentials: null }), /必须是一个 JSON 对象/)
  assert.throws(() => new BaiduPanClient({ credentials: [] }), /必须是一个 JSON 对象/)
  // 不传凭证也必须失败——绝不能悄悄退回某个内置身份。
  assert.throws(() => new BaiduPanClient({}), /应用凭证/)

  // 字段名认得宽一些：控制台里叫 AppKey，人手写 JSON 时写法难免有出入。
  const snake = new BaiduPanClient({ credentials: { app_key: 'K', secret_key: 'S' } })
  assert.equal(snake.appKey, 'K')
  assert.equal(snake.secretKey, 'S')
  const camel = new BaiduPanClient({ credentials: { client_id: 'K2', client_secret: 'S2' } })
  assert.equal(camel.appKey, 'K2')
  assert.equal(camel.secretKey, 'S2')
  // 直接照抄控制台的字段名（AppID 在控制台里还是个数字）必须能读出来。
  const consoleStyle = new BaiduPanClient({
    credentials: { AppID: 124380810, AppKey: 'K4', SecretKey: 'S4', SignKey: 'G4' }
  })
  assert.equal(consoleStyle.appId, '124380810', 'AppID 写成数字也要认')
  assert.equal(consoleStyle.appKey, 'K4')
  assert.equal(consoleStyle.secretKey, 'S4')
  assert.equal(consoleStyle.signKey, 'G4')
  // 全大写加下划线同样要认。
  const screaming = new BaiduPanClient({ credentials: { APP_KEY: 'K5', SECRET_KEY: 'S5' } })
  assert.equal(screaming.appKey, 'K5')
  assert.equal(screaming.secretKey, 'S5')
  // 从网页复制很容易带进首尾空白，要去掉；但密钥内部的空白是有效的，必须原样保留。
  const spaced = new BaiduPanClient({ credentials: { appKey: '  K3  ', secretKey: ' S 3 ' } })
  assert.equal(spaced.appKey, 'K3')
  assert.equal(spaced.secretKey, 'S 3')
}

// ── OAuth：设备码 ─────────────────────────────────────────────────────────────
{
  const fetchImpl = fakeFetch(async (call) => {
    assert.equal(call.path, '/oauth/2.0/device/code')
    assert.equal(call.params.response_type, 'device_code')
    assert.equal(call.params.client_id, 'test-app-key')
    // scope 必须原样是两个词、中间是英文逗号，写成别的形式百度会拒。
    assert.equal(call.params.scope, 'basic,netdisk')
    return {
      device_code: 'DEVICE-CODE',
      user_code: 'u8sk425x',
      verification_url: 'https://openapi.baidu.com/device',
      qrcode_url: 'https://openapi.baidu.com/device/qrcode/x/u8sk425x',
      expires_in: 300,
      // 服务端故意给一个太小的间隔，客户端必须抬到 5 秒。
      interval: 2
    }
  })
  const client = new BaiduPanClient({
    fetchImpl,
    credentials: { appKey: 'test-app-key', secretKey: 'test-secret' }
  })
  const code = await client.requestDeviceCode()
  assert.equal(code.deviceCode, 'DEVICE-CODE')
  assert.equal(code.userCode, 'u8sk425x')
  assert.equal(code.expiresIn, 300)
  assert.equal(code.interval, 5, '轮询间隔不得低于 5 秒，否则会触发百度风控')
  assertUserAgent(fetchImpl.calls)
}

// 轮询：未授权时返回 pending，授权后返回 token。
{
  let polls = 0
  const fetchImpl = fakeFetch(async () => {
    polls += 1
    if (polls < 3) return { error: 'authorization_pending', error_description: 'waiting' }
    return { access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 2592000, scope: 'basic netdisk' }
  })
  const client = new BaiduPanClient({ fetchImpl, credentials: { appKey: 'k', secretKey: 's' } })
  assert.deepEqual(await client.requestDeviceToken('D'), { pending: true })
  assert.deepEqual(await client.requestDeviceToken('D'), { pending: true })
  const done = await client.requestDeviceToken('D')
  assert.equal(done.pending, false)
  assert.equal(done.token.accessToken, 'AT-1')
  assert.equal(done.token.refreshToken, 'RT-1')
  assert.ok(done.token.expiresAt > Date.now() + 29 * 24 * 3600 * 1000, 'token 有效期应按 expires_in 换算到绝对时间')
}

// 授权失败（比如用户点了拒绝）必须抛出带原文的错误，而不是永远 pending。
{
  const fetchImpl = fakeFetch(async () => ({ error: 'access_denied', error_description: 'user refused' }))
  const client = new BaiduPanClient({ fetchImpl, credentials: { appKey: 'k', secretKey: 's' } })
  await assert.rejects(
    () => client.requestDeviceToken('D'),
    (error) => {
      assert.ok(error instanceof BaiduApiError)
      assert.ok(error.message.includes('access_denied'), '错误里必须保留百度给的原始 error')
      assert.ok(error.message.includes('user refused'), '错误里必须保留 error_description')
      return true
    }
  )
}

// ── 网盘落点：从 panbaidu.json 的 RemotePath 读，不写死在代码里 ────────────────
{
  // 没配就是空串，调用方回退到默认值。
  assert.equal(normalizeRemotePath({}), '')
  assert.equal(normalizeRemotePath(null), '')
  assert.equal(normalizeRemotePath({ AppKey: 'K' }), '')

  // 相对路径：拼在应用目录后面，不必关心应用叫什么名字。
  assert.equal(normalizeRemotePath({ RemotePath: 'AI/exports' }), 'AI/exports')
  assert.equal(normalizeRemotePath({ remote_path: 'backup/sessions' }), 'backup/sessions')
  // 绝对路径：直接指定，连应用目录都不用去探测。
  assert.equal(normalizeRemotePath({ RemotePath: '/apps/dsh/AI/exports' }), '/apps/dsh/AI/exports')
  // 各种手写习惯都要收敛到同一条路径上。
  assert.equal(normalizeRemotePath({ RemotePath: '  /apps/dsh/AI/exports/  ' }), '/apps/dsh/AI/exports')
  assert.equal(normalizeRemotePath({ RemotePath: 'AI//exports//' }), 'AI/exports')
  assert.equal(normalizeRemotePath({ RemotePath: 'AI\\exports' }), 'AI/exports')
  assert.equal(normalizeRemotePath({ RemotePath: './AI/./exports' }), 'AI/exports')
  assert.equal(normalizeRemotePath({ RemotePath: '/' }), '')
  // 别名的匹配忽略大小写与下划线，和凭证那套规则一致。
  assert.equal(normalizeRemotePath({ REMOTE_PATH: 'x/y' }), 'x/y')
  assert.equal(normalizeRemotePath({ RemoteDir: 'x/y' }), 'x/y')
  // 路径穿越必须挡住：这是外部数据，不能让它决定往哪儿写。
  assert.throws(() => normalizeRemotePath({ RemotePath: 'AI/../../etc' }), /不允许出现 "\.\."/)
}

// ── 分片切分 ──────────────────────────────────────────────────────────────────
{
  assert.equal(sliceCount(0), 1, '空文件也算一片')
  assert.equal(sliceCount(1), 1)
  assert.equal(sliceCount(SLICE_SIZE), 1, '正好一片时不该多切一片')
  assert.equal(sliceCount(SLICE_SIZE + 1), 2)
  assert.equal(sliceCount(SLICE_SIZE * 3), 3)

  const bigPath = join(workDir, 'big.bin')
  // 9MB = 4MB + 4MB + 1MB，三片。
  const big = Buffer.alloc(SLICE_SIZE * 2 + 1024)
  for (let i = 0; i < big.length; i += 4096) big[i] = i % 251
  writeFileSync(bigPath, big)
  const slices = await fileSliceMd5(bigPath, big.length)
  assert.equal(slices.length, 3, '9MB 应切成 3 片')
  assert.ok(slices.every((entry) => /^[0-9a-f]{32}$/.test(entry)), '分片 MD5 必须是 32 位小写十六进制')
  assert.equal(new Set(slices).size, 3, '三片内容不同，MD5 不应相同')
}

// ── 路径安全 ──────────────────────────────────────────────────────────────────
{
  assert.equal(joinRemote('/apps/x/AI/exports', 'sessions/a/b.json'), '/apps/x/AI/exports/sessions/a/b.json')
  assert.equal(joinRemote('/apps/x/AI/exports', 'index.json'), '/apps/x/AI/exports/index.json')
  assert.throws(() => joinRemote('/apps/x/AI/exports', '../escape.json'), /不允许出现 "\.\."/)
  assert.throws(() => joinRemote('/apps/x/AI/exports', 'a/../../escape.json'), /不允许出现 "\.\."/)

  assert.equal(relativeTo('/apps/x/AI/exports', '/apps/x/AI/exports/index.json'), 'index.json')
  assert.equal(relativeTo('/apps/x/AI/exports', '/apps/x/AI/exports/sessions/p/s/f.json'), 'sessions/p/s/f.json')
  assert.equal(relativeTo('/apps/x/AI/exports', '/apps/x/other/index.json'), null, '越出基准目录必须返回 null')
  assert.equal(relativeTo('/apps/x/AI/exports', '/apps/x/AI/exports'), '')
}

// ── 上传：分片都在云端时，一片都不用传，但 create 仍然必须调 ──────────────────
// 秒传的判据是「服务端说还缺哪几片」= 空数组，而不是 precreate 的 return_type
// （那是系统内部状态字段）。而且 create 永远是链路的终点——文件真的落到网盘上，
// 才算数。
{
  const filePath = join(workDir, 'small.json')
  writeFileSync(filePath, '{"hello":"world"}')
  const size = readFileSync(filePath).length
  const fetchImpl = fakeFetch(async (call) => {
    if (call.params.method === 'precreate') {
      assert.equal(call.params.rtype, '3', '必须用 rtype=3 覆盖，否则重传会生成 "xxx (1).json"')
      assert.equal(call.params.isdir, '0')
      assert.equal(call.params.size, String(size))
      assert.equal(call.params.autoinit, '1')
      assert.equal(call.params.openapi, 'xpansdk', 'precreate 必须带 openapi 标记')
      const blocks = JSON.parse(call.params.block_list)
      assert.equal(blocks.length, 1)
      // 还缺的分片是空数组 → 分片都已在云端，只差 create 这一步。
      return { errno: 0, uploadid: 'UP-1', block_list: [] }
    }
    if (call.params.method === 'create') {
      assert.equal(call.params.uploadid, 'UP-1', 'create 要用 precreate 下发的 uploadid')
      assert.equal(call.params.openapi, 'xpansdk', 'create 必须带 openapi 标记')
      return { errno: 0, fs_id: 11 }
    }
    throw new Error('不该发生的请求：' + call.url + ' ' + JSON.stringify(call.params))
  })
  const client = new BaiduPanClient({ fetchImpl, credentials: TEST_CREDENTIALS, accessToken: 'AT' })
  const result = await client.uploadFile({ filePath, path: '/apps/x/AI/exports/small.json', size })
  assert.equal(result.instant, true, '一片都没传时应报告 instant')
  assert.equal(result.uploadedSlices, 0, '分片都在云端时不该上传任何分片')
  assert.equal(fetchImpl.calls.length, 2, '预上传 + create，一个分片请求都不该有')
  assert.equal(fetchImpl.calls.filter((call) => call.path.includes('superfile2')).length, 0)
  assertUserAgent(fetchImpl.calls)
}

// ── 上传：create 报 -8 说明云端已有这份内容，对调用方就是成功 ──────────────────
{
  const filePath = join(workDir, 'existed.json')
  writeFileSync(filePath, 'already-there')
  const size = readFileSync(filePath).length
  const fetchImpl = fakeFetch(async (call) => {
    if (call.params.method === 'precreate') return { errno: 0, uploadid: 'UP-2', block_list: [] }
    if (call.params.method === 'create') return { errno: -8 }
    throw new Error('不该发生的请求：' + call.url)
  })
  const client = new BaiduPanClient({ fetchImpl, credentials: TEST_CREDENTIALS, accessToken: 'AT' })
  const result = await client.uploadFile({ filePath, path: '/apps/x/AI/exports/existed.json', size })
  assert.equal(result.instant, true)
  assert.equal(result.existed, true, 'create 报 -8 要标成「已存在」，而不是失败')
}

// ── 上传链路三个接口都必须带 openapi 标记 ─────────────────────────────────────
// 这是本插件最贵的一个坑：少了它，precreate 返回 errno=0 + return_type=1，
// 看着像秒传，实则既不建任务也不建文件——整个上传静默失败。
{
  const filePath = join(workDir, 'mark.bin')
  writeFileSync(filePath, Buffer.alloc(SLICE_SIZE + 1))
  const size = SLICE_SIZE + 1
  const fetchImpl = fakeFetch(async (call) => {
    if (call.params.method === 'precreate') return { errno: 0, uploadid: 'UP-3', block_list: [0, 1] }
    if (call.path.includes('superfile2')) return { errno: 0, md5: 'a'.repeat(32) }
    if (call.params.method === 'create') return { errno: 0, fs_id: 3 }
    throw new Error('不该发生的请求：' + call.url)
  })
  const client = new BaiduPanClient({ fetchImpl, credentials: TEST_CREDENTIALS, accessToken: 'AT' })
  await client.uploadFile({ filePath, path: '/apps/x/AI/exports/mark.bin', size })
  assert.equal(fetchImpl.calls.length, 4, '预上传 + 2 个分片 + create')
  const kinds = fetchImpl.calls.map((call) => (call.path.includes('superfile2') ? 'slice' : call.params.method))
  assert.deepEqual(kinds, ['precreate', 'slice', 'slice', 'create'])
  for (const call of fetchImpl.calls) {
    assert.equal(call.query.openapi, 'xpansdk', '上传链路的每个接口都要带 openapi：' + call.url)
  }
}

// ── 缺少 openapi 标记的经典症状：precreate 不返回 uploadid ─────────────────────
// 真实日志里的响应长这样：errno=0、return_type=1、block_list 被原样回显成 MD5
// 字符串数组（而正常应该是分片序号）。它看起来像秒传，实际上网盘上什么都没有。
// 必须报错，绝不能当成功。
{
  const filePath = join(workDir, 'nolink.json')
  writeFileSync(filePath, 'no-openapi')
  const size = readFileSync(filePath).length
  const fetchImpl = fakeFetch(async () => ({
    errno: 0,
    path: '/apps/dsh/AI/exports/nolink.json',
    return_type: 1,
    block_list: ['c6ffd57ef527e74f30dd3850f410208b'],
    request_id: 460870210490616260
  }))
  const client = new BaiduPanClient({ fetchImpl, credentials: TEST_CREDENTIALS, accessToken: 'AT' })
  await assert.rejects(
    () => client.uploadFile({ filePath, path: '/apps/x/AI/exports/nolink.json', size }),
    (error) => {
      assert.ok(error instanceof BaiduApiError)
      assert.ok(error.message.includes('uploadid'), '要说明缺的是 uploadid')
      assert.ok(error.message.includes('openapi'), '要点出真正的原因（缺 openapi 标记）')
      assert.ok(error.message.includes('return_type'), '错误里必须带响应原文')
      return true
    }
  )
  // 即便有 uploadid，但 block_list 被回显成 MD5（非序号）时也要挡住：
  // 当成序号用会得出「一片都不用传」的错误结论。
  const echoFetch = fakeFetch(async () => ({
    errno: 0,
    uploadid: 'UP-X',
    block_list: ['c6ffd57ef527e74f30dd3850f410208b']
  }))
  const echoClient = new BaiduPanClient({ fetchImpl: echoFetch, credentials: TEST_CREDENTIALS, accessToken: 'AT' })
  await assert.rejects(
    () => echoClient.uploadFile({ filePath, path: '/apps/x/AI/exports/nolink.json', size }),
    (error) => {
      assert.ok(error.message.includes('不是分片序号'), '要把「被回显的 MD5」认出来：' + error.message)
      return true
    }
  )
}

// ── POST 的业务参数必须同时出现在 query 里 ────────────────────────────────────
// 只放 form body 时服务端有可能读不到；query 与 body 各放一份，读哪边都不会丢。
{
  const filePath = join(workDir, 'query.json')
  writeFileSync(filePath, 'query-test')
  const size = readFileSync(filePath).length
  const fetchImpl = fakeFetch(async (call) => {
    if (call.params.method === 'precreate') return { errno: 0, uploadid: 'UP-Q', block_list: [] }
    if (call.params.method === 'create') return { errno: 0, fs_id: 1 }
    throw new Error('不该发生的请求：' + call.url)
  })
  const client = new BaiduPanClient({ fetchImpl, credentials: TEST_CREDENTIALS, accessToken: 'AT' })
  await client.uploadFile({ filePath, path: '/apps/x/AI/exports/query.json', size })
  const pre = fetchImpl.calls.find((call) => call.params.method === 'precreate')
  assert.ok(pre, '应当发出 precreate 请求')
  assert.equal(pre.method, 'POST')
  for (const key of ['method', 'access_token', 'openapi', 'path', 'size', 'isdir', 'block_list', 'rtype']) {
    assert.ok(pre.query[key] !== undefined, 'POST 的 query 里缺少 ' + key)
  }
  assert.equal(pre.query.path, '/apps/x/AI/exports/query.json')
  assert.equal(pre.query.size, String(size))
  assert.equal(pre.query.rtype, '3')
  assert.equal(pre.body.path, '/apps/x/AI/exports/query.json', 'body 里同样要有业务参数')
  assert.equal(pre.body.method, undefined, 'method 不必重复放进 body')
  assert.equal(pre.headers['Content-Type'], 'application/x-www-form-urlencoded')
}

// ── 上传：响应形状不认识时，错误里必须带上原文 ────────────────────────────────
// 回归：曾经只说「预上传没有返回 uploadid」。用户拿着这句话无从定位任何问题，
// 只能回来问作者——而这种问题本来一次就能说清。
{
  const filePath = join(workDir, 'odd.json')
  writeFileSync(filePath, 'odd')
  const size = readFileSync(filePath).length
  const fetchImpl = fakeFetch(async () => ({ errno: 0, something_unexpected: 'yes' }))
  const client = new BaiduPanClient({ fetchImpl, credentials: TEST_CREDENTIALS, accessToken: 'AT' })
  await assert.rejects(
    () => client.uploadFile({ filePath, path: '/apps/x/AI/exports/odd.json', size }),
    (error) => {
      assert.ok(error instanceof BaiduApiError)
      assert.ok(error.message.includes('uploadid'), '要说明缺的是 uploadid')
      assert.ok(error.message.includes('something_unexpected'), '错误里必须带响应原文：' + error.message)
      return true
    }
  )
  // 已知 errno 的文案同样要把原文带上，否则用户看到的还是一句无从下手的话。
  const errnoFetch = fakeFetch(async () => ({ errno: -7, request_id: 99 }))
  const errnoClient = new BaiduPanClient({ fetchImpl: errnoFetch, credentials: TEST_CREDENTIALS, accessToken: 'AT' })
  await assert.rejects(
    () => errnoClient.listDir('/apps/x'),
    (error) => {
      assert.equal(error.errno, -7)
      assert.equal(error.payload.request_id, 99)
      return true
    }
  )
}

// ── 上传：只补传服务端说缺的分片，且 create 用服务端返回的 MD5 ────────────────
{
  const filePath = join(workDir, 'multi.bin')
  const payload = Buffer.alloc(SLICE_SIZE * 2 + 1024)
  for (let i = 0; i < payload.length; i += 4096) payload[i] = (i * 7) % 251
  writeFileSync(filePath, payload)
  const size = payload.length
  const localMd5 = await fileSliceMd5(filePath, size)

  const uploadedParts = []
  let createBlocks = null
  const fetchImpl = fakeFetch(async (call) => {
    if (call.params.method === 'precreate') {
      // 服务端说：第 1 片已经有了（秒传），只需要传 0 和 2。
      return { errno: 0, uploadid: 'UP-2', return_type: 2, block_list: [0, 2] }
    }
    if (call.path.includes('superfile2')) {
      const seq = Number(call.params.partseq)
      uploadedParts.push(seq)
      assert.equal(call.params.uploadid, 'UP-2')
      assert.equal(call.params.type, 'tmpfile')
      assert.equal(call.params.method, 'upload')
      assert.equal(call.url.startsWith('https://d.pcs.baidu.com/'), true, '分片必须传到 d.pcs.baidu.com')
      assert.ok(call.form, '分片必须是 multipart/form-data')
      // 服务端对第 0 片返回一个「与本地不同」的 MD5，用来验证 create 用的是服务端那份。
      return { errno: 0, md5: seq === 0 ? 'ffffffffffffffffffffffffffffffff' : localMd5[seq] }
    }
    if (call.params.method === 'create') {
      createBlocks = JSON.parse(call.params.block_list)
      assert.equal(call.params.uploadid, 'UP-2')
      assert.equal(JSON.parse(call.params.block_list).length, 3, 'create 的 block_list 必须覆盖全部分片')
      return { errno: 0, fs_id: 12 }
    }
    throw new Error('不该发生的请求：' + call.url)
  })
  const client = new BaiduPanClient({ fetchImpl, credentials: TEST_CREDENTIALS, accessToken: 'AT' })
  const result = await client.uploadFile({ filePath, path: '/apps/x/AI/exports/multi.bin', size })
  assert.equal(result.instant, false)
  assert.equal(result.slices, 3)
  assert.deepEqual(uploadedParts, [0, 2], '只该补传服务端说缺的那两片，第 1 片不该重传')
  assert.equal(createBlocks[0], 'ffffffffffffffffffffffffffffffff', 'create 必须用分片上传返回的 MD5')
  assert.equal(createBlocks[1], localMd5[1], '秒传跳过的分片用预上传时提交的 MD5 补位')
  assert.equal(createBlocks[2], localMd5[2])
  assertUserAgent(fetchImpl.calls)
}

// ── 上传：业务错误要翻成人话，并保留 errno 与原始响应 ──────────────────────────
{
  const fetchImpl = fakeFetch(async () => ({ errno: -6, request_id: 123 }))
  const client = new BaiduPanClient({ fetchImpl, credentials: TEST_CREDENTIALS, accessToken: 'STALE' })
  await assert.rejects(
    () => client.listDir('/apps/x'),
    (error) => {
      assert.ok(error instanceof BaiduApiError)
      assert.equal(error.errno, -6)
      assert.ok(error.message.includes('重新登录'), 'errno=-6 必须提示重新登录')
      assert.equal(error.payload.request_id, 123, '原始响应要带上，便于排查未知错误')
      return true
    }
  )
}

// ── 写目录：已存在不算失败 ────────────────────────────────────────────────────
{
  const fetchImpl = fakeFetch(async (call) => {
    assert.equal(call.params.isdir, '1')
    assert.equal(call.params.method, 'create')
    // 第一次创建成功，第二次报「已存在」——调用方要的是「它在那儿」，不该当错误。
    return call.params.path === '/apps/x/AI' ? { errno: 0 } : { errno: -8 }
  })
  const client = new BaiduPanClient({ fetchImpl, credentials: TEST_CREDENTIALS, accessToken: 'AT' })
  assert.equal(await client.createDir('/apps/x/AI'), true)
  assert.equal(await client.createDir('/apps/x/AI/exports'), false)

  fetchImpl.calls.length = 0
  // base 是已知存在的前缀：/apps/<应用名> 属于开放平台自己，不该由我们去建。
  const created = await client.createDirTree('/apps/x/AI/exports', '/apps/x')
  assert.deepEqual(created, 1, '逐级建目录时只该统计真正新建的那些')
  assert.deepEqual(fetchImpl.calls.map((call) => call.params.path),
    ['/apps/x/AI', '/apps/x/AI/exports'], '必须逐级创建，且从应用根目录之下开始')
}

// ── 探测应用根目录：/apps 下有多个时取路径最短的那个 ──────────────────────────
{
  const fetchImpl = fakeFetch(async () => ({
    errno: 0,
    list: [
      { isdir: 1, path: '/apps/myapp/deeper', server_filename: 'deeper' },
      { isdir: 1, path: '/apps/myapp', server_filename: 'myapp' },
      { isdir: 0, path: '/apps/readme.txt', server_filename: 'readme.txt' }
    ]
  }))
  const client = new BaiduPanClient({ fetchImpl, credentials: TEST_CREDENTIALS, accessToken: 'AT' })
  assert.equal(await client.findAppRoot(), '/apps/myapp')
}

// ── 递归列举：listall 的分页必须跟着服务端给的 cursor 走 ───────────────────────
{
  let page = 0
  const fetchImpl = fakeFetch(async (call) => {
    assert.equal(call.params.method, 'listall')
    assert.equal(call.params.recursion, '1')
    page += 1
    if (page === 1) {
      // 有下一页时必须以响应里的 cursor 作为下一次的 start；自行按步长累加会漏项。
      return { errno: 0, has_more: 1, cursor: 2, list: [{ isdir: 0, path: '/apps/x/AI/exports/a.json' }] }
    }
    assert.equal(call.params.start, '2', '第二页必须用服务端给的 cursor')
    return { errno: 0, has_more: 0, list: [{ isdir: 0, path: '/apps/x/AI/exports/b.json' }] }
  })
  const client = new BaiduPanClient({ fetchImpl, credentials: TEST_CREDENTIALS, accessToken: 'AT' })
  const files = await client.listAllFiles('/apps/x/AI/exports')
  assert.deepEqual(files.map((entry) => entry.path),
    ['/apps/x/AI/exports/a.json', '/apps/x/AI/exports/b.json'])
}

// listall 不可用时退回逐层 list：目录项要展开，文件项要收集。
{
  const fetchImpl = fakeFetch(async (call) => {
    if (call.path.includes('/multimedia')) return { errno: 42213 }
    if (call.params.dir === '/apps/x/AI/exports') {
      return {
        errno: 0,
        list: [
          { isdir: 1, path: '/apps/x/AI/exports/sessions' },
          { isdir: 0, path: '/apps/x/AI/exports/index.json' }
        ]
      }
    }
    if (call.params.dir === '/apps/x/AI/exports/sessions') {
      return { errno: 0, list: [{ isdir: 0, path: '/apps/x/AI/exports/sessions/one.jsonl.zstd' }] }
    }
    return { errno: -9 }
  })
  const client = new BaiduPanClient({ fetchImpl, credentials: TEST_CREDENTIALS, accessToken: 'AT' })
  const files = await client.listAllFiles('/apps/x/AI/exports')
  assert.deepEqual(files.map((entry) => entry.path).sort(),
    ['/apps/x/AI/exports/index.json', '/apps/x/AI/exports/sessions/one.jsonl.zstd'])
}

// ── 下载：先 filemetas 拿 dlink，再带 access_token 去 GET ─────────────────────
// filemetas 的响应字段是 **list**（官方 Go SDK 的结构体是 `json:"list"`）。
// 回归：真实环境里「从百度云中获取」5 个文件全失败，报「网盘没有返回这个文件的
// 下载信息」——根因就是这里只读了 `info`，而实际字段叫 `list`。
{
  const fetchImpl = fakeFetch(async (call) => {
    if (call.params.method === 'filemetas') {
      assert.equal(call.params.dlink, '1')
      assert.equal(call.params.fsids, '[42]', 'fsids 要拼成数字数组字面量')
      return {
        errno: 0,
        list: [{ fs_id: 42, path: '/apps/x/AI/exports/index.json', size: 5, dlink: 'https://d.pcs.baidu.com/download/42?sign=abc' }]
      }
    }
    if (call.path === '/download/42') {
      // dlink 上必须补 access_token，否则拿到的是 403。
      assert.equal(call.params.access_token, 'AT')
      assert.ok((call.headers['User-Agent'] || '').includes('pan.baidu.com'), '下载同样要带 pan.baidu.com')
      return { __raw: Buffer.from('hello') }
    }
    throw new Error('不该发生的请求：' + call.url)
  })
  const client = new BaiduPanClient({ fetchImpl, credentials: TEST_CREDENTIALS, accessToken: 'AT' })
  const download = await client.openDownload(42)
  assert.equal(download.info.fs_id, 42)
  assert.equal(await download.response.text(), 'hello')
  assertUserAgent(fetchImpl.calls)

  // 旧文档写的是 info，同样要认——两个都认的成本为零，只认一个就是整条链路瘫痪。
  const legacyFetch = fakeFetch(async () => ({
    errno: 0,
    info: [{ fs_id: 7, dlink: 'https://d.pcs.baidu.com/legacy/7?x=1' }]
  }))
  const legacyClient = new BaiduPanClient({ fetchImpl: legacyFetch, credentials: TEST_CREDENTIALS, accessToken: 'AT' })
  const legacyMetas = await legacyClient.fileMetas([7])
  assert.equal(legacyMetas.length, 1, '响应字段写成 info 时也要能读出来')
  assert.equal(legacyMetas[0].fs_id, 7)
}

// ── fs_id 是 64 位整数，解析时必须无损保留 ────────────────────────────────────
// fs_id 形如 460870210490616260（18 位），超出 JS 的 2^53 安全整数范围。
// 多数值上 String(Number(x)) 的最短往返表示恰好还原原值、看不出问题，但那是运气：
// 换一个 fs_id 就可能把 …256 打印成 …260。所以解析时就该保住它。
{
  const bigId = '460870210490616260'
  // 前提断言：这个值的的确确超出安全整数范围，否则本用例证明不了任何事。
  assert.equal(Number.isSafeInteger(Number(bigId)), false, '前提：该 fs_id 应超出 JS 安全整数范围')

  const raw = (body) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  const fetchImpl = fakeFetch(async (call) => {
    if (call.params.method === 'listall') {
      return raw('{"errno":0,"has_more":0,"list":[{"fs_id":' + bigId
        + ',"path":"/apps/x/AI/exports/index.json","isdir":0,"size":5}]}')
    }
    if (call.params.method === 'filemetas') {
      // fsids 必须拼成**数字**数组的字面量；带上引号百度就不认了。
      assert.equal(call.params.fsids, '[' + bigId + ']', 'fsids 要拼成数字数组字面量')
      return raw('{"errno":0,"list":[{"fs_id":' + bigId + ',"dlink":"https://d.pcs.baidu.com/dl?x=1"}]}')
    }
    if (call.path === '/dl') return { __raw: Buffer.from('hello') }
    throw new Error('不该发生的请求：' + call.url)
  })
  const client = new BaiduPanClient({ fetchImpl, credentials: TEST_CREDENTIALS, accessToken: 'AT' })

  const listing = await client.listAllFiles('/apps/x/AI/exports')
  assert.equal(typeof listing[0].fs_id, 'string', 'fs_id 必须以字符串形式无损保留，而不是丢精度的 double')
  assert.equal(String(listing[0].fs_id), bigId)

  const download = await client.openDownload(listing[0].fs_id)
  assert.equal(await download.response.text(), 'hello', '拿到无损的 fs_id 之后下载才能成功')

  // 查不到时必须报出是哪个 fs_id、以及响应原文，而不是一句含糊的失败。
  const echoFetch = fakeFetch(async () => raw('{"errno":0,"list":[]}'))
  const echoClient = new BaiduPanClient({ fetchImpl: echoFetch, credentials: TEST_CREDENTIALS, accessToken: 'AT' })
  await assert.rejects(
    () => echoClient.openDownload('1'),
    (error) => {
      assert.ok(error.message.includes('fs_id=1'), '错误里必须带上是哪个 fs_id：' + error.message)
      assert.ok(error.message.includes('响应原文'), '错误里必须带响应原文')
      return true
    }
  )
}

// ── 宿主集成：上传本地导出目录 ────────────────────────────────────────────────
// 这一段走完整的 host 链路：读本地 exports → 探测网盘路径 → 建目录 → 逐文件上传。
{
  const home = join(workDir, 'home')
  const exportsDir = join(home, 'session-migrate', 'exports')
  // cwd 为 null 的会话落位在 _no-cwd 下，索引与实际目录必须自洽——
  // 增量上传靠「现算落位」把两者对上，对不上就永远匹配不到。
  const sessionDir = join(exportsDir, 'sessions', '_no-cwd', 'session-a')
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(exportsDir, 'index.json'), JSON.stringify({
    format: 'dsh-sessions-export',
    version: 4,
    exportedAt: 1,
    sessions: [{
      id: 'session-a',
      cwd: null,
      fileName: 'session.v3.jsonl.zstd',
      hash: 'HASH-OF-SESSION-A',
      remoteHash: null
    }]
  }))
  writeFileSync(join(sessionDir, 'session.v3.jsonl.zstd'), 'SESSION-BYTES')
  mkdirSync(join(home, 'session-migrate'), { recursive: true })
  const credentialsPath = join(home, 'session-migrate', 'panbaidu.json')
  const statePath = join(home, 'session-migrate', 'baidu.json')
  // 登录态（token）与应用凭证是两个文件：前者插件自己维护，后者只由用户维护。
  const signedIn = JSON.stringify({
    accessToken: 'AT',
    refreshToken: 'RT',
    expiresAt: Date.now() + 86400000,
    appRoot: '/apps/myapp'
  })

  const uploadedPaths = []
  const fetchImpl = fakeFetch(async (call) => {
    if (call.params.method === 'create' && String(call.params.isdir) === '1') return { errno: 0 }
    if (call.params.method === 'precreate') {
      uploadedPaths.push(call.params.path)
      assert.equal(call.params.path.startsWith('/apps/myapp/AI/exports/'), true, '必须落在应用的 AI/exports 下')
      assert.equal(call.params.openapi, 'xpansdk', 'precreate 必须带 openapi 标记')
      // 分片都在云端（还缺的分片是空数组），所以只要 create 就能落盘。
      return { errno: 0, uploadid: 'UP-' + uploadedPaths.length, block_list: [] }
    }
    if (call.params.method === 'create' && String(call.params.isdir) === '0') {
      assert.equal(call.params.openapi, 'xpansdk', 'create 必须带 openapi 标记')
      return { errno: 0, fs_id: 1 }
    }
    // 建完目录会列一次，确认它真的存在（create 报成功却没建出来是踩过的坑）。
    if (call.params.method === 'list') return { errno: 0, list: [] }
    // 传完会列一次目录，把网盘上的实际文件数报出来（秒传不产生传输，只能这样证伪）。
    if (call.params.method === 'listall') {
      return { errno: 0, has_more: 0, list: uploadedPaths.map((path, index) => ({ isdir: 0, fs_id: index, path: path })) }
    }
    throw new Error('不该发生的请求：' + call.url + ' ' + JSON.stringify(call.params))
  })

  const provided = new Map()
  const ctx = {
    reflect: {
      provide: (key, value) => {
        provided.set(key, value)
        return () => provided.delete(key)
      }
    },
    get: (key) => {
      if (key === 'dshHomePath') return (...segments) => join(home, ...segments)
      if (key === 'sessionQuery') return { listSessions: async () => [], filterSessions: async () => [], readTitleSnapshots: async () => [] }
      if (key === 'workspaceRegistry') return { archivedSessionIds: [], list: () => [] }
      if (key === 'baiduFetch') return fetchImpl
      return undefined
    },
    effect: () => {}
  }
  await applyHost(ctx)
  const service = provided.get('sessionMigrate')
  assert.ok(service, 'sessionMigrate 服务未注册')

  // ── 凭证只从 panbaidu.json 读 ────────────────────────────────────────────────
  // 文件不存在：明确说「还没配置」，并且一个网络请求都不该发出去。
  writeFileSync(statePath, signedIn)
  const noCreds = await service.baiduUpload()
  assert.equal(noCreds.configured, false, '没有凭证文件时必须报告未配置')
  assert.equal(noCreds.credentialsPath, credentialsPath, '要把期望的文件路径告诉用户')
  assert.ok(String(noCreds.error).includes('还没有配置'), '缺凭证时要给出明确原因：' + noCreds.error)
  assert.equal(fetchImpl.calls.length, 0, '缺凭证时不该发出任何网络请求')

  // 内容不是 JSON：要和「文件不存在」区分开，否则用户不知道该去建文件还是改格式。
  writeFileSync(credentialsPath, '{ this is not json')
  const brokenCreds = await service.baiduUpload()
  assert.equal(brokenCreds.configured, false)
  assert.ok(String(brokenCreds.error).includes('读不出来'), '格式错要单独说明：' + brokenCreds.error)

  // JSON 合法但缺必填项：要点出缺的是哪一个。
  writeFileSync(credentialsPath, JSON.stringify({ appKey: 'K' }))
  const partialCreds = await service.baiduUpload()
  assert.equal(partialCreds.configured, false)
  assert.ok(String(partialCreds.error).includes('secretKey'), '要指出缺哪个字段：' + partialCreds.error)
  assert.equal(fetchImpl.calls.length, 0, '凭证不合格时同样不该发请求')

  // 凭证齐了、但还没登录：这时才是「还没有登录」。
  writeFileSync(credentialsPath, JSON.stringify(TEST_CREDENTIALS))
  writeFileSync(statePath, JSON.stringify({ appRoot: '/apps/myapp' }))
  const denied = await service.baiduUpload()
  assert.equal(denied.configured, true, '凭证齐备后应报告已配置')
  assert.equal(denied.loggedIn, false)
  assert.ok(String(denied.error).includes('还没有登录'), '未登录时要给出明确原因')
  assert.equal(fetchImpl.calls.length, 0, '未登录时不该发请求')

  // 凭证 + 登录态齐备，再走一遍真正的上传。
  writeFileSync(statePath, signedIn)
  await service.baiduUpload()
  const deadline = Date.now() + 5000
  while (service.baiduTask.running) {
    if (Date.now() > deadline) throw new Error('上传任务超时未结束')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(service.baiduTask.error, null, '上传不该失败：' + service.baiduTask.error)
  assert.equal(service.baiduTask.result.uploaded, 2, 'exports 里的两个文件都要上传')
  assert.equal(service.baiduTask.result.failed, 0)
  assert.equal(service.baiduTask.result.remotePath, '/apps/myapp/AI/exports')
  assert.equal(service.baiduTask.result.instant, 2, '两个都命中秒传')
  assert.equal(service.baiduTask.result.remoteFileCount, 2, '上传后要报出网盘上的实际文件数')
  // index.json 必须是最后一个：它是「这份备份完整」的标志，中途失败时
  // 网盘上留下的应该是一份能对得上号的旧备份，而不是半个新备份。
  assert.equal(uploadedPaths[uploadedPaths.length - 1], '/apps/myapp/AI/exports/index.json',
    'index.json 必须最后上传')
  assert.deepEqual(uploadedPaths.slice().sort(), [
    '/apps/myapp/AI/exports/index.json',
    '/apps/myapp/AI/exports/sessions/_no-cwd/session-a/session.v3.jsonl.zstd'
  ].sort())

  // 面板状态里要能读到真实落点与本地概况。
  const status = await service.baiduStatus()
  assert.equal(status.loggedIn, true)
  assert.equal(status.phase, 'authorized')
  assert.equal(status.remotePath, '/apps/myapp/AI/exports')
  assert.equal(status.subdir, DEFAULT_REMOTE_SUBDIR)
  assert.equal(status.remotePathSource, 'default', '没配 RemotePath 时要标明用的是默认值')
  assert.equal(status.local.exists, true)
  assert.equal(status.local.fileCount, 2)
  assert.equal(status.local.sessionCount, 1)

  // ── 上传后核对：网盘上其实什么都没有时必须报失败 ─────────────────────────────
  // 回归：真实环境里出现过「已上传 5 个文件（其中 5 个命中秒传）」+「网盘上现在有
  // 0 个文件」却显示成绿色成功的自相矛盾结果。核对发现缺文件就必须报错——
  // 假成功比失败更危险，用户会以为数据已经安全了。
  {
    const emptyFetch = fakeFetch(async (call) => {
      if (call.params.method === 'create' && String(call.params.isdir) === '1') return { errno: 0 }
      if (call.params.method === 'list') return { errno: 0, list: [] }
      if (call.params.method === 'precreate') return { errno: 0, uploadid: 'UP-E', block_list: [] }
      if (call.params.method === 'create' && String(call.params.isdir) === '0') return { errno: 0, fs_id: 1 }
      // 网盘上什么都没有——上传链路没真正生效时的真实表现。
      if (call.params.method === 'listall') return { errno: 0, has_more: 0, list: [] }
      throw new Error('不该发生的请求：' + call.url)
    })
    service.baiduFetch = emptyFetch
    service.baidu = undefined
    await service.baiduUpload()
    const deadlineEmpty = Date.now() + 5000
    while (service.baiduTask.running) {
      if (Date.now() > deadlineEmpty) throw new Error('上传任务超时未结束')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(service.baiduTask.result.remoteFileCount, 0)
    assert.equal(service.baiduTask.result.missing.length, 2, '缺哪些文件必须点名')
    assert.ok(String(service.baiduTask.error).includes('核对不通过'), '核对发现缺文件必须报失败：' + service.baiduTask.error)
    // 诊断日志要留下来：界面上说不清的参数/响应问题，只能靠它定位。
    const debugLog = JSON.parse(await service.fsReadText(join(home, 'session-migrate', 'baidu-debug.log')))
    assert.equal(debugLog.kind, 'upload')
    assert.equal(debugLog.trace.filter((item) => item.precreate !== undefined).length, 2,
      '每个文件都要留一条请求/响应摘要')
    assert.equal(debugLog.trace[0].precreate.uploadid, 'UP-E', '要把 precreate 的原始响应记下来')
  }

  // ── 落点可配：panbaidu.json 里的 RemotePath 说了算 ──────────────────────────
  {
    const uploads = []
    const pathFetch = fakeFetch(async (call) => {
      if (call.params.method === 'create' && String(call.params.isdir) === '1') return { errno: 0 }
      if (call.params.method === 'precreate') {
        uploads.push(call.params.path)
        return { errno: 0, uploadid: 'UP', block_list: [] }
      }
      if (call.params.method === 'create' && String(call.params.isdir) === '0') return { errno: 0, fs_id: 1 }
      if (call.params.method === 'list') {
        // /apps 下面挂着这个应用目录——相对路径模式要靠它拼出完整落点。
        if (call.params.dir === '/apps') {
          return { errno: 0, list: [{ isdir: 1, path: '/apps/myapp', server_filename: 'myapp' }] }
        }
        return { errno: 0, list: [] }
      }
      if (call.params.method === 'listall') {
        return { errno: 0, has_more: 0, list: uploads.map((path, index) => ({ isdir: 0, fs_id: index, path: path })) }
      }
      throw new Error('不该发生的请求：' + call.url)
    })

    // 绝对路径：直接用，不该再去探测应用目录。
    service.baiduFetch = pathFetch
    service.baidu = undefined
    writeFileSync(credentialsPath, JSON.stringify({ ...TEST_CREDENTIALS, RemotePath: '/apps/other/Backup/deep' }))
    writeFileSync(statePath, signedIn)
    await service.baiduUpload()
    while (service.baiduTask.running) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(service.baiduTask.result.remotePath, '/apps/other/Backup/deep', '绝对路径要原样使用')
    assert.equal(service.baiduTask.error, null, '绝对路径上传不该失败：' + service.baiduTask.error)
    assert.equal(
      pathFetch.calls.some((call) => call.params.method === 'list' && call.params.dir === '/apps'),
      false,
      '给了绝对路径就不该再去探测 /apps'
    )
    for (const path of uploads) {
      assert.ok(path.startsWith('/apps/other/Backup/deep/'), '文件要落在配置的落点下：' + path)
    }
    assert.equal(uploads[uploads.length - 1], '/apps/other/Backup/deep/index.json', 'index.json 仍然最后传')

    // 相对路径：拼在应用目录后面，应用名仍从 /apps 探测。
    uploads.length = 0
    pathFetch.calls.length = 0
    service.baidu = undefined
    writeFileSync(credentialsPath, JSON.stringify({ ...TEST_CREDENTIALS, RemotePath: 'Backup/v2' }))
    // 清掉记住的 appRoot，逼它重新探测。
    writeFileSync(statePath, JSON.stringify({
      accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 86400000
    }))
    await service.baiduUpload()
    while (service.baiduTask.running) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(service.baiduTask.result.remotePath, '/apps/myapp/Backup/v2', '相对路径要拼在应用目录后面')
    assert.equal(service.baiduTask.error, null, '相对路径上传不该失败：' + service.baiduTask.error)

    // 收尾：恢复成不配 RemotePath 的状态，后面的用例依赖默认落点。
    writeFileSync(credentialsPath, JSON.stringify(TEST_CREDENTIALS))
    writeFileSync(statePath, signedIn)
    service.baidu = undefined
  }

  // ── 增量与删除：两端最终必须完全一致 ────────────────────────────────────────
  {
    const pan = makeFakePan()
    service.baiduFetch = pan.impl
    service.baidu = undefined
    writeFileSync(statePath, signedIn)
    writeFileSync(credentialsPath, JSON.stringify(TEST_CREDENTIALS))
    // 恢复一份完整的导出内容（前面的用例动过它）。
    mkdirSync(join(exportsDir, 'sessions', '_no-cwd', 'session-a'), { recursive: true })
    writeFileSync(join(exportsDir, 'sessions', '_no-cwd', 'session-a', 'session.v3.jsonl.zstd'), 'SESSION-BYTES')
    writeFileSync(join(exportsDir, 'index.json'), JSON.stringify({
      format: 'dsh-sessions-export',
      version: 4,
      exportedAt: 1,
      sessions: [{
        id: 'session-a',
        cwd: null,
        fileName: 'session.v3.jsonl.zstd',
        hash: 'HASH-A',
        remoteHash: null
      }]
    }))

    const runUpload = async () => {
      await service.baiduUpload()
      const deadline = Date.now() + 5000
      while (service.baiduTask.running) {
        if (Date.now() > deadline) throw new Error('上传任务超时未结束')
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      return service.baiduTask
    }

    // 第一轮：全量上传，并把 remoteHash 写回索引。
    let task = await runUpload()
    assert.equal(task.error, null, '第一轮不该失败：' + task.error)
    assert.equal(task.result.uploaded, 2, '会话与索引都要传')
    assert.equal(task.result.skipped, 0, '第一次没有可跳过的')
    let idx = JSON.parse(await service.fsReadText(join(exportsDir, 'index.json')))
    assert.equal(idx.sessions[0].remoteHash, 'HASH-A', '上传成功后要把 remoteHash 写成当时的 hash')

    // 第二轮：什么都没变 → 会话该被跳过，只剩索引要传。
    pan.uploads.length = 0
    task = await runUpload()
    assert.equal(task.error, null, '第二轮不该失败：' + task.error)
    assert.equal(task.result.skipped, 1, '内容没变的会话必须跳过')
    assert.deepEqual(pan.uploads, ['/apps/myapp/AI/exports/index.json'],
      '没变化的会话不该重传——这正是「每次点上传就全传一遍」要解决的问题')

    // 第三轮：本地删掉那个会话 → 云端多出来的必须被清掉。
    rmSync(join(exportsDir, 'sessions', '_no-cwd', 'session-a'), { recursive: true, force: true })
    const trimmed = JSON.parse(await service.fsReadText(join(exportsDir, 'index.json')))
    trimmed.sessions = []
    writeFileSync(join(exportsDir, 'index.json'), JSON.stringify(trimmed, null, 2))
    task = await runUpload()
    assert.equal(task.error, null, '第三轮不该失败：' + task.error)
    assert.equal(pan.files.has('/apps/myapp/AI/exports/sessions/_no-cwd/session-a/session.v3.jsonl.zstd'), false,
      '本地已经删掉的会话，云端必须跟着删')
    assert.ok(task.result.deleted >= 1, '要报告清理了几项：' + task.result.deleted)
    assert.deepEqual(task.result.missing, [], '删完之后云端不该缺东西')
    assert.deepEqual(task.result.extra, [], '删完之后云端不该多东西')

    // 第四轮：云端被手动删掉一个文件 → 不能因为「索引说传过」就跳过。
    pan.files.delete('/apps/myapp/AI/exports/index.json')
    pan.uploads.length = 0
    task = await runUpload()
    assert.equal(task.error, null, '第四轮不该失败：' + task.error)
    assert.deepEqual(pan.uploads, ['/apps/myapp/AI/exports/index.json'], '云端缺的必须补回来')
  }

  // ── 宿主集成：从网盘拉回来覆盖本地 ──────────────────────────────────────────
  // 网盘上放两份「与本地不同」的内容，下载后本地必须完全等于网盘那份——
  // 包括本地那个网盘上没有的文件要被清掉（获取的语义是「以网盘为准」）。
  writeFileSync(join(exportsDir, 'stale.json'), 'LOCAL-ONLY')
  const remoteFiles = [
    { fs_id: 100, isdir: 0, path: '/apps/myapp/AI/exports/index.json', size: 5 },
    { fs_id: 101, isdir: 0, path: '/apps/myapp/AI/exports/sessions/--p2--/session-b/session.v3.jsonl.zstd', size: 6 }
  ]
  const downloadFetch = fakeFetch(async (call) => {
    if (call.params.method === 'listall') {
      assert.equal(call.params.path, '/apps/myapp/AI/exports')
      return { errno: 0, has_more: 0, list: remoteFiles }
    }
    if (call.params.method === 'filemetas') {
      const ids = JSON.parse(call.params.fsids)
      return { errno: 0, info: ids.map((id) => ({ fs_id: id, dlink: 'https://d.pcs.baidu.com/dl/' + id })) }
    }
    if (call.path.startsWith('/dl/')) {
      assert.equal(call.params.access_token, 'AT')
      const id = Number(call.path.split('/').pop())
      return { __raw: Buffer.from(id === 100 ? 'REMOTE-INDEX' : 'REMOTE-SESSION') }
    }
    throw new Error('不该发生的请求：' + call.url)
  })
  service.baiduFetch = downloadFetch
  service.baidu = undefined // 丢掉上一个客户端，让它用新的 fetch 重建
  await service.baiduDownload()
  const deadline2 = Date.now() + 5000
  while (service.baiduTask.running) {
    if (Date.now() > deadline2) throw new Error('下载任务超时未结束')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(service.baiduTask.error, null, '下载不该失败：' + service.baiduTask.error)
  assert.equal(service.baiduTask.result.downloaded, 2)
  assert.equal(readFileSync(join(exportsDir, 'index.json'), 'utf8'), 'REMOTE-INDEX')
  assert.equal(
    readFileSync(join(exportsDir, 'sessions', '--p2--', 'session-b', 'session.v3.jsonl.zstd'), 'utf8'),
    'REMOTE-SESSION'
  )
  assert.equal(existsSync(join(exportsDir, 'stale.json')), false, '本地多出来的文件必须被清掉（以网盘为准）')
  assert.equal(existsSync(join(exportsDir, 'sessions', '_no-cwd', 'session-a')), false, '网盘上没有的旧目录必须被清掉')
  assert.equal(existsSync(join(home, 'session-migrate', '.baidu-incoming')), false, '临时目录必须清理干净')

  // 网盘上没有 index.json 时不能覆盖本地——那多半是别的应用放的目录。
  rmSync(join(exportsDir, 'index.json'), { force: true })
  const badFetch = fakeFetch(async (call) => {
    if (call.params.method === 'listall') {
      return { errno: 0, has_more: 0, list: [{ fs_id: 200, isdir: 0, path: '/apps/myapp/AI/exports/readme.txt' }] }
    }
    throw new Error('不该发生的请求：' + call.url)
  })
  service.baiduFetch = badFetch
  service.baidu = undefined
  await service.baiduDownload()
  const deadline3 = Date.now() + 5000
  while (service.baiduTask.running) {
    if (Date.now() > deadline3) throw new Error('下载任务超时未结束')
  }
  assert.ok(String(service.baiduTask.error).includes('index.json'), '缺 index.json 时必须明确拒绝')

  // 未登录时两个动作都必须给出可读的原因，而不是抛一堆网络错误。
  await service.baiduLogout()
  const afterLogout = await service.baiduStatus()
  assert.equal(afterLogout.loggedIn, false)
  assert.equal(afterLogout.phase, 'idle')
  const uploadAfterLogout = await service.baiduUpload()
  assert.equal(uploadAfterLogout.error, '还没有登录百度网盘')
}

rmSync(workDir, { recursive: true, force: true })

console.log('百度网盘冒烟测试通过：授权间隔、分片与秒传、递归列举、下载链路、路径安全、宿主上传下载均符合百度开放平台契约。')
