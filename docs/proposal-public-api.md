# Proposal：新增 `connectV2` 对外数据接口（旧 `connect` 保留）

状态：已实现（`zen-fs-config` V2 + `zen-fs-config-ui` V2）。库侧 V2 单元测试、UI V2 单测/类型检查、真实页面冒烟测试均通过；旧 `connect` / `ConfigRepo` / `AppDataGroup` 保留不变。

目标：在**不破坏旧 API** 的前提下，给应用一个更简单的入口。应用只看到三个动作：

1. `connectV2(appId)` —— 打开应用的数据环境，返回 `AppRepo`；
2. `repo.getDefaultDataGroup()` —— 拿本机已有的默认数据组，用它的 FS 存文件；
3. `group.addBackend(...)` —— 给这个数据组加同步后端；
4. `group.onSyncEvent(...)` —— 订阅同步开始/进度/结束/错误事件。

前三个是动作，第四个是只读事件订阅；应用仍然不需要知道配置仓、描述符、`listAppDataGroups`、`createAppDataGroup`、`local-idb` 这些概念。

配置 UI 不是第四个业务动作：它复用同一个连接，只做展示和配置。

旧 `connect(appId)` 的返回结构、`ConfigRepo`、`createConfigRepo` 全部保持原样，不做破坏性修改；`connectV2` 是新入口。

---

## 0. 背景与问题

现有 API 把内部拓扑直接暴露给应用，导致几个反复出现的问题：

1. **应用必须自己判断「有没有数据组」**：旧 `connect` 在 config-sync 模式下不建数据组，`repo` 有、`appDataGroups` 为空；只有 data-sync 模式且本地无组时才自动建 `default`。应用因此要自己调 `listAppDataGroups()` / `createAppDataGroup()`，很容易写出「没组就建、有组也建」的重复逻辑。
2. **`createAppDataGroup(id, backends)` 不是 get-or-create**：它返回一个已经初始化好的活 `AppDataGroup`，会写描述符、建本地组 IDB、注册到 repo；同 id 已加载会抛错。应用把它当「确保有组」用，就会在配置首次拉取还没落定时写出空描述符，覆盖远端同名组的后端信息。
3. **业务数据可能被写进配置区**：`ConnectResult.repo.fs` 和配置组 `fs` 都在调用方手里，应用很容易把业务文件写进 `.config/`，而不是数据组。
4. **默认组语义不统一**：`default` 只是新建时的命名；从别的设备同步下来的组可能叫 `c5b50d9d-…`，应用如果硬编码 `default` 就会找不到自己的数据。
5. **隐式 `local-idb` 不可见**：每个数据组都有内置的本地 IndexedDB，但它不是后端、不写入描述符、不参与同步；UI 不展示它时，用户会以为「没有数据组 / 数据没地方存」。
6. **应用层解析器带应用偏好**：`preferGroupId`、`dataPath`、localStorage 里的上次选择，都是应用自己的事；放进库会让库依赖应用，也会让两个应用得到不同的「默认组」定义。

本提案要解决的是 1–4 和 6；5 属于 UI/可观测性，单独列为待定项。

---

## 1. 对外接口

```ts
export function connectV2(appId: string, options?: ConnectV2Options): Promise<AppRepo>

export interface ConnectV2Options {
  // 只放配置环境相关选项；不接收 dataBackends / dataGroupId，
  // 也不接收任何应用偏好。具体字段沿用旧 connect 的配置类选项。
}

export interface AppRepo {
  readonly appId: string

  /** 拿本机存在的数据组；一个都没有才创建一个本地 default。 */
  getDefaultDataGroup(): Promise<DataGroup>

  /** 按 id 加载本机已存在的数据组；只读，不创建。 */
  getDataGroup(id: string): Promise<DataGroup>

  /** 列出本机已有数据组的轻量信息，供应用自己的组选择器使用。 */
  listDataGroups(): Promise<DataGroupInfo[]>
}

export interface DataGroupInfo {
  id: string
  name: string
  hasRemote: boolean          // 组里是否声明了远端后端
}

export interface DataGroup {
  readonly id: string          // 实际组 id，不一定是 'default'
  readonly fs: typeof fs       // 业务文件只走这里

  /** 给这个数据组添加一个同步后端。 */
  addBackend(input: DataBackendInput): Promise<AddBackendResult>

  /** 立即同步本组的所有同步对，并按 pair 返回结果。 */
  flush(): Promise<DataGroupFlushResult[]>

  /**
   * 通过数据组的墓碑路径删除文件/目录。
   * 比 fs.promises.unlink 安全：删除会参与同步，不会被下一轮同步复活。
   */
  deleteFile(path: string): Promise<void>

  /** 订阅本组的同步开始/进度/结束/错误事件；返回取消订阅函数。 */
  onSyncEvent(handler: (event: DataGroupSyncEvent) => void): () => void
}

export interface DataGroupSyncResult {
  filesCreated: number
  filesUpdated: number
  filesDeleted: number
  filesSkipped: number
  durationMs: number
  conflicts?: unknown[]
  errors?: { path?: string; message: string }[]
}

export interface DataGroupFlushResult extends DataGroupSyncResult {
  pairId: string
}

export interface DataGroupSyncProgress {
  processed: number            // 已处理文件数
  total?: number               // 能提前知道总数时才有
  currentPath?: string         // 当前文件，未知时省略
  phase?: 'scan' | 'apply'     // 扫描/应用阶段
}

export type DataGroupSyncEvent =
  | {
      type: 'sync:start'
      groupKind: 'data'; groupId: string; backendId: string; pairId: string; timestamp: number
    }
  | {
      type: 'sync:progress'
      groupKind: 'data'; groupId: string; backendId: string; pairId: string; timestamp: number
      progress: DataGroupSyncProgress
    }
  | {
      type: 'sync:end'
      groupKind: 'data'; groupId: string; backendId: string; pairId: string; timestamp: number
      result: DataGroupSyncResult
    }
  | {
      type: 'sync:error'
      groupKind: 'data'; groupId: string; backendId: string; pairId: string; timestamp: number
      error: string
    }
  | {
      type: 'conflict'
      groupKind: 'data'; groupId: string; backendId: string; pairId: string; timestamp: number
      conflict?: unknown
    }

export interface DataBackendInput {
  id?: string                  // 不传则自动生成
  type: string                 // RemoteStorage / Gitee / GitHub / WebDAV ...
  options: Record<string, unknown>
  description?: string
}

export interface AddBackendResult {
  backendId: string
  addedBackend: boolean        // 本次是否真的挂上了
}
```

`DataGroup` 暴露 `id`、`fs`、`addBackend`、`flush`、`deleteFile` 和 `onSyncEvent`。不加 `removeBackend`、`dispose`，避免应用随意拆拓扑；加后端只加在自己正在用的这个组上，不会挂错组。

`flush()` 和 `deleteFile()` 是为迁移现有应用补的两个必要入口：前者对应旧应用的“立即同步”，后者对应 `AppDataGroup.deleteFile()` 的墓碑语义；直接 `fs.unlink` 会让删除在下一轮同步里被远端复活。

---

## 2. `connectV2(appId)`

**做什么**

