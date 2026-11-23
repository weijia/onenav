// 文件浏览器的本机缓存：让刷新后先画出上次读到的内容，不必空等同步组连接。
//
// 缓存两类东西，放同一个 IndexedDB 库的不同 key：
// - struct-raws-v1：读取层拼装好的目录清单（RawManifest[]，可能几 MB）；
// - host-disks-doc-v1：主机磁盘文档（host / 磁盘 / 分区 / 卷，几十 KB）。
// 连接就绪后照常读远端并覆盖缓存；读失败时继续显示缓存，并提示同步组未连。

const DB_NAME = 'onenav-filebrowser'
const STORE_NAME = 'kv'
const CACHE_KEY = 'struct-raws-v1'
const HOST_DISKS_KEY = 'host-disks-doc-v1'
/** 超过这个体积就不写缓存（避免把超大清单塞进浏览器存储，拖慢页面） */
const MAX_CACHE_BYTES = 16 * 1024 * 1024

interface CacheEnvelope {
  at: number
  [field: string]: unknown
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

/** 读一条缓存记录；没有/不可用/形态不对时返回 null（不抛错）。 */
async function readCached<T extends CacheEnvelope>(
  key: string,
  validate: (value: CacheEnvelope) => boolean,
): Promise<T | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(key)
      req.onsuccess = () => {
        const value = req.result as CacheEnvelope | undefined
        if (!value || typeof value.at !== 'number' || !validate(value)) {
          resolve(null)
          return
        }
        resolve(value as T)
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

/** 写一条缓存记录；体积超限/不可用时返回 false（不抛错）。 */
async function writeCached(key: string, value: CacheEnvelope): Promise<boolean> {
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
      tx.objectStore(STORE_NAME).put(value, key)
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

interface ManifestCacheRecord extends CacheEnvelope {
  raws: unknown[]
}

/** 读上次写入的清单缓存；没有/不可用时返回 null（不抛错）。 */
export async function readManifestCache(): Promise<{ at: number; raws: unknown[] } | null> {
  const rec = await readCached<ManifestCacheRecord>(CACHE_KEY, (v) => Array.isArray(v.raws))
  return rec ? { at: rec.at, raws: rec.raws } : null
}

/**
 * 写清单缓存（读取成功后调用）。
 * 体积超限时放弃写并返回 false；返回 true 表示已写入。
 */
export async function writeManifestCache(raws: unknown[]): Promise<boolean> {
  if (!Array.isArray(raws) || !raws.length) return false
  return writeCached(CACHE_KEY, { at: Date.now(), raws })
}

interface HostDisksCacheRecord extends CacheEnvelope {
  doc: unknown
}

/** 读上次写入的主机磁盘文档；没有/不可用时返回 null。 */
export async function readHostDisksCache(): Promise<{ at: number; doc: Record<string, unknown> } | null> {
  const rec = await readCached<HostDisksCacheRecord>(
    HOST_DISKS_KEY,
    (v) => !!v.doc && typeof v.doc === 'object' && !Array.isArray(v.doc),
  )
  return rec ? { at: rec.at, doc: rec.doc as Record<string, unknown> } : null
}

/** 写主机磁盘文档缓存（读取成功后调用）。 */
export async function writeHostDisksCache(doc: Record<string, unknown>): Promise<boolean> {
  if (!doc || typeof doc !== 'object') return false
  return writeCached(HOST_DISKS_KEY, { at: Date.now(), doc })
}

/** 清掉缓存（例如用户在设置里重置同步组时）。 */
export async function clearManifestCache(): Promise<void> {
  const db = await openDb()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(CACHE_KEY)
      tx.objectStore(STORE_NAME).delete(HOST_DISKS_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
  db.close()
}
