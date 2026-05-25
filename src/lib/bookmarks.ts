import type { BookmarksStore, DisplayBookmark } from '@/types'
import { loadClickStats } from './stats'

// 检查书签是否已被删除
export function isDeleted(entry: { deletedMeta?: unknown; meta: { deleted?: number }; tags: string[] }): boolean {
  if (entry.deletedMeta) return true
  if (entry.meta.deleted) return true
  if (entry.tags.includes('._DELETED_')) return true
  return false
}

export function filterByTag(store: BookmarksStore, tag: string): DisplayBookmark[] {
  const results: DisplayBookmark[] = []
  // 支持逗号分隔的多个 tag，书签匹配其中任意一个即可
  const tags = tag.split(',').map(t => t.trim()).filter(Boolean)

  for (const [_key, entry] of Object.entries(store.data)) {
    // Skip deleted entries
    if (isDeleted(entry)) continue

    // Check if entry has at least one of the requested tags
    if (!entry.tags.some((t: string) => tags.includes(t))) continue

    const url = entry.meta.url || entry.meta.mainUrl || ''
    if (!url) continue

    const title = entry.meta.shortTitle || entry.meta.title || url

    results.push({
      url,
      title,
      description: entry.meta.description || '',
      favicon: entry.meta.favicon || getFaviconUrl(url),
      color: stringToColor(new URL(url).hostname),
      tags: entry.tags,
      isPinned: false,
    })
  }

  return results
}

export function filterByMultipleTags(store: BookmarksStore, tags: string[]): DisplayBookmark[] {
  const results: DisplayBookmark[] = []

  for (const [_key, entry] of Object.entries(store.data)) {
    if (isDeleted(entry)) continue

    // Entry must have at least one of the configured tags
    const hasTag = entry.tags.some((t: string) => tags.includes(t))
    if (!hasTag) continue

    const url = entry.meta.url || entry.meta.mainUrl || ''
    if (!url) continue

    const title = entry.meta.shortTitle || entry.meta.title || url

    results.push({
      url,
      title,
      description: entry.meta.description || '',
      favicon: entry.meta.favicon || getFaviconUrl(url),
      color: stringToColor(new URL(url).hostname),
      tags: entry.tags,
      isPinned: false,
    })
  }

  return results
}

export function getAllTags(store: BookmarksStore): string[] {
  const tagSet = new Set<string>()

  for (const [_key, entry] of Object.entries(store.data)) {
    if (isDeleted(entry)) continue
    for (const tag of entry.tags) {
      // Exclude system tags (prefixed with ._)
      if (!tag.startsWith('._')) {
        tagSet.add(tag)
      }
    }
  }

  return Array.from(tagSet).sort()
}

export function getFaviconUrl(url: string): string {
  try {
    const domain = new URL(url).hostname
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`
  } catch {
    return ''
  }
}

export function stringToColor(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32-bit integer
  }

  const hue = Math.abs(hash) % 360
  const saturation = 55 + (Math.abs(hash >> 8) % 20) // 55-75%
  const lightness = 45 + (Math.abs(hash >> 16) % 15) // 45-60%

  return `hsl(${hue}, ${saturation}%, ${lightness}%)`
}

/**
 * 获取最常访问的书签（用于 'onenav' 标签页）
 */
export function getMostVisitedBookmarks(store: BookmarksStore, limit: number = 30): DisplayBookmark[] {
  const stats = loadClickStats()
  const records = Object.values(stats.records)
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count
      return b.lastClicked - a.lastClicked
    })
    .slice(0, limit)

  const results: DisplayBookmark[] = []
  for (const record of records) {
    // 从 store 中查找完整的书签信息
    const entry = Object.entries(store.data).find(([_, e]) => {
      const url = e.meta.url || e.meta.mainUrl || ''
      return url === record.url && !isDeleted(e)
    })

    if (entry) {
      const [_, e] = entry
      const url = e.meta.url || e.meta.mainUrl || ''
      const title = e.meta.shortTitle || e.meta.title || url
      results.push({
        url,
        title,
        description: e.meta.description || '',
        favicon: e.meta.favicon || getFaviconUrl(url),
        color: stringToColor(new URL(url).hostname),
        tags: e.tags,
        isPinned: false,
      })
    }
    // 如果书签已从 utags 删除，跳过不显示
  }

  return results
}