- 内部调用旧 `connect(appId, options)`，从 `ConnectResult.repo` 取配置仓；
- 用 `connectionToAppRepo` 把 `ConnectResult + appId` 包装成 `AppRepo`；同一个包装函数也供 UI 使用；
- 内部同时保留 `whenReplicasReady` / 配置组句柄等就绪信号，供 `getDefaultDataGroup` 等待首次配置拉取；这些字段不对外暴露；
- 包装成 `AppRepo`：默认组、按 id 取组、列出已有组；不暴露配置仓、descriptor 和后端凭据；
- 纯本地时只建配置用的 IndexedDB，不建数据组、不建同步对；
- 同一组调用做 `Map` 缓存，避免重复连接；不另建连接池、不复制旧 `connect` 的连接逻辑。

**不做什么**

- 不接收 `dataBackends`、`dataGroupId`，避免旧 `connect` 进入 data-sync 模式后自动建 `default`；
- 不自动创建数据组；
- 不把业务数据放进配置区；
- 不要求调用方填后端信息，也不接收应用偏好（localStorage、路径、上次选择的组）。

**时序**

- 没有配置后端：`connectV2` 只等本地就绪，立即返回；
- 有配置后端：`connectV2` 返回时远端配置可能还在拉。**`getDefaultDataGroup()` 内部负责等首次配置拉取落定**，而不是让每个调用方自己等；
- `ConnectResult` 里可能带回 `configGroup`、`groups`、`dataGroup`、`whenReplicasReady` 等字段，V2 不对外暴露这些字段；内部只保留 `repo` 和首次配置就绪所需的句柄。

示例：

```ts
const repo = await connectV2('golf')
```

**与旧 API 的关系**

- 旧 `connect` 原样保留，已有调用方不受影响；
- `connectV2` 直接复用旧 `connect`，不新造连接池；
- 旧 `connect` 返回的 `ConnectResult`、`ConfigRepo`、`AppDataGroup` 等类型不删、不改名。

| 项目 | 旧 `connect` | 新 `connectV2` |
|---|---|---|
| 返回 | `ConnectResult`，含 `repo` / `configGroup` / `groups` / `dataGroup` / `appDataGroups` / `whenReplicasReady` 等 | `AppRepo`，只有 `appId` + `getDefaultDataGroup` |
| 是否建数据组 | data-sync 模式且无组时自动建 `default` | 不建，只有 `getDefaultDataGroup` 在无组时建 |
| 业务数据入口 | 调用方自己选 `repo.fs` / 组 `fs` | 只能 `group.fs` |
| 后端挂载 | 调用方拿组自己加，或建组时传 | `group.addBackend` |
| 配置拓扑 | 全部暴露 | 全部隐藏 |
| 适用方 | 旧应用、配置 UI、高级用法 | 普通应用 |

---

## 3. `repo.getDefaultDataGroup()`

**默认组 = 本机已经存在的那个数据组**，库不认识任何应用路径，也不读应用的 localStorage。

规则：

1. 本机有 `id='default'` 的组 → 直接返回它；
2. 没有 `default`，但有其他数据组（本机创建的，或从远端同步描述符后加载的）→ 返回其中第一个；
3. 一个数据组都没有 → 创建本地 `default`（只有隐式 `local-idb`），并返回；
4. 配置组有远端后端时，创建前先等配置首次拉取落定，确认远端真的没有组；拉不下来就抛 `ConfigNotReadyError`，不创建。

**为什么这样**

数据组的「存在」本身就是本地或同步过来的事实：

- 用户在本机点过新建 → 本地有描述符；
- 别的设备同步过 → 配置组的 `.config/app-data-groups/` 拉到本地，`listAppDataGroups()` 能看到；
- 两种情况下它都已经是「存在的组」，`getDefaultDataGroup` 直接返回它，不关心它是叫 `default` 还是 `c5b50d9d-…`。

**返回**

```ts
const group = await repo.getDefaultDataGroup()

await group.fs.promises.writeFile('/courses/a.json', json)

const unsub = group.onSyncEvent((event) => {
  if (event.type === 'sync:start') showSyncing(event.backendId)
  if (event.type === 'sync:progress') updateProgress(event.progress) // 上游支持后
  if (event.type === 'sync:end') showDone(event.result)
  if (event.type === 'sync:error') showError(event.error)
})

// 卸载/切换组时
unsub()
```

路径是**组内逻辑路径**，由应用自己划命名空间。不要按后端 `basePath` 加前缀。

同一个 repo 内缓存解析结果；并发调用共享同一个 Promise，避免两个调用同时看到「0 个组」而重复创建；组被删除或描述符变化后重新解析。

### 3.1 按 id 取组 / 列出组

```ts
const infos = await repo.listDataGroups()
// [{ id: 'default', name: '默认组', hasRemote: true }, ...]

const group = await repo.getDataGroup(infos[0].id)
```

- `listDataGroups()` 只返回 `id` / `name` / `hasRemote`，不返回 descriptor、后端凭据和组实例；
- `getDataGroup(id)` 只加载**本机已存在**的组，不创建；不存在时抛 `DataGroupNotFoundError`（code `DATA_GROUP_NOT_FOUND`）；
- 多个组且应用需要让用户选择时，用这两个方法；`getDefaultDataGroup()` 仍然只负责“默认组”；
- 同一个 id 的多次 `getDataGroup()` / `getDefaultDataGroup()` 返回同一个 `DataGroup` 实例。

---

## 4. `group.addBackend(input)`

**做什么**

- 给当前这个数据组加一个远端后端；
- 组一定已经存在（来自 `getDefaultDataGroup`），所以不需要「先建组」这一步；
- 如果同 id 或同 endpoint 已存在，按幂等/冲突规则处理，不重复建对。

**返回**

```ts
const result = await group.addBackend({
  type: 'RemoteStorage',
  options: { href: 'https://storage.example/', token: '...' },
  description: '主同步后端',
})

result.backendId       // 实际使用的后端 id
result.addedBackend    // true = 这次真的挂上了；false = 已存在/幂等跳过
```

**约束**

- 不接受 `local-idb` 作为后端 id；
- 同一个 endpoint 不能被两个数据组同时挂；
- 后端指向已有数据时，必须先确认它属于同一个组身份；数据组初始同步是本地优先，新组去认领旧远端数据会覆盖远端同名文件；
- 加后端不改变应用读写位置，仍然是同一个 `group.fs`；本地已有文件会成为同步的本地版本。

### 4.1 同步事件

`onSyncEvent` 是**按同步对（pair）**发的，不是按组汇总；一个组有多个后端时，会有多个 `backendId` / `pairId` 的事件流。

| 事件 | 时机 | 关键字段 |
|---|---|---|
| `sync:start` | 一轮同步开始 | `backendId` / `pairId` / `timestamp` |
| `sync:progress` | 一轮同步进行中 | `progress.processed` / `total?` / `currentPath?` / `phase?` |
| `sync:end` | 一轮同步结束，**零变更轮也会发** | `result.filesCreated/Updated/Deleted/Skipped`、`durationMs`、`errors` |
| `sync:error` | 这一轮同步失败 | `error` |
| `conflict` | 发现并处理冲突 | `conflict` |

