import type { BookmarkEntry } from '@/types'
import { getEntryUpdatedAt } from '@/lib/bookmark-conflicts'

const DB_NAME = 'onenav'
let db: any = null
let dbNeedsReset = false

/**
 * 删除损坏的 PouchDB 数据库
 */
async function destroyAndRecreate(): Promise<any> {
  console.log('[PouchDB] 正在删除损坏的数据库...')
  try {
    if (db) {
      await db.destroy()
      db = null
    }
  } catch (e) {
    console.warn('[PouchDB] destroy 失败，尝试直接删除 IndexedDB:', e)
  }
  // 也直接删除 IndexedDB
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('_pouch_' + DB_NAME)
    req.onsuccess = () => console.log('[PouchDB] IndexedDB 删除成功')
    req.onerror = () => console.warn('[PouchDB] IndexedDB 删除失败')
    req.onblocked = () => console.warn('[PouchDB] IndexedDB 删除被阻塞')
    // 无论成功失败都 resolve
    req.addEventListener('success', () => resolve())
    req.addEventListener('error', () => resolve())
    req.addEventListener('blocked', () => resolve())
    setTimeout(resolve, 1000) // 最多等1秒
  })
  
  const PouchDB = (await import('pouchdb-browser')).default
  db = new PouchDB(DB_NAME)
  dbNeedsReset = false
  console.log('[PouchDB] 数据库重新创建完成')
  return db
}

async function getDb(): Promise<any> {
  if (dbNeedsReset || !db) {
    if (dbNeedsReset && db) {
      return destroyAndRecreate()
    }
    const PouchDB = (await import('pouchdb-browser')).default
    db = new PouchDB(DB_NAME)
    console.log('[PouchDB] 数据库初始化成功')
  }
  return db
}

/**
 * 包装 PouchDB 操作，遇到 IndexedDB 损坏错误时自动重置
 */
async function withAutoReset<T>(fn: (database: any) => Promise<T>): Promise<T> {
  const database = await getDb()
  try {
    return await fn(database)
  } catch (err: any) {
    const msg = err?.message || String(err)
    if (msg.includes('object store was not found') || 
        msg.includes('indexed_db_went_bad') ||
        msg.includes('specified object store') ||
        msg.includes('onupgradeneeded')) {
      console.error('[PouchDB] 检测到数据库损坏，自动重置:', msg)
      const newDb = await destroyAndRecreate()
      return await fn(newDb)
    }
    throw err
  }
}

/**
 * 获取 PouchDB 实例（用于同步）
 */
export async function getPouchDB(): Promise<PouchDB.Database> {
  return getDb()
}

// ==================== 文档 ID 前缀 ====================
export const PREFIX = {
  BOOKMARK: 'bm:',
  CLICK: 'clk:',
  CONFIG: 'cfg:',
  META: 'meta:',
} as const

// ==================== 书签（每条一个文档）====================

export interface BookmarkDoc {
  _id: string
  _rev?: string
  type: 'bookmark'
  url: string
  title: string
  tags: string[]
  description?: string
  icon?: string
  clicks: number
  lastClickedAt?: number
  createdAt: number
  updatedAt: number
  deleted?: boolean
}

export async function saveBookmark(bookmark: Omit<BookmarkDoc, '_id' | 'type'> & { url: string }): Promise<void> {
  const database = await getDb()
  const id = PREFIX.BOOKMARK + bookmark.url
  
  try {
    const existing = await database.get(id).catch(() => null)
    const doc: BookmarkDoc = {
      _id: id,
      type: 'bookmark',
      url: bookmark.url,
      title: bookmark.title,
      tags: bookmark.tags || [],
      description: bookmark.description,
      icon: bookmark.icon,
      clicks: bookmark.clicks || 0,
      lastClickedAt: bookmark.lastClickedAt,
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
      deleted: bookmark.deleted || false,
    }
    
    if (existing) {
      await database.put({ ...doc, _rev: existing._rev })
    } else {
      await database.put(doc)
    }
  } catch (err) {
    console.error('[PouchDB] saveBookmark error:', bookmark.url, err)
  }
}

