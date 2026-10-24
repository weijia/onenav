import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Trash2,
  TrendingUp,
  TrendingDown,
  Wallet,
  Search,
  FileUp,
  FileDown,
  HelpCircle,
  Tag,
  Package,
  Ticket,
  Plus,
  Copy,
  Check,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  type BookkeepingRecord,
  type TxRecord,
  type PriceRecord,
  type OrderRecord,
  type OrderItem,
  type ComboItem,
  type PriceKind,
  directionOf,
  loadAllRecords,
  putRecords,
  removeRecord,
  removeRecords,
  priceTotalOf,
} from '@/lib/bookkeeping-store'
import { mergePrices } from '@/lib/bookkeeping-price'

// 单据类型（TxRecord / PriceRecord / OrderRecord / BookkeepingRecord）与存储函数
// 统一 type 模型 + 每条记录一个独立 PouchDB 文档，见 src/lib/bookkeeping-store.ts 与 docs/bookkeeping-data-model.md


// ───────────────────────────────────────────────────────────
// 价格类型注册表（可扩展性的核心接缝）
// ───────────────────────────────────────────────────────────
interface PriceTypeMeta {
  label: string
  icon: LucideIcon
  /** 代表价：用于排序、上次报价带入 */
  getPrice: (r: PriceRecord) => number
  /** 列表主标题 */
  getTitle: (r: PriceRecord) => string
  /** 列表副标题 */
  getSubtitle: (r: PriceRecord) => string
  /** 展开明细（如套餐的菜品清单），没有则为空 */
  detail?: (r: PriceRecord) => React.ReactNode
}

const PRICE_TYPES: Record<PriceKind, PriceTypeMeta> = {
  item: {
    label: '单品',
    icon: Tag,
    getPrice: (r) => (r.kind === 'item' ? priceTotalOf(r) : 0),
    getTitle: (r) => (r.kind === 'item' ? r.product : ''),
    getSubtitle: (r) =>
      r.kind === 'item'
        ? r.quantity && r.quantity > 0
          ? `单价 ¥${r.unitPrice}/${r.unit || '—'} × ${r.quantity} · 总价 ¥${priceTotalOf(r)}`
          : `单价 ¥${r.unitPrice}/${r.unit || '—'} · 总价 ¥${priceTotalOf(r)}`
        : '',
  },
  combo: {
    label: '套餐',
    icon: Package,
    getPrice: (r) => (r.kind === 'combo' ? r.unitPrice : 0),
    getTitle: (r) => (r.kind === 'combo' ? r.name : ''),
    getSubtitle: (r) => (r.kind === 'combo' ? `套餐价 ¥${r.unitPrice} · 含 ${r.items.length} 项` : ''),
    detail: (r) =>
      r.kind === 'combo' ? (
        <div className="mt-1 space-y-0.5">
          {r.items.length === 0 ? (
            <div className="text-white/30 text-xs">（无明细）</div>
          ) : (
            r.items.map((it, i) => (
              <div key={i} className="text-white/40 text-xs">
                {it.product}
                {it.unit ? ` · ${it.unit}` : ''}
                {it.quantity ? ` ×${it.quantity}` : ''}
                {it.unitPrice != null ? ` · ¥${it.unitPrice}` : ''}
              </div>
            ))
          )}
        </div>
      ) : null,
  },
  voucher: {
    label: '代金券',
    icon: Ticket,
    getPrice: (r) => (r.kind === 'voucher' ? r.cost : 0),
    getTitle: (r) => (r.kind === 'voucher' ? r.name : ''),
    getSubtitle: (r) =>
      r.kind === 'voucher'
        ? `花 ¥${r.cost} 得 ¥${r.faceValue}（约 ${(r.cost / r.faceValue * 10).toFixed(1)} 折）`
        : '',
  },
}

/** 注册表顺序即分组展示顺序 */
const PRICE_KINDS = Object.keys(PRICE_TYPES) as PriceKind[]

// ───────────────────────────────────────────────────────────
// 通用工具
// ───────────────────────────────────────────────────────────
const CATEGORIES = ['餐饮', '交通', '购物', '居家', '娱乐', '医疗', '工资', '理财', '其他']
// 单位建议：细分单位（粒/斤/克/个…）优先，利于跨记录比价；整件单位（箱/盒/袋/包…）靠后，
// 选择整件单位时提示「整件单位不利比价，建议用细分单位」。
const FINE_UNITS = ['粒', '斤', '克', '个', '条', '块', '只', '毫升', '升', '袋']
const COARSE_UNITS = ['件', '包', '瓶', '盒', '箱', '桶']
const UNIT_SUGGESTIONS = [...FINE_UNITS, ...COARSE_UNITS]
const COARSE_UNIT_SET = new Set(COARSE_UNITS)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 统一时间线每页条数（翻页 / 动态加载） */
const PAGE_SIZE = 50

/** 生成紧凑页码序列（含省略号占位） */
function buildPages(cur: number, total: number): (number | '...')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const anchors = new Set<number>([1, total, cur, cur - 1, cur + 1, cur - 2, cur + 2])
  const sorted = [...anchors].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b)
  const out: (number | '...')[] = []
  let prev = 0
  for (const n of sorted) {
    if (prev && n - prev > 1) out.push('...')
    out.push(n)
    prev = n
  }
  return out
}