约束：

- `onSyncEvent` 返回取消订阅函数；应用卸载、切换组时必须调用；
- 回调抛错不会中断同步，库内会 catch 并记录；
- `sync:end` 的 `result` 是判断「有没有真实变更」的依据，不能只看事件次数；
- `sync:progress` 必须做节流（例如每 N 个文件或每 200ms 一次），不能每处理一个文件都回调；
- 多个后端、多个 pair 事件会交错，应用需要按 `backendId` / `pairId` 聚合。

**当前上游能力与缺口：**

- `zen-fs-sync` 现在提供 `sync:start` / `sync:end` / `sync:error` / `conflict`，**没有逐文件 `sync:progress`**；
- `DataGroup` 已转发 `sync:start` / `sync:end` / `sync:error` / `conflict`；
- 真正的 `sync:progress` 需要 `zen-fs-sync` 增加进度回调（`processed` / `total?` / `currentPath?`），库再透传；在此之前不能伪造百分比，只能先提供 `sync:start` + `sync:end`。

### 4.2 `group.flush()`

立即同步当前数据组的所有 pair，等价于旧 `AppDataGroup.flush()`。

```ts
const results = await group.flush()
// [{ pairId, filesCreated, filesUpdated, filesDeleted, filesSkipped, durationMs, ... }]
```

- 没有远端后端时返回空数组；
- 每个 pair 一条结果，不把多个 pair 汇总成一个数字；
- 这是显式“现在同步”，不依赖 30 分钟的 watcher 间隔；
- 失败抛 `DataGroupOperationError`（code `DATA_GROUP_OPERATION_FAILED`）。

### 4.3 `group.deleteFile(path)`

走数据组的墓碑删除路径，而不是普通 `fs.unlink`。

```ts
await group.deleteFile('/golf/old-course.json')
```

- 删除会参与同步，远端不会在下一轮把文件复活；
- `path` 是组内逻辑路径；
- 失败抛 `DataGroupOperationError`。

---

## 5. 典型使用

```ts
// 1. 打开
const repo = await connectV2('golf')

// 2. 拿默认组（没有就建一个纯本地的）
const group = await repo.getDefaultDataGroup()

// 3. 业务数据全部写组
await group.fs.promises.writeFile('/golf/state.json', json)

// 4. 用户之后配置同步后端
await group.addBackend({
  type: 'RemoteStorage',
  options: { href: 'https://storage.example/', token: '...' },
})
```

三种状态：

| 状态 | 数据在哪 | 是否同步 |
|---|---|---|
| 只 `connectV2`，没取组 | 应用本地暂存（由应用自己决定） | 否 |
| 取了默认组，没加后端 | `default` 组的 `local-idb` | 否 |
| 加了后端 | 同一个组的 `local-idb` + 远端副本 | 是 |

---

## 6. 边界与错误

| 情况 | 行为 |
|---|---|
| 旧 `connect` 没有返回 `repo` | `connectV2` 抛 `ConnectFailedError`，不伪造空 repo |
| 配置组有远端，但首次拉取超时/失败 | `getDefaultDataGroup` 抛 `ConfigNotReadyError`，不建组 |
| 本机已有数据组（本地建的或同步来的） | 直接返回该组，不新建、不覆盖 |
| 同 id 后端已存在 | 抛 `BackendAlreadyExistsError`，或按配置返回 `addedBackend: false` |
| 同 endpoint 已被本组挂载 | 幂等返回，不重复建对 |
| 同 endpoint 已被其他数据组挂载 | 抛 `BackendEndpointConflictError`，不挂 |
| `id='local-idb'` 或显式把本地 IDB 当后端 | 抛 `InvalidBackendError` |
| 后端数据不属于当前组身份 | 抛 `BackendIdentityError`；确认前不认领，避免本地优先覆盖远端文件 |
| 建组失败 | 抛 `DataGroupCreateError`，不返回组 |
| 挂后端失败 | 抛 `DataGroupBackendError`，保留原组和本地数据 |
| `onSyncEvent` 回调抛错 | 捕获并记录，不中断同步、不影响其他订阅者 |
| 订阅后组被删除/替换 | 取消函数仍有效；旧组事件停止，应用应重新取组并重新订阅 |
| 离线但组已存在 | 正常读写 `local-idb`，同步状态显示离线 |

---

## 7. 内部映射（非对外）

| 对外 | 内部 |
|---|---|
| `connectV2(appId)` | 调旧 `connect(appId, options)`，取 `repo`；内部保留 `whenReplicasReady`；V2 不传 dataBackends，避免自动建组 |
| `getDefaultDataGroup()` | `listAppDataGroups()`：有 `default` 取 default，否则取第一个已有组；0 个组时先等配置首次拉取落定，仍为 0 才 `createAppDataGroup('default', [])` |
| `group.addBackend(input)` | 直接调用 `AppDataGroup.addBackend(...)`；不再有「组不存在时建组」的分支 |
| `group.onSyncEvent(handler)` | 包装 `AppDataGroup.onSyncEvent`；库层额外转发 `sync:start` / `conflict`，并在 `zen-fs-sync` 支持后转发 `sync:progress`；返回取消函数 |
| `group.fs` | `AppDataGroup.fs`，逻辑组根 |
| 后端列表 | 组描述符 `.config/app-data-groups/<appId>/<groupId>.json` + 组自己的 `.meta/backends/` |

`repo.fs`（配置区）永远不对外暴露。

---

## 8. 明确不暴露

- `listAppDataGroups`（原始 descriptor 列表）
- `createAppDataGroup`
- `getAppDataGroup`（V2 用 `getDataGroup(id)` 加载已有组，不创建）
- 组描述符读写
- `local-idb` 作为可选后端
- 配置同步组的 `fs`
- 组内后端列表、完整同步状态快照（事件流通过 `DataGroup.onSyncEvent` 单独提供）
- `DataGroup.removeBackend` / `dispose`（后端只增不减；需要删除时走配置 UI）

多组场景通过 `repo.listDataGroups()` 拿轻量列表，再用 `repo.getDataGroup(id)` 加载用户选中的组；`listDataGroups` 不返回 descriptor 和后端凭据。

**例外：** 高级入口 `getUiConnection(repo)` 会把旧连接快照交给 `zen-fs-config-ui`，其中包含配置仓。它不属于普通应用 API，只能用于配置 UI，见第 16 节；业务代码仍然不能写 `repo.fs`。

---

## 9. 待定

开放问题统一收在第 17 节，避免两处不同步；当前主接口（`connectV2` / `getDefaultDataGroup` / `group.addBackend`）不依赖这些待定项。

---

## 10. 与现有文档的差异

现有 [`zen-fs-config-usage.md`](zen-fs-config-usage.md) 描述的是严格模式 C：没有数据组后端时**不建组**，`getOrCreateAppDataGroup` 返回 `null`。

本提案为了给应用一个稳定的 `group.fs`，改成「`getDefaultDataGroup()` 返回本机已存在的组；一个都没有时才惰性创建本地默认组」：

