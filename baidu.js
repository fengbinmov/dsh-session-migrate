// 百度网盘开放平台的协议层。
//
// 这一层只做 HTTP 与协议：OAuth 设备码授权、分片上传（含秒传）、递归列举、下载。
// 文件系统操作一律留给调用方（host.js），于是整层可以用一个假的 fetch 完整测出来，
// 不必碰真实网络，也不必碰真实磁盘。
//
// 几个容易踩的坑，都在下面各自的注释里写清了来由：
//   1. 所有请求的 User-Agent 必须含 pan.baidu.com，否则一律被拒
//   2. 第三方应用只能访问 /apps/<应用名>/，应用名只有列一次目录才知道
//   3. 分片大小固定 4MB，且 block_list 的 MD5 必须与实际上传的分片逐位对应
//   4. 上传是「预上传 → 分片上传 → 创建文件」三步，path/size/block_list 三处必须一致

import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'

// 应用凭证一律从外部读取，这一层不内置任何默认值。
//
// 凭证（AppKey / SecretKey）等同于账号的身份：谁能拿到它，谁就能以这个应用的名义
// 向用户索要授权。把它写进源码就等于写进了版本库，一次 push 之后再也收不回来。
// 所以这里只提供「把外部读到的对象规范成凭证」这一件事，读取由调用方负责。

// 配置文件由用户手写，格式以百度控制台为准，而控制台里写的是
// AppID / AppKey / SecretKey / SignKey。手写 JSON 时大小写和下划线几乎必然有出入，
// 所以把键名规范成「全小写、去掉下划线与连字符」再比对——这样
// `AppKey` / `appKey` / `app_key` / `APP_KEY` 是同一个东西，用户不用猜该写哪种。
const APP_ID_ALIASES = ['appid']
const APP_KEY_ALIASES = ['appkey', 'apikey', 'clientid']
const SECRET_KEY_ALIASES = ['secretkey', 'clientsecret']
// SignKey 属于早期的 PCS API，xpan 接口用不到它，所以只是可选地留着。
const SIGN_KEY_ALIASES = ['signkey']

function normalizeKeyName(name) {
  return String(name).toLowerCase().replace(/[_\-\s]/g, '')
}