function today(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function randId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function toNumber(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function normalizeType(v: unknown): 'income' | 'expense' {
  const s = String(v ?? '').trim()
  if (s === 'income' || s === '收入' || s === 'in' || s === '+') return 'income'
  return 'expense'
}

function toNumberOrNull(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 把 schema 的 items 数组归一化为内部 OrderItem[]（无效行丢弃） */
function parseItems(raw: unknown): OrderItem[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const list = raw
    .map((it): OrderItem | null => {
      if (!it || typeof it !== 'object') return null
      const o = it as Record<string, unknown>
      const name = typeof o.name === 'string' ? o.name.trim() : ''
      if (!name) return null
      return {
        name,
        spec: typeof o.spec === 'string' ? o.spec : null,
        price: toNumberOrNull(o.price),
        qty: toNumberOrNull(o.qty),
        amount: toNumberOrNull(o.amount),
      }
    })
    .filter((x): x is OrderItem => x !== null)
  return list.length ? list : undefined
}

// ───────────────────────────────────────────────────────────
// 交易记录（流水）导入导出
// ───────────────────────────────────────────────────────────
function normalizeRow(raw: unknown, fallbackDate: string): TxRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const type = normalizeType(r.type)
  let amount = toNumber(r.amount)
  const quantity = toNumber(r.quantity)
  const unitPrice = toNumber(r.unitPrice)
  if (!amount && quantity && unitPrice) {
    amount = Math.round(quantity * unitPrice * 100) / 100
  }
  if (!amount) return null
  const date = typeof r.date === 'string' && DATE_RE.test(r.date) ? r.date : fallbackDate
  const category = typeof r.category === 'string' && r.category.trim() ? r.category.trim() : '其他'
  const note = typeof r.note === 'string' ? r.note.trim() : ''
  const product = typeof r.product === 'string' ? r.product.trim() : ''
  const unit = typeof r.unit === 'string' ? r.unit.trim() : ''
  return {
    id: randId(),
    type: 'tx',
    direction: type,
    amount,
    category,
    note,
    date,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
    product: product || undefined,
    quantity: quantity || undefined,
    unit: unit || undefined,
    unitPrice: unitPrice || undefined,
  }
}

function normalizeOrderRow(raw: unknown, fallbackDate: string): OrderRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  // 过滤京东拆单主单（schema §5.1：统计真实交易时排除）
  if (r.is_master_split === true) return null
  const platform = r.platform === 'jd' || r.platform === 'taobao' ? r.platform : undefined
  const orderId = typeof r.order_id === 'string' ? r.order_id : undefined
  if (!platform || !orderId) return null
  const total = toNumber(r.total_amount)
  const orderTime = typeof r.order_time === 'string' ? r.order_time : ''
  const ymd = orderTime.slice(0, 10)
  const date =
    DATE_RE.test(ymd) ? ymd : typeof r.year === 'string' && /^\d{4}$/.test(r.year) ? `${r.year}-01-01` : fallbackDate
  const items = parseItems(r.items)
  const firstProduct = items?.[0]?.name ?? (typeof r.shop === 'string' && r.shop ? r.shop : undefined)
  const status = typeof r.status === 'string' ? r.status : undefined
  const shop = typeof r.shop === 'string' ? r.shop : undefined
  const account = typeof r.account === 'string' ? r.account : undefined
  const payment = typeof r.payment === 'string' ? r.payment : undefined
  const platformLabel = platform === 'jd' ? '京东' : '淘宝'
  const noteParts = [platformLabel, account ? `@${account}` : '', status ?? ''].filter(Boolean)
  return {
    id: randId(),
    type: 'order',
    amount: total,
    category: '购物',
    note: noteParts.join(' · '),
    date,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
    product: firstProduct,
    platform,
    account,
    orderId,
    status,
    shop,
    payment,
    items,
  }
}

/** 从订单商品里提取「有单价」的条目，生成价格记录（item）。同名不同时间/来源的记录各自保留（去重键 = 商品名 + 时间，见 bookkeeping-price.ts）。 */
function extractOrderPrices(raw: unknown, fallbackDate: string): PriceRecord[] {
  if (!raw || typeof raw !== 'object') return []
  const r = raw as Record<string, unknown>
  if (r.is_master_split === true) return []
  const platform = r.platform === 'jd' || r.platform === 'taobao' ? r.platform : undefined
  if (!platform) return []
  const orderTime = typeof r.order_time === 'string' ? r.order_time : ''
  const ymd = orderTime.slice(0, 10)
  const date = DATE_RE.test(ymd) ? ymd : typeof r.year === 'string' && /^\d{4}$/.test(r.year) ? `${r.year}-01-01` : fallbackDate
  // 保留完整时间（HH:MM:SS）：有日期时间时按「商品名+日期时间」去重，让同一天不同时间点的报价各自保留
  const time = /^\d{2}:\d{2}:\d{2}$/.test(orderTime.slice(11, 19)) ? orderTime.slice(11, 19) : undefined
  const createdAt = typeof r.createdAt === 'number' ? r.createdAt : Date.now()
  const source = platform === 'jd' ? '京东订单' : '淘宝订单'
  const out: PriceRecord[] = []
  if (Array.isArray(r.items)) {
    for (const it of r.items) {
      if (!it || typeof it !== 'object') continue
      const o = it as Record<string, unknown>
      const name = typeof o.name === 'string' ? o.name.trim() : ''
      const price = toNumber(o.price)
      const qty = toNumber(o.qty) || toNumber(o.quantity)
      if (!name || !(price > 0.01)) continue // 跳过无单价 / 红包占位 0.01
      out.push({
        type: 'price',
        kind: 'item',
        id: randId(),
        product: name,
        unit: '',
        unitPrice: price,
        quantity: qty > 1 ? qty : undefined, // 数量>1 才保留（体现整体价；默认单份无意义）
        date,
        time,
        source,
        createdAt,
      })
    }
  }
  return out
}

function toExportShape(t: TxRecord | OrderRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {
    date: t.date,
    type: directionOf(t), // 导出 income/expense 语义（订单导出为 expense），导入时按 order_id/platform 再判别
    category: t.category ?? '',
    amount: t.amount,
    note: t.note ?? null,
    product: t.product ?? null,
    quantity: t.quantity ?? null,
    unit: t.unit ?? null,
    unitPrice: t.unitPrice ?? null,
  }
  // 订单字段：仅当该记录确实来自电商订单时才写，避免普通记账记录被误判为订单
  if (t.type === 'order') {
    out.platform = t.platform
    out.account = t.account ?? null
    out.order_id = t.orderId
    out.order_time = `${t.date} 00:00:00`
    out.year = t.date.slice(0, 4)
    out.shop = t.shop ?? null
    out.status = t.status ?? null
    out.payment = t.payment ?? null
    out.items = t.items ?? null
    out.is_master_split = false
    out.total_amount = t.amount // 用 schema 的 total_amount 表达金额，保证回灌时识别正确
  }
  return out
}

// ───────────────────────────────────────────────────────────
// 价格记录导入导出
// ───────────────────────────────────────────────────────────
function normalizeComboItem(raw: unknown): ComboItem | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const product = typeof r.product === 'string' ? r.product.trim() : ''
  if (!product) return null
  const unit = typeof r.unit === 'string' ? r.unit.trim() : ''
  return {
    product,
    unit: unit || undefined,
    quantity: toNumber(r.quantity) || undefined,
    unitPrice: toNumber(r.unitPrice) || undefined,
  }
}

/** 把任意 JSON 行归一化为合法 PriceRecord；kind 未知（老版本读新类型）直接跳过，保证不崩 */
function normalizePriceRow(raw: unknown, fallbackDate: string): PriceRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kind = r.kind
  if (kind !== 'item' && kind !== 'combo' && kind !== 'voucher') return null
  const date = typeof r.date === 'string' && DATE_RE.test(r.date) ? r.date : fallbackDate
  const source = typeof r.source === 'string' ? r.source.trim() : ''
  const base = {
    id: randId(),
    type: 'price' as const,
    date,
    source: source || undefined,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
  }
  if (kind === 'item') {
    const product = typeof r.product === 'string' ? r.product.trim() : ''
    const unitPrice = toNumber(r.unitPrice)
    if (!product || !unitPrice) return null
    const unit = typeof r.unit === 'string' ? r.unit.trim() : ''
    return { ...base, kind: 'item', product, unit, unitPrice, quantity: toNumber(r.quantity) || undefined }
  }
  if (kind === 'combo') {
    const name = typeof r.name === 'string' ? r.name.trim() : ''
    const unitPrice = toNumber(r.unitPrice)
    if (!name || !unitPrice) return null
    const items = Array.isArray(r.items)
      ? (r.items.map(normalizeComboItem).filter(Boolean) as ComboItem[])
      : []
    return { ...base, kind: 'combo', name, unitPrice, items }
  }
  // voucher
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  const cost = toNumber(r.cost)
  const faceValue = toNumber(r.faceValue)
  if (!name || !cost || !faceValue) return null
  return { ...base, kind: 'voucher', name, cost, faceValue }
}

function toPriceExportShape(r: PriceRecord) {
  if (r.kind === 'item') {
    return { kind: 'item', date: r.date, product: r.product, unit: r.unit || null, unitPrice: r.unitPrice, quantity: r.quantity ?? null, source: r.source ?? null }
  }
  if (r.kind === 'combo') {
    return { kind: 'combo', date: r.date, name: r.name, unitPrice: r.unitPrice, items: r.items, source: r.source ?? null }
  }
  return { kind: 'voucher', date: r.date, name: r.name, cost: r.cost, faceValue: r.faceValue, source: r.source ?? null }
}

