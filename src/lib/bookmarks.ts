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
  console.log('[filterByTag] 开始过滤，标签:', tag)
  const results: DisplayBookmark[] = []
  // 支持逗号分隔的多个 tag，书签匹配其中任意一个即可
  const tags = tag.split(',').map(t => t.trim()).filter(Boolean)
  console.log('[filterByTag] 解析后的标签:', tags)
  console.log('[filterByTag] 总书签数量:', Object.keys(store.data).length)

  for (const [key, entry] of Object.entries(store.data)) {
    // Skip deleted entries
    if (isDeleted(entry)) continue

    // Check if entry has at least one of the requested tags
    console.log('[filterByTag] 检查书签:', key, 'tags:', entry.tags)
    if (!entry.tags.some((t: string) => tags.includes(t))) {
      console.log('[filterByTag]   -> 不匹配')
      continue
    }
    console.log('[filterByTag]   -> 匹配成功')

    // URL 从 key 获取（key 就是 URL），meta.url 可能为空
    const url = key

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

  console.log('[filterByTag] 过滤完成，结果数量:', results.length)
  return results
}

export function filterByMultipleTags(store: BookmarksStore, tags: string[]): DisplayBookmark[] {
  const results: DisplayBookmark[] = []

  for (const [key, entry] of Object.entries(store.data)) {
    if (isDeleted(entry)) continue

    // Entry must have at least one of the configured tags
    const hasTag = entry.tags.some((t: string) => tags.includes(t))
    if (!hasTag) continue

    const url = key

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
    const origin = new URL(url).origin
    return `${origin}/favicon.ico`
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
 * 如果没有点击记录，返回所有书签（按添加时间倒序）
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
  
  // 如果有点击记录，按点击排序
  if (records.length > 0) {
    for (const record of records) {
      const entry = Object.entries(store.data).find(([key, e]) => {
        return key === record.url && !isDeleted(e)
      })

      if (entry) {
        const [url, e] = entry
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
    }
  }
  
  // 如果没有点击记录或结果不足，补充其他书签
  if (results.length === 0) {
    console.log('[Bookmarks] 没有点击记录，显示所有书签')
    const allBookmarks = Object.entries(store.data)
      .filter(([_, e]) => !isDeleted(e))
      .map(([url, e]) => ({
        url,
        title: e.meta.shortTitle || e.meta.title || url,
        description: e.meta.description || '',
        favicon: e.meta.favicon || getFaviconUrl(url),
        color: stringToColor(new URL(url).hostname),
        tags: e.tags,
        isPinned: false,
      }))
    
    return allBookmarks.slice(0, limit)
  }

  return results
}