function pick(source, aliases) {
  const index = new Map()
  for (const key of Object.keys(source)) {
    const normalized = normalizeKeyName(key)
    if (!index.has(normalized)) index.set(normalized, key)
  }
  for (const alias of aliases) {
    const actual = index.get(alias)
    if (actual === undefined) continue
    const value = source[actual]
    // 只去掉首尾空白：密钥里出现空格是合法的，不能顺手「整理」掉。
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    // AppID 在控制台里就是数字，写成数字也该认。
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

/**
 * 把外部读到的对象规范化成凭证。缺 AppKey 或 SecretKey 时抛错——
 * 这两个是硬性必需，少了它们在授权阶段只会得到一个含糊的失败。
 */
export function normalizeCredentials(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('应用凭证必须是一个 JSON 对象')
  }
  const appKey = pick(input, APP_KEY_ALIASES)
  const secretKey = pick(input, SECRET_KEY_ALIASES)
  const missing = []
  if (appKey === '') missing.push('appKey')
  if (secretKey === '') missing.push('secretKey')
  if (missing.length > 0) {
    throw new Error('应用凭证缺少必填项：' + missing.join('、'))
  }
  return {
    appId: pick(input, APP_ID_ALIASES),
    appKey: appKey,
    secretKey: secretKey,
    signKey: pick(input, SIGN_KEY_ALIASES)
  }
}

const OAUTH_BASE = 'https://openapi.baidu.com/oauth/2.0'
const PAN_BASE = 'https://pan.baidu.com/rest/2.0/xpan'
const UPLOAD_BASE = 'https://d.pcs.baidu.com/rest/2.0/pcs/superfile2'

// 开放平台对所有接口的硬性要求：User-Agent 必须包含 pan.baidu.com。
// 少了它不报参数错误，而是直接返回「身份验证失败」，很难反查。
const USER_AGENT = 'pan.baidu.com'

// 上传链路（precreate / superfile2 / create）必须携带的官方 SDK 标记。
//
// 这是本插件踩过最贵的一个坑：少了 `openapi=xpansdk`，precreate 会返回
// `{"errno":0,"return_type":1,"block_list":[...]}`——errno 是 0、形状像秒传，
// 但**既不返回 uploadid，也不在云端建立上传任务**。整个上传静默失败，
// 界面上却一路显示成功。官方 Go SDK 把这三个接口的这个字段标成
// 「官方 OpenAPI SDK 标记，上传链路需要携带」。
const OPENAPI_MARK = 'xpansdk'

// 官方文档给出的分片大小。block_list 必须与实际上传的分片逐位对应，
// 所以这个值一经确定就不能在两次上传之间变化。
export const SLICE_SIZE = 4 * 1024 * 1024

// 官方限制分片数不超过 10000（约 40GB）。
const MAX_SLICES = 10000

// POST 接口里固定走 query 的两个参数（见 httpJson 里的说明）。
const POST_QUERY_KEYS = new Set(['method', 'access_token'])

// 网盘上的默认落点（相对于应用的 /apps/<应用名>/ 目录）。
//
// 落点本身是可配的，写在 baiduclound.json 的 RemotePath 字段里。这里只是一份兜底，
// 让没配过的人也能直接用。RemotePath 支持两种写法：
//   - 相对路径 `AI/exports` —— 拼在应用目录后面，不必关心应用叫什么名字
//   - 绝对路径 `/apps/dsh/AI/exports` —— 直接指定，连应用目录都不用再去探测
export const DEFAULT_REMOTE_SUBDIR = 'AI/exports'

const REMOTE_PATH_ALIASES = ['remotepath', 'remotedir', 'remotefolder']

/**
 * 从配置里取网盘落点，返回规范化后的路径；没配则返回空串。
 *
 * 别名的匹配沿用凭证那套「忽略大小写与下划线」的规则，所以
 * `RemotePath` / `remotePath` / `remote_path` 是同一个东西。
 */
export function normalizeRemotePath(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return ''
  const raw = pick(input, REMOTE_PATH_ALIASES)
  if (raw === '') return ''
  const absolute = raw.trim().startsWith('/')
  const parts = raw.replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.')
  if (parts.some((part) => part === '..')) {
    throw new Error('RemotePath 里不允许出现 ".."')
  }
  if (parts.length === 0) return ''
  return (absolute ? '/' : '') + parts.join('/')
}

const ERRNO_TEXT = {
  '-1': '网盘服务暂时不可用',
  '-2': '请求参数有误',
  '-3': '文件不存在',
  '-4': '文件已存在',
  '-6': 'access_token 无效或已过期，请重新登录百度网盘',
  '-7': '文件名或路径非法',
  '-8': '文件或目录已存在',
  '-9': '文件或目录不存在',
  '-10': '云盘容量不足',
  '2': '参数错误',
  '31023': '请求参数有误',
  '31034': '命中防盗链限制，请稍后重试',
  '31064': '分片上传失败',
  '31066': '文件不存在',
  '31326': '文件名非法',
  '42211': '参数错误（路径或文件不合法）',
  '42212': '无权访问该目录',
  '42213': '该目录不在当前应用的可访问范围内',
  '42214': '文件已存在',
  '42216': '请求过于频繁，请稍后重试'
}

export class BaiduApiError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'BaiduApiError'
    this.errno = details.errno
    this.request = details.request || null
    this.payload = details.payload === undefined ? null : details.payload
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

function md5(buffer) {
  return createHash('md5').update(buffer).digest('hex')
}

/**
 * 解析百度返回的 JSON，同时保住它那些 64 位整数。
 *
 * 百度的 `fs_id` / `request_id` 是 64 位整数（实测 18 位：460870210490616260），
 * 远超 JS 的安全整数上限 2^53。直接 `JSON.parse` 会把它们变成不精确的 double。
 * 多数情况下 `String()` 的最短往返表示恰好还原成原值、看不出问题，但这是运气——
 * 换一个 fs_id 就可能把 …256 打印成 …260。所以先把超过 15 位的整数字面量加上
 * 引号，让它们无损保留；用到这些字段的地方本来就会做 Number()/String() 转换。
 */
function parseJsonPreservingIds(text) {
  return JSON.parse(text.replace(/:\s*(-?\d{16,})(?=\s*[,}\]])/g, ': "$1"'))
}

/**
 * 取出 filemetas 返回的文件信息数组。
 *
 * 这个接口的响应字段在不同版本/文档里写作 `list` 或 `info`：官方 Go SDK 的结构体
 * 是 `json:"list"`，而一些文档示例写的是 `info`。只认其中一个的后果是「从百度云中
 * 获取」整体失败、报「网盘没有返回这个文件的下载信息」——看起来像权限或路径问题，
 * 实际上只是没读懂响应。两个都认，成本为零。
 */
function fileMetasItems(json) {
  if (json === null || typeof json !== 'object') return []
  if (Array.isArray(json.list)) return json.list
  if (Array.isArray(json.info)) return json.info
  return []
}