- 好处：应用不用维护「无组」分支，读写位置从一开始就固定；
- 代价：在完全没有组时会产生一条 `backends: []` 的本地描述符；只要 `getDefaultDataGroup` 在配置目录落定之后才创建，就不会覆盖远端已有的组；
- 如果坚持严格 C，`getDefaultDataGroup` 在没有组时应返回 `null` 或抛 `NoDataGroupError`，应用自行使用本地暂存库，加后端后再建组。

这是本提案与严格模式 C 的语义差异；最终以第 11 节的决策记录为准。

---

## 11. 决策记录

这一节把讨论中已经定下来的结论和已经否决的方案集中写清楚，避免实现时又回到旧习惯。

### 11.1 默认组

**结论：默认组 = 本机已经存在的数据组。**

- 用户在本机创建过数据组 → 它就是默认组；
- 从别的设备/远端同步过描述符到本地 → 它已经在 `listAppDataGroups()` 里，它就是默认组；
- 不要求它叫 `default`，`DataGroup.id` 返回实际 id；
- 如果本机有 `default`，优先返回 `default`；没有 `default` 但有其他组，返回第一个；
- 一个组都没有，才创建本地 `default`；
- 只要应用配置了 `appId` 并来取默认组，就必须返回一个可用的 `DataGroup`，不能返回 `null`；没有组时由库补一个纯本地的 `default`；
- 配置区 `app-data-groups/` 为空时，就是「没有组」，按默认流程走；不要把空目录当成已有组，也不要写占位描述符。

**明确不做：**

- 不读应用的 localStorage；
- 不接收 `preferGroupId` / `dataPath`；
- 不在配置仓里维护默认组指针，也不单独建一个 config repo 存这个信息；
- 不把应用层的 `resolveDataGroup` 搬进库，也不从库反向依赖应用代码；
- 不因为「必须有组」就先写一个空描述符。

理由：组的「存在」本身就是事实，不需要额外指针去解释。指针会带来跨设备合并、覆盖、失效清理问题，而且会让库知道应用的偏好。

**关于原来的 `resolveDataGroup`：** 它的候选收集、`hasData` 判断、`groupHasPath` 等逻辑本身可以复用，但必须搬到库层并去掉应用偏好；按当前「已有组就是默认组」的语义，V2 的 `getDefaultDataGroup` 不需要这套解析。将来如果要支持多组选择，再把它作为库内部 helper，不从应用 import。

### 11.2 建组时机

**结论：`connectV2` 不建组，`getDefaultDataGroup` 在没有组时才建。**

- `connectV2` 只负责打开配置环境，返回 `AppRepo`；
- 不在应用启动时无条件 `ensure` / 建组；启动只 `connectV2`，首次真正需要数据时再 `getDefaultDataGroup`；
- 应用真的需要存业务数据时，调 `getDefaultDataGroup()`；
- 没有组 → 创建本地 `default`（只有隐式 `local-idb`）；
- 已有组 → 直接复用，绝不重复创建；
- 配置组有远端后端时，创建前必须等配置首次拉取落定；
- 没有任何配置/数据后端时，配置组只建本地 IndexedDB，同步相关字段全部留空，不要求调用方填；
- 数据组同理：没有后端时它只是一个本地 IndexedDB，不写同步元数据；等 `addBackend` 后才产生后端信息和同步状态。

**明确不做：**

- 不在 `connectV2` 里自动建 `default`；
- 不调用旧 `connect` 时传 `dataBackends`，避免它进入 data-sync 模式自动建组；
- 不「先建空组，之后再加后端」；
- 不在配置首次拉取完成前写任何组描述符；
- 不把 `createAppDataGroup` 当成公开的 get-or-create；它只作为「确认 0 个组之后」的内部兜底。

### 11.3 描述符与远端覆盖

**结论：本地空描述符不能覆盖远端已有的组信息。**

- 配置组首次拉取完成前，`listAppDataGroups()` 为空只代表「暂时为空」，不代表「远端没有组」；
- 本地先建了 `default`、之后才给配置组加配置后端时，远端可能已有同 id 组；这种冲突由配置 UI 让用户选择保留/覆盖，V2 不自动删除或覆盖本地组；
- 此时创建 `default` 会写入 `.config/app-data-groups/<appId>/default.json`；如果远端已有同名组，同 id 文件会冲突；
- 数据组初始同步是 `source-wins`，新组去认领旧远端数据会用本地空文件覆盖远端同名文件；
- 本地默认组由 repo 的组管理 API 创建，只写它自己的 `.config/app-data-groups/<appId>/default.json`；不往配置组根目录塞自定义 key，也不覆盖其他组的描述符；
- 没有任何配置/数据后端时，配置区的 `app-data-groups/` 只是本地元数据容器，不具备同步意义；目录为空就按「没有组」处理，不据此建组，也不写占位文件；
- 因此：有配置后端时，先等 `whenReplicasReady` / 配置拉取落定，再判断是否建组；等不到就抛错，不建。

### 11.4 后端挂在组上，不挂在 repo 上

**结论：`group.addBackend(...)` 是 `DataGroup` 的方法，`AppRepo` 只有 `getDefaultDataGroup`。**

理由：

- 后端必须挂在应用实际读写的那个组上，放在 repo 上容易挂错组；
- 组已经由 `getDefaultDataGroup` 解析出来，`addBackend` 不需要再猜组 id；
- 应用只拿得到默认组，拓扑不会被应用随意改。

**明确不做：**

- `repo.addDataGroupBackend(...)`；
- `DataGroup.removeBackend` / `dispose`；
- 让应用传 `groupId` 给 `addBackend` 去挂别的组。

### 11.5 隐式 `local-idb`

**结论：每个数据组都有本地 IndexedDB，但它是 primary，不是可配置后端。**

- 配置组：`zen-fs-config-config-<appId>`；
- 数据组：`zen-fs-config-data-<appId>` 或 `zen-fs-config-data-<appId>-<groupId>`；
- 不写入描述符的 `backends`；
- 不参与同步；
- 配置组同步的内容里不包含数据组本地 IDB 的内容或库名；它是每台设备本地的 primary，缺省重建；
- 不能作为 `addBackend` 的 `id`，传了抛 `InvalidBackendError`；
- 配置组已经有隐式 `local-idb` 的展示时，数据组必须对等展示；不能只让配置组显示本地存储，数据组却看起来「没有存储」；
- 默认组不是「没有组」；它的 `local-idb` 一直可写，UI 不显示是展示缺陷，不是数据层缺陷；
- UI 应显示为「本地 IndexedDB（隐式，不参与同步）」，不能因为不展示而让用户以为没有存储。

### 11.6 兼容策略

**结论：旧 `connect` 不动，新增 `connectV2`。**

- 旧 `connect`、`createConfigRepo`、`ConfigRepo`、`ConnectResult`、`AppDataGroup` 全部保留；
- `connectV2` 内部直接 `await connect(appId, options)`，从 `ConnectResult.repo` 取仓库；
- 不另建连接池、不复制旧 `connect` 的连接逻辑；
- V2 模块自己维护 `Map` 缓存，避免同一 appId 重复连接；
- 旧 `zen-fs-config-ui` 继续用旧 API，不进 V2；
- V2 不暴露 `repo.fs`，应用不能把业务数据写进配置区。

### 11.7 存储职责边界

