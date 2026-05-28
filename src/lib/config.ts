import type { WebDAVConfig, AppConfig, BookmarksStore, BookmarkEntry } from '@/types'
import { getFileContents, putFileContents, createDirectory } from '@/lib/webdav'
import {
  saveWebDAVConfigToPouch,
  saveAppConfigToPouch,
  saveBookmarks,
  getAllBookmarks,
  loadAppConfigFromPouch,
  type BookmarkDoc,
} from '@/lib/pouchdb'

const WEBDAV_CONFIG_KEY = 'webDAVConfig'
const APP_CONFIG_KEY = 'onenavConfig'
const BOOKMARKS_CACHE_KEY = 'onenavBookmarksCache'

// ==================== WebDAV 配置 ====================

export function loadWebDAVConfig(): WebDAVConfig | null {
  try {
    const raw = localStorage.getItem(WEBDAV_CONFIG_KEY)
    if (!raw) return null
    return JSON.parse(raw) as WebDAVConfig
  } catch {
    return null
  }
}

export function saveWebDAVConfig(config: WebDAVConfig): void {
  localStorage.setItem(WEBDAV_CONFIG_KEY, JSON.stringify(config))
  saveWebDAVConfigToPouch(config) // 同步到 PouchDB
}

// ==================== 应用配置 ====================

export function loadAppConfig(): AppConfig | null {
  try {
    const raw = localStorage.getItem(APP_CONFIG_KEY)
    if (!raw) return null
    return JSON.parse(raw) as AppConfig
  } catch {
    return null
  }
}

export async function saveAppConfig(config: AppConfig): Promise<void> {
  localStorage.setItem(APP_CONFIG_KEY, JSON.stringify(config))
  await saveAppConfigToPouch({
    tags: config.tags.map(t => ({ id: t.id, name: t.tag, displayName: t.label, icon: t.icon, order: t.order })),
    display: {
      showFavicons: true,
      cardStyle: 'comfortable',
      showDescriptions: true,
    },
    pinnedBookmarks: [],
    updatedAt: Date.now(),
  })
  console.log('[Config] saveAppConfig: 配置已保存到 localStorage 和 PouchDB')
}

export async function fetchAppConfig(wdav: WebDAVConfig): Promise<AppConfig | null> {
  try {
    const raw = await getFileContents(wdav, 'app_data/onenav/config.json')
    const config = JSON.parse(raw) as AppConfig
    await saveAppConfig(config)
    return config
  } catch {
    return null
  }
}

export async function saveAppConfigToWebDAV(wdav: WebDAVConfig, config: AppConfig): Promise<void> {
  await createDirectory(wdav, 'app_data')
  await createDirectory(wdav, 'app_data/onenav')
  await putFileContents(wdav, 'app_data/onenav/config.json', JSON.stringify(config, null, 2))
  await saveAppConfig(config)
}

// ==================== 书签数据 ====================

// 将 BookmarkDoc 转换为 BookmarkEntry（用于兼容旧格式）
function docToBookmarkEntry(doc: BookmarkDoc): BookmarkEntry {
  return {
    tags: doc.tags,
    meta: {
      url: doc.url,
      title: doc.title,
      description: doc.description,
      favicon: doc.icon,
    },
  }
}

// 将 BookmarkEntry 转换为 BookmarkDoc
function bookmarkEntryToDoc(url: string, entry: BookmarkEntry): Omit<BookmarkDoc, '_id' | 'type'> {
  const now = Date.now()
  return {
    url,
    title: entry.meta?.title || url,
    tags: entry.tags || [],
    description: entry.meta?.description,
    icon: entry.meta?.favicon,
    clicks: 0,
    lastClickedAt: undefined,
    createdAt: now,
    updatedAt: now,
  }
}

export async function fetchBookmarks(wdav: WebDAVConfig, path: string): Promise<BookmarksStore | null> {
  try {
    console.log('[Config] fetchBookmarks: 开始从 WebDAV 获取书签:', path)
    const raw = await getFileContents(wdav, path)
    const store = JSON.parse(raw) as BookmarksStore
    console.log('[Config] fetchBookmarks: 获取到书签数量:', Object.keys(store.data).length)
    
    // 将书签保存到 PouchDB（每条一个文档）
    const bookmarks = Object.entries(store.data).map(([url, entry]) => bookmarkEntryToDoc(url, entry))
    console.log('[Config] fetchBookmarks: 准备保存到 PouchDB，书签数量:', bookmarks.length)
    await saveBookmarks(bookmarks)
    console.log('[Config] fetchBookmarks: PouchDB 保存完成')
    
    // 同时保存到 localStorage 缓存
    saveBookmarksCache(store)
    console.log('[Config] fetchBookmarks: localStorage 缓存完成')
    
    return store
  } catch (err) {
    console.error('[Config] fetchBookmarks: 失败:', err)
    return null
  }
}