// ───────────────────────────────────────────────────────────
// 统一导入解析：自动识别 tx / price，支持混合数组
// ───────────────────────────────────────────────────────────
type ImportTarget = 'tx' | 'price' | 'auto'

/**
 * 自动识别单条记录属于 tx 还是 price：
 * - 有 kind 字段 → price（kind=item/combo/voucher）
 * - 有 type + category + amount → tx
 * - 含糊：有 unitPrice 且无 type → price item；否则 tx
 */
function detectRowKind(raw: any): 'tx' | 'price' | 'order' | null {
  if (!raw || typeof raw !== 'object') return null
  // 电商订单 schema 强特征（platform + order_id / total_amount）
  if ('order_id' in raw || ('platform' in raw && 'total_amount' in raw)) return 'order'
  if ('kind' in raw) return 'price'
  // tx 强特征
  if ('amount' in raw && ('type' in raw || 'category' in raw)) return 'tx'
  // price item 特征
  if ('unitPrice' in raw && !('type' in raw)) return 'price'
  return null
}

type ImportPreview = {
  txs: TxRecord[]
  orders: OrderRecord[]
  prices: PriceRecord[]
  skipped: number
}

function parseImport(text: string, target: ImportTarget = 'auto'): ImportPreview {
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('剪贴板内容不是有效的 JSON')
  }

  // 1. 确定数组来源：纯数组 / { transactions, prices } 包装
  let txArr: any[] | null = null
  let priceArr: any[] | null = null
  let mixedArr: any[] | null = null

  if (Array.isArray(parsed)) {
    mixedArr = parsed
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, any>
    if (Array.isArray(obj.transactions)) txArr = obj.transactions
    if (Array.isArray(obj.prices)) priceArr = obj.prices
    // 也支持 kind 标签包装：{ records: [...] } 按 kind 自识别
    if (!txArr && !priceArr) {
      for (const key of Object.keys(obj)) {
        if (Array.isArray(obj[key])) { mixedArr = obj[key]; break }
      }
    }
  }

  // 2. 有强制目标时：把全部数组都按该目标解析
  if (target !== 'auto') {
    if (target === 'tx') {
      txArr = txArr ?? priceArr ?? mixedArr
      priceArr = null
    } else {
      priceArr = priceArr ?? txArr ?? mixedArr
      txArr = null
    }
    mixedArr = null
  }

  // 3. 遍历所有来源，自动识别
  const fd = today()
  const txs: TxRecord[] = []
  const orders: OrderRecord[] = []
  const prices: PriceRecord[] = []
  let skipped = 0

  const feed = (rows: any[]) => {
    for (const raw of rows) {
      const kind = detectRowKind(raw)
      if (kind === 'tx') {
        const r = normalizeRow(raw, fd)
        r ? txs.push(r) : skipped++
      } else if (kind === 'price') {
        const r = normalizePriceRow(raw, fd)
        r ? prices.push(r) : skipped++
      } else if (kind === 'order') {
        // 京东拆单主单按 schema 规定过滤，不计入"无效"
        if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).is_master_split === true) continue
        const r = normalizeOrderRow(raw, fd)
        r ? orders.push(r) : skipped++
        // 订单里「有单价」的商品同时生成价格记录，导入后会出现在统一时间线的「报价」里
        for (const pr of extractOrderPrices(raw, fd)) prices.push(pr)
      } else {
        skipped++
      }
    }
  }

  if (txArr) feed(txArr)
  if (priceArr) feed(priceArr)
  if (mixedArr) feed(mixedArr)

  if (txs.length === 0 && orders.length === 0 && prices.length === 0)
    throw new Error('没有可导入的有效记录')
  // 价格记录完全不去重：同名商品在不同日期/来源的记录各自保留，仅按时间排序（见 bookkeeping-price.ts）
  const sortedPrices = mergePrices([], prices, 'replace')
  return { txs, orders, prices: sortedPrices, skipped }
}

// ── AI 提示词模板：复制到 AI 里生成记录，然后 Ctrl+V 粘贴导入 ──

/** 统一提示词：AI 自己判断是记账记录还是价格记录 */
const AI_PROMPT_TEMPLATE = `你是一个智能记账助手。请理解以下内容（可能是消费流水、也可能是商品价格、可能同时有两者），
输出一个严格的 JSON 数组，不要输出任何其他文字（不要解释、不要 markdown 代码块标记）。

内容：{在这里粘贴你的流水或价格描述，例如：今天午餐麻辣烫35，地铁6；鸡蛋5.8一斤；超市券75买100}

请判断每条内容属于哪种类型，用不同字段输出：

【A. 记账记录（支出/收入）】
特征：有金额支出或收入，带 type/category/amount 字段
字段：date(YYYY-MM-DD)、type("expense"支出/"income"收入)、category(分类)、amount(金额)、note(备注，可选)、product(商品名，可选)
分类建议：餐饮/交通/购物/居家/娱乐/医疗/工资/理财/其他

【B. 价格记录（报价/单价/套餐/代金券）】
特征：描述"X 多少钱一斤"、套餐价格、代金券面值等，用 kind 字段区分
- kind:"item" 单品：product、unit、unitPrice、quantity(数量，可选，用于显示整体价=单价×数量)、date
  · unit 建议用细分单位（粒/斤/克/个）便于跨记录比价，避免用箱/盒/袋/包等整件单位
  · 描述含数量时给出 quantity（如 3 斤、5 盒），以便显示整体价
- kind:"combo" 套餐：name、unitPrice、items[] (product/unit/quantity)、date
- kind:"voucher" 代金券：name、cost(实付)、faceValue(面值)、date

【C. 电商订单（京东/淘宝统一 schema）】
特征：来自 all_orders_unified.json，有 platform(京东=jd/淘宝=taobao) 和 order_id
字段：account、platform、order_id、order_time(YYYY-MM-DD HH:MM:SS)、year、shop、status、items[{name,spec,price,qty,amount}]、total_amount、payment、is_master_split
注意：系统会自动过滤 is_master_split=true 的拆单主单，并把每笔真实订单作为一条"支出"记录归入统一时间线（按金额计入支出）

数组里可以混合三类，系统会自动识别。

示例输出：
[
  {"date":"2026-10-20","type":"expense","category":"餐饮","amount":35,"note":"午餐","product":"麻辣烫"},
  {"date":"2026-10-20","type":"expense","category":"交通","amount":6,"note":"地铁"},
  {"kind":"item","date":"2026-10-20","product":"鸡蛋","unit":"斤","unitPrice":5.8,"quantity":3},
  {"kind":"item","date":"2026-10-20","product":"西瓜","unit":"斤","unitPrice":2.5},
  {"kind":"voucher","date":"2026-10-20","name":"超市券","cost":75,"faceValue":100}
]`