- 配置组只存配置：`.config/`、应用数据组描述符、后端元信息；
- 数据组只存业务文件：应用的所有业务数据都写 `group.fs`；
- 配置同步后端只同步配置组；数据同步后端只同步它挂的那个数据组；
- 两套同步互不代管：配了数据后端不等于配了配置后端，反之亦然；
- 应用不能写 `repo.fs`，也不能写配置组 `fs`；这是 V2 不暴露它们的原因。

### 11.8 否决方案

| 被否决的方案 | 否决原因 |
|---|---|
| 应用启动时无条件 `ensureDataGroup` / 建 `default` | 配置首次拉取可能还没完成，会写空描述符并覆盖远端组；应等应用真正取数据时再建 |
| 先建空 `default`，再加后端 | 配置首次拉取未完成时会覆盖远端同名组；空组认领旧数据会 `source-wins` 覆盖远端文件 |
| 默认组指针存在配置仓 | 跨设备合并、覆盖、删除后失效都要额外处理；组的「存在」已经足够判断默认 |
| `preferGroupId` / `dataPath` 交给库解析 | 这是应用偏好和业务路径，库不应知道；不同应用会得到不同默认定义 |
| 把应用层的 `resolveDataGroup` 直接 import 进库 | 依赖方向反了；库不能依赖应用代码 |
| `repo.addDataGroupBackend(...)` | 容易挂错组；后端应属于具体 `DataGroup` |
| `connectV2` 另建连接池 | 和旧 `connect` 状态重复，容易出现两套连接、两套缓存 |
| `connectV2` 接收 `dataBackends` | 旧 `connect` 会进入 data-sync 模式并自动建 `default`，破坏「连接不建组」 |
| 应用直接写 `repo.fs` / 配置组 `fs` | 业务数据会进配置区，配置同步会变慢，且语义错误 |
| 把 `local-idb` 当普通后端 | 它是每个组的 primary，不是同步后端；写进描述符会破坏组模型 |
| 硬编码只找 `id='default'`，没有就报无组 | 同步下来的组可能叫 `c5b50d9d-…`，会找不到数据 |

### 11.9 迁移补充接口

全量迁移现有应用前，V2 补了四个直接对应现有代码的入口，而不是把 `AppDataGroup` 整体泄露出来：

- `DataGroup.flush()`：对应现有 `dish-order` / `filebrowser` 的“立即同步”；
- `DataGroup.deleteFile(path)`：对应现有删除逻辑的墓碑语义，避免退回 `fs.unlink` 后删除被远端复活；
- `AppRepo.listDataGroups()`：只给 `{ id, name, hasRemote }`，不泄露 descriptor 和后端配置；
- `AppRepo.getDataGroup(id)`：加载本机已有组，不创建；解决 Golf 这类多组应用“默认组不等于用户选的组”的问题。

`removeBackend` / `dispose` 仍不暴露；需要拆后端时继续走配置 UI。

---

## 12. 生命周期场景

| 场景 | 结果 |
|---|---|
| 全新浏览器，没有配置后端 | `connectV2` 建配置 IDB；`getDefaultDataGroup` 建本地 `default`；数据写入 `default` 的 `local-idb` |
| 本机已有本地组 `default` | `getDefaultDataGroup` 直接返回，不新建 |
| 本机只有同步下来的组 `c5b50d9d-…` | 返回该组，`DataGroup.id` 为 `c5b50d9d-…`，不新建 `default` |
| 第二台设备首次配置同步 | `connectV2` 返回时远端可能还在拉；`getDefaultDataGroup` 等拉取完成，看到远端组后返回它 |
| 有配置后端，但远端首次拉取超时 | `getDefaultDataGroup` 抛 `ConfigNotReadyError`，不写空描述符 |
| 组已存在，用户加第一个后端 | 后端挂在同一个组；本地已有文件成为本地版本，开始同步 |
| 组已存在，再加第二个后端 | 同一组多后端；仍走同一个 `group.fs` |
| 组已存在，离线 | 继续读写 `local-idb`；后端恢复后同步 |
| 旧 data-sync `connect` 已自动建过 `default` | V2 直接把它当已有组返回，不重复建 |
| 配置 UI 建了额外组 | `getDefaultDataGroup` 仍按「`default` 优先，否则第一个」返回；应用可用 `listDataGroups` + `getDataGroup(id)` 自行选择 |
| 同一页面重复 `connectV2('golf')` | 命中缓存，返回同一个 `AppRepo`，不重复连接 |
| 同一页面 `getDefaultDataGroup()` 多次调用 | 返回同一个 `DataGroup`，不重复解析、不重复建组 |

---

## 13. 兼容与迁移

### 13.1 库

- 新增导出：`connectV2`、`AppRepo`、`DataGroup`、`DataBackendInput`、`AddBackendResult`、`DataGroupInfo`、`DataGroupFlushResult` 及错误类型；
- 旧导出全部保留，不删字段、不改签名；
- `connectV2` 是加法，不是替换；旧应用不改代码也能继续运行；
- 新实现放在独立模块（如 `public-api` / `connect-v2`），不把 V2 逻辑塞进旧 `connect`。

### 13.2 应用

应用迁移只需三步：

1. `connect(appId)` → `connectV2(appId)`；
2. 删掉应用里的 `listAppDataGroups()` / `createAppDataGroup()` / `ensureDataGroup()` 逻辑，改调 `getDefaultDataGroup()`；
3. 所有业务文件只写 `group.fs`，不写 `repo.fs` / 配置组 `fs`；同步后端改调 `group.addBackend()`。

迁移后应用不再需要知道：

- 组 id 是不是 `default`；
- 描述符放在哪；
- 配置是否拉完；
- `local-idb` 的库名；
- 远端后端怎么挂。

### 13.3 UI

- 未升级的旧配置 UI 继续用旧 `connect` / `ConfigRepo`，不受 V2 影响；此时应用不要同时再用 V2 连接同一个 appId；
- 升级后的 UI（`SyncGroupConfiguratorV2`）通过 `repo` / `getUiConnection` 复用 V2 连接，不自己 `connect`，见第 16 节；
- 如果 UI 要展示 V2 的默认组，至少显示实际组 id 和「本地 IndexedDB（隐式，不参与同步）」；
- V2 暂不暴露后端列表和同步状态，UI 的完整状态展示仍走旧 API。

---

## 14. 测试与验收

### 14.1 单元测试

1. 无组：第一次 `getDefaultDataGroup` 创建 `default`；第二次返回同一实例，不重复建。
2. 有 `default` + 其他组：返回 `default`。
3. 无 `default`、只有一个同步组：返回该组，id 原样保留。
4. 无 `default`、多个同步组：返回列表第一个；记录该行为。
5. 有配置远端、拉取未完成：等待；超时抛 `ConfigNotReadyError`；不写描述符。
6. 配置拉取带回远端组：返回远端组，不建 `default`。
7. `addBackend`：正常挂载、同 id 幂等、同 endpoint 幂等、跨组 endpoint 冲突、`local-idb` 拒绝、身份不匹配拒绝。
8. `connectV2`：调用旧 `connect` 一次；不传 `dataBackends`；`repo` 缺失抛 `ConnectFailedError`；重复调用命中缓存。
9. 同步事件：`sync:start` / `sync:end` 能收到；零变更轮也收到 `sync:end`；`sync:error` 带错误；多后端事件按 `backendId` / `pairId` 区分；取消订阅后不再回调；回调抛错不影响同步。
10. `sync:progress`：上游支持后验证节流、`processed/total/currentPath`；上游未支持时明确不伪造进度。
11. 旧 API 回归：旧 `connect` / `createAppDataGroup` / `AppDataGroup` 行为不变。

