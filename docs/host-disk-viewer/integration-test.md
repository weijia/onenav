# 集成测试文档 + 执行 (P3 文档 / P6 执行)

> 关联：`open-questions.md`、`design.md`、`fetch.ts`、`normalize.ts`、`HostDiskApp.tsx`
> 运行方式：`npm test`（=`vitest run`）已覆盖「远程存储获取层 → 归一化层」真实代码路径（mock 掉 `@/lib/remotestorage-fs` 与 `@/lib/remotestorage-connection`）。

## 自动化范围说明
- **可自动化（已执行）**：数据管线 `fetchUfsNodesRaw() → normalizeUfsNodes()`。通过 mock 远程存储文件系统，用受控文件清单/内容驱动真实 `fetch.ts`，再交给真实 `normalize.ts`，断言端到端结果。覆盖 E2E-1 与 B-1~B-7 中除「纯浏览器交互」外的全部判定点。见 `src/components/apps/hostmonitor/integration.test.ts`（11 个用例）。
- **需人工（浏览器 + 已连接 RemoteStorage）**：UI 渲染交互 —— 点击揭示敏感字段遮罩（B-6 的 DOM 层）、手动刷新按钮重拉（Q6）、未连接时「去连接」跳转（Q5/B-4 的导航层）。下方「手工 E2E 演练」给出可操作步骤，需在已连接账号的真实环境由人工执行。

## 端到端场景
| 场景 | 前置条件 | 操作步骤 | 预期结果 | 判定标准 | 执行 |
|------|----------|----------|----------|----------|------|
| E2E-1 | 已连接 RS，ufs-nodes 含 host 心跳 + 磁盘 SMART + 主机明细 + 节点控制对象 | 打开设备监控页 → 自动拉取并分类 | 主机在线/磁盘健康正确渲染；节点控制单独成区 | hosts=1 且 online/disks 正确；controlNodes=1 且不混入主机列表 | ✅ 自动化 |

## 边界场景
| 场景 | 前置条件 | 操作步骤 | 预期结果 | 判定标准 | 执行 |
|------|----------|----------|----------|----------|------|
| B-1 | ufs-nodes 为空 | 拉取 | 空态，不报错 | fetch 返回 [] → hosts=[]、controlNodes=[] | ✅ 自动化 |
| B-2 | 存在 1 个损坏 JSON 文件 | 拉取 | 损坏文件跳过，其余正常 | 仅有效文件进入 raws；不整页崩溃 | ✅ 自动化 |
| B-2(读失败) | 列得见但读不到的文件 | 拉取 | 该文件跳过 | raws 不含该文件；其余正常 | ✅ 自动化 |
| B-3 | JSON 非预期形态（缺字段/数字/字符串） | 拉取+归一化 | 降级处理不抛异常 | normalize 返回空 hosts/controlNodes | ✅ 自动化 |
| B-4 | 未连接 RS（无凭据） | 拉取 | 抛 `RsNotConnectedError`（code=NOT_CONNECTED）→ UI「去连接」引导 | 异常类型/code 正确 | ✅ 自动化（导航层需人工） |
| B-4(鉴权) | token 失效（401/403）——多为「已连接但缺 ufs-nodes 作用域」 | 拉取 | 抛 `RsAuthError`（code=AUTH）→ **首次自动** disconnect+connectWithUserAddress 跳 OAuth 重新授权（sessionStorage 一次性守卫）；若已尝试过或重连失败则显示「目录权限不足 / 去主页重新连接」 | 异常类型/code 正确；自动重授权仅在首次触发，避免死循环 | ✅ 自动化（跳转交互需人工验证） |
| B-5 | 节点控制对象混入 | 拉取+分类 | 不误展示为主机/磁盘 | hosts=[]、controlNodes=1 | ✅ 自动化 |
| B-6 | 节点控制含 mqtt 密码/密钥 | 归一化 | 标记 `sensitive:true`（UI 据此外遮罩，DOM 默认不暴露明文） | sensitive 含「MQTT 密码」「AES 密钥」且 sensitive=true | ✅ 自动化（点击揭示交互需人工） |
| B-7 | 缺 `{uuid}_disks.json` | 拉取+融合 | 心跳+SMART 仍展示主机，`hasDetail=false` | 主机展示、磁盘来自 SMART | ✅ 自动化 |

