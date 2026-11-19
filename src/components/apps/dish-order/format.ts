/**
 * 点菜助手的数据格式：类型定义、归一化、校验、按月分片路径、示例与 AI 提示词。
 *
 * 设计要点：
 *  - 一条记录 = 一次就餐（restaurant/date/meal 等），items 为菜品数组；
 *  - 价格全部可选（price / total 可为 null），照片识别不到就不要编造；
 *  - 「导入格式」宽松（缺省字段自动补），「存储格式」严格（归一化后写盘）；
 *  - AI 提示词与示例、校验共用本模块的定义，避免格式改了提示词没跟上。
 */

// ───────────────────────────────────────────────────────────
// 类型
// ───────────────────────────────────────────────────────────

/** 单道菜 */
export interface DishItem {
  name: string
  qty: number
  unit?: string
  price: number | null
  note?: string
}

/** 一条点菜记录（存储/展示格式，字段完整） */
export interface DishOrder {
  /** 去重 id：稳定生成（date + 内容哈希）或 AI 给定 */
  id: string
  /** YYYY-MM-DD */
  date: string
  /** 早餐 / 午餐 / 晚餐 / 夜宵 等，自由文本 */
  meal?: string
  restaurant?: string
  people?: number
  items: DishItem[]
  /** 小票/账单总额；识别不到为 null */
  total: number | null
  note?: string
  /** 来源：photo-agent（照片 Agent）/ manual（手填）/ import（粘贴或文件导入） */
  source?: DishOrderSource
  createdAt: number
}

export type DishOrderSource = 'photo-agent' | 'manual' | 'import'

/** 导入时允许缺省的宽松菜品形态 */
export interface RawDishItem {
  name?: unknown
  qty?: unknown
  unit?: unknown
  price?: unknown
  note?: unknown
}

/** 导入时允许缺省的宽松记录形态 */
export interface RawDishOrder {
  id?: unknown
  date?: unknown
  meal?: unknown
  restaurant?: unknown
  people?: unknown
  items?: unknown
  total?: unknown
  note?: unknown
  source?: unknown
}

export interface NormalizeOk {
  ok: true
  order: DishOrder
  /** 归一化过程中的温和提示（如价格缺失），不影响入库 */
  warnings: string[]
}
export interface NormalizeErr {
  ok: false
  /** 面向用户的错误原因 */
  error: string
}
export type NormalizeResult = NormalizeOk | NormalizeErr

// ───────────────────────────────────────────────────────────
// 校验 / 归一化辅助
// ───────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function todayStr(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const s = v.trim()
    return s ? s : undefined
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return undefined
}

/** 价格/金额：接受 number 或纯数字字符串；null / 空 / 非数字 → null（不编造） */
function asPrice(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[¥￥,，\s]/g, '')) : NaN
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100) / 100
}

/** 数量：缺省 1；非正数/非法 → 1 */
function asQty(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) / 1000 : 1
}

function asPeople(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
}

