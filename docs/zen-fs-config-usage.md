# zen-fs-config 的两个函数

CFS 指 `zen-fs-config`。应用只需要记住两个函数：

```ts
connect(appId)                         // 打开配置仓，拿到 repo
getOrCreateAppDataGroup(repo, opts)    // 拿数据组；没有才建
```

本文按模式 C：没有数据组后端时不建组，有后端时一次建成。

---

## 1. `connect(appId)`

**用途**：打开这个应用的配置仓。

```ts
const { repo } = await connect('golf')
```

**返回的 `repo` 管什么：**

- 应用配置：`/<appId>/…`
- 节点配置：`/nodes/<nodeId>/…`
- 共享配置：`/shared/…`
- 数据组目录：`.config/app-data-groups/<appId>/…`

**不管什么：** 业务数据。不要用 `repo.fs` 存应用数据。

**没有配置后端时：**

- 只建本地 IndexedDB（`zen-fs-config-config-<appId>`）；
- 不写后端信息，不建同步对，什么都不用填。

**有配置后端时：**

- 只同步上面那些配置和数据组目录；
- 不会同步数据组里的业务文件。

**注意：** `connect` 返回时，远端配置可能还在后台拉。要判断「有没有数据组」，先等首次配置拉取完成；拉取没完成时的「没有」不等于「远端没有」。

---

## 2. `getOrCreateAppDataGroup(repo, opts)`

**名字含义**：先 get，拿不到再 create。不是无条件创建。

```ts
const { group, created } = await getOrCreateAppDataGroup(repo, {
  groupId: 'default',
  backend: {
    id: 'rs-main',
    type: 'RemoteStorage',
    options: { href: 'https://storage.example/', token: '...' },
  },
})
```

**参数：**

- `repo`：`connect` 返回的配置仓；
- `groupId`：数据组 id，例如 `default`；
- `backend`：可选。要挂到这个组上的第一个远端后端。

**行为：**

| 情况 | 结果 |
|---|---|
| 组已存在 | 直接返回该组，`created: false` |
| 组已存在，且传了尚未挂载的 `backend` | 返回该组，并把这个后端挂上去，`created: false` |
| 组不存在，传了 `backend` | 创建组并带这个后端，`created: true` |
| 组不存在，没传 `backend` | 返回 `null`，**什么都不写** |

最后一行是重点：**没有后端就不建组**，不写空描述符。

**返回值：**

```ts
{ group: AppDataGroup | null, created: boolean }
```

**拿到的 `group` 怎么用：**

```ts
await group.fs.promises.writeFile('/golf/course.json', json)
const text = await group.fs.promises.readFile('/golf/course.json', 'utf8')
```

`group.fs` 是业务数据的唯一入口。组内部自带一个本地的 IndexedDB（`local-idb`），不用用户配置，也不出现在后端列表里。

---

## 3. 两个函数怎么配合

```ts
// 第一步：打开配置仓（没有后端时纯本地）
const { repo } = await connect('golf')

// 第二步：有组就拿，没有且用户配了后端才建
const { group } = await getOrCreateAppDataGroup(repo, {
  groupId: 'default',
  backend: userSelectedBackend, // 没有就传 undefined
})

if (!group) {
  // 还没有数据组：先用应用自己的本地暂存库
  useLocalStagingStore()
} else {
  // 有组了：业务数据走 group.fs
  useDataGroup(group)
}
```

用户第一次配后端时，`backend` 有值，`getOrCreate` 一次完成「建组 + 挂后端」；用户没配后端时，`group` 为 `null`，应用继续用本地暂存库。

---

## 4. 三句话记住

1. `repo.fs` 只放配置，`group.fs` 才放应用数据。
2. 没有后端就不建组；建组必须同时带后端。
3. 组里的 `local-idb` 是内置的本地主存储，不是同步后端。

---

## 5. 和底层 API 的对应

`getOrCreateAppDataGroup` 是 OneNav 约定的一层封装（上游没有同名函数）。它内部做三件事：

1. `repo.listAppDataGroups()` 看有没有这个 id；
2. 有就 `repo.getAppDataGroup(id)`；
3. 没有且传了 `backend`，才 `repo.createAppDataGroup(id, [backend])`。

所以文档里说的 `getOrCreate`，底层仍然是上游的 `getAppDataGroup` / `createAppDataGroup`；只是把「先查再建、没有后端不建」这个容易写错的顺序固定下来。

如果远端已经有一个组，不要用新 id 去新建：先 `list` 找到原组，用原 id 挂后端。数据组的初始同步是本地优先，新组去认领旧远端数据会覆盖远端同名文件。
