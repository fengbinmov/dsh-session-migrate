# session-migrate

DSH（DeepSeek Harness）的**会话迁移**插件：把工作区里的会话备份成可移植的目录，也能从备份恢复。

面板位置：**设置 → 会话迁移**。

---

## 功能

- 按工作区列出会话，并标出每个会话相对上次导出的状态：`未导出` / `无变化` / `有变化` / `新增`
- 勾选会话后导出到 `$DSH_HOME/session-migrate/exports`
- 从备份目录导入（按 sha256 校验后拷贝，目标已存在的会话跳过）
- 把已归档的会话取消归档
- 删除整个工作区（连同它的会话与投影缓存）

---

## 安装

插件以 profile bundle 的形式加载。最省事的方式是把它链接进目标 profile：

```bash
dsh plugin --profile web add link:/absolute/path/to/session-migrate
```

手工方式等价于两步：

1. 让 profile 能解析到这个包——在 `$DSH_HOME/profiles/<profile>/node_modules/` 下建一个指向本仓库的链接（Windows 用 `junction`，macOS/Linux 用软链）。
2. 把包名加进 `$DSH_HOME/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 数组。

`cordis.patch.yml` 会把插件行插入 profile 的层栈；`package.json` 的 `dsh.client` 声明则让浏览器半边在 web GUI 里加载。

---

## 备份目录结构

```
$DSH_HOME/session-migrate/
├── exports/
│   ├── index.json                                        # 备份索引（sha256、相对路径、元数据）
│   └── sessions/<projectDir>/<sessionSegment>/<fileName> # 逐会话的日志副本
├── export-snapshot.json                                  # 最近一次导出的指纹快照
└── selection.json                                        # 当前勾选的会话 id
```

`index.json` 是自包含的：`import` 只依赖它和同级文件，因此整个 `exports/` 目录可以直接拷到另一台机器使用。

---

## 设计说明

- **导出是整体覆盖**：每次导出都会先清空 `exports/`，并用本次选择重写 `export-snapshot.json`。所以分批导出不同工作区时，先前的备份会被覆盖——这是有意设计，`exports/` 始终代表"最近一次导出"。需要多份备份就先把 `exports/` 整个目录复制出去。
- **指纹与宿主 fs 服务同形**：快照里的 fingerprint 是 `dev:ino:size:mtimeNs:ctimeNs`，与 DSH 自身 `ctx.fs` 的 `version` 语义一致，因此快照可以在插件版本之间复用，不会因为升级插件就全部显示"有变化"。
- **判定"有变化"用的是文件版本**（设备号 + inode + 大小 + 高精度 mtime/ctime），不是内容哈希——因此极快，且不会误报。
- **导入会覆盖**：同一会话的现有数据会被备份内容替换——这才是"恢复/回滚"的语义（否则导入只能补缺失的会话，回滚不了任何改动）。新增与覆盖的数量在结果里分别列出，覆盖后该会话的投影缓存会被清掉，让宿主按新内容重建。
- **备份损坏会被拦住**：导入前逐个比对 `index.json` 里的 sha256，不匹配的条目直接跳过，不会用坏文件覆盖好数据。
- **导入会自动补建目录区域**：目标机器上 `sessions/<projectDir>/<sessionSegment>/` 可能根本不存在，原工作区目录也可能不存在——这恰恰是"要从备份恢复"的典型情形。导入会按需创建目录后再写入；工作区目录同样会被补建出来再注册归属。若原工作区路径在当前机器上压根不可能存在（例如把 Windows 的 `E:\...` 备份恢复到 macOS），会话文件仍会写回磁盘，但归属挂不上，结果里会单独报出这个数量。
- **导入会并入勾选**：恢复出来的会话自动进入当前勾选列表（并入而不是替换，不会清掉你原有的勾选），因此导入后可以直接对它们再导出，不必回去逐个勾。
- **配置会自我收敛**：读取 `selection.json` / `export-snapshot.json` 时，凡是指向已不存在的会话（会话记录没了，或磁盘上的日志文件没了）的条目会被直接删除并写回文件；导出时选中的会话若已消失则静默跳过。因此配置里不会残留无效项，也不会出现失败占位或错误条目——`index.json` 只描述**实际导出成功的内容**。

---

## 架构

| 文件 | 角色 |
|---|---|
| `host.js` | 宿主半边：注册 `sessionMigrate` 远程服务（8 个 direct 方法），负责所有文件与查询逻辑 |
| `client.js` | 浏览器半边：在 `settings.section` 槽位注册面板，通过 typert Remote 调用宿主 |
| `cordis.patch.yml` | bundle 补丁：把插件行插入 profile 层栈 |

两侧通过 `@deepseek-ai/dsh-typert-protocol` 的 Remote 协议通信。

### 宿主依赖

必需：`sessionQuery`、`workspaceRegistry`。
可选：`dshHomePath`（决定 `$DSH_HOME` 位置）、`sessionPersistence`（导出前 flush 落盘）。

**文件操作全部走 `node:fs`**，不依赖 `shell` 服务，因此 Windows 与 macOS 行为一致，也没有 PowerShell 的进程启动开销。

### 两个已踩过的坑

这两处在协议升级时都会**静默**失效，值得记一笔：

1. **客户端命名空间是异步安装的**。`ctx.remote.$mount(contribution)` 返回后才存在 `ctx.remote.<namespace>`，且新版客户端不再用 Proxy 做惰性查找。在 `apply()` 同步阶段取快照会永远拿到 `undefined`，必须在调用前 `await mount`。

2. **宿主只认原型上的稳定字符串键描述符**（`@deepseek-ai/dsh-typert-protocol/remote-methods`）。协议包 ≤ `0.1.0` 把标记存在模块私有的 `WeakMap` 里，而 `@deepseek-ai/dsh-typert-protocol` 这个说明符很可能被别的插件 hoist 到 profile 顶层——于是插件的标记写进了旧副本的 `WeakMap`，宿主的 `collectSrcClaims()` 读原型却什么都没有，端点最终以 **HTTP 404** 收场。

   因此 `host.js` 现在**不继承任何第三方基类**，直接用 `ctx.reflect.provide()` 按 Cordis 契约注册服务，并按新约定手工写描述符；对旧宿主的 `WeakMap` 标记则通过 best-effort 的动态 `import` 补写，缺失也不影响运行。

---

## 测试

```bash
npm test
```

- `tests/client-mount.smoke.mjs` — 用替身浏览器/react/ctx 跑完整客户端装配，断言"挂载完成前不发远程调用"，并复刻 typert 注册表的描述符校验
- `tests/host-remote.smoke.mjs` — 断言服务注册、字符串键标记完整，以及文件层契约（指纹格式、sha256 大写、拷贝自动建目录、`clearDir` 保留点文件）

---

## 兼容性

- 在 DSH `0.1.5-rc.3` 上验证通过
- 需要 Node ≥ 18（指纹依赖 `stat(..., { bigint: true })` 的 `mtimeNs` / `ctimeNs`）
