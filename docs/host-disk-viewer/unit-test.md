# 单元测试计划 + 执行 (P5)

> 关联：`normalize.ts` / `types.ts`、`design.md`（Q3 节点控制对象归并为 `ControlNodeView`，非「跳过」）

## 测试文件
- `src/components/apps/hostmonitor/normalize.test.ts`（6 个用例，纯函数、不依赖远程存储）

## 用例与结论
- [x] **分类 + 融合（Q3）**：`heartbeat` + `diskSmart` + `hostDetail` + `nodeControl` 输入 → 主机融合出磁盘/明细；节点控制对象**不进主机列表**，单独产出 `controlNodes`（1 条）。
- [x] **仅心跳无明细**：主机仍展示，`hasDetail=false`，磁盘来自 SMART；仅以磁盘 `host_uuid` 出现的主机（host-2）也被纳入。
- [x] **明细存在但无 SMART**：物理盘仍展示（`hasSmart=false`、`hasDetail=true`、`model=null`、`deviceId` 来自明细）。
- [x] **30 分钟在线判定（Q6）**：`host-1`（1 分钟前）在线排前，`host-2`（40 分钟前）离线排后。
- [x] **节点控制敏感字段（Q8）**：`nodeControl` → `controlNodes[0].sensitive` 含「MQTT 密码」「AES 密钥」，全部 `sensitive:true`、保留明文值（交由 UI 遮罩）；无 mqtt 的主机 `sensitive` 为空。
- [x] **空 / 畸形输入健壮性**：`[]`、`[null,123,'str',{foo:'bar'}]` 均返回空 `hosts` / 空 `controlNodes`，不抛异常。

## 运行
- [x] `npm test`（=`vitest run`）全部通过：**6 passed**。
- 注：受限沙箱中 Vitest 的 forked worker 对内部 SSR 缓存的并发写入会被 brokered-fs 拦截（EPERM）导致整轮中途中止；已在 `vitest.config.ts` 设 `pool:'threads'` + `singleThread:true` 解决，`npm test` 在本机与沙箱均稳定跑全量。
