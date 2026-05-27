const DB_NAME = 'onenav'
let db: any = null

async function getDb(): Promise<any> {
  if (!db) {
    const PouchDB = (await import('pouchdb-browser')).default
    db = new PouchDB(DB_NAME)
  }
  return db
}

/**
 * 获取 PouchDB 实例（用于同步）
 */
export async function getPouchDB(): Promise<PouchDB.Database> {
  return getDb()
}

// 通用：写入或更新文档（upsert）
async function upsertDoc(doc: any): Promise<void> {
  try {
    const database = await getDb()
    const existing = await database.get(doc._id).catch(() => null)
    if (existing) {
      await database.put({ ...doc, _rev: existing._rev })
    } else {
      await database.put(doc)
    }
  } catch (err) {
    console.error('[PouchDB] upsertDoc error:', doc._id, err)
  }
}

// 通用：读取文档
async function getDoc<T>(id: string): Promise<T | null> {
  try {
    const database = await getDb()
    const doc = await database.get(id)
    return doc as unknown as T
  } catch {
    return null
  }
}

// ==================== WebDAV 配置 ====================

export async function saveWebDAVConfigToPouch(config: { url: string; username: string; password: string }): Promise<void> {
  await upsertDoc({
    _id: 'config:webdav',
    type: 'webdav-config',
    ...config,
    updatedAt: Date.now(),
  })
}

export async function loadWebDAVConfigFromPouch(): Promise<{ url: string; username: string; password: string } | null> {
  const doc = await getDoc<any>('config:webdav')
  if (!doc) return null
  return { url: doc.url, username: doc.username, password: doc.password }
}

// ==================== 应用配置 ====================

export async function saveAppConfigToPouch(config: any): Promise<void> {
  await upsertDoc({
    _id: 'config:app',
    type: 'app-config',
    ...config,
    updatedAt: Date.now(),
  })
}

export async function loadAppConfigFromPouch(): Promise<any | null> {
  return getDoc<any>('config:app')
}

// ==================== 书签数据 ====================

export async function saveBookmarksToPouch(store: { data: Record<string, any>; meta: any }): Promise<void> {
  await upsertDoc({
    _id: 'data:bookmarks',
    type: 'bookmarks',
    data: store.data,
    meta: store.meta,
    updatedAt: Date.now(),
  })
}

export async function loadBookmarksFromPouch(): Promise<{ data: Record<string, any>; meta: any } | null> {
  const doc = await getDoc<any>('data:bookmarks')
  if (!doc) return null
  return { data: doc.data, meta: doc.meta }
}

// ==================== 点击统计 ====================

export async function saveClickStatsToPouch(stats: { version: number; records: Record<string, any> }): Promise<void> {
  await upsertDoc({
    _id: 'stats:clicks',
    type: 'click-stats',
    version: stats.version,
    records: stats.records,
    updatedAt: Date.now(),
  })
}

export async function loadClickStatsFromPouch(): Promise<{ version: number; records: Record<string, any> } | null> {
  const doc = await getDoc<any>('stats:clicks')
  if (!doc) return null
  return { version: doc.version, records: doc.records }
}

// ==================== 固定书签 ====================

export async function savePinnedToPouch(urls: string[]): Promise<void> {
  await upsertDoc({
    _id: 'config:pinned',
    type: 'pinned',
    urls,
    updatedAt: Date.now(),
  })
}

export async function loadPinnedFromPouch(): Promise<string[] | null> {
  const doc = await getDoc<any>('config:pinned')
  if (!doc) return null
  return doc.urls
}