/**
 * 把响应压成一行短摘要塞进错误信息。
 *
 * 开放平台的错误码表并不完整，而且同一个 errno 在不同接口下含义并不一致——
 * 遇到没见过的响应形状时，唯一能定位问题的东西就是原文。截断是为了界面不被刷屏。
 */
function summarize(value, limit = 400) {
  let text
  try {
    text = JSON.stringify(value)
  } catch (e) {
    text = String(value)
  }
  if (text === undefined) text = String(value)
  return text.length > limit ? text.slice(0, limit) + '…' : text
}

function errnoText(errno, payload) {
  const known = ERRNO_TEXT[String(errno)]
  if (known !== undefined) return known
  // 不认识错误码时把响应原文带上：开放平台的错误码表并不完整，
  // 留一个口子比统一说「未知错误」有用得多。
  return '百度网盘返回错误 errno=' + errno + '，响应原文：' + summarize(payload, 300)
}

// ── 分片计算：与磁盘解耦，方便单独测试 ────────────────────────────────────────

/** 把一个文件按 4MB 切分，逐片算 MD5（这就是预上传要的 block_list）。 */
export async function fileSliceMd5(filePath, size, sliceSize = SLICE_SIZE) {
  const count = sliceCount(size)
  const handle = await open(filePath, 'r')
  try {
    const list = []
    const buffer = Buffer.alloc(sliceSize)
    for (let index = 0; index < count; index++) {
      const start = index * sliceSize
      const length = Math.min(sliceSize, size - start)
      const result = await handle.read(buffer, 0, length, start)
      list.push(md5(buffer.subarray(0, result.bytesRead)))
    }
    return list
  } finally {
    await handle.close()
  }
}

/** 读第 index 个分片的字节。 */
export async function readSlice(filePath, index, size, sliceSize = SLICE_SIZE) {
  const start = index * sliceSize
  const length = Math.max(0, Math.min(sliceSize, size - start))
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    if (length === 0) return buffer
    const result = await handle.read(buffer, 0, length, start)
    return buffer.subarray(0, result.bytesRead)
  } finally {
    await handle.close()
  }
}

/** 分片数：空文件也算一片（MD5 为空内容的哈希），与百度对空文件的处理一致。 */
export function sliceCount(size, sliceSize = SLICE_SIZE) {
  if (!Number.isFinite(size) || size <= 0) return 1
  return Math.ceil(size / sliceSize)
}

/**
 * 把本地相对路径拼成网盘绝对路径，并挡住路径穿越。
 * 网盘上的文件名是外部数据，不能直接当本地路径用，反过来也一样。
 */
export function joinRemote(base, relative) {
  const parts = String(relative).replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.')
  for (const part of parts) {
    if (part === '..') throw new Error('路径里不允许出现 ".."：' + relative)
    if (part.includes('\u0000')) throw new Error('路径里不允许出现空字符：' + relative)
  }
  return base.replace(/\/+$/, '') + '/' + parts.join('/')
}

/** 反向：从网盘绝对路径取出相对 base 的那一段，越界返回 null。 */
export function relativeTo(base, absolute) {
  const normalizedBase = String(base).replace(/\/+$/, '')
  const path = String(absolute).replace(/\\/g, '/')
  if (path === normalizedBase) return ''
  if (!path.startsWith(normalizedBase + '/')) return null
  const relative = path.slice(normalizedBase.length + 1)
  if (relative === '' || relative.split('/').some((part) => part === '..' || part === '')) return null
  return relative
}

