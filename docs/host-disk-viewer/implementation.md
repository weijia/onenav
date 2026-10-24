# 实现计划 (P4)

> 关联：`design.md`
> 注：Q1~Q8 已确认，以下为具体任务拆解与落地记录。

## 4.1 脚手架与注册 ✅
- [x] `apps/hostmonitor/index.html`：照搬 `apps/bookkeeping/index.html`，标题「设备监控 · OneNav」、theme-color `#0e7490`。
- [x] `apps/hostmonitor/entry.tsx`：`id='hostmonitor'`、`accent='from-cyan-500 to-blue-600'`、`goBack` 回退到 `../../index.html`，挂载 `HostDiskApp`。
- [x] `src/components/apps/manifest.ts` 追加 `hostmonitor` 元信息（id=`hostmonitor`、name=`设备监控`、icon=`Server`、entry=`apps/hostmonitor/index.html`）。

## 4.2 数据获取层 ✅
- [x] `src/components/apps/hostmonitor/fetch.ts`：
  - 复用 onenav 现有 RemoteStorage 连接：`getStorageCredentials() || getSavedStorageCredentials()` 取 href+token，构建 `RemoteStorageFileSystem`（与 `favorites-remotestorage.ts` 同模式）。
  - best-effort `claimAccess('ufs-nodes','r')`（token 已 mint 时不会 retroactively 生效，仅保证下次重新授权带上 scope）。
  - `readdir('ufs-nodes')` + 逐文件 `readFile` 读取全部 JSON；路径约定无前导斜杠（与 `app_data/favorites` 一致），并兼容带/不带结尾斜杠两种列举。
  - 未连接 → 抛 `RsNotConnectedError`；鉴权失败（401/403，经 `isRemoteStorageAuthError` 判定）→ 抛 `RsAuthError`；供 UI 显示「去连接」引导（Q5）。
  - 单文件解析/读取失败跳过，不整页崩溃。

## 4.3 解析/归一化层 ✅
- [x] `src/components/apps/hostmonitor/normalize.ts` + `types.ts`：
  - 分类规则（Q3，最具体优先）：`type==="disk"`→磁盘 SMART；含 `host_info`→主机明细；含 `capabilities/inbox/mqtt`→节点控制(跳过)；其余→主机心跳。
  - 先用 detail/disk 引用的 `host_uuid`/`device_uuid` 构成 `knownHostUuids`，心跳 uuid 命中集合时更可靠判为主机（优化误判）。
  - 以主机 `uuid` 融合 `{uuid}.json`（心跳）+ `{uuid}_disks.json`（明细）+ SMART `{serial}.json`（host_uuid 命中）→ `HostView`（含 `disks: DiskView[]`）。
  - 磁盘融合：SMART 字段 + 明细物理盘（DeviceID/MediaType/Partitions/Status/InterfaceType）+ 逻辑盘（经 `disk_partition_mappings` 关联）。
  - 在线判定（Q6）：`(now - last_access) <= 30min` → online；排序在线优先、`last_access` 倒序。
  - 敏感字段（Q8）：提取心跳 `mqtt` 的 password/secret/broker/topic/username/client_id，标记 `sensitive:true` 交 UI 遮罩揭示。

## 4.4 UI 展示层 ✅
- [x] `src/components/apps/HostDiskApp.tsx`：
  - 状态机：`loading` / `error` / `empty` / `data`。
  - 未连接 / 鉴权失败（Q5）→「去连接」引导，按钮跳回主页 `../../index.html` 完成连接 + 重试。
  - 手动刷新按钮（Q6，无自动刷新）。
  - 主机卡片：名称、在线/离线徽标、局域网 IP、平台/主机名/架构、采集时间。
  - 磁盘子卡片：型号、序列号、容量、接口、介质、温度、健康徽标（PASSED→绿 / 否则红 / 无 SMART→灰）、分区映射（物理盘→逻辑盘，使用率进度条，>=90% 红 / >=70% 黄 / 否则绿）。
  - 敏感字段（Q8）：密码遮罩 `•••` + 点击眼睛图标揭示/隐藏。

## 4.5 构建验证 ✅
- [x] `npm run build` 通过（exit 0）；`dist/apps/hostmonitor/index.html` 与 `dist/assets/app-hostmonitor-*.js` 已产出；首页「应用」区出现「设备监控」卡片（经 `AppCard` 用 `app.entry` 跳转）。

## 4.6 单元测试 (P5) ✅
- [x] `src/components/apps/hostmonitor/normalize.test.ts`：用样本 JSON 覆盖分类(Q3)、融合、30min 在线判定(Q6)、敏感字段(Q8)、节点控制跳过、空输入健壮性。
- [x] 引入 `vitest`（devDependency）并新增 `test` 脚本（见 package.json）。

## 跨项目前置（非本应用任务，需另行跟进）
- [ ] 确认 home_cloud 运行时产出 `ufs-nodes/{uuid}_disks.json`（否则 Q2(b) 明细取不到，仅展示心跳+SMART）。
