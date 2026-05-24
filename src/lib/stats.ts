import type { DisplayBookmark } from '@/types'

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

export function recordClick(bookmark: DisplayBookmark): void {
  const stats = loadClickStats()
  const now = Date.now()
  
  if (stats.records[bookmark.url]) {
    stats.records[bookmark.url].count++
    stats.records[bookmark.url].lastClicked = now
    stats.records[bookmark.url].title = bookmark.title // Update title in case it changed
  } else {
    stats.records[bookmark.url] = {
      url: bookmark.url,
      title: bookmark.title,
      count: 1,
      lastClicked: now,
    }
  }
  
  saveClickStats(stats)
  console.log('[OneNav] Click recorded:', bookmark.url, 'count:', stats.records[bookmark.url].count)
}

export function getMostVisitedBookmarks(limit: number = 20): ClickRecord[] {
  const stats = loadClickStats()
  const records = Object.values(stats.records)
  
  // 按点击次数排序，次数相同按最近点击时间排序
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
  
  // 按最近点击时间排序
  return records
    .sort((a, b) => b.lastClicked - a.lastClicked)
    .slice(0, limit)
}
