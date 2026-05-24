import type { DisplayBookmark, WebDAVConfig } from '@/types'
import { getFileContents, putFileContents } from './webdav'

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
      // Merge with local stats
      const localStats = loadClickStats()
      const merged = mergeStats(localStats, data)
      saveClickStats(merged)
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
      // Use higher count and more recent timestamp
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
  
  saveClickStats(stats)
  
  // Sync to WebDAV if available
  if (wdav) {
    syncClickStatsToWebDAV(wdav)
  }
  
  console.log('[OneNav] Click recorded:', bookmark.url, 'count:', stats.records[bookmark.url].count)
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