### 14.2 集成/浏览器验收

- 全新 origin，无配置后端：`connectV2` → `getDefaultDataGroup` → 写文件；`zen-fs-config-data-<appId>` 有数据块；`default` 描述符只有 `backends: []`。
- 有配置后端，第二设备：同步后 `getDefaultDataGroup` 返回远端组 id，不出现重复 `default`。
- 有配置后端但断网首次连接：不产生空描述符；恢复后能拿到远端组。
- 已有组加后端：本地文件成为本地版本；远端出现同名文件；不出现空文件覆盖。
- 同步事件：UI/应用都订阅 `DataGroup.onSyncEvent`，能显示「同步中 → 完成」；事件不重复、不丢 `sync:end`。
- 页面刷新/重进：组 id 稳定；默认组不漂移。

### 14.3 验收标准

- 应用代码里不再出现 `listAppDataGroups` / `createAppDataGroup` / `ensureDataGroup`；
- 应用代码里不再写 `repo.fs` 或配置组 `fs`；
- 全新环境第一次使用不报「没有数据组」；
- 第二设备同步后不出现重复 `default`；
- 配置首次拉取失败时不会留下空描述符；
- 旧 API 单测、构建、旧 UI 全部通过。

### 14.4 UI 集成验收

- 应用 `connectV2` + UI 注入 `connection`：旧 `connect` 只被调用一次，没有第二个 `ConfigRepo`；
- `SyncGroupConfiguratorV2` 传入 `repo`：不再调用 `connectV2`，`onRepoReady` 返回同一个 `AppRepo`；
- `SyncGroupConfiguratorV2` 不传 `repo`：自己调用 `connectV2`，`onRepoReady` 返回的 `AppRepo` 可直接 `getDefaultDataGroup()`；
- 旧 `SyncGroupConfigurator` 单测/行为不变；
- UI 注入模式下，`onRepoReady` / `core.getAppRepo()` 返回的 `AppRepo` 与应用 `connectV2` 返回的是同一个实例；
- UI 自己 `connect` 模式下，`onRepoReady` 返回的是包装后的 `AppRepo`，`getDefaultDataGroup()` 可正常使用；
- UI 加载出的数据组实例与 `getDefaultDataGroup()` 返回的是同一个实例（同一 `repo.getAppDataGroup` 缓存）；
- UI 给默认组加后端后，应用 `group.fs` 仍可读写，后端出现在默认组上；
- UI 创建额外组后，`getDefaultDataGroup()` 仍返回原来的默认组；
- UI 删除当前默认组被阻止或要求宿主确认；宿主确认后重新取组能拿到新组；
- UI 卸载后应用继续读写 `group.fs`，说明 UI 没有 dispose 共享 repo；
- V2 在 UI 挂载后创建默认组时，UI 能通过 `refresh()` 或重挂看到新组；
- 数据组卡片显示「本地 IndexedDB（隐式，不参与同步）」，配置组和数据组展示对等。

### 14.5 本轮实现与验证（2026-11-24）

已按本提案落地库侧与 UI 侧 V2，旧 API 保持不动：

- 库侧 `api-v2.test.ts` 9/9 通过，`sync-events.test.ts` 2/2 通过；库 `tsc --noEmit` 通过。
- UI 全套单测 51/51 通过；UI `tsc --noEmit` 通过。
- 真实浏览器页面验证：`http://127.0.0.1:4177/v2-test.html` 25 项检查全部 PASS，覆盖 `connectV2` 缓存、默认数据组、`listDataGroups` / `getDataGroup`、`addBackend` 幂等、`group.fs.promises` 读写、`group.flush`、`deleteFile`、`sync:start` / `sync:end`、取消订阅、UI 组件与宿主共用同一个 `AppRepo`。截图：`docs/v2-page-smoke.png`。
- 在真实 OneNav 页面 `http://127.0.0.1:4177/apps/golf/index.html` 注入 V2 bundle 后同链路 13 项检查全部 PASS（含 UI 组件复用宿主传入的 `AppRepo`）；未改动 Golf 面板本身的旧 UI 代码。
- 验证时发现并修复一个 UI V2 根因：`mountV2()` 在调用 `applyConnection()` 时没有把宿主的 `appRepo` 传下去，导致 UI 用 `wrapConnectionAsAppRepo()` 重新包了一层；现在传入同一个 `AppRepo`，页面检查「UI 组件与页面共用同一 AppRepo」为 PASS。
- 仍未实现：`sync:progress` 需要上游 `zen-fs-sync` 提供逐文件进度回调；当前只透传 `sync:start` / `sync:end` / `sync:error` / `conflict`。

---

## 15. 实施步骤（库侧）

1. 新建 V2 模块，定义 `connectV2`、`AppRepo`、`DataGroup`、`DataBackendInput`、`AddBackendResult`、`connectionToAppRepo`、`getUiConnection` 和错误类型。
2. `connectV2`：调用旧 `connect`，用 `connectionToAppRepo({ ...result, appId })` 包装；把 `whenReplicasReady` 等就绪句柄留在内部；`Map<appId, Promise<AppRepo>>` 缓存；不建 pool；缓存 rejected promise 时移除，避免一次失败永久失败。
3. `AppRepoImpl.getDefaultDataGroup()`：
   - `repo.listAppDataGroups()`；
   - 有 `default` 取 `default`，否则取第一个；
   - 0 个组时，若配置组有远端则等首次拉取落定；
   - 落定后仍为 0 个才 `createAppDataGroup('default', [])`；
   - 缓存 `DataGroup`，描述符变化时失效。
4. `DataGroupImpl.addBackend()`：
   - 校验 `id` / endpoint / `local-idb` / 组身份；
   - 调 `AppDataGroup.addBackend(...)`；
   - 返回 `{ backendId, addedBackend }`；
   - 不提供 `removeBackend` / `dispose`。
5. `DataGroupImpl.onSyncEvent()`：
   - 调 `AppDataGroup.onSyncEvent` 拿 `sync:end` / `sync:error`；
   - 库层补 `sync:start` / `conflict` 转发；
   - `zen-fs-sync` 支持后转发 `sync:progress`，并做节流；
   - 返回取消订阅函数；回调异常 catch。
6. 旧 API 不动；新增导出放在独立入口，避免影响旧构建。
7. 新增高级包装：`connectionToAppRepo(connection)` 和 `getUiConnection(repo)`；前者只包装已有连接，后者只返回已有快照，都不新建连接；不放进 `AppRepo` 普通方法。
8. 补单元测试、集成测试、浏览器手工验收；更新 README 与使用文档。
9. UI 包新增 `SyncGroupConfiguratorV2`：复用旧 core，只把连接入口换成 `repo ?? connectV2`，通过 `onRepoReady` / `getAppRepo()` 暴露同一个 `AppRepo`；旧组件不改。