## 手工 E2E 演练（需人工，浏览器 + 已连接账号）
1. **连接与未连接（B-4/Q5）**：在已退出 onenav RemoteStorage 的状态下打开「设备监控」→ 应见「去连接」引导；点按钮回主页完成 OAuth 连接后刷新本页 → 数据出现。
2. **敏感字段揭示（B-6/Q8）**：展开控制节点区，mqtt 密码/密钥默认显示 `•••`；点击眼睛图标 → 明文出现；再次点击 → 重新遮罩。确认页面初始 DOM 不含明文。
3. **手动刷新（Q6）**：等待 >30min 不操作，状态不变（无自动刷新）；点刷新按钮 → 重新拉取，在线/离线随 `last_access` 重算。
4. **跨项目依赖确认（Q2(b)）**：确认 home_cloud 运行时已向 RS 产出 `ufs-nodes/{uuid}_disks.json`；否则明细区为空（仅心跳+SMART），需回到 home_cloud 侧排查产出脚本。

## 执行记录
| 场景 | 结果 | 备注 |
|------|------|------|
| E2E-1 | ✅ PASS | 自动化 11 用例覆盖 |
| B-1 | ✅ PASS | 自动化 |
| B-2 | ✅ PASS | 自动化（损坏/读失败两种） |
| B-3 | ✅ PASS | 自动化 |
| B-4（未连接/鉴权） | ✅ PASS | 异常类型已断言；导航交互待人工 |
| B-5 | ✅ PASS | 自动化 |
| B-6 | ✅ PASS | 数据层 sensitive 已断言；DOM 揭示待人工 |
| B-7 | ✅ PASS | 自动化 |
| 汇总 | **17 用例全绿**（单测 6 + 集成 11），`npm test` 稳定通过 | 沙箱已用 `vitest.config.ts` 单线程池规避 brokered-fs EPERM |

## 遗留 / 跨项目项
- [ ] 人工在真实环境跑「手工 E2E 演练」（需已连接 RS + home_cloud 已产出明细）。
- [ ] 确认 home_cloud 运行时产出 `ufs-nodes/{uuid}_disks.json`（否则 Q2(b) 明细缺失，非本应用 bug）。

## 运维须知：已连接账号首次出现 401（EAUTH）的处理
- **现象**：打开设备监控报 `Failed to load data` 或 readdir `ufs-nodes/` 返回 `{"code":"EAUTH","status":401}`。
- **根因**：RemoteStorage 的目录权限（scope）在 OAuth 授权那一刻写入令牌。本项目在 `claimDefaultAccess()` 加入 `ufs-nodes:r` 之前签发的旧令牌**不会自动获得**该作用域，服务端因此对 `ufs-nodes` 拒绝读取（401）。
- **解决（一次性）**：在 OneNav 主页「断开 RemoteStorage」，再用同一账号（`user@host`）重新连接一次 —— 触发完整 OAuth，新令牌带上 `ufs-nodes` 读权限；连上后回设备监控点「刷新」即可。
- **代码侧（自动重授权）**：设备监控检测到 `ufs-nodes` 的 401 时，会**自动**调用 `reauthorizeForUfsNodes()`（`remotestorage-connection.ts`）：先 `disconnect()` 清掉库内旧 token（否则 remotestoragejs 会复用旧令牌跳过 OAuth），再用已保存的 `userAddress` 走 `connectWithUserAddress()` 触发完整 OAuth 重定向；新令牌即带 `ufs-nodes:r`。该自动跳转用 `sessionStorage` 标记 `onenav:rs-ufs-reauth-attempted` 做**一次性守卫**——仅首次 401 自动跳，若服务商未真正升级 scope 而再次 401，则退回「目录权限不足 / 去主页重新连接」手动面板，避免死循环。
- **跳转落点**：OAuth 重定向是整页跳转，授权完回到 onenav 主页（非设备监控页），需重新点进「设备监控」。
- **注意**：`claimAccess` 必须在 `rs.connect()` 之前调用（即只在 `connectWithUserAddress/connectWithToken` 走到的 `claimDefaultAccess` 里有效），事后调用无效。
