import PouchDB from 'pouchdb-browser/lib/index-browser.js'

const DB_NAME = 'onenav'
let db: PouchDB.Database | null = null

function getDb(): PouchDB.Database {
  if (!db) {
    db = new PouchDB(DB_NAME)
  }
  return db
}

// 通用：写入或更新文档（upsert）
async function upsertDoc(doc: any): Promise<void> {
  try {
    const database = getDb()
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
    const database = getDb()
    const doc = await database.get(id)
    return doc as unknown as T
  } catch {
    return null
  }
}

// ==================== WebDAV 配置 ====================

interface WebDAVConfigDoc {
  _id: string
  type: 'webdav-config'
  url: string
  username: string
  password: string
  updatedAt: number
}

export async function saveWebDAVConfigToPouch(config: { url: string; username: string; password: string }): Promise<void> {
  await upsertDoc({
    _id: 'config:webdav',
    type: 'webdav-config',
    ...config,
    updatedAt: Date.now(),
  } as WebDAVConfigDoc)
}

export async function loadWebDAVConfigFromPouch(): Promise<{ url: string; username: string; password: string } | null> {
  const doc = await getDoc<WebDAVConfigDoc>('config:webdav')
  if (!doc) return null
  return { url: doc.url, username: doc.username, password: doc.password }
}

// ==================== 应用配置 ====================

interface AppConfigDoc {
  _id: string
  type: 'app-config'
  [key: string]: any
  updatedAt: number
}

export async function saveAppConfigToPouch(config: any): Promise<void> {
  await upsertDoc({
    _id: 'config:app',
    type: 'app-config',
    ...config,
    updatedAt: Date.now(),
  } as AppConfigDoc)
}

export async function loadAppConfigFromPouch(): Promise<any | null> {
  return getDoc<AppConfigDoc>('config:app')
}

// ==================== 书签数据 ====================

interface BookmarksDoc {
  _id: string
  type: 'bookmarks'
  data: Record<string, any>
  meta: any
  updatedAt: number
}

export async function saveBookmarksToPouch(store: { data: Record<string, any>; meta: any }): Promise<void> {
  await upsertDoc({
    _id: 'data:bookmarks',
    type: 'bookmarks',
    data: store.data,
    meta: store.meta,
    updatedAt: Date.now(),
  } as BookmarksDoc)
}

export async function loadBookmarksFromPouch(): Promise<{ data: Record<string, any>; meta: any } | null> {
  const doc = await getDoc<BookmarksDoc>('data:bookmarks')
  if (!doc) return null
  return { data: doc.data, meta: doc.meta }
}

// ==================== 点击统计 ====================

interface ClickStatsDoc {
  _id: string
  type: 'click-stats'
  version: number
  records: Record<string, any>
  updatedAt: number
}

export async function saveClickStatsToPouch(stats: { version: number; records: Record<string, any> }): Promise<void> {
  await upsertDoc({
    _id: 'stats:clicks',
    type: 'click-stats',
    version: stats.version,
    records: stats.records,
    updatedAt: Date.now(),
  } as ClickStatsDoc)
}

export async function loadClickStatsFromPouch(): Promise<{ version: number; records: Record<string, any> } | null> {
  const doc = await getDoc<ClickStatsDoc>('stats:clicks')
  if (!doc) return null
  return { version: doc.version, records: doc.records }
}

// ==================== 固定书签 ====================

interface PinnedDoc {
  _id: string
  type: 'pinned'
  urls: string[]
  updatedAt: number
}

export async function savePinnedToPouch(urls: string[]): Promise<void> {
  await upsertDoc({
    _id: 'config:pinned',
    type: 'pinned',
    urls,
    updatedAt: Date.now(),
  } as PinnedDoc)
}

export async function loadPinnedFromPouch(): Promise<string[] | null> {
  const doc = await getDoc<PinnedDoc>('config:pinned')
  if (!doc) return null
  return doc.urls
}
