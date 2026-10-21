# 记账数据结构设计（统一 `type` 模型）

> 目标：记账 App 的数据（流水 / 价格 / 电商订单）采用**统一 `type` 字段区分**的单一记录模型，
> 并落地为**每条记录一个独立 PouchDB 文档**，以支撑大记录量（导入京东+淘宝统一订单约 2290 条）
> 下的按需分页、细粒度同步，同时消除当前"单文档塞全部数据"的体积隐患。
>
> 本设计是 `apps-design.md`（§8 记账示例）的**数据与存储层修订**：记账不再用 `useAppData` 的单文档形态，
> 改为专用的多文档存储（前缀 `bk:`），与 `pouchdb-design.md` 的"每条数据独立文档"原则对齐。
> 组件交互层（MPA 入口、清单、显隐）不变。

## 1. 背景与问题

- 当前记账数据存于单个 PouchDB 文档 `app:bookkeeping`：
  ```ts
  BookkeepingData = { transactions: Tx[], prices: PriceRecord[] }
  ```
  价格与流水靠"数组归属"区分，没有统一的 `type`；订单被并入 `transactions`、只能用 `platform`/`orderId`
  字段间接识别，类型语义不清晰。
- 导入京东+淘宝统一订单（`all_orders_unified.json`，2290 条，过滤拆单主单后约 2250 条真实交易）后，
  全部数据塞进这一个文档 → 文档体积巨大：
  - PouchDB 单文档读写、RemoteStorage 整库同步、移动端首次拉取都偏慢；
  - 违背 `pouchdb-design.md`「旧设计（单文档）vs 新设计（多文档）」已论证的原则（修改一条要同步整个数据集、单文档大小受限）。
- 记录量大时，单一的"全量读写"模式无法分页、无法按类型/时间范围增量加载。

## 2. 决策

1. **统一 `type` 模型**：所有记账数据（流水 / 价格 / 订单）放进一个 `BookkeepingRecord[]` 判别联合，
   用顶层 `type` 字段区分三类记录：
   | `type` | 含义 | 原结构对应 |
   |---|---|---|
   | `'tx'` | 记账 / 流水（收入或支出） | 原 `transactions` 中无 `platform`/`orderId` 者 |
   | `'price'` | 价格（单品 / 套餐 / 代金券） | 原 `prices` |
   | `'order'` | 电商订单（京东 / 淘宝） | 原 `transactions` 中带 `platform`/`orderId` 者 |
2. **多文档落地**：每条记录 = 一个独立 PouchDB 文档（ID 前缀 `bk:`），`type` 写在 body 兼作查询键。
   这样大记录量可 `allDocs` 按 `bk:<type>:` 前缀范围查询 + 分页，且每条记录独立同步。
3. **订单独立成 `type`**：不再伪装成 `type:'expense'` 的流水，电商字段（`platform/account/orderId/status/...`）
   集中在 `OrderRecord` 上，`type` 即可一眼区分订单，无需靠 `platform` 是否存在推断。

> 命名注意：原 `Tx.type`（`'income' | 'expense'`）与顶层 `type` 语义冲突，流水内部方向**改名为 `direction`**。

## 3. 统一记录结构（判别联合）

```ts
type BookkeepingType = 'tx' | 'price' | 'order'

interface BaseRecord {
  id: string
  type: BookkeepingType
  date: string          // YYYY-MM-DD（订单取 order_time 前 10 位）
  createdAt: number
  source?: string       // 数据来源，如 '京东订单' / '淘宝订单' / 手动
}

// ── 流水 ──
interface TxRecord extends BaseRecord {
  type: 'tx'
  direction: 'income' | 'expense'   // 原 Tx.type 改名，避免与顶层 type 混淆
  amount: number
  category: string
  note?: string
  product?: string
  quantity?: number
  unit?: string
  unitPrice?: number
}

// ── 价格（保留原 kind 子类型）──
interface PriceRecord extends BaseRecord {
  type: 'price'
  kind: 'item' | 'combo' | 'voucher'
  // item:   { product, unit, unitPrice }
  // combo:  { name, unitPrice, items: ComboItem[] }
  // voucher:{ name, cost, faceValue }
  // 字段沿用现有 PriceRecord 变体定义
}

// ── 电商订单（原 normalizeOrderRow 产物，独立成 type）──
interface OrderItem {
  name: string
  spec: string | null
  price: number | null
  qty: number | null
  amount: number | null
}
interface OrderRecord extends BaseRecord {
  type: 'order'
  platform: 'jd' | 'taobao'
  account?: string
  orderId: string        // 复合主键的一部分（platform+account+orderId）
  status?: string
  shop?: string
  payment?: string
  totalAmount: number    // 原 schema 的 total_amount
  items?: OrderItem[]
}

type BookkeepingRecord = TxRecord | PriceRecord | OrderRecord
```

## 4. 存储层（多文档，对齐 pouchdb-design.md）

- **文档 ID**：`bk:<type>:<id>`（例：`bk:tx:1697…`、`bk:price:1697…`、`bk:order:1697…`）。
  复用 `pouchdb-design.md` 的"单库 + ID 前缀 + `doc.type`"规范，新增 `bk:` 前缀。