export async function saveBookmarks(bookmarks: Array<Omit<BookmarkDoc, '_id' | 'type'>>): Promise<void> {
  console.log('[PouchDB] saveBookmarks: 开始保存', bookmarks.length, '条书签到 PouchDB')
  
  return withAutoReset(async (database) => {
    console.log('[PouchDB] saveBookmarks: 获取到数据库实例')
    const docs: BookmarkDoc[] = []
    
    for (const bm of bookmarks) {
      const id = PREFIX.BOOKMARK + bm.url
      let existing = null
      try {
        existing = await database.get(id)
      } catch (err: any) {
        if (err.status !== 404) {
          console.error('[PouchDB] saveBookmarks: 检查文档时出错:', err)
        }
      }
      
      docs.push({
        _id: id,
        type: 'bookmark',
        url: bm.url,
        title: bm.title,
        tags: bm.tags || [],
        description: bm.description,
        icon: bm.icon,
        clicks: bm.clicks || 0,
        lastClickedAt: bm.lastClickedAt,
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now(),
        deleted: bm.deleted || false,
      })
    }
    
    console.log('[PouchDB] saveBookmarks: 准备 bulkDocs，文档数量:', docs.length)
    await database.bulkDocs(docs)
    console.log('[PouchDB] saveBookmarks: bulkDocs 完成')
  })
}

export async function upsertBookmarkEntriesFromExternal(
  entries: Record<string, BookmarkEntry>,
  source: string,
): Promise<number> {
  const items = Object.entries(entries)
  if (items.length === 0) return 0

  return withAutoReset(async (database) => {
    let changed = 0

    for (const [url, entry] of items) {
      const id = PREFIX.BOOKMARK + url
      const existing = await database.get(id).catch(() => null)
      const incomingUpdatedAt = getEntryUpdatedAt(entry)
      const existingUpdatedAt = Number(existing?.updatedAt || 0)

      if (existing && existingUpdatedAt >= incomingUpdatedAt) {
        continue
      }

      const now = Date.now()
      const tagSet = new Set<string>([...(existing?.tags || []), ...(entry.tags || [])])
      const doc: BookmarkDoc = {
        _id: id,
        type: 'bookmark',
        url,
        title: entry.meta?.title || existing?.title || url,
        tags: Array.from(tagSet),
        description: entry.meta?.description ?? existing?.description,
        icon: entry.meta?.favicon ?? existing?.icon,
        clicks: Number(existing?.clicks || 0),
        lastClickedAt: existing?.lastClickedAt,
        createdAt: Number(existing?.createdAt || entry.meta?.created || now),
        updatedAt: incomingUpdatedAt || now,
        deleted: existing?.deleted || false,
      }

      if (existing) {
        await database.put({ ...doc, _rev: existing._rev })
      } else {
        await database.put(doc)
      }
      changed++
    }

    if (changed > 0) {
      console.log(`[PouchDB] ${source}: 已导入/更新 ${changed} 条外部书签`)
    }

    return changed
  })
}

export async function getBookmark(url: string): Promise<BookmarkDoc | null> {
  try {
    const database = await getDb()
    return await database.get(PREFIX.BOOKMARK + url)
  } catch {
    return null
  }
}

export async function getAllBookmarks(): Promise<BookmarkDoc[]> {
  try {
    return withAutoReset(async (database) => {
      console.log('[PouchDB] getAllBookmarks: 查询所有书签...')
      const result = await database.allDocs({
        startkey: PREFIX.BOOKMARK,
        endkey: PREFIX.BOOKMARK + '\uffff',
        include_docs: true,
      })
      console.log('[PouchDB] getAllBookmarks: 查询结果 rows 数量:', result.rows.length)
      const docs = result.rows.map((row: any) => row.doc).filter((doc: BookmarkDoc) => !doc.deleted)
      console.log('[PouchDB] getAllBookmarks: 过滤后文档数量:', docs.length)
      return docs
    })
  } catch (err) {
    console.error('[PouchDB] getAllBookmarks error:', err)
    return []
  }
}

