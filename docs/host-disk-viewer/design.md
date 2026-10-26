# 设计文档 — 设备监控应用 (P2)

> 关联：`open-questions.md`（✅ 已确认）、`requirements.md`
> 现有能力：`src/lib/remotestorage-fs.ts`、`src/lib/remotestorage-connection.ts`
> 现有 app 模式：`apps/bookkeeping/`、`apps/golf/`、`src/components/apps/manifest.ts`、`src/components/apps/AppHost.tsx`

## 架构
```
独立页面 (apps/hostmonitor/index.html)
  → entry.tsx
  → HostDiskApp
      → 数据获取层 (fetch.ts)
      → 解析/归一化层 (normalize.ts)
      → UI 展示层 (HostDiskApp.tsx)
```

## 数据获取层（`src/components/apps/hostmonitor/fetch.ts`）
- **数据源**：复用 onenav 同账号 RemoteStorage（Q1=A）。在连接建立后 `claim('ufs-nodes', 'r')`（参考 `remotestorage-connection.ts` 的 `claimAccess`）。
- 用 `RemoteStorageFileSystem.readdir('/ufs-nodes/')` 列出全部文件，逐文件 `readFile` 读取 JSON。
- **三类文件（Q2=c / Q3）**：
  - `ufs-nodes/{uuid}.json` → 主机心跳状态
  - `ufs-nodes/{serial}.json` → 磁盘 SMART（`type:"disk"`）
  - `ufs-nodes/{uuid}_disks.json` → 该主机的磁盘+分区明细（physical_disks / logical_disks / disk_partition_mappings）；需运行时验证 home_cloud 已产出（见 open-questions.md 跨项目依赖）
- 处理未连接 / 鉴权失败：返回明确错误态，交由 UI 显示「去连接」引导（Q5）。

## 解析/归一化层（`src/components/apps/hostmonitor/normalize.ts`）
- **区分规则（Q3=字段规则，最具体优先）**：
  - `type === "disk"` → 磁盘（SMART）
  - 含 `host_info`（含 `device_uuid`）→ 主机明细（`{uuid}_disks.json`）
  - 命中 `capabilities` / `inbox` / `mqtt` 任一 → **节点控制对象**：不并入主机监控列表（Q3 意图），但单独归并为 `ControlNodeView` 供「控制节点」区展示（解决 Q3 与 Q8 的矛盾，详见下）
  - 其余（含 `local_ip`/`last_access_str`）→ 主机心跳
  - 优化：先用 detail/disk 引用的 `host_uuid`/`device_uuid` 构成 `knownHostUuids`，心跳文件 uuid 命中该集合时更可靠地判为主机心跳。
- 以主机 `uuid` 为主键，把同主机的「心跳」「`{uuid}_disks.json` 明细」「SMART `{serial}.json`（按 `host_uuid` 命中）」融合为 `HostView`（含 `disks: DiskView[]`）。仅出现在磁盘 `host_uuid`、尚无心跳的主机也纳入（防御）。
- 在线判定（**Q6**）：`(now - last_access) <= 30min` → online，否则 offline；排序在线优先、last_access 倒序。
- 敏感字段（**Q8**）：`mqtt.password`/`secret` 等只来自节点控制对象（home_cloud 心跳本身不含 mqtt），提取为 `sensitive:true` 交给 UI 以密码遮罩呈现。

## UI 展示层（`src/components/apps/HostDiskApp.tsx`）
- 沿用 `AppHost` 外壳（`name/description/accent/icon/component/onBack`）。
- 状态机：`loading` / `error` / `empty` / `data`。
- **未连接（Q5）**：显示「去连接」引导，跳转回主页 `../../index.html` 完成 onenav 现有 RemoteStorage OAuth 连接，并提供重试。
- **刷新（Q6）**：无自动刷新；提供手动刷新按钮，重新拉取 `/ufs-nodes/`。
- 主机卡片：名称、在线/离线徽标、局域网 IP、平台/主机名/架构、采集时间（取自 `last_access`，可选 `last_access_str` 优先）；控制节点卡片同样展示采集时间。
  - 采集时间展示规则：优先 `last_access_str`（可选，home_cloud 心跳）；若缺失则用必填的 `last_access` 毫秒时间戳经 `new Date(ms).toLocaleString()` 本地化格式化兜底。原因：`ufs-nodes/` 可能同时含 vue-element-admin 的节点控制对象（**无** `last_access_str`，仅 `last_access`）与省略该字段的 home_cloud 心跳；二者 `last_access` 均为必填，故展示时间必须以 `last_access` 为准，不能依赖可能缺失的 `last_access_str`（详见 `host-disk-info-format.md` 与 `ufs-nodes-remotestorage-format.md`）。
  - 实现：`normalize.ts` 导出纯函数 `formatLastAccess({ lastAccessStr, lastAccessMs })`，UI 两处卡片统一调用。
- 磁盘区：型号、序列号、容量、温度、健康（PASSED→绿 / 否则红 / 无 SMART→灰）、接口、介质、分区数；分区映射（来自 `{uuid}_disks.json`）：物理盘 → 逻辑盘（盘符/文件系统/已用% 进度条，>=90% 红 / >=70% 黄 / 否则绿）。
- **控制节点区（Q3+Q8 协调）**：节点控制对象作为独立分组展示（不混入主机监控），其 `mqtt.password`/`secret` 等敏感字段以「密码遮罩 + 点击揭示」呈现，不原样明文暴露、也不硬性剔除。
- 主机卡片内的 mqtt 敏感字段（兜底）：若某主机心跳意外携带 mqtt，同样遮罩揭示。

## 磁盘信息过滤（区分有 / 无磁盘信息的主机）
- **判定口径**：主机「有磁盘信息」= `host.disks.length > 0`（存在任意磁盘记录：SMART 或明细物理盘）；「无磁盘信息」= `disks.length === 0`（仅心跳、无任何磁盘数据）。与 UI 卡片中「暂无磁盘数据」的展示口径一致。
- **实现**：`normalize.ts` 导出纯函数 `hostHasDiskInfo(host)` 与 `filterHostsByDiskInfo(hosts, mode)`，`mode ∈ 'all' | 'with-disk' | 'no-disk'`，便于单测、不依赖 React。
- **UI**：`HostDiskApp` data 态在主机列表上方加三枚分段按钮「全部 N / 有磁盘 X / 无磁盘 Y」（实时计数），点击切换 `diskFilter`；当前筛选无匹配时提示「当前筛选无匹配的主机」。控制节点不参与主机过滤。

## 注册方式
- `src/components/apps/manifest.ts` 的 `APP_MANIFEST` 追加 `hostmonitor` 一项（id=`hostmonitor`、name=`设备监控`、icon 待定、accent、description、entry=`apps/hostmonitor/index.html`）。
- `apps/hostmonitor/index.html` + `entry.tsx` 照搬 `apps/bookkeeping/` 模板（vite 自动发现 `apps/*/index.html`，无需手改 vite 配置）。

## 待确认
- 无（Q1~Q8 均已 ✅ 确认，结论见 `open-questions.md`）
