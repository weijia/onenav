// 目录清单的本机缓存：让文件浏览器刷新后先画出上次读到的内容，不必空等同步组连接。
//
// 只缓存「读取层拼装好的原始清单」(RawManifest[])，与远端结构无关：
// 连接就绪后照常读远端并覆盖缓存；读失败时继续显示缓存，并提示同步组未连。
// 用 IndexedDB（配额比 localStorage 大得多，清单树可能几 MB）。

const DB_NAME = 'onenav-filebrowser'
const STORE_NAME = 'kv'
const CACHE_KEY = 'struct-raws-v1'
/** 超过这个体积就不写缓存（避免把超大清单塞进浏览器存储，拖慢页面） */
const MAX_CACHE_BYTES = 16 * 1024 * 1024

interface CacheRecord {
  at: number
  raws: unknown[]
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

/** 读上次写入的清单缓存；没有/不可用时返回 null（不抛错）。 */
export async function readManifestCache(): Promise<CacheRecord | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const req = store.get(CACHE_KEY)
      req.onsuccess = () => {
        const value = req.result as CacheRecord | undefined
        if (!value || !Array.isArray(value.raws) || typeof value.at !== 'number') {
          resolve(null)
          return
        }
        resolve({ at: value.at, raws: value.raws })
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

/**
 * 写清单缓存（读取成功后调用）。
 * 体积超限时放弃写并返回 false；返回 true 表示已写入。
 */
export async function writeManifestCache(raws: unknown[]): Promise<boolean> {
  if (!Array.isArray(raws) || !raws.length) return false
  let size = 0
  try {
    size = JSON.stringify(raws).length
  } catch {
    return false
  }
  if (size > MAX_CACHE_BYTES) return false
  const db = await openDb()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put({ at: Date.now(), raws } as CacheRecord, CACHE_KEY)
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

/** 清掉缓存（例如用户在设置里重置同步组时）。 */
export async function clearManifestCache(): Promise<void> {
  const db = await openDb()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(CACHE_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
  db.close()
}
