/**
 * 设备监控的本机快照缓存。
 *
 * 目的：独立应用页现在「本地缓存优先、后端同步后台跑」。设备监控的数据每次都要从
 * RemoteStorage 的 ufs-nodes/ 目录现拉，网络/令牌未就绪时此前只能显示加载失败。
 * 这里把上次 normalize 后的结果（hosts / controlNodes）落到本机 IndexedDB：
 *   - 打开页面先画快照，标注「缓存 · 时间」；
 *   - 后端读到新数据后覆盖快照并去掉缓存标记；
 *   - 读取失败时继续显示快照，只在顶部提示，不整页报错。
 *
 * 注意：快照**不落敏感凭证**（mqtt 密码等 sensitive 字段在写入时清空），
 * 只缓存主机/磁盘概况用于离线浏览；敏感字段等后端读回后再展示。
 */
import type { ControlNodeView, HostView } from './types'

const DB_NAME = 'onenav-hostmonitor'
const STORE_NAME = 'kv'
const SNAPSHOT_KEY = 'ufs-nodes-snapshot-v1'
/** 超过这个体积就不写缓存（避免异常大的设备清单拖慢浏览器存储） */
const MAX_CACHE_BYTES = 8 * 1024 * 1024

export interface HostSnapshot {
  at: number
  hosts: HostView[]
  controlNodes: ControlNodeView[]
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

function isValidSnapshot(value: any): value is HostSnapshot {
  return (
    !!value &&
    typeof value.at === 'number' &&
    Array.isArray(value.hosts) &&
    Array.isArray(value.controlNodes)
  )
}

/** 读上次写入的设备快照；没有/不可用/形态不对时返回 null（不抛错）。 */
export async function readHostSnapshot(): Promise<HostSnapshot | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(SNAPSHOT_KEY)
      req.onsuccess = () => {
        const value = req.result
        resolve(isValidSnapshot(value) ? value : null)
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

/** 写设备快照；空数据/体积超限/不可用时返回 false（不抛错）。 */
export async function writeHostSnapshot(
  hosts: HostView[],
  controlNodes: ControlNodeView[],
): Promise<boolean> {
  if (!Array.isArray(hosts) || !Array.isArray(controlNodes)) return false
  if (hosts.length === 0 && controlNodes.length === 0) return false
  // 快照不落敏感凭证：缓存只用于离线浏览主机/磁盘概况；
  // mqtt 密码等敏感字段等后端读回后再展示，避免把凭证明文持久化进 IndexedDB。
  const value: HostSnapshot = {
    at: Date.now(),
    hosts: hosts.map((h) => ({ ...h, sensitive: [] })),
    controlNodes: controlNodes.map((n) => ({ ...n, sensitive: [] })),
  }
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
      tx.objectStore(STORE_NAME).put(value, SNAPSHOT_KEY)
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
