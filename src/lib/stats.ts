import type { DisplayBookmark, WebDAVConfig } from '@/types'
import { getFileContents, putFileContents } from './webdav'
import { recordClickToPouch, savePinnedToPouch, loadPinnedFromPouch } from './pouchdb'

interface ClickRecord {
  url: string
  title: string
  count: number
  lastClicked: number
}

interface ClickStats {
  records: Record<string, ClickRecord>
  version: number
}

const STATS_KEY = 'onenavClickStats'
const STATS_VERSION = 1
const WEBDAV_STATS_PATH = 'app_data/onenav/click_stats.json'

// ==================== 点击统计 ====================

export function loadClickStats(): ClickStats {
  try {
    const raw = localStorage.getItem(STATS_KEY)
    if (!raw) {
      return { records: {}, version: STATS_VERSION }
    }
    const data = JSON.parse(raw) as ClickStats
    return data.version === STATS_VERSION ? data : { records: {}, version: STATS_VERSION }
  } catch {
    return { records: {}, version: STATS_VERSION }
  }
}

export function saveClickStats(stats: ClickStats): void {
  localStorage.setItem(STATS_KEY, JSON.stringify(stats))
  // 注意：不再使用 saveClickStatsToPouch，改用 recordClickToPouch 逐条记录
}

export async function syncClickStatsToWebDAV(wdav: WebDAVConfig): Promise<void> {
  const stats = loadClickStats()
  try {
    await putFileContents(wdav, WEBDAV_STATS_PATH, JSON.stringify(stats, null, 2))
  } catch (err) {
    console.error('[OneNav] Failed to sync click stats to WebDAV:', err)
  }
}

export async function loadClickStatsFromWebDAV(wdav: WebDAVConfig): Promise<ClickStats | null> {
  try {
    const raw = await getFileContents(wdav, WEBDAV_STATS_PATH)
    const data = JSON.parse(raw) as ClickStats
    if (data.version === STATS_VERSION) {
      const localStats = loadClickStats()
      const merged = mergeStats(localStats, data)
      saveClickStats(merged) // 同时写入 localStorage
      // 同时更新 PouchDB 中的点击记录
      for (const [url, record] of Object.entries(merged.records)) {
        for (let i = 0; i < record.count; i++) {
          await recordClickToPouch(url)
        }
      }
      return merged
    }
    return null
  } catch {
    return null
  }
}

function mergeStats(local: ClickStats, remote: ClickStats): ClickStats {
  const merged: Record<string, ClickRecord> = { ...local.records }

  for (const [url, record] of Object.entries(remote.records)) {
    if (merged[url]) {
      merged[url].count = Math.max(merged[url].count, record.count)
      merged[url].lastClicked = Math.max(merged[url].lastClicked, record.lastClicked)
    } else {
      merged[url] = record
    }
  }

  return { records: merged, version: STATS_VERSION }
}

export function recordClick(bookmark: DisplayBookmark, wdav?: WebDAVConfig): void {
  const stats = loadClickStats()
  const now = Date.now()

  if (stats.records[bookmark.url]) {
    stats.records[bookmark.url].count++
    stats.records[bookmark.url].lastClicked = now
    stats.records[bookmark.url].title = bookmark.title
  } else {
    stats.records[bookmark.url] = {
      url: bookmark.url,
      title: bookmark.title,
      count: 1,
      lastClicked: now,
    }
  }

  saveClickStats(stats) // 写入 localStorage
  
  // 同时记录到 PouchDB（逐条记录）
  recordClickToPouch(bookmark.url, bookmark.tags?.[0])

  if (wdav) {
    syncClickStatsToWebDAV(wdav)
  }
}

export function getMostVisitedBookmarks(limit: number = 20): ClickRecord[] {
  const stats = loadClickStats()
  const records = Object.values(stats.records)

  return records
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count
      }
      return b.lastClicked - a.lastClicked
    })
    .slice(0, limit)
}

export function getRecentBookmarks(limit: number = 20): ClickRecord[] {
  const stats = loadClickStats()
  const records = Object.values(stats.records)

  return records
    .sort((a, b) => b.lastClicked - a.lastClicked)
    .slice(0, limit)
}

// ==================== 固定书签 ====================

const PINNED_KEY = 'onenavPinnedBookmarks'

export function loadPinnedBookmarks(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_KEY)
    console.log('[Stats] loadPinnedBookmarks: localStorage raw:', raw)
    if (!raw) {
      console.log('[Stats] loadPinnedBookmarks: localStorage 为空')
      return []
    }
    const parsed = JSON.parse(raw) as string[]
    console.log('[Stats] loadPinnedBookmarks: 加载到', parsed.length, '条固定书签:', parsed)
    return parsed
  } catch (err) {
    console.error('[Stats] loadPinnedBookmarks: 解析失败:', err)
    return []
  }
}

export async function loadPinnedBookmarksAsync(): Promise<string[]> {
  console.log('[Stats] loadPinnedBookmarksAsync: 开始加载')
  // 优先从 localStorage 加载
  const local = loadPinnedBookmarks()
  if (local.length > 0) {
    console.log('[Stats] loadPinnedBookmarksAsync: 从 localStorage 加载到', local.length, '条')
    return local
  }
  
  // localStorage 为空时，尝试从 PouchDB 加载
  console.log('[Stats] loadPinnedBookmarksAsync: localStorage 为空，尝试从 PouchDB 加载')
  try {
    const pouch = await loadPinnedFromPouch()
    console.log('[Stats] loadPinnedBookmarksAsync: PouchDB 返回:', pouch)
    if (pouch && pouch.length > 0) {
      // 同步回 localStorage
      localStorage.setItem(PINNED_KEY, JSON.stringify(pouch))
      console.log('[Stats] loadPinnedBookmarksAsync: 从 PouchDB 加载到', pouch.length, '条:', pouch)
      return pouch
    }
  } catch (err) {
    console.error('[Stats] loadPinnedBookmarksAsync: 从 PouchDB 加载失败:', err)
  }
  console.log('[Stats] loadPinnedBookmarksAsync: 没有找到固定书签')
  return []
}

export function savePinnedBookmarks(urls: string[]): void {
  localStorage.setItem(PINNED_KEY, JSON.stringify(urls))
  savePinnedToPouch(urls) // 同步到 PouchDB
}

export function togglePinnedBookmark(url: string): boolean {
  const pinned = loadPinnedBookmarks()
  const index = pinned.indexOf(url)
  if (index > -1) {
    pinned.splice(index, 1)
    savePinnedBookmarks(pinned)
    return false
  } else {
    pinned.push(url)
    savePinnedBookmarks(pinned)
    return true
  }
}
