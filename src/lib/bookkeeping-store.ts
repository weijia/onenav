/**
 * 记账数据存储层（统一 type 模型 + 每条记录一个独立 PouchDB 文档）
 *
 * 设计目标（详见 docs/bookkeeping-data-model.md）：
 *  - 所有记账数据（流水 / 价格 / 电商订单）用顶层 `type` 字段区分，存为判别联合 BookkeepingRecord。
 *  - 每条记录一个独立 PouchDB 文档，ID 前缀 `bk:<type>:<id>`，避免单文档体积问题（导入 2290 条订单也不膨胀）。
 *  - 对齐 pouchdb-design.md 的"每条数据独立文档"原则（新增 `bk:` 前缀）。
 *  - 旧的单文档 `app:bookkeeping`（{ transactions, prices }）在首次加载时自动迁移为 `bk:` 多文档。
 *  - 同步：RemoteStorage 整库同步自动覆盖 bk: 文档；WebDAV 兜底聚合为 app_data/onenav/apps/bookkeeping-records.json。
 */
import { getPouchDB } from '@/lib/pouchdb'
import { loadWebDAVConfig } from '@/lib/config'
import { createDirectory, putFileContents, getFileContents } from '@/lib/webdav'
import { isRemoteStorageConfigured, scheduleAutoSync } from '@/lib/remotestorage-sync'

// ───────────────────────────────────────────────────────────
// 类型定义
// ───────────────────────────────────────────────────────────
export interface OrderItem {
  name: string
  spec: string | null
  price: number | null
  qty: number | null
  amount: number | null
}

export interface ComboItem {
  product: string
  unit?: string
  quantity?: number
  unitPrice?: number
}

export type PriceKind = 'item' | 'combo' | 'voucher'
export type BookkeepingType = 'tx' | 'price' | 'order'

interface BaseRecord {
  id: string
  type: BookkeepingType
  date: string // YYYY-MM-DD
  createdAt: number
  source?: string
}

/** 流水（收入 / 支出） */
export interface TxRecord extends BaseRecord {
  type: 'tx'
  direction: 'income' | 'expense'
  amount: number
  category: string
  note?: string
  product?: string
  quantity?: number
  unit?: string
  unitPrice?: number
  items?: OrderItem[]
  // 以下电商订单字段仅订单记录使用（普通流水恒为 undefined），放到此处仅为让 tx/order 共用渲染逻辑
  platform?: 'jd' | 'taobao'
  account?: string
  orderId?: string
  status?: string
  shop?: string
  payment?: string
}

/** 价格（单品 / 套餐 / 代金券） */
export type PriceRecord =
  | (BaseRecord & { kind: 'item'; product: string; unit: string; unitPrice: number })
  | (BaseRecord & { kind: 'combo'; name: string; unitPrice: number; items: ComboItem[] })
  | (BaseRecord & { kind: 'voucher'; name: string; cost: number; faceValue: number })

/** 电商订单（京东 / 淘宝） */
export interface OrderRecord extends BaseRecord {
  type: 'order'
  platform: 'jd' | 'taobao'
  account?: string
  orderId: string
  status?: string
  shop?: string
  payment?: string
  amount: number // 订单总额
  category?: string // 通常 '购物'
  note?: string
  product?: string
  quantity?: number
  unit?: string
  unitPrice?: number
  items?: OrderItem[]
}

export type BookkeepingRecord = TxRecord | PriceRecord | OrderRecord

/** 流水 / 订单的方向（订单一律视为支出） */
export function directionOf(r: TxRecord | OrderRecord): 'income' | 'expense' {
  return r.type === 'order' ? 'expense' : r.direction
}

// ───────────────────────────────────────────────────────────
// 存储实现
// ───────────────────────────────────────────────────────────
const BK_PREFIX = 'bk:'
const BK_END = BK_PREFIX + '￿' // U+FFFF 范围上界
const APPS_DIR = 'app_data/onenav/apps'
const WEBDAV_FILE = `${APPS_DIR}/bookkeeping-records.json`

function randId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function bkId(type: string, id: string): string {
  return `${BK_PREFIX}${type}:${id}`
}

function isBookkeepingDoc(d: any): d is Record<string, unknown> {
  return !!d && typeof d._id === 'string' && d._id.startsWith(BK_PREFIX) && !d.deleted
}

/** 从 PouchDB doc 还原为记录（剥离 _id/_rev） */
function docToRecord(d: any): BookkeepingRecord {
  const { _id, _rev, ...rec } = d
  return rec as BookkeepingRecord
}

async function readAllRecords(db: any): Promise<BookkeepingRecord[]> {
  const res = await db.allDocs({ startkey: BK_PREFIX, endkey: BK_END, include_docs: true })
  return res.rows.map((r: any) => r.doc).filter(isBookkeepingDoc).map(docToRecord)
}

