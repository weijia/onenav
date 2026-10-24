# 待确认问题（Open Questions）— 主机磁盘应用

本文件记录开发中需要用户拍板的问题与最终结论。结论确定后在对应条目标注 ✅，并回填到各分析文档（requirements/design/...）。

---

## Q1 · 数据源归属（最关键） ✅ 已确认
主机/磁盘遥测数据（home_cloud 写入 `ufs-nodes/`）到底存在哪套远程存储？
- **✅ A. 与 onenav 书签同步同一套 RemoteStorage 账号**：复用 onenav 现有 OAuth 连接，需额外 `claim('ufs-nodes', 'r')`。
- B. home_cloud / vue-element-admin 使用的另一套 RemoteStorage 账号
- C. my-data 的 WebDAV（teracloud）
- **结论**：复用 onenav 同账号 RemoteStorage；数据获取层用 `RemoteStorageFileSystem` 读取 `/ufs-nodes/`，并 `claim('ufs-nodes','r')`。

## Q2 · 展示范围 ✅ 已确认
- (a) 仅 RemoteStorage 内的主机心跳状态 + 磁盘 SMART
- (b) 额外含「主机+磁盘+分区」明细
- **✅ (c) 全部**
- **结论**：展示 (a)+(b)。其中 (b) 的明细来自 **RemoteStorage 的 `ufs-nodes/{uuid}_disks.json`**（每台主机一个，含 physical_disks / logical_disks / disk_partition_mappings）。
- **运行时验证项**：确认 home_cloud 在运行时会向 RemoteStorage 产出 `ufs-nodes/{uuid}_disks.json`（见下方「跨项目依赖」）。

## Q3 · ufs-nodes 文件区分规则 ✅ 已确认
`ufs-nodes/` 目录并存三类 JSON：节点控制对象（含 `capabilities/inbox/mqtt`）、主机心跳、磁盘 SMART（`type:"disk"`）。
- **✅ 方案1（字段规则）**：`type === "disk"` → 磁盘；命中 `capabilities`/`inbox`/`mqtt` 任一 → 节点控制对象（跳过不展示）；其余 → 主机心跳。
- 方案2（稳定标记）：要求 home_cloud 增加 `kind` 标记。
- **结论**：采用字段规则；已知边界风险（新建未设 capabilities 的节点控制对象会被误判为主机心跳），实现时在 normalize 层加注释并优先用更稳定的判定（如存在 `host_info`/`local_ip` 视为主机心跳）。

## Q4 · 应用元信息 ✅ 已确认
- **✅ id=`hostmonitor`、名称=`设备监控`、入口 `apps/hostmonitor/index.html`**。

## Q5 · 未连接远程存储时的行为 ✅ 已确认
- **✅ A. 显示「去连接」引导**：复用 onenav 现有 RemoteStorage OAuth 连接流程。
- B. WebDAV 兜底 / C. 仅空态或错误提示
- **结论**：未连接或 token 失效时，页面显示「去连接」引导，引导用户走 onenav 现有连接流程。

## Q6 · 刷新与在线判定 ✅ 已确认
- **✅ 仅手动刷新**：不自动刷新，提供手动刷新按钮。
- 在线/离线判定仍沿用 `last_access` 的 **30 分钟阈值**（与 ufs-nodes 文档一致）。
- **结论**：无定时自动刷新；用户点刷新按钮重新拉取 `/ufs-nodes/`；在线状态由 `last_access` 计算。

## Q7 · 文档与代码落点 ✅ 已确认（由维护者按现有约定决定）
- **文档**：`onenav/docs/host-disk-viewer/`（requirements/design/integration-test/implementation/unit-test/open-questions）。
- **代码**：`apps/hostmonitor/`（index.html + entry.tsx）+ `src/components/apps/HostDiskApp.tsx`，并在 `src/components/apps/manifest.ts` 注册。

## Q8 · 敏感字段处理 ✅ 已确认
- **✅ 敏感字段作为密码展示，可点击显示**：`mqtt.password`/`secret` 等字段以遮罩形式呈现，用户点击后可揭示明文；不做硬性白名单剔除。
- **结论**：展示层对敏感字段采用「密码遮罩 + 点击揭示」交互，而非直接隐藏或原样明文暴露。

---

## 跨项目依赖 / 行动项
- **home_cloud 侧**：需确保运行时向 RemoteStorage 产出 `ufs-nodes/{uuid}_disks.json`（每台主机的磁盘+分区明细），否则 Q2(b) 取不到数据。该产出是否已有、由哪个脚本负责，需在实现阶段向 home_cloud / my-data 维护者确认（属 my-data 项目范围，非本 onenav 应用内部任务）。
- **onenav 侧**：`claim('ufs-nodes','r')` 后读取 `/ufs-nodes/` 全部文件，按 Q3 规则分类，融合 `ufs-nodes/{uuid}.json`（主机心跳）、`ufs-nodes/{serial}.json`（磁盘 SMART）、`ufs-nodes/{uuid}_disks.json`（主机磁盘明细）。