---

## 16. 与 `zen-fs-config-ui` 配合

### 16.1 问题

`SyncGroupConfigurator` 现在只接收 `appId`，内部自己调用旧 `connect`：

- 如果应用同时也调 `connectV2`，同一页面会出现两个 `ConfigRepo` 实例、两套同步对，操作同一个 IndexedDB；
- UI 需要 `repo` 才能列组、建组、删组、加/删配置后端、加/删数据组后端；
- V2 又刻意不把 `repo` 暴露给业务代码。

所以不能简单「两边各自 connect」。

### 16.2 原则：一个页面，一个 `appId`，一个连接

- 一个页面里，同一个 `appId` 只能有一个连接；
- 两种合法模式：
  - **应用持有**：应用 `connectV2`，UI 通过 `connection` 注入复用；
  - **UI 持有**：UI 自己 `connect`，包装成 `AppRepo` 交给应用；
- UI 只通过受控的 `UiConnection` / `AppRepo` 拿到底层 `repo` 和已加载的数据组；
- 业务数据仍然只走 `group.fs`，UI 不写业务数据；
- 旧 UI 单独使用时行为完全不变，仍然自己 `connect`；
- UI 持有模式一旦把 `AppRepo` 交给宿主，UI 卸载就不能 `dispose` 连接；生命周期要么由 UI 保持，要么显式移交宿主。

推荐优先「应用持有、UI 注入」：应用可能比 UI 更早需要数据，连接生命周期也更清楚。但如果应用只在 UI 打开后才用数据，「UI 持有、返回 `AppRepo`」也成立。

### 16.3 库侧桥接接口

在高级入口新增一个只给 UI 用的桥接，不放进 `AppRepo` 的普通方法：

```ts
export type UiConnection = ConnectResult & { readonly appId: string }

/** 把已有连接包装成和 connectV2 相同的 AppRepo；不新建连接。 */
export function connectionToAppRepo(connection: UiConnection): AppRepo

/** 高级接口：把 V2 的连接快照交给 zen-fs-config-ui，不新建连接。 */
export function getUiConnection(repo: AppRepo): UiConnection
```

`connectV2` 本身也走同一个包装：

```ts
async function connectV2(appId, options) {
  const result = await connect(appId, options)
  return connectionToAppRepo({ ...result, appId })
}
```

所以 `connectV2(appId)` 和「UI 自己 connect 后包装」返回的是同一种对象，都是 `AppRepo`，不是两套 API。

注意：**同类型不等于同一个实例**。如果 UI 自己 `connect` 了一次，应用又 `connectV2` 一次，两个 `AppRepo` 形状一样但底层是两个 `ConfigRepo`，仍然会双同步。要同一个实例，只能走同一条连接：要么应用先建、UI 注入；要么 UI 先建、应用用 UI 给的那个 `AppRepo`。

实现上：

- `WeakMap<AppRepo, UiConnection>` 保存正向关系，`WeakMap<UiConnection, AppRepo>` 保存反向关系；
- `getUiConnection` 只返回已有连接，不新建；
- `connectionToAppRepo` 只包装已有连接；同一个 `UiConnection` 必须返回同一个 `AppRepo`，不重复造包装；
- `AppRepo` 仍然只有 `appId` + `getDefaultDataGroup`，不增加 `getConnection` 方法。

### 16.4 UI 侧改动

`SyncGroupConfigurator` 增加一个可选 `connection`，以及一个统一输出 `AppRepo` 的回调：

```ts
interface SyncGroupConfiguratorProps {
  appId: string
  connection?: UiConnection       // 有就复用，没有就保持原来的自行 connect
  onRepoReady?: (repo: AppRepo) => void
  // ...现有 props
}
```

有 `connection` 时：

- 跳过 `connectGroup(...)`；
- `this.repo = connection.repo`；
- `this.appRepo = connectionToAppRepo(connection)`；
- `groupInstances` 直接用 `connection.appDataGroups` / `connection.dataGroup` 填充；
- `replicasPending` / `whenReplicasReady` 用 `connection` 里的值；
- 仍然正常发 `connected` / `onCoreReady`，宿主行为不变。

没有 `connection`、UI 自己 `connect` 时：

- 拿到旧 `ConnectResult` 后，`this.appRepo = connectionToAppRepo({ ...result, appId: this.props.appId })`；
- 这样 UI 自己持有的连接也能对外给出与 `connectV2` 完全相同的 `AppRepo`；
- 不改变旧的 `onConnected` 字段，额外增加 `appRepo` / `onRepoReady`。

两种用法：

```ts
// A. 应用持有连接
const repo = await connectV2('golf')
const group = await repo.getDefaultDataGroup()
const ui = getUiConnection(repo)

<SyncGroupConfigurator appId="golf" connection={ui} onRepoReady={...} />

// B. UI 持有连接，应用等 UI 给 repo
<SyncGroupConfigurator
  appId="golf"
  onRepoReady={async (repo) => {
    const group = await repo.getDefaultDataGroup()
    await group.fs.promises.writeFile('/courses/a.json', json)
  }}
/>
```

`SyncGroupConfiguratorCore` 增加：

```ts
getAppRepo(): AppRepo | null
```

React 组件本身不能直接返回值，所以统一通过 `onRepoReady`、`onConnected` 里的可选 `appRepo`、或 `core.getAppRepo()` 暴露；三者都是同一个 `AppRepo` 实例。

`CoreEventMap['connected']` 增加可选 `appRepo`，旧字段 `repo` / `dataGroup` 保留，避免破坏现有宿主。

可选实现：UI 内部不调旧 `connect`，而是调 `connectV2`，再用 `getUiConnection(appRepo)` 取配置视图。这样宿主用相同 `appId + 配置后端` 调 `connectV2` 时可以命中同一个缓存实例。前提是 V2 缓存键必须包含配置后端签名，不能只按 `appId`。

### 16.5 UI 必须遵守的行为

- 有 `connection` 时绝不调旧 `connect`，避免第二个 repo；
- 没有 `connection`、UI 自己 `connect` 时，必须把现有连接包装成 `AppRepo` 暴露；宿主用了这个 `AppRepo` 后不得再调 `connectV2`；
- 有 `connection` 时不按 UI 自己的 localStorage `backendInfo` 再连一次；`backendInfo` 只作为表单默认值/展示，连接状态以 `connection.repo` 为准；
- 配置后端、数据组的增删都走当前共享的同一个 `repo`（有 `connection` 时是 `connection.repo`，UI 自己持有连接时是 `this.repo`），不要另建连接；
- 给数据组加后端时，优先从 `connection.repo.getAppDataGroup(id)` 拿 live 实例，保证和应用的 `group.fs` 是同一个实例；
- 同步进度/结束状态统一订阅组实例的 `onSyncEvent`，不要另开轮询；UI 和应用可以同时订阅，各自 `unsubscribe`；
- 配置组和数据组放在同一个列表里展示；数据组卡片必须显示隐式的「本地 IndexedDB（隐式，不参与同步）」；
- 标记 V2 当前默认组（`getDefaultDataGroup` 返回的组）为「当前默认组」；卡片显示实际 `id`，不要写死 `default`；删除它需要应用确认，不能静默删；
- UI 不写 `group.fs` 的业务路径，只管理配置和后端；
- UI 卸载/销毁时不得 `dispose` 共享 repo 或数据组，只清理自己的 DOM、定时器和事件订阅；连接生命周期由宿主的 V2 管理；
- 共享连接模式下，「重置本页配置」/删除本地库这类危险操作必须禁用或交给宿主确认，不能由 UI 单方面删掉应用正在用的 IDB；
- V2 在 UI 挂载后新建了默认组时，UI 必须能刷新组列表；可以先提供 `refresh()`，或由宿主换 `key` / `uiNonce` 重挂；
- UI 删除/新建数据组后，宿主要重新调 `getDefaultDataGroup()`；V2 每次调用会校验组列表，缓存组不存在时重新解析。