export class BaiduPanClient {
  /**
   * @param {object} options
   * @param {Function} [options.fetchImpl] 注入的 fetch，测试用；默认取全局 fetch
   * @param {object} options.credentials 应用凭证，必填；缺失或不全直接抛错
   */
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('当前 Node 运行时没有 fetch，百度网盘功能不可用（需要 Node 18 及以上）')
    }
    // 没有内置兜底凭证是刻意的：宁可在这里明确失败，也不要让插件偷偷用一个
    // 不属于当前用户的身份去请求授权。
    const credentials = normalizeCredentials(options.credentials)
    this.appId = credentials.appId
    this.appKey = credentials.appKey
    this.secretKey = credentials.secretKey
    this.signKey = credentials.signKey
    // access_token 由调用方持有并写入（它要持久化到磁盘、要能刷新），
    // 客户端只负责在每次调用时带上它。
    this.accessToken = options.accessToken || null
    this.remoteBase = options.remoteBase || null
  }

  // ── HTTP 底座 ──────────────────────────────────────────────────────────────

  /**
   * 发一次请求并解析 JSON。
   * 只重试「网络层/解析层」的失败——业务错误（errno 非 0）由 assertOk 抛出，
   * 不在这里重试：参数错了重试多少次都是错的。
   */
  async httpJson(url, options = {}) {
    const method = options.method || 'GET'
    const params = options.params || {}
    const attempts = (options.retries === undefined ? 2 : options.retries) + 1
    const timeout = options.timeout || 30000
    // 百度网盘对 POST 接口同样读 query 参数，而服务端到底读哪一处并不稳定——
    // 这里踩过一次很贵的坑：只把业务参数放 form body 时，precreate 返回了
    // `{"errno":0,"return_type":1,"info":{...}}`，看着像秒传成功，实际上参数压根
    // 没被读到——既没有 uploadid，也没有在网盘上建出任何东西，目录也是空的。
    // 所以 query 放全部参数，body 再放一遍业务参数：两边都放，读哪边都不会丢。
    const query = new URLSearchParams()
    const body = new URLSearchParams()
    for (const key of Object.keys(params)) {
      const value = params[key]
      if (value === undefined || value === null) continue
      query.append(key, String(value))
      if (method !== 'GET' && !POST_QUERY_KEYS.has(key)) body.append(key, String(value))
    }
    const target = query.toString() === '' ? url : url + '?' + query.toString()
    let lastError = null
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await delay(500 * attempt * attempt)
      try {
        const init = {
          method: method,
          headers: { 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(timeout)
        }
        if (method !== 'GET') {
          init.headers['Content-Type'] = 'application/x-www-form-urlencoded'
          init.body = body.toString()
        }
        const response = await this.fetchImpl(target, init)
        const text = await response.text()
        let json = null
        try {
          json = parseJsonPreservingIds(text)
        } catch (e) {
          json = null
        }
        if (json === null) {
          // 非 JSON 响应在开放平台上通常是风控页或网关错误页，重试是有意义的。
          throw new Error('百度网盘返回了非 JSON 响应（HTTP ' + response.status + '）：' + text.slice(0, 200))
        }
        return json
      } catch (e) {
        lastError = e
      }
    }
    throw lastError
  }

  /** 带 access_token 的业务调用，顺带把 errno 翻成人话。 */
  async call(url, params = {}, options = {}) {
    const payload = { ...params }
    if (this.accessToken) payload.access_token = this.accessToken
    const json = await this.httpJson(url, { ...options, params: payload })
    this.assertOk(json, url, payload)
    return json
  }

  assertOk(json, url, params) {
    const errno = json !== null && typeof json === 'object' ? json.errno : undefined
    if (errno === undefined || Number(errno) === 0) return
    throw new BaiduApiError(errnoText(errno, json), {
      errno: Number(errno),
      request: { url: url, params: params },
      payload: json
    })
  }

  /** OAuth 接口的失败形状与业务接口不同：它返回 error / error_description。 */
  assertOauthOk(json, url) {
    if (json === null || typeof json !== 'object') {
      throw new BaiduApiError('百度授权服务返回了空响应', { request: { url: url } })
    }
    if (json.error === undefined || json.error === null) {
      if (json.access_token) return json
      throw new BaiduApiError('百度授权服务没有返回 access_token', { request: { url: url }, payload: json })
    }
    throw new BaiduApiError(
      '百度授权失败：' + json.error + (json.error_description ? '（' + json.error_description + '）' : ''),
      { request: { url: url }, payload: json }
    )
  }

  // ── OAuth：设备码模式 ──────────────────────────────────────────────────────
  // 选设备码而不是授权码模式，是因为授权码模式要求 redirect_uri 预先在控制台登记，
  // 而本插件跑在用户的桌面上，端口不固定、也没有公网回调地址。设备码模式不需要回调。

  async requestDeviceCode() {
    const json = await this.httpJson(OAUTH_BASE + '/device/code', {
      params: {
        response_type: 'device_code',
        client_id: this.appKey,
        scope: 'basic,netdisk'
      }
    })
    if (!json.device_code || !json.user_code) {
      throw new BaiduApiError('百度没有返回设备码，请检查 AppKey 是否正确', { payload: json })
    }
    return {
      deviceCode: json.device_code,
      userCode: json.user_code,
      verificationUrl: json.verification_url || 'https://openapi.baidu.com/device',
      qrcodeUrl: json.qrcode_url || '',
      expiresIn: Number(json.expires_in) || 300,
      // 官方要求轮询间隔不低于 5 秒，服务端下发的 interval 优先，但绝不低于 5。
      interval: Math.max(Number(json.interval) || 5, 5)
    }
  }

  /**
   * 用 device_code 换 token。
   * 用户还没点授权时百度返回 error=authorization_pending（部分版本是 waiting），
   * 这不是错误，只是「还没好」，所以单独标出来让调用方继续轮询。
   */
  async requestDeviceToken(deviceCode) {
    const json = await this.httpJson(OAUTH_BASE + '/token', {
      params: {
        grant_type: 'device_token',
        code: deviceCode,
        client_id: this.appKey,
        client_secret: this.secretKey
      }
    })
    if (json && json.access_token) return { pending: false, token: this.normalizeToken(json) }
    const error = json && json.error ? String(json.error) : ''
    if (error === 'authorization_pending' || error === 'authorization_waiting' || error === 'slow_down') {
      return { pending: true }
    }
    this.assertOauthOk(json, OAUTH_BASE + '/token')
    return { pending: true }
  }

  async refreshAccessToken(refreshToken) {
    const json = await this.httpJson(OAUTH_BASE + '/token', {
      params: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.appKey,
        client_secret: this.secretKey
      }
    })
    return this.normalizeToken(this.assertOauthOk(json, OAUTH_BASE + '/token'))
  }

  normalizeToken(json) {
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token || null,
      scope: json.scope || '',
      // 提前 5 分钟算过期，避免「刚好在用的时候过期」。
      expiresAt: Date.now() + (Number(json.expires_in) || 2592000) * 1000
    }
  }

  // ── 用户与应用目录 ─────────────────────────────────────────────────────────

  async userInfo() {
    return await this.call(PAN_BASE + '/nas', { method: 'uinfo' })
  }

  /** 列出某一层目录。dir 传绝对路径。 */
  async listDir(dir) {
    return await this.call(PAN_BASE + '/file', {
      method: 'list',
      dir: dir,
      order: 'name',
      desc: 0,
      start: 0,
      limit: 1000,
      web: 0
    })
  }

  /**
   * 递归列出 path 下的所有条目——**文件和目录都留着**。
   *
   * 同步要做到「两端完全一致」就必须看得见目录：只列文件的话，云端残留的空目录
   * 永远不会被发现，也就永远删不掉。
   *
   * 首选 listall（一次请求拿到整棵树）；它在部分权限下不可用，那就退回逐层 list。
   * 备份目录的层级不深，但工作区一多，逐层 list 的调用次数会成倍上涨，
   * 所以 listall 是主路径。
   */
  async listAllEntries(path) {
    let entries = null
    try {
      entries = await this.listAllFlat(path)
    } catch (e) {
      entries = null
    }
    // listall 在个别权限下会「成功但返回空」。宁可多花一次调用用 list 确认，
    // 也不要让用户看到「网盘上没有备份」这种可能是假的结论——那会让人以为数据丢了。
    if (entries === null || entries.length === 0) {
      const fallback = await this.listAllRecursive(path)
      if (fallback.length > 0) return fallback
      return entries === null ? fallback : entries
    }
    return entries
  }

  async listAllFiles(path) {
    const entries = await this.listAllEntries(path)
    return entries.filter((entry) => Number(entry.isdir) !== 1)
  }

  async listAllFlat(path) {
    const entries = []
    let start = 0
    for (let page = 0; page < 200; page++) {
      const json = await this.call(PAN_BASE + '/multimedia', {
        method: 'listall',
        path: path,
        recursion: 1,
        start: start,
        limit: 1000
      })
      const list = Array.isArray(json.list) ? json.list : []
      for (const entry of list) entries.push(entry)
      if (Number(json.has_more) !== 1) break
      // 有下一页时必须以响应里的 cursor 作为下一次的 start，自行按步长累加会漏项。
      const cursor = Number(json.cursor)
      if (!Number.isFinite(cursor) || cursor === start) throw new Error('listall 分页游标没有前进')
      start = cursor
    }
    return entries
  }

  async listAllRecursive(path) {
    const entries = []
    const queue = [path]
    for (let hop = 0; queue.length > 0 && hop < 500; hop++) {
      const dir = queue.shift()
      const json = await this.listDir(dir).catch((e) => {
        // 目录不存在时当作空目录：备份目录可能只是还没建出来。
        if (e instanceof BaiduApiError && (e.errno === -9 || e.errno === -3)) return { list: [] }
        throw e
      })
      const list = Array.isArray(json.list) ? json.list : []
      for (const entry of list) {
        entries.push(entry)
        if (Number(entry.isdir) === 1) queue.push(entry.path)
      }
    }
    return entries
  }

  /**
   * 批量删除网盘上的路径。目录会连同里面的内容一起删掉。
   *
   * 这是不可逆的破坏性操作，所以调用方必须自己保证传进来的路径都在受管目录内——
   * 这一层不做范围判断，它只负责删（见 host.js 里的护栏）。
   */
  async deletePaths(paths) {
    const targets = Array.from(new Set((paths || []).filter((path) => typeof path === 'string' && path !== '')))
    const results = []
    // 百度对单次 filelist 的长度有限制，分批走。
    const BATCH = 100
    for (let index = 0; index < targets.length; index += BATCH) {
      const batch = targets.slice(index, index + BATCH)
      const json = await this.call(PAN_BASE + '/file', {
        method: 'filemanager',
        opera: 'delete',
        // async=0 要同步结果：删了没有是同步语义的一部分，不能当后台任务丢出去。
        async: 0,
        filelist: JSON.stringify(batch)
      }, { method: 'POST' })
      const info = Array.isArray(json.info) ? json.info : []
      for (const path of batch) {
        const hit = info.find((entry) => entry !== null && typeof entry === 'object' && entry.path === path)
        if (hit === undefined) {
          // 响应里没提到它，多半是本来就不存在——删除是幂等的，这不算失败。
          results.push({ path: path, ok: true, errno: 0, note: '响应中未提及' })
        } else {
          const errno = Number(hit.errno)
          // -9 / -3 是「本来就不存在」，对「让它消失」这个目标而言同样是达成。
          const ok = errno === 0 || errno === -9 || errno === -3
          results.push({ path: path, ok: ok, errno: errno })
        }
      }
    }
    return results
  }

  /** 建目录。已经存在不算失败——调用方要的是「它在那儿」。 */
  async createDir(path) {
    try {
      await this.call(PAN_BASE + '/file', {
        openapi: OPENAPI_MARK,
        method: 'create',
        path: path,
        isdir: 1,
        rtype: 0
      }, { method: 'POST' })
      return true
    } catch (e) {
      // -8 / -4 / 42214 都是「已经存在」。对调用方而言这就是目标状态，不是错误。
      if (e instanceof BaiduApiError && (e.errno === -8 || e.errno === -4 || e.errno === 42214)) return false
      throw e
    }
  }

  /**
   * 逐级建目录。
   * base 是「已知存在」的那一段前缀——`/apps/<应用名>` 是开放平台自己的目录，
   * 既不该也不能由我们去创建，从它下面开始建才不会撞一鼻子灰。
   */
  async createDirTree(path, base) {
    const prefix = typeof base === 'string' ? base.replace(/\/+$/, '') : ''
    const target = String(path)
    const rest = prefix !== '' && target.startsWith(prefix) ? target.slice(prefix.length) : target
    let current = prefix
    let created = 0
    for (const part of rest.split('/').filter((entry) => entry !== '')) {
      current += '/' + part
      if (await this.createDir(current)) created += 1
    }
    return created
  }

  /**
   * 找出应用可写的根目录 /apps/<应用名>。
   * 应用名只有列一次目录才知道，别处拿不到——uinfo 只给百度账号名。
   */
  async findAppRoot() {
    let listing = null
    try {
      listing = await this.listDir('/apps')
    } catch (e) {
      throw new BaiduApiError(
        '无法列出 /apps 目录，说明这个应用还没有获得网盘基础服务的目录权限：' + (e && e.message ? e.message : String(e)),
        { errno: e && e.errno, request: { url: PAN_BASE + '/file', params: { method: 'list', dir: '/apps' } } }
      )
    }
    const dirs = (Array.isArray(listing.list) ? listing.list : []).filter((entry) => Number(entry.isdir) === 1)
    if (dirs.length === 0) {
      throw new BaiduApiError(
        '网盘的 /apps 目录下没有属于这个应用的目录。请先在网盘里让应用创建一次目录，或在控制台确认应用已通过审核。',
        { payload: listing }
      )
    }
    // 正常情况下只会有一个；有多个时取路径最短的那个（应用根目录）并把它显示给用户。
    dirs.sort((a, b) => String(a.path).length - String(b.path).length)
    return dirs[0].path
  }

  // ── 上传 ───────────────────────────────────────────────────────────────────

  /**
   * 预上传：拿到 uploadid，以及「哪几个分片还需要真的传」。
   *
   * 两个容易误判的地方：
   *
   * 1. **必须带 `openapi=xpansdk`**。少了它，百度会返回一个 errno=0、
   *    `return_type: 1`、看起来像「秒传」的响应，但里面没有 uploadid，
   *    云端也没有建出任何上传任务——整个上传静默失败。
   * 2. **`return_type` 是系统内部状态字段，不能拿它判断秒传**。官方 SDK 的注释
   *    就是这么写的，实测中它即使对已存在的文件也可能返回 1。跳过与否只能看
   *    `block_list`（还缺哪几片），最终是否成立由 `create` 说了算。
   */
  async precreate(params) {
    const json = await this.call(PAN_BASE + '/file', {
      openapi: OPENAPI_MARK,
      method: 'precreate',
      path: params.path,
      size: params.size,
      isdir: 0,
      block_list: JSON.stringify(params.blockList),
      // rtype=3 是覆盖：重复上传必须落到同一个文件上，而不是生成 "xxx (1).json"。
      rtype: 3,
      autoinit: 1,
      local_ctime: params.ctime,
      local_mtime: params.mtime
    }, { method: 'POST' })
    const uploadid = typeof json.uploadid === 'string' && json.uploadid !== '' ? json.uploadid : null
    if (uploadid === null) {
      throw new BaiduApiError(
        '预上传没有返回 uploadid（上传链路缺少 openapi 标记时就会这样），响应原文：' + summarize(json),
        { payload: json }
      )
    }
    let blockList = null
    if (Array.isArray(json.block_list)) {
      const parsed = json.block_list.map(Number)
      // 缺 openapi 标记时，这个字段会被原样回显成 MD5 字符串数组。那不是分片序号，
      // 当成序号用会得出「一片都不用传」的错误结论，所以必须挡住。
      if (parsed.some((value) => !Number.isFinite(value))) {
        throw new BaiduApiError(
          '预上传返回的 block_list 不是分片序号（可能是被原样回显的 MD5），响应原文：' + summarize(json),
          { payload: json }
        )
      }
      blockList = parsed
    }
    return { uploadid: uploadid, blockList: blockList, raw: json }
  }

  /** 分片上传：multipart/form-data，字段名固定为 file。 */
  async uploadSlice(params) {
    const search = new URLSearchParams()
    // openapi 标记同样是分片上传的硬性要求。
    search.append('openapi', OPENAPI_MARK)
    search.append('method', 'upload')
    search.append('access_token', this.accessToken || '')
    search.append('type', 'tmpfile')
    search.append('path', params.path)
    search.append('uploadid', params.uploadid)
    search.append('partseq', String(params.partseq))
    const form = new FormData()
    form.append('file', new Blob([params.buffer]), 'slice-' + params.partseq)
    // 大分片要留足时间：4MB 在慢速上行链路上可能要几分钟。
    const response = await this.fetchImpl(UPLOAD_BASE + '?' + search.toString(), {
      method: 'POST',
      // 这里刻意不设 Content-Type：boundary 必须由 fetch 自己生成。
      headers: { 'User-Agent': USER_AGENT },
      body: form,
      signal: AbortSignal.timeout(300000)
    })
    const text = await response.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch (e) {
      throw new BaiduApiError('分片上传返回了非 JSON 响应（HTTP ' + response.status + '）：' + text.slice(0, 200), {})
    }
    this.assertOk(json, UPLOAD_BASE, { path: params.path, partseq: params.partseq })
    return json
  }

  /** 创建文件：把已上传的分片合并成最终文件，也是整条上传链路的终点。 */
  async createFile(params) {
    return await this.call(PAN_BASE + '/file', {
      openapi: OPENAPI_MARK,
      method: 'create',
      path: params.path,
      size: params.size,
      isdir: 0,
      // create 的 block_list 必须是「分片上传返回的 MD5」，按分片序号排列。
      block_list: JSON.stringify(params.blockList),
      uploadid: params.uploadid,
      rtype: 3,
      local_ctime: params.ctime,
      local_mtime: params.mtime
    }, { method: 'POST' })
  }

  /**
   * 上传一个本地文件到网盘。三步走：预上传 → 补传缺失分片 → 创建文件。
   * 秒传命中时第二步整段跳过，这就是「同一个备份重传几乎瞬间完成」的原因。
   */
  async uploadFile(params) {
    const size = params.size
    const count = sliceCount(size)
    if (count > MAX_SLICES) {
      throw new Error('文件超过 ' + Math.round(MAX_SLICES * SLICE_SIZE / 1024 / 1024 / 1024) + 'GB，超出百度网盘单文件上限')
    }
    const localBlockList = await fileSliceMd5(params.filePath, size)
    const pre = await this.precreate({
      path: params.path,
      size: size,
      blockList: localBlockList,
      ctime: params.ctime,
      mtime: params.mtime
    })
    const finalBlockList = localBlockList.slice()
    // 服务端只回「还缺哪几片」；没回（null）就保守地全传，回空数组则一片都不用传
    // （分片都已在云端）。这两种情况必须区分开。
    const needed = pre.blockList === null
      ? Array.from({ length: count }, (unused, index) => index)
      : pre.blockList
    let uploadedSlices = 0
    for (const seq of needed) {
      if (!Number.isInteger(seq) || seq < 0 || seq >= count) continue
      const buffer = await readSlice(params.filePath, seq, size)
      const result = await this.uploadSlice({
        path: params.path,
        uploadid: pre.uploadid,
        partseq: seq,
        buffer: buffer
      })
      // 服务端回传的 MD5 才是权威值，用它覆盖本地算的那一份。
      if (result && typeof result.md5 === 'string' && result.md5 !== '') finalBlockList[seq] = result.md5
      uploadedSlices += 1
      if (typeof params.onSlice === 'function') params.onSlice(seq, needed.length)
    }
    // create 是整条链路的终点，**任何情况下都要走**。
    // 是否「秒传」不由 precreate 决定，而是由这里的结果决定——文件真的落在网盘上，
    // 才算数。早先版本在 precreate 看到 return_type=1 就直接返回「成功」，
    // 结果云端什么都没有。
    try {
      await this.createFile({
        path: params.path,
        size: size,
        blockList: finalBlockList,
        uploadid: pre.uploadid,
        ctime: params.ctime,
        mtime: params.mtime
      })
    } catch (e) {
      // 云端已有同样内容时 create 会报 -8（文件已存在）。对调用方而言这就是目标状态。
      if (!(e instanceof BaiduApiError && e.errno === -8)) throw e
      return {
        instant: true,
        existed: true,
        slices: count,
        uploadedSlices: uploadedSlices,
        precreateResponse: pre.raw
      }
    }
    return {
      instant: uploadedSlices === 0,
      existed: false,
      slices: count,
      uploadedSlices: uploadedSlices,
      precreateResponse: pre.raw
    }
  }

  // ── 下载 ───────────────────────────────────────────────────────────────────

  /**
   * 查询文件信息并拿到 dlink。百度允许一次问多个 fs_id。
   *
   * `fsids` 手工拼成数字数组的字面量，而不是走 JSON.stringify：fs_id 是 64 位整数，
   * 在 JS 里只能以字符串形式无损保存，而 JSON.stringify 会给字符串加上引号，
   * 百度就不认了。
   */
  async fileMetas(fsIds) {
    const literal = '[' + fsIds.map((id) => String(id)).join(',') + ']'
    const json = await this.call(PAN_BASE + '/multimedia', {
      method: 'filemetas',
      fsids: literal,
      dlink: 1,
      thumb: 0,
      extra: 1
    })
    return fileMetasItems(json)
  }

  /**
   * 打开一个下载流。dlink 有时效（8 小时）且必须带 access_token，
   * 同时 User-Agent 仍要含 pan.baidu.com——少了会被防盗链挡掉。
   */
  async openDownload(fsId) {
    const literal = '[' + String(fsId) + ']'
    const json = await this.call(PAN_BASE + '/multimedia', {
      method: 'filemetas',
      fsids: literal,
      dlink: 1,
      thumb: 0,
      extra: 1
    })
    const metas = fileMetasItems(json)
    const info = metas.find((entry) => String(entry.fs_id) === String(fsId)) || metas[0]
    if (!info) {
      // 带上 fs_id 与整份响应的原文——这个分支以前只说「没有返回下载信息」，
      // 而它背后可能是响应字段名不同、fs_id 不对、权限不足等等，不打出原文没法判断。
      throw new BaiduApiError(
        '网盘没有返回这个文件的下载信息（fs_id=' + String(fsId) + '），响应原文：' + summarize(json),
        { payload: json }
      )
    }
    if (!info.dlink) {
      throw new BaiduApiError(
        '网盘没有返回这个文件的下载地址（fs_id=' + String(fsId) + '），响应原文：' + summarize(info),
        { payload: info }
      )
    }
    // 少数情况下 dlink 是相对路径（官方 SDK 也会为它拼上 PCS 域名）。
    const link = info.dlink.startsWith('http') ? info.dlink : 'https://pcs.baidu.com' + info.dlink
    const url = link + (link.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(this.accessToken || '')
    const response = await this.fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(600000)
    })
    if (!response.ok) {
      throw new BaiduApiError('下载文件失败：HTTP ' + response.status, { request: { url: link } })
    }
    return { info: info, response: response }
  }
}
