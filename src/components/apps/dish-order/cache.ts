/**
 * 点菜助手的本机快照缓存。
 *
 * 目的：独立应用页改为「本地缓存先打开、后端同步后台跑」。点菜记录存在 zen-fs-config
 * 数据组里，数据组连接（含 config 仓连接 + 首轮 flush）常要十几秒，此前这段时间只能显示
 * 「尚未连接数据同步组」。这里把上次读到的记录按月份落到本机 IndexedDB：
 *   - 打开页面先画快照（标注「缓存 · 时间」）；
 *   - 数据组就绪后读实时数据并覆盖快照；
 *   - 未连接/读取失败时继续显示快照，只提示，不整页清空。
 *
 * 缓存按「月份筛选」分开存：month='all' 表示全部月份；读取时只在 month 与当前筛选一致时命中，
 * 避免把「某个月的子集」当成全量数据画出来。
 */
import type { DishOrder } from './format'

const DB_NAME = 'onenav-dish-order'
const STORE_NAME = 'kv'
const SNAPSHOT_PREFIX = 'orders-v1:'
/** 超过这个体积就不写缓存（避免异常大的记录集拖慢浏览器存储） */
const MAX_CACHE_BYTES = 16 * 1024 * 1024

export interface DishOrdersSnapshot {
  at: number
  /** 该快照对应的月份筛选：'all' 或 'YYYY-MM' */
  month: string
  orders: DishOrder[]
  months: string[]
}

function hasIdb(): boolean {
  return typeof indexedDB !== 'undefined'
}

function openDb(): Promise<IDBDatabase | null> {
  if (!hasIdb()) return Promise.resolve(null)
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, 1)
    } catch {
      resolve(null)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
}

function keyOf(month: string): string {
  return `${SNAPSHOT_PREFIX}${month || 'all'}`
}

function isValidSnapshot(value: any, month: string): value is DishOrdersSnapshot {
  return (
    !!value &&
    typeof value.at === 'number' &&
    value.month === month &&
    Array.isArray(value.orders) &&
    Array.isArray(value.months)
  )
}

/** 读指定月份筛选的上次快照；没有/不可用/形态不对时返回 null（不抛错）。 */
export async function readOrdersSnapshot(month: string): Promise<DishOrdersSnapshot | null> {
  const m = month || 'all'
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(keyOf(m))
      req.onsuccess = () => {
        const value = req.result
        resolve(isValidSnapshot(value, m) ? value : null)
      }
      req.onerror = () => resolve(null)
      tx.oncomplete = () => db.close()
      tx.onerror = () => {
        db.close()
        resolve(null)
      }
    } catch {
      db.close()
      resolve(null)
    }
  })
}

/** 写指定月份筛选的快照；空记录/体积超限/不可用时返回 false（不抛错）。 */
export async function writeOrdersSnapshot(
  month: string,
  orders: DishOrder[],
  months: string[],
): Promise<boolean> {
  if (!Array.isArray(orders) || !Array.isArray(months)) return false
  if (orders.length === 0) return false
  const m = month || 'all'
  const value: DishOrdersSnapshot = { at: Date.now(), month: m, orders, months }
  let size = 0
  try {
    size = JSON.stringify(value).length
  } catch {
    return false
  }
  if (size > MAX_CACHE_BYTES) return false

  const db = await openDb()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(value, keyOf(m))
      tx.oncomplete = () => {
        db.close()
        resolve(true)
      }
      tx.onerror = () => {
        db.close()
        resolve(false)
      }
    } catch {
      db.close()
      resolve(false)
    }
  })
}