### 16.6 兼容回退

- **只用 V2、不挂 UI**：正常，UI 不参与；
- **只用旧 UI、不用 V2**：保持现状，UI 自己 `connect`，应用从 `onConnected` 拿 `repo` / `dataGroup`；
- **旧 UI 没升级、又用了 V2**：不要两边都 `connect`。要么暂时只用 UI 的连接（应用退回旧 API），要么等 UI 支持 `connection` 注入；
- 同一个页面里，UI 和应用不能各自持有一个 `ConfigRepo` 去操作同一个 appId。

### 16.7 UI 侧待定

- `connection` 这个 prop 名是否最终采用；
- UI 是否需要公开 `refresh()`，还是宿主用 `key` 重挂；
- 删除当前默认组时，UI 的确认流程和 V2 的缓存失效如何联动；
- 配置后端增删后，UI 是否还需要 `connect` 重连；在共享 repo 下应优先用 `repo.addBackend`，避免重建连接。

### 16.8 UI V2 组件

可以新增一个独立的 `SyncGroupConfiguratorV2`，不改旧组件：

```ts
export interface SyncGroupConfiguratorV2Props {
  appId: string
  /** 应用已有连接时直接传入；不传则 UI V2 自己 connectV2。 */
  repo?: AppRepo
  /** UI V2 最终使用的连接，和 connectV2 返回的是同一个 AppRepo。 */
  onRepoReady?: (repo: AppRepo) => void
  // ...其余沿用现有 UI props
}
```

内部实现复用原来的 core / 渲染逻辑，只换连接入口：

```ts
const appRepo = props.repo ?? await connectV2(props.appId, options)
const uiConnection = getUiConnection(appRepo)   // 只给 UI 内部用

// 原来 core 的 mount / loadConfigBackends / loadDataGroups / 渲染全部复用
core.mountWithConnection(uiConnection)

props.onRepoReady?.(appRepo)
```

`core` 只增加一个可选的 `connection` 输入（或 `mountWithConnection`），原来的 `loadConfigBackends` / `loadDataGroups` / 建组 / 加后端 / 状态轮询 / 渲染逻辑不变。

要点：

- **有 `repo` 就不 connect**；没有才 `connectV2`；
- 无论哪种方式，UI V2 对外给出的都是 `AppRepo`，和 `connectV2` 完全同类型；
- `UiConnection` 只在 UI V2 内部存在，应用不需要接触；
- 旧 `SyncGroupConfigurator` 一行不改，旧应用不受影响；
- 渲染、建组、加后端、状态轮询等内部实现基本照旧，只把「自己 `connect` 拿 `ConnectResult`」改成「拿 `AppRepo` 后 `getUiConnection`」；
- React 组件本身不能 `return` 运行时对象，所以「返回」通过 `onRepoReady` 或 core 的 `getAppRepo()` 暴露。

推荐新应用直接用 UI V2：

```ts
const repo = await connectV2('golf')

<SyncGroupConfiguratorV2
  appId="golf"
  repo={repo}
  onRepoReady={(sameRepo) => {
    // sameRepo === repo
  }}
/>
```

或者应用完全不管连接：

```ts
<SyncGroupConfiguratorV2
  appId="golf"
  onRepoReady={async (repo) => {
    const group = await repo.getDefaultDataGroup()
    // 业务读写
  }}
/>
```

第二种模式下，UI V2 是连接持有者，应用拿到 `AppRepo` 后不能再调 `connectV2`，否则还是两个连接。只有应用确定传入的 `appId + 配置后端` 与 UI V2 完全一致、且 V2 缓存键包含该签名时，后续 `connectV2` 才会命中同一个实例。

### 16.9 配置后端的持久化

V2 不负责发现或保存配置后端。宿主必须自己持久化，并在下次 `connectV2` 时传入：

- 无论「应用持有」还是「UI 持有」，都要持久化配置后端；UI 持有模式不能只靠 UI 的 localStorage；
- 首次由 UI 给共享 repo 加配置后端后，宿主应在 `onBackendAdded` 里把 `{ type, options }` 存到自己的设置里；
- 下次启动 `connectV2(appId, { configBackends: [...] })`，否则只会打开纯本地配置仓，看不到远端数据组；
- UI 自己的 localStorage `backendInfo` 只能作为表单缓存，不能成为唯一来源；
- 如果宿主不持久化，UI 能连、V2 下次连不上，这是配置问题，不是默认组解析问题。

---

## 17. 开放问题

1. `getDefaultDataGroup` 是「取组即建」还是「首次写入才建」：当前提案是取组时建，应用不需要维护无组分支；更严格可以改成写入拦截。
2. 多组选择：当前规则是「`default` 优先，否则第一个」。如果同时存在一个空的本地 `default` 和一个同步下来、已有数据的组，是否仍优先空 `default`？可能需要改成「有数据的组优先」或让应用显式选组。
3. V2 是否要暴露完整同步状态快照（`getSyncStatuses` / `getBackendSyncStates`）；当前只有 `onSyncEvent` 事件流，没有状态快照。
4. 隐式 `local-idb` 在 UI 如何展示；V2 是否需要一个 `hasRemoteBackends` 之类的只读标志。
5. `connectV2` 缓存键只按 `appId` 是否安全；同一 appId 配不同配置后端时是否要分开。
6. 后端身份校验的具体手段：靠组 id、描述符、远端目录标记，还是首次挂载时让用户确认。
7. `addBackend` 同 id 已存在时，是抛 `BackendAlreadyExistsError` 还是返回 `addedBackend: false`；当前允许按配置选择。
8. `connectV2` 最终是长期名字，还是后续作为 `connect` 的默认行为；当前保持加法，不破坏旧 API。
9. 本地先建 `default`、之后才加配置后端，而远端已有同 id 组时，配置 UI 的冲突策略（保留本地 / 采用远端 / 另建组）。
10. `zen-fs-sync` 的 `sync:progress` 具体粒度：文件数、字节数、当前路径、是否可提前知道 `total`；当前上游没有，需要先扩展。
11. 进度事件节流参数：每 N 个文件或每 200ms；大文件单文件内部是否还要字节级进度。
12. 事件顺序与丢失：`sync:start` / `progress` / `end` 是否保证按顺序；多后端并发时是否需要组级聚合事件。