export async function deleteBookmark(url: string): Promise<void> {
  try {
    const database = await getDb()
    const doc = await database.get(PREFIX.BOOKMARK + url)
    await database.put({ ...doc, deleted: true, updatedAt: Date.now() })
  } catch (err) {
    console.error('[PouchDB] deleteBookmark error:', url, err)
  }
}

// ==================== 点击统计（每条 URL 一个文档）====================

export interface ClickStatDoc {
  _id: string
  _rev?: string
  type: 'click-stat'
  url: string
  count: number
  lastClickedAt: number
  clickHistory?: Array<{ timestamp: number; tag?: string }>
}

export async function recordClickToPouch(url: string, tag?: string): Promise<void> {
  try {
    const database = await getDb()
    const id = PREFIX.CLICK + url
    const existing = await database.get(id).catch(() => null)
    
    const now = Date.now()
    const history = existing?.clickHistory || []
    history.push({ timestamp: now, tag })
    
    // 只保留最近 100 条点击记录
    if (history.length > 100) {
      history.shift()
    }
    
    const doc: ClickStatDoc = {
      _id: id,
      type: 'click-stat',
      url,
      count: (existing?.count || 0) + 1,
      lastClickedAt: now,
      clickHistory: history,
    }
    
    if (existing) {
      await database.put({ ...doc, _rev: existing._rev })
    } else {
      await database.put(doc)
    }
  } catch (err) {
    console.error('[PouchDB] recordClickToPouch error:', url, err)
  }
}

export async function getClickStats(): Promise<Record<string, { count: number; lastClickedAt: number }>> {
  try {
    const database = await getDb()
    const result = await database.allDocs({
      startkey: PREFIX.CLICK,
      endkey: PREFIX.CLICK + '\uffff',
      include_docs: true,
    })
    
    const stats: Record<string, { count: number; lastClickedAt: number }> = {}
    for (const row of result.rows) {
      const doc = row.doc as ClickStatDoc
      stats[doc.url] = {
        count: doc.count,
        lastClickedAt: doc.lastClickedAt,
      }
    }
    return stats
  } catch (err) {
    console.error('[PouchDB] getClickStats error:', err)
    return {}
  }
}

// ==================== 应用配置（单条文档）====================

export interface AppConfigDoc {
  _id: string
  _rev?: string
  type: 'app-config'
  tags: Array<{ id: string; name: string; displayName: string; icon: string; order: number }>
  display: {
    showFavicons: boolean
    cardStyle: 'compact' | 'comfortable'
    showDescriptions: boolean
  }
  pinnedBookmarks: string[]
  updatedAt: number
}

export async function saveAppConfigToPouch(config: Omit<AppConfigDoc, '_id' | 'type'>): Promise<void> {
  console.log('[PouchDB] saveAppConfigToPouch: 开始保存配置到 PouchDB, tags:', config.tags.length)
  return withAutoReset(async (database) => {
    const id = PREFIX.CONFIG + 'app'
    console.log('[PouchDB] saveAppConfigToPouch: 检查现有文档:', id)
    const existing = await database.get(id).catch(() => null)
    console.log('[PouchDB] saveAppConfigToPouch: 现有文档:', existing ? '存在' : '不存在')
    
    const doc: AppConfigDoc = {
      _id: id,
      type: 'app-config',
      tags: config.tags,
      display: config.display,
      pinnedBookmarks: config.pinnedBookmarks,
      updatedAt: Date.now(),
    }
    
    if (existing) {
      await database.put({ ...doc, _rev: existing._rev })
      console.log('[PouchDB] saveAppConfigToPouch: 配置已更新')
    } else {
      await database.put(doc)
      console.log('[PouchDB] saveAppConfigToPouch: 配置已创建')
    }
  })
}