/**
 * 迁移旧单文档 app:bookkeeping（{ transactions, prices }）→ bk: 多文档。
 * 幂等：无旧文档则直接返回。
 */
async function migrateLegacy(db: any): Promise<void> {
  const legacy = await db.get('app:bookkeeping').catch(() => null)
  if (!legacy || !legacy.data) return
  const data = legacy.data as { transactions?: any[]; prices?: any[] }
  const txs = Array.isArray(data.transactions) ? data.transactions : []
  const prices = Array.isArray(data.prices) ? data.prices : []
  const out: BookkeepingRecord[] = []

  for (const t of txs) {
    if (t && (t.platform === 'jd' || t.platform === 'taobao') && t.order_id) {
      // 电商订单 → OrderRecord
      out.push({
        type: 'order',
        id: t.id || randId(),
        platform: t.platform,
        account: t.account,
        orderId: t.order_id,
        status: t.status,
        shop: t.shop,
        payment: t.payment,
        amount: Number(t.amount) || 0,
        date: t.date || '',
        createdAt: Number(t.createdAt) || Date.now(),
        category: t.category,
        note: t.note,
        product: t.product,
        items: t.items,
      })
    } else {
      // 普通流水 → TxRecord
      out.push({
        type: 'tx',
        id: t.id || randId(),
        direction: t.type === 'income' ? 'income' : 'expense',
        amount: Number(t.amount) || 0,
        category: t.category || '其他',
        note: t.note,
        date: t.date || '',
        createdAt: Number(t.createdAt) || Date.now(),
        product: t.product,
        quantity: t.quantity,
        unit: t.unit,
        unitPrice: t.unitPrice,
      })
    }
  }

  for (const p of prices) {
    if (!p || typeof p !== 'object') continue
    out.push({ ...p, type: 'price' } as PriceRecord)
  }

  if (out.length) {
    await db.bulkDocs(out.map((r) => ({ _id: bkId(r.type, r.id), ...r })))
  }
  await db.remove(legacy).catch(() => null)
}

/** 写后同步：WebDAV 聚合兜底 + RemoteStorage 整库同步（均为最佳努力） */
async function afterWrite(db: any): Promise<void> {
  const wdav = loadWebDAVConfig()
  if (wdav) {
    try {
      const records = await readAllRecords(db)
      await createDirectory(wdav, 'app_data')
      await createDirectory(wdav, 'app_data/onenav')
      await createDirectory(wdav, APPS_DIR)
      await putFileContents(
        wdav,
        WEBDAV_FILE,
        JSON.stringify({ updatedAt: Date.now(), records }),
      )
    } catch (e) {
      console.error('[bookkeeping-store] WebDAV 写失败（已忽略）:', e)
    }
  }
  if (isRemoteStorageConfigured()) {
    try {
      await scheduleAutoSync(db)
    } catch (e) {
      console.error('[bookkeeping-store] RemoteStorage 同步失败（已忽略）:', e)
    }
  }
}

/** 加载全部记账记录（含旧文档迁移 + WebDAV 兜底） */
export async function loadAllRecords(): Promise<BookkeepingRecord[]> {
  const db = await getPouchDB()
  await migrateLegacy(db)
  let records = await readAllRecords(db)
  if (records.length === 0) {
    const wdav = loadWebDAVConfig()
    if (wdav) {
      try {
        const raw = await getFileContents(wdav, WEBDAV_FILE)
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed.records) && parsed.records.length) {
          records = parsed.records as BookkeepingRecord[]
          await db.bulkDocs(records.map((r) => ({ _id: bkId(r.type, r.id), ...r })))
        }
      } catch {
        // WebDAV 无数据或读取失败，忽略
      }
    }
  }
  return records
}

/** 批量写入记录（仅用于新增文档：调用方需保证这些是尚未入库的新记录） */
export async function putRecords(records: BookkeepingRecord[]): Promise<void> {
  if (!records.length) return
  const db = await getPouchDB()
  await db.bulkDocs(records.map((r) => ({ _id: bkId(r.type, r.id), ...r })))
  await afterWrite(db)
}

/** 删除单条记录（按 id + type 精确定位，软删除） */
export async function removeRecord(record: BookkeepingRecord): Promise<void> {
  const db = await getPouchDB()
  const doc = await db.get(bkId(record.type, record.id)).catch(() => null)
  if (doc) await db.remove(doc)
  await afterWrite(db)
}

/** 批量删除记录 */
export async function removeRecords(records: BookkeepingRecord[]): Promise<void> {
  if (!records.length) return
  const db = await getPouchDB()
  const docs = await Promise.all(records.map((r) => db.get(bkId(r.type, r.id)).catch(() => null)))
  const existing = docs.filter(Boolean)
  if (existing.length) {
    await db.bulkDocs(existing.map((d: any) => ({ _id: d._id, _rev: d._rev, _deleted: true })))
  }
  await afterWrite(db)
}
