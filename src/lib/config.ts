import type { WebDAVConfig, AppConfig, BookmarksStore } from '@/types'
import { getFileContents, putFileContents, createDirectory } from '@/lib/webdav'
import {
  saveWebDAVConfigToPouch,
  saveAppConfigToPouch,
  saveBookmarksToPouch,
  loadBookmarksFromPouch,
  loadAppConfigFromPouch,
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

export function saveAppConfig(config: AppConfig): void {
  localStorage.setItem(APP_CONFIG_KEY, JSON.stringify(config))
  saveAppConfigToPouch(config) // 同步到 PouchDB
}

export async function fetchAppConfig(wdav: WebDAVConfig): Promise<AppConfig | null> {
  try {
    const raw = await getFileContents(wdav, 'app_data/onenav/config.json')
    const config = JSON.parse(raw) as AppConfig
    saveAppConfig(config) // 同时写入 localStorage 和 PouchDB
    return config
  } catch {
    return null
  }
}

export async function saveAppConfigToWebDAV(wdav: WebDAVConfig, config: AppConfig): Promise<void> {
  await createDirectory(wdav, 'app_data')
  await createDirectory(wdav, 'app_data/onenav')
  await putFileContents(wdav, 'app_data/onenav/config.json', JSON.stringify(config, null, 2))
  saveAppConfig(config) // 同时写入 localStorage 和 PouchDB
}

// ==================== 书签数据 ====================

export async function fetchBookmarks(wdav: WebDAVConfig, path: string): Promise<BookmarksStore | null> {
  try {
    const raw = await getFileContents(wdav, path)
    const store = JSON.parse(raw) as BookmarksStore
    saveBookmarksCache(store) // 同时写入 localStorage 和 PouchDB
    return store
  } catch {
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
    saveBookmarksToPouch(store) // 同步到 PouchDB
  } catch {
    // localStorage 满了就忽略
  }
}

// ==================== 从 PouchDB 加载（优先） ====================

export async function loadAppConfigFromPouchDB(): Promise<AppConfig | null> {
  return loadAppConfigFromPouch()
}

export async function loadBookmarksFromPouchDB(): Promise<BookmarksStore | null> {
  const result = await loadBookmarksFromPouch()
  if (!result) return null
  return { data: result.data, meta: result.meta } as BookmarksStore
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