export function loadBookmarksCache(): BookmarksStore | null {
  try {
    const raw = localStorage.getItem(BOOKMARKS_CACHE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as BookmarksStore
  } catch {
    return null
  }
}

export function saveBookmarksCache(store: BookmarksStore): void {
  try {
    localStorage.setItem(BOOKMARKS_CACHE_KEY, JSON.stringify(store))
  } catch {
    // localStorage 满了就忽略
  }
}

// ==================== 从 PouchDB 加载（优先）====================

export async function loadAppConfigFromPouchDB(): Promise<AppConfig | null> {
  const doc = await loadAppConfigFromPouch()
  if (!doc) return null
  
  console.log('[Config] loadAppConfigFromPouchDB: 加载配置', doc)
  console.log('[Config] loadAppConfigFromPouchDB: tags 详情:', doc.tags.map((t: any) => ({ id: t.id, name: t.name, icon: t.icon, hasIcon: 'icon' in t })))
  
  // 转换回 AppConfig 格式
  return {
    version: 1,
    tags: doc.tags.map((t: any) => ({ 
      id: t.id || t.name, 
      label: t.displayName, 
      tag: t.name, 
      icon: t.icon || 'LayoutGrid', 
      order: t.order 
    })),
    bookmarkPath: 'app_data/utags/bookmarks.json',
    display: {
      iconSize: 60,
      iconBorderRadius: 16,
      iconSpacing: 27,
      showName: true,
      nameSize: 12,
      maxWidth: 1600,
      openInNewTab: true,
      defaultColor: '#1e293b',
    },
    background: {
      type: 'gradient',
      value: 'from-blue-900 via-purple-900 to-indigo-900',
      maskOpacity: 0.2,
      blur: 0,
    },
    widgets: {
      showTime: false,
      showSearchBar: false,
      showSeconds: false,
      searchEngine: 'google',
      fontSize: 70,
      fontColor: '#ffffff',
    },
  }
}

export async function loadBookmarksFromPouchDB(): Promise<BookmarksStore | null> {
  console.log('[Config] loadBookmarksFromPouchDB: 开始加载...')
  const docs = await getAllBookmarks()
  console.log('[Config] loadBookmarksFromPouchDB: 获取到', docs.length, '条文档')
  console.log('[Config] loadBookmarksFromPouchDB: 文档示例:', docs.slice(0, 2))
  
  if (docs.length === 0) {
    console.log('[Config] loadBookmarksFromPouchDB: 没有文档，返回 null')
    return null
  }
  
  // 转换回 BookmarksStore 格式
  const data: Record<string, BookmarkEntry> = {}
  for (const doc of docs) {
    console.log('[Config] loadBookmarksFromPouchDB: 转换文档:', doc._id, doc.url)
    data[doc.url] = docToBookmarkEntry(doc)
  }
  
  console.log('[Config] loadBookmarksFromPouchDB: 转换完成，共', Object.keys(data).length, '条书签')
  
  return {
    data,
    meta: {
      databaseVersion: 1,
      created: Date.now(),
      updated: Date.now(),
    },
  }
}

// ==================== 默认配置 ====================

export function getDefaultAppConfig(): AppConfig {
  return {
    version: 1,
    tags: [
      { id: 'default-onenav', label: '常用', tag: 'onenav', icon: 'LayoutGrid', order: 0 },
      { id: 'default-all', label: '全部', tag: '._all_', icon: 'Globe', order: 1 }
    ],
    bookmarkPath: 'app_data/utags/bookmarks.json',
    display: {
      iconSize: 60,
      iconBorderRadius: 16,
      iconSpacing: 27,
      showName: true,
      nameSize: 12,
      maxWidth: 1600,
      openInNewTab: true,
      defaultColor: '#1e293b',
    },
    background: {
      type: 'gradient',
      value: 'from-blue-900 via-purple-900 to-indigo-900',
      maskOpacity: 0.2,
      blur: 0,
    },
    widgets: {
      showTime: false,
      showSearchBar: false,
      showSeconds: false,
      searchEngine: 'google',
      fontSize: 70,
      fontColor: '#ffffff',
    },
  }
}
