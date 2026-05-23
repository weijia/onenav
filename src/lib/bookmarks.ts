import type { BookmarksStore, DisplayBookmark } from '@/types'

export function filterByTag(store: BookmarksStore, tag: string): DisplayBookmark[] {
  const results: DisplayBookmark[] = []

  for (const [_key, entry] of Object.entries(store.data)) {
    // Skip deleted entries
    if (entry.deletedMeta) continue
    if (entry.meta.deleted) continue

    // Check if entry has the requested tag
    if (!entry.tags.includes(tag)) continue

    const url = entry.meta.url || entry.meta.mainUrl || ''
    if (!url) continue

    const title = entry.meta.shortTitle || entry.meta.title || url

    results.push({
      url,
      title,
      favicon: entry.meta.favicon || getFaviconUrl(url),
      color: stringToColor(new URL(url).hostname),
      tags: entry.tags,
    })
  }

  return results
}

export function filterByMultipleTags(store: BookmarksStore, tags: string[]): DisplayBookmark[] {
  const results: DisplayBookmark[] = []

  for (const [_key, entry] of Object.entries(store.data)) {
    if (entry.deletedMeta) continue
    if (entry.meta.deleted) continue

    // Entry must have at least one of the configured tags
    const hasTag = entry.tags.some((t: string) => tags.includes(t))
    if (!hasTag) continue

    const url = entry.meta.url || entry.meta.mainUrl || ''
    if (!url) continue

    const title = entry.meta.shortTitle || entry.meta.title || url

    results.push({
      url,
      title,
      favicon: entry.meta.favicon || getFaviconUrl(url),
      color: stringToColor(new URL(url).hostname),
      tags: entry.tags,
    })
  }

  return results
}

export function getAllTags(store: BookmarksStore): string[] {
  const tagSet = new Set<string>()

  for (const [_key, entry] of Object.entries(store.data)) {
    if (entry.deletedMeta) continue
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