export async function loadAppConfigFromPouch(): Promise<AppConfigDoc | null> {
  try {
    return withAutoReset(async (database) => {
      const doc = await database.get(PREFIX.CONFIG + 'app')
      console.log('[PouchDB] loadAppConfigFromPouch: 原始文档完整内容:', JSON.stringify(doc, null, 2))
      return doc
    })
  } catch (err) {
    console.error('[PouchDB] loadAppConfigFromPouch: 读取失败:', err)
    return null
  }
}

// ==================== WebDAV 配置（单条文档）====================

export interface WebDAVConfigDoc {
  _id: string
  _rev?: string
  type: 'webdav-config'
  url: string
  username: string
  password: string
  bookmarkPath?: string
}

export async function saveWebDAVConfigToPouch(config: Omit<WebDAVConfigDoc, '_id' | 'type'>): Promise<void> {
  try {
    const database = await getDb()
    const id = PREFIX.CONFIG + 'webdav'
    const existing = await database.get(id).catch(() => null)
    
    const doc: WebDAVConfigDoc = {
      _id: id,
      type: 'webdav-config',
      url: config.url,
      username: config.username,
      password: config.password,
      bookmarkPath: config.bookmarkPath,
    }
    
    if (existing) {
      await database.put({ ...doc, _rev: existing._rev })
    } else {
      await database.put(doc)
    }
  } catch (err) {
    console.error('[PouchDB] saveWebDAVConfigToPouch error:', err)
  }
}

export async function loadWebDAVConfigFromPouch(): Promise<WebDAVConfigDoc | null> {
  try {
    const database = await getDb()
    return await database.get(PREFIX.CONFIG + 'webdav')
  } catch {
    return null
  }
}

// ==================== 固定书签 ====================

export async function savePinnedToPouch(urls: string[]): Promise<void> {
  try {
    const database = await getDb()
    const id = PREFIX.CONFIG + 'pinned'
    const existing = await database.get(id).catch(() => null)
    
    const doc = {
      _id: id,
      type: 'pinned',
      urls,
      updatedAt: Date.now(),
    }
    
    if (existing) {
      await database.put({ ...doc, _rev: existing._rev })
    } else {
      await database.put(doc)
    }
  } catch (err) {
    console.error('[PouchDB] savePinnedToPouch error:', err)
  }
}

export async function loadPinnedFromPouch(): Promise<string[] | null> {
  try {
    const database = await getDb()
    const doc = await database.get(PREFIX.CONFIG + 'pinned')
    return doc.urls
  } catch {
    return null
  }
}

// ==================== 元数据（同步用）====================

export interface SyncMetaDoc {
  _id: string
  _rev?: string
  type: 'sync-meta'
  lastSyncAt: number
  deviceId: string
}

export async function saveSyncMeta(meta: Omit<SyncMetaDoc, '_id' | 'type'>): Promise<void> {
  try {
    const database = await getDb()
    const id = PREFIX.META + 'sync'
    const existing = await database.get(id).catch(() => null)
    
    const doc: SyncMetaDoc = {
      _id: id,
      type: 'sync-meta',
      lastSyncAt: meta.lastSyncAt,
      deviceId: meta.deviceId,
    }
    
    if (existing) {
      await database.put({ ...doc, _rev: existing._rev })
    } else {
      await database.put(doc)
    }
  } catch (err) {
    console.error('[PouchDB] saveSyncMeta error:', err)
  }
}

export async function loadSyncMeta(): Promise<SyncMetaDoc | null> {
  try {
    const database = await getDb()
    return await database.get(PREFIX.META + 'sync')
  } catch {
    return null
  }
}