- **逐条写入**：每条记录 `database.put({ _id, type, ...record })`；软删除沿用 `deleted: true`（不物理删，便于同步恢复）。
- **查询（按类型 / 分页）**：
  ```ts
  // 记录 Tab：流水 + 订单
  allDocs({ startkey: 'bk:tx:',   endkey: 'bk:tx:'   + '￰' })
  allDocs({ startkey: 'bk:order:', endkey: 'bk:order:' + '￰' })
  // 价格 Tab
  allDocs({ startkey: 'bk:price:', endkey: 'bk:price:' + '￰' })
  // 分页：limit + startkey（上一页末位 key 续查）
  allDocs({ startkey, endkey, limit: 50 })
  ```
  如需按 `date` 倒序或跨类型统一时间线，建一个 MapReduce view（`map`: `emit([type, date], null)`）。
- **同步**：
  - RemoteStorage 整库同步自动覆盖这些 `bk:` 文档（细粒度，单条变更只同步该文档）。
  - WebDAV 兜底：改为聚合 `app_data/onenav/apps/bookkeeping-records.json`（首次加载若无 `bk:` 文档则回退读此文件并写回 `bk:`），或按 `bk:` 前缀分文件（实现时定）。
- **不再使用 `useAppData('bookkeeping', …)` 的单文档模式**；改为专用存储模块（建议 `src/lib/bookkeeping-store.ts`），
  直接 `getPouchDB()` 操作 `bk:` 前缀，对外暴露 `listByType / putRecord / bulkPut / removeRecord / queryByDate`。

## 5. 迁移（旧 → 新）

加载时检测旧 shape `{ transactions, prices }`（即 `app:bookkeeping` 文档存在、且 `bk:` 前缀无文档）：

1. `transactions` 中**无** `platform`/`orderId` → `TxRecord`（`direction = 原 type`）。
2. `transactions` 中**有** `platform`/`orderId` → `OrderRecord`（拆出电商字段，`totalAmount = amount`）。
3. `prices` → `PriceRecord`（`kind` 不变）。
4. 逐条 `put` 为 `bk:<type>:<id>` 文档；迁移完成后删除旧 `app:bookkeeping` 文档。
5. 幂等：若已存在 `bk:` 文档则跳过迁移。

## 6. UI 映射

> 价格与流水保存在一起、也显示在一起（用户决策：统一 `type` 模型本就同源，无需拆 Tab）。

- **统一时间线**：`records` 按 `date` 倒序合成一个列表（流水 / 订单 / 报价 同列）。顶部筛选 chip：`全部 / 流水 / 订单 / 报价`。
- **类型徽标**：订单行带「京东 / 淘宝」+「订单」标签、`account`、`status`、`shop`，可展开 `items`；报价行带「报价」标签、按 `kind`（单品 / 套餐 / 代金券）沿用 `PRICE_TYPES` 注册表展示。
- **添加区**：同一屏内用「记流水 / 记价格」切换两种表单（替代原两个 Tab）。
- **搜索**：跨全部 `records` 命中 `platform / account / orderId / status / shop / product / category / note / 报价标题`。用 `recordHaystack(r)` 按 `type` 取对应字段。
- **汇总**：仅统计 `type in ('tx','order')`（即 `directionOf` 为 income/expense 的真实收支），**报价不计入**收入 / 支出 / 结余。选「报价」chip 时隐藏汇总卡。

## 7. 导入 / 导出

- **导入**：`detectRowKind` 由字段判定 `type` 后统一 push 进 `records`，再批量 `put`：
  - 含 `order_id`（或 `platform + total_amount`）→ `'order'`（自动过滤 `is_master_split === true` 拆单主单）。
  - 含 `kind`（item/combo/voucher）→ `'price'`。
  - 含 `type + category + amount` → `'tx'`。
  - 订单商品中「有单价」者（`price > 0.01`，过滤红包占位）额外生成 `type:'price'` 记录（按商品名去重、保留最新报价）。
- **导出**：导出 `records`（或按 `type` 过滤为模板）；订单记录保留 `order_id` / `total_amount` / `platform`，
  保证回灌经 `detectRowKind` 仍正确识别（修复此前"普通记录被误判为订单"的回环 bug）。

## 8. 与既有设计的关系

| 文档 | 关系 |
|---|---|
| `pouchdb-design.md` | 本设计的存储层直接套用其"每条数据独立文档 + ID 前缀 + 软删除"原则，新增 `bk:` 前缀。 |
| `apps-design.md` §8 | 其描述的 `useAppData('bookkeeping', { transactions: [] })` 单文档形态**被本设计取代**；组件入口 / 清单 / 显隐不变。 |

## 9. 验证状态（实现后填写）

- [ ] `tsc -b` 通过
- [ ] `vite build` 通过
- [ ] 用 `bookkeeping-order-sample.json` 验证：统一时间线中出现订单（带京东/淘宝标签）与报价（带「报价」标签）、拆单主单被过滤；选「报价」chip 隐藏汇总
- [ ] 导入 2290 条后 `bk:*` 文档数 ≈ 2250（已排除拆单主单）
- [ ] 迁移：旧 `app:bookkeeping` 单文档可正确转为 `bk:*` 多文档