/** JSON 格式说明 */
const FORMAT_NOTE = `系统自动识别每条记录是 记账 / 价格 / 订单，支持混合数组：
- 含 order_id（或 platform + total_amount）→ 电商订单：每笔真实订单解析为一条 type:"order" 记录（在统一时间线中显示为流水/订单，按金额计入支出）；其商品中「有单价」的条目（主要淘宝，已过滤 0.01 红包占位）同时写入「报价」记录（完全不去重，同名商品在不同日期/来源的记录各自保留）
- 含 kind(item/combo/voucher) → 价格记录（item 支持 quantity：显示「单价 × 数量 = 整体价」；unit 建议用粒/斤/克/个等细分单位便于比价，避免箱/盒/袋等整件单位）
- 含 type + category + amount → 记账记录
解析失败的行会跳过，Toast 会告诉你跳过了几条。导出的 JSON 可直接当模板交给 AI 生成。`

// ───────────────────────────────────────────────────────────
// 主组件
// ───────────────────────────────────────────────────────────
// ── 统一时间线辅助 ──
function recordHaystack(r: BookkeepingRecord): string {
  if (r.type === 'price') {
    const meta = PRICE_TYPES[r.kind]
    return [meta?.getTitle(r), meta?.getSubtitle(r), 'source' in r ? r.source ?? '' : '']
      .join(' ')
      .toLowerCase()
  }
  return [
    r.note,
    r.category,
    r.product ?? '',
    r.platform ? (r.platform === 'jd' ? '京东' : '淘宝') : '',
    r.account ?? '',
    r.orderId ?? '',
    r.status ?? '',
    r.shop ?? '',
    r.payment ?? '',
    r.items?.map((i) => i.name).join(' ') ?? '',
    r.unit,
    String(r.amount),
    r.unitPrice != null ? String(r.unitPrice) : '',
    r.quantity != null ? String(r.quantity) : '',
  ]
    .join(' ')
    .toLowerCase()
}

function recordToExport(r: BookkeepingRecord): Record<string, unknown> {
  return r.type === 'price' ? toPriceExportShape(r) : toExportShape(r as TxRecord | OrderRecord)
}

function RecordRow({ r, onDelete }: { r: BookkeepingRecord; onDelete: (id: string) => void }) {
  if (r.type === 'price') {
    const m = PRICE_TYPES[r.kind]
    return (
      <div className="flex items-center gap-3 px-4 py-2.5">
        <div className="flex-1 min-w-0">
          <div className="text-white/90 text-sm truncate flex items-center gap-1.5">
            <span className="inline-block px-1.5 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-200 align-middle">报价</span>
            {m?.getTitle(r)}
          </div>
          <div className="text-white/40 text-xs">{m?.getSubtitle(r)}</div>
          <div className="text-white/40 text-xs">
            {r.date}
            {'source' in r && r.source ? ` · ${r.source}` : ''}
          </div>
          {m?.detail ? m.detail(r) : null}
        </div>
        <div className="text-sm font-medium text-white/70">
          {r.kind === 'voucher' ? `¥${r.cost}` : `¥${m?.getPrice(r)}`}
        </div>
        <button
          onClick={() => onDelete(r.id)}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white/30 hover:text-red-300 hover:bg-red-500/10 transition-colors"
          title="删除"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    )
  }
  const isOrder = r.type === 'order'
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div className="flex-1 min-w-0">
        <div className="text-white/90 text-sm truncate flex items-center gap-1.5">
          {isOrder && r.platform ? (
            <span
              className={`inline-block px-1.5 py-0.5 rounded text-[10px] align-middle ${
                r.platform === 'jd' ? 'bg-red-500/20 text-red-200' : 'bg-orange-500/20 text-orange-200'
              }`}
            >
              {r.platform === 'jd' ? '京东' : '淘宝'}
            </span>
          ) : null}
          {isOrder ? (
            <span className="inline-block px-1.5 py-0.5 rounded text-[10px] bg-sky-500/20 text-sky-200 align-middle">订单</span>
          ) : null}
          {r.category}
          {r.product ? ` · ${r.product}` : ''}
          {r.note ? ` · ${r.note}` : ''}
          {r.unitPrice ? ` · ¥${r.unitPrice}/${r.unit ?? ''}${r.quantity ? ` ×${r.quantity}` : ''}` : ''}
        </div>
        <div className="text-white/40 text-xs">
          {r.date}
          {r.items?.length ? ` · ${r.items.length} 件` : ''}
          {r.account ? ` · ${r.account}` : ''}
        </div>
      </div>
      <div className={`text-sm font-medium ${directionOf(r) === 'income' ? 'text-emerald-300' : 'text-rose-300'}`}>
        {directionOf(r) === 'income' ? '+' : '-'}
        {r.amount.toFixed(2)}
      </div>
      <button
        onClick={() => onDelete(r.id)}
        className="w-7 h-7 rounded-lg flex items-center justify-center text-white/30 hover:text-red-300 hover:bg-red-500/10 transition-colors"
        title="删除"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  )
}