function stableHash(s: string): string {
  // FNV-1a 32bit → 8 位十六进制，作为去重 id 的后缀，足够点到菜记录量级
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

const SOURCES: DishOrderSource[] = ['photo-agent', 'manual', 'import']

function asSource(v: unknown): DishOrderSource {
  return typeof v === 'string' && SOURCES.includes(v as DishOrderSource)
    ? (v as DishOrderSource)
    : 'import'
}

// ───────────────────────────────────────────────────────────
// 归一化（导入格式 → 存储格式）
// ───────────────────────────────────────────────────────────

/**
 * 把一条宽松记录归一化为 DishOrder。
 *  - date 缺失用今天；格式非法直接报错（避免按月分片路径错乱）；
 *  - items 必须是非空数组且每项有 name，否则报错；
 *  - price/total 缺失记 null，不编造；
 *  - id 缺失或非法时，用 date + 内容生成稳定 id（同一批重复导入可去重）。
 */
export function normalizeOrder(raw: unknown, now = Date.now()): NormalizeResult {
  if (!isObject(raw)) return { ok: false, error: '记录不是 JSON 对象' }
  const r = raw as RawDishOrder

  let date = asString(r.date) ?? todayStr()
  if (!DATE_RE.test(date)) {
    return { ok: false, error: `日期格式无效（应为 YYYY-MM-DD）：${date}` }
  }
  // 校验真实日历日期（如 2026-02-30 应拒绝）
  const [yy, mm, dd] = date.split('-').map(Number)
  const probe = new Date(Date.UTC(yy, mm - 1, dd))
  if (probe.getUTCFullYear() !== yy || probe.getUTCMonth() !== mm - 1 || probe.getUTCDate() !== dd) {
    return { ok: false, error: `日期不存在：${date}` }
  }

  if (!Array.isArray(r.items) || r.items.length === 0) {
    return { ok: false, error: '缺少菜品列表 items（至少 1 项）' }
  }

  const warnings: string[] = []
  const items: DishItem[] = []
  for (let i = 0; i < r.items.length; i++) {
    const ri = r.items[i]
    if (!isObject(ri)) return { ok: false, error: `第 ${i + 1} 道菜不是对象` }
    const name = asString((ri as RawDishItem).name)
    if (!name) return { ok: false, error: `第 ${i + 1} 道菜缺少名称 name` }
    const price = asPrice((ri as RawDishItem).price)
    if (price === null) warnings.push(`「${name}」无价格`)
    const item: DishItem = {
      name,
      qty: asQty((ri as RawDishItem).qty),
      price,
    }
    const unit = asString((ri as RawDishItem).unit)
    if (unit) item.unit = unit
    const note = asString((ri as RawDishItem).note)
    if (note) item.note = note
    items.push(item)
  }

  const total = asPrice(r.total)
  const order: DishOrder = {
    id: '',
    date,
    items,
    total,
    source: asSource(r.source),
    createdAt: now,
  }
  const meal = asString(r.meal)
  if (meal) order.meal = meal
  const restaurant = asString(r.restaurant)
  if (restaurant) order.restaurant = restaurant
  const people = asPeople(r.people)
  if (people !== undefined) order.people = people
  const note = asString(r.note)
  if (note) order.note = note

  const givenId = asString(r.id)
  // 只用 AI/来源给定的 id 时，清洗为安全字符；缺失则按内容生成稳定 id。
  const contentKey = JSON.stringify({
    date: order.date,
    restaurant: order.restaurant ?? '',
    meal: order.meal ?? '',
    items: items.map((it) => [it.name, it.qty, it.price]),
  })
  order.id = givenId ? `${sanitizeKey(givenId)}-${stableHash(contentKey).slice(0, 4)}` : `${date}-${stableHash(contentKey)}`

  return { ok: true, order, warnings }
}

/** 去掉 AI 常输出的 Markdown 代码围栏（```json ... ```），即使提示词已要求不要输出 */
function stripCodeFence(text: string): string {
  let s = text.trim()
  // 去掉首尾成对的围栏（允许 ```json / ```JSON / ``` 后跟换行）
  s = s.replace(/^\s*```(?:json|JSON)?\s*\r?\n?/, '').replace(/\r?\n?```\s*$/, '')
  // 若 AI 在围栏外还写了零碎说明，尝试截取第一个 [ 或 { 到最后一个 ] 或 }
  if (!/^[\[{]/.test(s)) {
    const start = s.search(/[\[{]/)
    const end = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'))
    if (start >= 0 && end > start) s = s.slice(start, end + 1)
  }
  return s.trim()
}

/** 把粘贴/上传的内容解析为宽松对象数组（单对象、数组、换行分隔的多个 JSON、带代码围栏均支持） */
export function parseImportText(text: string): unknown[] {
  const trimmed = stripCodeFence(text)
  if (!trimmed) return []
  const tryParse = (s: string): unknown => JSON.parse(s)
  try {
    const v = tryParse(trimmed)
    return Array.isArray(v) ? v : [v]
  } catch {
    // 兼容「每行一个 JSON」的粘贴（AI 有时这样输出）
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim())
    if (lines.length > 1) {
      const out: unknown[] = []
      for (const line of lines) {
        try {
          out.push(tryParse(line))
        } catch {
          return [] // 交给调用方统一报「JSON 解析失败」
        }
      }
      return out
    }
    throw new Error('JSON 解析失败：请检查括号、引号是否完整')
  }
}

// ───────────────────────────────────────────────────────────
// 路径 / 分片
// ───────────────────────────────────────────────────────────

export const ORDERS_DIR = '/orders'

/** RemoteStorage / 文件名安全化（与 dir-struct-gen 的 sanitizeKey 同口径） */
export function sanitizeKey(s: string): string {
  return (s || '').replace(/[^A-Za-z0-9._-]/g, '_')
}

/** 记录所在月份路径：/orders/YYYY/MM */
export function orderMonthDir(dateOrOrder: string | DishOrder): string {
  const date = typeof dateOrOrder === 'string' ? dateOrOrder : dateOrOrder.date
  return `${ORDERS_DIR}/${date.slice(0, 4)}/${date.slice(5, 7)}`
}

/** 记录文件路径：/orders/YYYY/MM/<id>.json */
export function orderFilePath(order: DishOrder): string {
  return `${orderMonthDir(order)}/${sanitizeKey(order.id)}.json`
}

/** 从文件路径反解月份 key（YYYY-MM），失败返回 null */
export function monthKeyFromPath(path: string): string | null {
  const m = path.match(/^\/orders\/(\d{4})\/(\d{2})\//)
  return m ? `${m[1]}-${m[2]}` : null
}

/** 单行菜品小计：数量 × 单价；无价格返回 null */
export function itemSubtotal(item: DishItem): number | null {
  return item.price === null ? null : Math.round(item.price * item.qty * 100) / 100
}

/** 记录合计：优先用 total；否则累加有价格的菜品小计；无价格返回 null */
export function orderTotal(order: DishOrder): number | null {
  if (order.total !== null) return order.total
  const subs = order.items.map(itemSubtotal).filter((n): n is number => n !== null)
  return subs.length ? Math.round(subs.reduce((a, b) => a + b, 0) * 100) / 100 : null
}

// ───────────────────────────────────────────────────────────
// 示例与 AI 提示词（与上面校验口径一致，单一来源）
// ───────────────────────────────────────────────────────────

export const SAMPLE_ORDER: Record<string, unknown> = {
  date: '2026-11-19',
  meal: '晚餐',
  restaurant: '老地方家常菜',
  people: 3,
  items: [
    { name: '宫保鸡丁', qty: 1, unit: '份', price: 38, note: '微辣' },
    { name: '米饭', qty: 2, unit: '碗', price: 3 },
    { name: '酸辣汤', qty: 1, unit: '份', price: null },
  ],
  total: 44,
  note: '朋友聚餐',
}

/** 一键复制给多模态 AI Agent 的提示词：把点菜照片转成可直接导入的 JSON */
export const AI_PROMPT = `你是一个点菜记录识别助手。我会给你一张点菜照片（菜单、点单小票、手写点菜单或结账账单），请仔细识别其中的信息，并输出**严格符合下面格式的 JSON**，让点菜助手程序可以直接导入。

## 硬性要求
1. 只输出 JSON 本身，不要任何解释文字、不要 Markdown 代码块标记（不要 \`\`\`）。
2. 照片里看不清、没有提供的信息一律留空或填 null，**绝对不要猜测或编造**。
3. 一次就餐输出一个 JSON 对象；如果照片里有多张单子/多餐，输出对象数组 [...]。
4. 日期格式必须是 YYYY-MM-DD。照片没有日期时，用今天日期：${todayStr()}。
5. 菜名保持照片原样（不要翻译、不要改写、不要合并同类项）。
6. 价格识别到就填数字（不要带货币符号、不要加引号）；没识别到就填 null。
7. 数量 qty 是数字，默认 1；单位 unit 如"份/碗/盘/杯"，没有就不填。

## 字段说明
- date：就餐日期，YYYY-MM-DD（必填）。
- meal：餐次，如 早餐 / 午餐 / 晚餐 / 夜宵，没有就不填。
- restaurant：店名，没有就不填。
- people：就餐人数，数字，没有就不填。
- items：菜品数组，至少 1 项。每项：
  - name：菜名（必填）
  - qty：数量，数字，默认 1
  - unit：单位，可选
  - price：单价，数字或 null（识别不到填 null）
  - note：备注如"微辣/不要香菜"，可选
- total：账单总额，数字或 null（照片没有总额就填 null，不要用菜品价格相加去猜）。
- note：整单备注，可选。
- source：固定填 "photo-agent"。

## 输出示例（照着这个结构输出）
${JSON.stringify({ ...SAMPLE_ORDER, source: 'photo-agent' }, null, 2)}

现在请识别我提供的照片，按上面的格式输出 JSON。`
