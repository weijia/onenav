# 需求文档 — 设备监控应用 (P1)

> 关联：`open-questions.md`（✅ 已确认）、`design.md`
> 数据格式依据：`my-data/docs/formats/host-disk-info-format.md`、`ufs-nodes-remotestorage-format.md`

## 目标
在 onenav 新增一个**独立 HTML 应用「设备监控」**，从 **remote storage（onenav 同账号 RemoteStorage）** 读取 `my-data` 定义的「主机与磁盘信息」，并以可视化方式展示。

## 用户场景
1. 用户在 onenav 首页看到「设备监控」应用入口（来自 `manifest.ts`）。
2. 点击进入独立页面（`apps/hostmonitor/index.html`）。
3. 页面从 RemoteStorage 读取 `ufs-nodes/` 下全部 JSON，按规则分类为主机与磁盘并融合明细。
4. 展示每台主机的在线状态、基础信息，及其下磁盘型号/容量/温度/健康等遥测与分区映射。
5. 用户可点击手动刷新按钮重新拉取数据；未连接时显示「去连接」引导。

## 展示范围（Q2=c 全部）
- **(a) 主机心跳状态**：`ufs-nodes/{uuid}.json`（名称、在线/离线、局域网 IP、平台、采集时间）
- **(a) 磁盘 SMART**：`ufs-nodes/{serial}.json`（型号、序列号、容量、温度、健康、接口类型、SMART 概要）
- **(b) 主机磁盘+分区明细**：`ufs-nodes/{uuid}_disks.json`（physical_disks / logical_disks / disk_partition_mappings）
  - 注：该文件由 home_cloud 运行时产出，需验证其存在（见 open-questions.md 跨项目依赖）。

## 展示字段
- **主机**：名称、在线/离线、局域网 IP、平台、采集时间
- **磁盘**：型号、序列号、容量、温度、健康、接口类型、SMART 概要
- **分区映射**：物理盘 → 逻辑盘（盘符 / 文件系统 / 已用%）

## 非目标
- 敏感字段（如 `mqtt.password`/`secret`）**不剔除**，以「密码遮罩 + 点击揭示」呈现（Q8）。
- 不下发命令、不写回 remote storage。

## 接口需求（要点）
- 入参：onenav 现有 RemoteStorage 连接（无需额外配置，同账号）。
- 出参：归一化后的 `HostView[]`（每个含 `disks: DiskView[]`）。
- 降级：未连接 / 文件缺失 / JSON 解析失败 / 字段缺失时给出明确空态或错误，不整页崩溃。

## 待确认
- 无（Q1~Q8 均已 ✅ 确认）