export default function BookkeepingApp() {
  const [records, setRecords] = useState<BookkeepingRecord[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    loadAllRecords()
      .then((r) => {
        if (!cancelled) setRecords(r)
      })
      .catch(() => {
        // 加载失败保留空列表
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 统一时间线筛选：全部 / 流水 / 订单 / 报价
  const [viewFilter, setViewFilter] = useState<'all' | 'tx' | 'order' | 'price'>('all')
  // 添加区模式：记流水 / 记价格
  const [addMode, setAddMode] = useState<'tx' | 'price'>('tx')

  // 搜索
  const [search, setSearch] = useState('')

  // ── 统一时间线分页：每页 PAGE_SIZE 条，切换筛选 / 搜索时回到第 1 页 ──
  const [page, setPage] = useState(1)
  useEffect(() => {
    setPage(1)
  }, [viewFilter, search])
  // 导入预览
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge')
  const [importError, setImportError] = useState<string | null>(null)
  const [showFormatHelp, setShowFormatHelp] = useState(false)
  const [copiedPrompt, setCopiedPrompt] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(AI_PROMPT_TEMPLATE)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = AI_PROMPT_TEMPLATE
      document.body.appendChild(ta); ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopiedPrompt(true)
    setTimeout(() => setCopiedPrompt(false), 1500)
  }
  // 粘贴反馈 toast
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = (text: string, kind: 'ok' | 'err' = 'ok') => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ text, kind })
    toastTimer.current = setTimeout(() => setToast(null), 2500)
  }

  const transactions = useMemo(
    () => records.filter((r) => r.type === 'tx' || r.type === 'order') as (TxRecord | OrderRecord)[],
    [records],
  )
  const prices = useMemo(() => records.filter((r) => r.type === 'price') as PriceRecord[], [records])

  // ── 交易（记录）Tab 表单状态 ──
  const [type, setType] = useState<'income' | 'expense'>('expense')
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState('餐饮')
  const [note, setNote] = useState('')
  const [date, setDate] = useState(today())
  const [product, setProduct] = useState('') // 商品（用于上次报价带入）
  const [showUnit, setShowUnit] = useState(false)
  const [unitPrice, setUnitPrice] = useState('')
  const [quantity, setQuantity] = useState('')
  const [unit, setUnit] = useState('')

  // ── 价格 Tab 表单状态 ──
  const [priceKind, setPriceKind] = useState<PriceKind>('item')
  const [pName, setPName] = useState('')
  const [pDate, setPDate] = useState(today())
  const [pSource, setPSource] = useState('')
  const [pUnitPrice, setPUnitPrice] = useState('') // 单品单价 / 套餐总价
  const [pQuantity, setPQuantity] = useState('') // 单品数量（可选，用于显示整体价）
  const [pUnit, setPUnit] = useState('')
  const [pCost, setPCost] = useState('') // 代金券实付
  const [pFace, setPFace] = useState('') // 代金券面值
  const [comboItems, setComboItems] = useState<ComboItem[]>([])

  // ── 汇总（仅交易） ──
  const { income, expense, balance } = useMemo(() => {
    let inc = 0
    let exp = 0
    for (const t of transactions) {
      if (directionOf(t) === 'income') inc += t.amount
      else exp += t.amount
    }
    return { income: inc, expense: exp, balance: inc - exp }
  }, [transactions])

  // ── 上次报价带入：仅匹配单品价格（套餐/代金券不污染单品价） ──
  const lastQuote = useMemo(() => {
    const p = product.trim()
    if (!p) return null
    const matches = prices.filter(
      (x) =>
        x.kind === 'item' &&
        (x.product === p || x.product.includes(p) || p.includes(x.product)),
    )
    if (!matches.length) return null
    return [...matches].sort((a, b) =>
      a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.createdAt - a.createdAt,
    )[0] as Extract<PriceRecord, { kind: 'item' }>
  }, [product, prices])

  // ── 统一时间线（按日期降序，搜索覆盖所有类型） ──
  const visibleRecords = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list: BookkeepingRecord[] = records
    if (viewFilter !== 'all') list = list.filter((r) => r.type === viewFilter)
    list = [...list].sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1
      return b.createdAt - a.createdAt
    })
    if (!q) return list
    return list.filter((r) => recordHaystack(r).includes(q))
  }, [records, viewFilter, search])

  // ── 分页切片：所有筛选 Tab（全部/流水/订单/报价）共用同一套翻页 ──
  const totalCount = visibleRecords.length
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
  const safePage = Math.min(page, totalPages) // 删除后总页数变少时收敛，避免越界
  const pageStart = (safePage - 1) * PAGE_SIZE
  const pagedRecords = visibleRecords.slice(pageStart, pageStart + PAGE_SIZE)
  // 删除导致总页数变少时，把 page 收敛到合法范围
  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  // ── 单价×数量自动算金额 ──
  const computedAmount = useMemo(() => {
    const q = toNumber(quantity)
    const p = toNumber(unitPrice)
    if (q && p) return Math.round(q * p * 100) / 100
    return 0
  }, [quantity, unitPrice])

  // ── 交易：新增 ──
  const handleAddTx = async () => {
    const amt = computedAmount || Number(amount)
    if (!amt || amt <= 0) return
    const tx: TxRecord = {
      id: randId(),
      type: 'tx',
      direction: type,
      amount: amt,
      category: category || '其他',
      note: note.trim(),
      date,
      createdAt: Date.now(),
      product: product.trim() || undefined,
      quantity: toNumber(quantity) || undefined,
      unit: unit.trim() || undefined,
      unitPrice: toNumber(unitPrice) || undefined,
    }
    setRecords((prev) => [tx, ...prev])
    await putRecords([tx])
    setAmount('')
    setNote('')
    setProduct('')
    setQuantity('')
    setUnitPrice('')
    setUnit('')
    setShowUnit(false)
  }

  // ── 价格：新增（按 kind 构建，校验不通过则忽略） ──
  const handleAddPrice = async () => {
    const id = randId()
    const createdAt = Date.now()
    const source = pSource.trim() || undefined
    let rec: PriceRecord | null = null
    if (priceKind === 'item') {
      const up = toNumber(pUnitPrice)
      if (!pName.trim() || !up) return
      rec = {
        type: 'price',
        kind: 'item',
        id,
        product: pName.trim(),
        unit: pUnit.trim() || '份',
        unitPrice: up,
        quantity: toNumber(pQuantity) || undefined,
        date: pDate,
        source,
        createdAt,
      }
    } else if (priceKind === 'combo') {
      const up = toNumber(pUnitPrice)
      if (!pName.trim() || !up) return
      rec = {
        type: 'price',
        kind: 'combo',
        id,
        name: pName.trim(),
        unitPrice: up,
        date: pDate,
        source,
        createdAt,
        items: comboItems.filter((i) => i.product.trim()),
      }
    } else {
      const cost = toNumber(pCost)
      const face = toNumber(pFace)
      if (!pName.trim() || !cost || !face) return
      rec = { type: 'price', kind: 'voucher', id, name: pName.trim(), cost, faceValue: face, date: pDate, source, createdAt }
    }
    if (!rec) return
    setRecords((prev) => [rec, ...prev])
    await putRecords([rec])
    // 重置表单
    setPName('')
    setPUnitPrice('')
    setPQuantity('')
    setPUnit('')
    setPDate(today())
    setPSource('')
    setPCost('')
    setPFace('')
    setComboItems([])
  }

  const handleDeleteTx = async (id: string) => {
    setRecords((prev) => prev.filter((r) => r.id !== id))
    const target = records.find((r) => r.id === id)
    if (target) await removeRecord(target)
  }
  const handleDeletePrice = async (id: string) => {
    setRecords((prev) => prev.filter((r) => r.id !== id))
    const target = records.find((r) => r.id === id)
    if (target) await removeRecord(target)
  }

  const handleExport = () => {
    const payload = records.map(recordToExport)
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `bookkeeping-${today()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const runImport = (text: string, forcedTarget?: ImportTarget) => {
    setImportError(null)
    const target: ImportTarget = forcedTarget ?? 'auto'
    try {
      const preview = parseImport(text, target)
      setImportPreview(preview)
      const parts: string[] = []
      if (preview.txs.length + preview.orders.length)
        parts.push(`${preview.txs.length + preview.orders.length} 条记录`)
      if (preview.prices.length) parts.push(`${preview.prices.length} 条价格`)
      showToast(
        `识别到 ${parts.join('、')}${preview.skipped ? `（跳过 ${preview.skipped} 条无效）` : ''}`,
        'ok',
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : '解析失败'
      setImportError(msg)
      showToast(msg, 'err')
    }
  }

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    setImportError(null)
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => runImport(String(reader.result))
    reader.readAsText(file)
    e.target.value = ''
  }

  /** 点"导入"按钮：优先读剪贴板 JSON，不行则 fallback 到选文件 */
  const handleImportClick = async () => {
    try {
      if (navigator.clipboard?.readText) {
        const text = await navigator.clipboard.readText()
        if (text && text.trim()) {
          runImport(text)
          return
        }
      }
    } catch {
      // 剪贴板不可用（HTTP / 无权限），降级到文件选择
    }
    // Fallback：打开文件选择器
    showToast('剪贴板不可用，打开文件选择…', 'err')
    setTimeout(() => fileInputRef.current?.click(), 300)
  }

  const confirmImport = async () => {
    if (!importPreview) return
    const existingTxOrders = transactions
    const existingPrices = prices
    const importedTxOrders: BookkeepingRecord[] = [...importPreview.txs, ...importPreview.orders]
    const finalTxOrders: BookkeepingRecord[] =
      importMode === 'replace' && importedTxOrders.length > 0
        ? importedTxOrders
        : [...importedTxOrders, ...existingTxOrders]
    const finalPrices = mergePrices(existingPrices, importPreview.prices, importMode)
    const existingPriceIds = new Set(existingPrices.map((p) => p.id))
    const toPut: BookkeepingRecord[] = [
      ...importedTxOrders,
      ...finalPrices.filter((p) => !existingPriceIds.has(p.id)),
    ]
    const finalPriceIds = new Set(finalPrices.map((p) => p.id))
    const toRemove: BookkeepingRecord[] = existingPrices.filter((p) => !finalPriceIds.has(p.id))
    if (importMode === 'replace' && importedTxOrders.length > 0) {
      toRemove.push(...existingTxOrders)
    }
    const nextRecords = [...finalTxOrders, ...finalPrices]
    setRecords(nextRecords)
    if (toRemove.length) await removeRecords(toRemove)
    if (toPut.length) await putRecords(toPut)
    setImportPreview(null)
  }

  // ── 全局粘贴拦截：Ctrl+V / Cmd+V 在非输入焦点处自动触发导入 ──
  useEffect(() => {
    const isEditable = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false
      const tag = el.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return true
      if ((el as HTMLElement).isContentEditable) return true
      return false
    }
    const onPaste = (e: ClipboardEvent) => {
      if (isEditable(e.target)) return // 输入框内正常粘贴
      const text = e.clipboardData?.getData('text/plain')
      if (!text || !text.trim()) return
      e.preventDefault()
      runImport(text)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loading) {
    return <div className="text-center text-white/40 py-10">加载中…</div>
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-5 space-y-5">
      {/* 筛选 chip：全部 / 流水 / 订单 / 报价 */}
      <div className="flex gap-1 p-1 rounded-xl bg-white/5 border border-white/10">
        {([
          { k: 'all', label: '全部' },
          { k: 'tx', label: '流水' },
          { k: 'order', label: '订单' },
          { k: 'price', label: '报价' },
        ] as const).map((f) => (
          <button
            key={f.k}
            onClick={() => setViewFilter(f.k)}
            className={`flex-1 py-2 rounded-lg text-sm transition-colors ${
              viewFilter === f.k ? 'bg-white/20 text-white' : 'text-white/50 hover:bg-white/10'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* 汇总（仅真实收支：流水 + 订单；报价不计入） */}
      {viewFilter !== 'price' && (
        <div className="grid grid-cols-3 gap-3">
          <SummaryCard label="收入" value={income} accent="text-emerald-300" icon={<TrendingUp className="w-4 h-4" />} />
          <SummaryCard label="支出" value={expense} accent="text-rose-300" icon={<TrendingDown className="w-4 h-4" />} />
          <SummaryCard label="结余" value={balance} accent="text-white" icon={<Wallet className="w-4 h-4" />} />
        </div>
      )}

      {/* 添加区：记流水 / 记价格 切换 */}
      <div className="flex gap-1 p-1 rounded-xl bg-white/5 border border-white/10">
        <button
          onClick={() => setAddMode('tx')}
          className={`flex-1 py-2 rounded-lg text-sm transition-colors ${
            addMode === 'tx' ? 'bg-white/20 text-white' : 'text-white/50 hover:bg-white/10'
          }`}
        >
          记流水
        </button>
        <button
          onClick={() => setAddMode('price')}
          className={`flex-1 py-2 rounded-lg text-sm transition-colors ${
            addMode === 'price' ? 'bg-white/20 text-white' : 'text-white/50 hover:bg-white/10'
          }`}
        >
          记价格
        </button>
      </div>

      {addMode === 'tx' ? (
        <>
          {/* 添加记录（流水 / 订单） */}
          <div className="rounded-xl bg-white/5 border border-white/10 p-4 space-y-3">
            <div className="flex gap-2">
              <button
                onClick={() => setType('expense')}
                className={`flex-1 py-2 rounded-lg text-sm transition-colors ${
                  type === 'expense'
                    ? 'bg-rose-500/20 text-rose-200 border border-rose-400/30'
                    : 'bg-white/5 text-white/50 border border-white/10'
                }`}
              >
                支出
              </button>
              <button
                onClick={() => setType('income')}
                className={`flex-1 py-2 rounded-lg text-sm transition-colors ${
                  type === 'income'
                    ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-400/30'
                    : 'bg-white/5 text-white/50 border border-white/10'
                }`}
              >
                收入
              </button>
            </div>

            <div className="flex gap-2">
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="h-9 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-2 outline-none focus:border-white/40 [color-scheme:dark]"
              />
              <input
                type="number"
                inputMode="decimal"
                placeholder={computedAmount ? `金额（已算 ${computedAmount}）` : '金额'}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="flex-1 h-9 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-3 outline-none focus:border-white/40"
              />
            </div>

            <div className="flex flex-wrap gap-1.5">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  className={`px-2.5 py-1 rounded-full text-xs transition-colors ${
                    category === c ? 'bg-white/25 text-white' : 'bg-white/5 text-white/50 hover:bg-white/10'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>

            <input
              placeholder="商品（可选，用于价格记录「上次报价」带入）"
              value={product}
              onChange={(e) => setProduct(e.target.value)}
              className="w-full h-9 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-3 outline-none focus:border-white/40"
            />

            {/* 单价 / 数量（可选） */}
            <button
              onClick={() => setShowUnit((v) => !v)}
              className="text-xs text-white/45 hover:text-white/70 flex items-center gap-1"
            >
              {showUnit ? '▾' : '▸'} 单价 / 数量（可选，如按粒、按斤）
            </button>
            {showUnit && (
              <div className="grid grid-cols-3 gap-2">
                <input
                  type="number"
                  inputMode="decimal"
                  placeholder="单价"
                  value={unitPrice}
                  onChange={(e) => setUnitPrice(e.target.value)}
                  className="h-9 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-3 outline-none focus:border-white/40"
                />
                <input
                  type="number"
                  inputMode="decimal"
                  placeholder="数量"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className="h-9 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-3 outline-none focus:border-white/40"
                />
                <input
                  list="unit-suggestions"
                  placeholder="单位"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  className="h-9 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-3 outline-none focus:border-white/40"
                />
                <datalist id="unit-suggestions">
                  {UNIT_SUGGESTIONS.map((u) => (
                    <option key={u} value={u} />
                  ))}
                </datalist>
              </div>
            )}

            {/* 上次报价带入（只读，不写回价格表） */}
            {lastQuote && (
              <button
                onClick={() => {
                  setUnitPrice(String(lastQuote.unitPrice))
                  setUnit(lastQuote.unit)
                  setQuantity(lastQuote.quantity ? String(lastQuote.quantity) : '')
                }}
                className="text-xs text-emerald-300 hover:text-emerald-200 bg-emerald-500/10 border border-emerald-400/20 rounded-lg px-3 py-1.5 text-left"
              >
                上次报价 ¥{lastQuote.unitPrice}/{lastQuote.unit}（点击带入，不会写回价格表）
              </button>
            )}

            <div className="flex gap-2">
              <input
                placeholder="备注（可选）"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="flex-1 h-9 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-3 outline-none focus:border-white/40"
              />
              <button
                onClick={handleAddTx}
                disabled={!(computedAmount || (amount && Number(amount) > 0))}
                className="px-4 h-9 rounded-lg bg-emerald-500/80 hover:bg-emerald-500 text-white text-sm disabled:opacity-40"
              >
                添加
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          {/* 添加价格记录 */}
          <div className="rounded-xl bg-white/5 border border-white/10 p-4 space-y-3">
            <div className="flex gap-1">
              {PRICE_KINDS.map((k) => {
                const Icon = PRICE_TYPES[k].icon
                return (
                  <button
                    key={k}
                    onClick={() => setPriceKind(k)}
                    className={`flex-1 py-2 rounded-lg text-sm flex items-center justify-center gap-1 transition-colors ${
                      priceKind === k ? 'bg-white/20 text-white' : 'text-white/50 hover:bg-white/10'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {PRICE_TYPES[k].label}
                  </button>
                )
              })}
            </div>

            <div className="flex gap-2">
              <input
                placeholder={priceKind === 'item' ? '商品名' : '名称'}
                value={pName}
                onChange={(e) => setPName(e.target.value)}
                className="flex-1 h-9 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-3 outline-none focus:border-white/40"
              />
              <input
                type="date"
                value={pDate}
                onChange={(e) => setPDate(e.target.value)}
                className="h-9 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-2 outline-none focus:border-white/40 [color-scheme:dark]"
              />
            </div>

            {priceKind === 'item' && (
              <div className="space-y-1.5">
                <div className="grid grid-cols-3 gap-2">
                  <input
                    type="number"
                    inputMode="decimal"
                    placeholder="单价 *"
                    value={pUnitPrice}
                    onChange={(e) => setPUnitPrice(e.target.value)}
                    className="h-9 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-3 outline-none focus:border-white/40"
                  />
                  <input
                    type="number"
                    inputMode="decimal"
                    placeholder="数量"
                    value={pQuantity}
                    onChange={(e) => setPQuantity(e.target.value)}
                    className="h-9 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-3 outline-none focus:border-white/40"
                  />
                  <input
                    list="unit-suggestions"
                    placeholder="单位（默认 份）"
                    value={pUnit}
                    onChange={(e) => setPUnit(e.target.value)}
                    className="h-9 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-3 outline-none focus:border-white/40"
                  />
                </div>
                {COARSE_UNIT_SET.has(pUnit.trim()) && (
                  <div className="text-amber-300/90 text-xs px-1">
                    整件单位（{pUnit.trim()}）不利比价，建议用 粒 / 斤 / 克 等细分单位便于跨记录比较。
                  </div>
                )}
              </div>
            )}

            {priceKind === 'combo' && (
              <div className="space-y-2">
                <input
                  type="number"
                  inputMode="decimal"
                  placeholder="套餐总价 *"
                  value={pUnitPrice}
                  onChange={(e) => setPUnitPrice(e.target.value)}
                  className="w-full h-9 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-3 outline-none focus:border-white/40"
                />
                <div className="space-y-1.5">
                  {comboItems.map((it, i) => (
                    <div key={i} className="grid grid-cols-[1fr_0.7fr_0.7fr_0.7fr_auto] gap-1.5 items-center">
                      <input
                        placeholder="菜品名"
                        value={it.product}
                        onChange={(e) =>
                          setComboItems((list) =>
                            list.map((x, idx) => (idx === i ? { ...x, product: e.target.value } : x)),
                          )
                        }
                        className="h-8 rounded-lg bg-white/10 border border-white/20 text-white text-xs px-2 outline-none focus:border-white/40"
                      />
                      <input
                        placeholder="单位"
                        value={it.unit ?? ''}
                        onChange={(e) =>
                          setComboItems((list) =>
                            list.map((x, idx) => (idx === i ? { ...x, unit: e.target.value } : x)),
                          )
                        }
                        className="h-8 rounded-lg bg-white/10 border border-white/20 text-white text-xs px-2 outline-none focus:border-white/40"
                      />
                      <input
                        type="number"
                        placeholder="数量"
                        value={it.quantity ?? ''}
                        onChange={(e) =>
                          setComboItems((list) =>
                            list.map((x, idx) =>
                              idx === i ? { ...x, quantity: toNumber(e.target.value) || undefined } : x,
                            ),
                          )
                        }
                        className="h-8 rounded-lg bg-white/10 border border-white/20 text-white text-xs px-2 outline-none focus:border-white/40"
                      />
                      <input
                        type="number"
                        placeholder="单价"
                        value={it.unitPrice ?? ''}
                        onChange={(e) =>
                          setComboItems((list) =>
                            list.map((x, idx) =>
                              idx === i ? { ...x, unitPrice: toNumber(e.target.value) || undefined } : x,
                            ),
                          )
                        }
                        className="h-8 rounded-lg bg-white/10 border border-white/20 text-white text-xs px-2 outline-none focus:border-white/40"
                      />
                      <button
                        onClick={() => setComboItems((list) => list.filter((_, idx) => idx !== i))}
                        className="w-7 h-8 rounded-lg flex items-center justify-center text-white/30 hover:text-red-300 hover:bg-red-500/10"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => setComboItems((list) => [...list, { product: '' }])}
                    className="text-xs text-white/50 hover:text-white/80 flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" /> 添加菜品
                  </button>
                </div>
              </div>
            )}

            {priceKind === 'voucher' && (
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  inputMode="decimal"
                  placeholder="实付 *（如 75）"
                  value={pCost}
                  onChange={(e) => setPCost(e.target.value)}
                  className="h-9 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-3 outline-none focus:border-white/40"
                />
                <input
                  type="number"
                  inputMode="decimal"
                  placeholder="面值 *（如 100）"
                  value={pFace}
                  onChange={(e) => setPFace(e.target.value)}
                  className="h-9 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-3 outline-none focus:border-white/40"
                />
              </div>
            )}

            <input
              placeholder="来源（可选，如 超市/电商）"
              value={pSource}
              onChange={(e) => setPSource(e.target.value)}
              className="w-full h-9 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-3 outline-none focus:border-white/40"
            />

            <button
              onClick={handleAddPrice}
              className="w-full py-2 rounded-lg bg-emerald-500/80 hover:bg-emerald-500 text-white text-sm"
            >
              添加{PRICE_TYPES[priceKind].label}价格
            </button>
          </div>
        </>
      )}

      {/* 搜索 / 筛选 / 导入导出（随 Tab 生效） */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
          <input
            type="text"
            placeholder="搜索备注 / 分类 / 商品 / 店铺 / 订单号 / 报价…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-9 pl-10 pr-3 rounded-lg bg-white/10 border border-white/20 text-white text-sm outline-none focus:border-white/40"
          />
        </div>
        <div className="flex gap-1">
          <button
            onClick={handleImportClick}
            className="px-2.5 py-1.5 rounded-lg text-xs flex items-center gap-1 bg-white/5 text-white/70 hover:bg-white/15 hover:text-white"
            title="粘贴 JSON 导入（Ctrl+V 也可）"
          >
            <FileUp className="w-3.5 h-3.5" /> 导入
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-8 h-8 rounded-lg text-xs bg-white/5 text-white/50 hover:bg-white/10 hover:text-white flex items-center justify-center"
            title="选择本地 JSON 文件"
          >
            <FileUp className="w-4 h-4 opacity-70" />
          </button>
          <button
            onClick={handleExport}
            className="px-2.5 py-1.5 rounded-lg text-xs bg-white/5 text-white/60 hover:bg-white/10 flex items-center gap-1"
          >
            <FileDown className="w-3.5 h-3.5" /> 导出
          </button>
          <button
            onClick={() => setShowFormatHelp((v) => !v)}
            className="w-8 h-8 rounded-lg text-xs bg-white/5 text-white/50 hover:bg-white/10 flex items-center justify-center"
            title="AI 提示词 / JSON 格式说明"
          >
            <HelpCircle className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Hidden file input — triggered programmatically */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json,.txt"
        className="hidden"
        onChange={handleImportFile}
      />

      {showFormatHelp && (
        <div className="rounded-xl bg-black/30 border border-white/10 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-white/80">🎯 让 AI 生成 JSON（自动识别类型）</h3>
            <button
              onClick={() => setShowFormatHelp(false)}
              className="text-white/40 hover:text-white/70 text-xs"
            >
              ✕
            </button>
          </div>
          <p className="text-[11px] text-white/50 leading-relaxed">
            复制下面的提示词粘贴到 AI（ChatGPT / Claude / 豆包 等），把你的流水或价格描述替换掉占位符，AI 会输出 JSON。
            回来点「导入」或直接 Ctrl+V 粘贴，系统自动识别每条是记账记录还是价格记录，支持混合数组。
          </p>

          <div className="rounded-lg bg-white/5 border border-white/10">
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
              <span className="text-xs text-white/70 font-medium">📋 统一提示词（复制即用）</span>
              <button
                onClick={copyPrompt}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-white/10 hover:bg-white/20 text-white/80 transition-colors"
              >
                {copiedPrompt ? (
                  <><Check className="w-3 h-3 text-emerald-400" /> 已复制</>
                ) : (
                  <><Copy className="w-3 h-3" /> 复制</>
                )}
              </button>
            </div>
            <pre className="p-3 text-[10.5px] leading-relaxed text-white/55 whitespace-pre-wrap max-h-80 overflow-y-auto font-mono">
{AI_PROMPT_TEMPLATE}
            </pre>
          </div>

          <div className="rounded-lg bg-white/[0.03] border border-white/10 p-3 text-[11px] text-white/50 leading-relaxed">
            {FORMAT_NOTE}
          </div>
        </div>
      )}

      {importError && (
        <div className="rounded-lg bg-red-500/15 border border-red-400/30 text-red-200 text-sm px-3 py-2">
          {importError}
        </div>
      )}

      {/* 列表（统一时间线：流水 / 订单 / 报价 同列）+ 分页 */}
      <div className="rounded-xl bg-white/5 border border-white/10 divide-y divide-white/5">
        {visibleRecords.length === 0 && (
          <p className="text-center text-white/40 py-8 text-sm">
            {records.length === 0
              ? '还没有记录，去上方添加吧'
              : viewFilter === 'price'
                ? '这个筛选下没有报价记录'
                : '没有匹配的记录'}
          </p>
        )}
        {pagedRecords.map((r) => (
          <RecordRow
            key={r.id}
            r={r}
            onDelete={r.type === 'price' ? handleDeletePrice : handleDeleteTx}
          />
        ))}
      </div>

      {/* 分页器：所有筛选 Tab 通用，支持翻页 + 动态加载（加载更多） */}
      {totalCount > 0 && (
        <div className="flex flex-col items-center gap-3 pt-1">
          <div className="text-xs text-white/40">
            共 {totalCount} 条 · 第 {safePage} / {totalPages} 页
          </div>
          <div className="flex items-center gap-1 flex-wrap justify-center">
            <button
              onClick={() => setPage((p) => Math.max(1, Math.min(totalPages, p - 1)))}
              disabled={safePage <= 1}
              className="px-3 py-1.5 rounded-lg text-sm bg-white/5 text-white/70 hover:bg-white/15 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              上一页
            </button>
            {buildPages(safePage, totalPages).map((p, i) =>
              p === '...' ? (
                <span key={`e${i}`} className="px-1.5 text-white/30 text-sm select-none">
                  …
                </span>
              ) : (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  className={`w-9 h-9 rounded-lg text-sm transition-colors ${
                    p === safePage ? 'bg-white/25 text-white' : 'bg-white/5 text-white/60 hover:bg-white/15'
                  }`}
                >
                  {p}
                </button>
              ),
            )}
            <button
              onClick={() => setPage((p) => Math.min(totalPages, Math.max(1, p + 1)))}
              disabled={safePage >= totalPages}
              className="px-3 py-1.5 rounded-lg text-sm bg-white/5 text-white/70 hover:bg-white/15 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              下一页
            </button>
          </div>
          {safePage < totalPages && (
            <button
              onClick={() => setPage((p) => Math.min(totalPages, Math.max(1, p + 1)))}
              className="px-4 py-1.5 rounded-lg text-xs bg-white/10 text-white/70 hover:bg-white/20"
            >
              加载更多（已显示 {Math.min(pageStart + PAGE_SIZE, totalCount)} / {totalCount}）
            </button>
          )}
        </div>
      )}

      {/* 导入预览弹窗 */}
      {importPreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={() => setImportPreview(null)}
        >
          <div
            className="w-full max-w-sm rounded-xl bg-zinc-900 border border-white/15 p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-white font-medium">导入预览</h3>
            <p className="text-sm text-white/70">
              {importPreview.txs.length + importPreview.orders.length > 0 && (
                <><span className="text-emerald-300 font-medium">{importPreview.txs.length + importPreview.orders.length}</span> 条记录 </>
              )}
              {importPreview.prices.length > 0 && (
                <><span className="text-emerald-300 font-medium">{importPreview.prices.length}</span> 条价格 </>
              )}
              {importPreview.skipped > 0 && (
                <span className="text-rose-300">（跳过 {importPreview.skipped} 条无效）</span>
              )}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setImportMode('merge')}
                className={`flex-1 py-2 rounded-lg text-sm ${
                  importMode === 'merge'
                    ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-400/30'
                    : 'bg-white/5 text-white/50 border border-white/10'
                }`}
              >
                合并到现有
              </button>
              <button
                onClick={() => setImportMode('replace')}
                className={`flex-1 py-2 rounded-lg text-sm ${
                  importMode === 'replace'
                    ? 'bg-rose-500/25 text-rose-200 border border-rose-400/30'
                    : 'bg-white/5 text-white/50 border border-white/10'
                }`}
              >
                替换全部
              </button>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setImportPreview(null)}
                className="flex-1 py-2 rounded-lg text-sm bg-white/5 text-white/60 border border-white/10"
              >
                取消
              </button>
              <button
                onClick={confirmImport}
                className="flex-1 py-2 rounded-lg text-sm bg-emerald-500/80 hover:bg-emerald-500 text-white"
              >
                确认导入
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 粘贴反馈 Toast */}
      {toast && (
        <div
          className={`fixed top-4 left-1/2 -translate-x-1/2 z-[60] px-4 py-2 rounded-lg text-sm shadow-lg backdrop-blur-sm border transition-all duration-200 ${
            toast.kind === 'ok'
              ? 'bg-emerald-500/20 border-emerald-400/30 text-emerald-100'
              : 'bg-rose-500/20 border-rose-400/30 text-rose-100'
          }`}
        >
          {toast.text}
        </div>
      )}

    </div>
  )
}

function SummaryCard({
  label,
  value,
  accent,
  icon,
}: {
  label: string
  value: number
  accent: string
  icon: React.ReactNode
}) {
  return (
    <div className="rounded-xl bg-white/5 border border-white/10 p-3">
      <div className="flex items-center gap-1 text-white/40 text-xs mb-1">
        {icon}
        {label}
      </div>
      <div className={`text-lg font-semibold ${accent}`}>{value.toFixed(2)}</div>
    </div>
  )
}
