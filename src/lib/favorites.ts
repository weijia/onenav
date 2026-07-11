import type { WebDAVConfig, BookmarkEntry, BookmarksStore, RawFavoritesBookmark, ArchiveResult } from '@/types'
import { getFileContents, putFileContents, listDirectory, stat } from '@/lib/webdav'

const FAVORITES_ROOT = 'app_data/favorites'
const BM_FILE_RE = /^bm_.*\.json$/

/** 当前 UTC 年月（YYYY-MM） */
export function getCurrentYM(): string {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

/** 是否为新月份第一天（UTC），用于自动触发归档 */
export function shouldAutoArchive(): boolean {
  return new Date().getUTCDate() === 1
}

function rawToBookmarkEntry(raw: RawFavoritesBookmark): BookmarkEntry | null {
  if (!raw.url) return null
  return {
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    meta: {
      url: raw.url,
      title: raw.title,
      description: raw.description,
      favicon: raw.icon,
    },
  }
}

interface MonthDir {
  ym: string
  dirPath: string
  isCurrent: boolean
}

/** 列举 app_data/favorites 下所有 年份 / YYYY-MM 月份目录 */
export async function listFavoritesMonths(config: WebDAVConfig): Promise<MonthDir[]> {
  let years: { name: string; path: string; isCollection: boolean }[]
  try {
    years = await listDirectory(config, FAVORITES_ROOT)
  } catch {
    return []
  }
  const yearDirs = years.filter((c) => c.isCollection && /^\d{4}$/.test(c.name))
  const currentYM = getCurrentYM()
  const out: MonthDir[] = []

  for (const y of yearDirs) {
    const yearPath = `${FAVORITES_ROOT}/${y.name}`
    let months
    try {
      months = await listDirectory(config, yearPath)
    } catch {
      continue
    }
    const monthDirs = months.filter((c) => c.isCollection && /^\d{4}-\d{2}$/.test(c.name))
    for (const mo of monthDirs) {
      const ym = mo.name
      out.push({
        ym,
        dirPath: `${yearPath}/${mo.name}`,
        isCurrent: ym === currentYM,
      })
    }
  }
  return out
}

/**
 * 加载收藏书签，返回 utags 格式的 data 映射（key=url）。
 * - 历史月：优先读取 archive-YYYY-MM.json（存在即完整）；否则回退扫描 bm_*.json
 * - 当前月：直接扫描 bm_*.json（活跃源数据，需纳入展示）
 */
export async function loadFavoritesBookmarks(config: WebDAVConfig): Promise<Record<string, BookmarkEntry>> {
  const result: Record<string, BookmarkEntry> = {}
  const months = await listFavoritesMonths(config)

  for (const m of months) {
    let raws: RawFavoritesBookmark[] = []

    if (!m.isCurrent) {
      // 优先读取归档快照
      try {
        const raw = await getFileContents(config, `${m.dirPath}/archive-${m.ym}.json`)
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) raws = parsed as RawFavoritesBookmark[]
      } catch {
        raws = [] // 归档缺失，回退扫描单文件
      }
    }

    if (raws.length === 0) {
      // 扫描单文件 bm_*.json
      try {
        const children = await listDirectory(config, m.dirPath)
        const bmFiles = children.filter((c) => !c.isCollection && BM_FILE_RE.test(c.name))
        for (const f of bmFiles) {
          try {
            const raw = await getFileContents(config, `${m.dirPath}/${f.name}`)
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed)) raws.push(...(parsed as RawFavoritesBookmark[]))
            else if (parsed && typeof parsed === 'object') raws.push(parsed as RawFavoritesBookmark)
          } catch {
            // 单个文件失败不影响其余
          }
        }
      } catch {
        // 目录不可读，跳过该月
      }
    }

    for (const r of raws) {
      const entry = rawToBookmarkEntry(r)
      if (entry && entry.meta.url) {
        result[entry.meta.url] = entry
      }
    }
  }

  return result
}

/**
 * 归档：对“上个月及更早”的月份，若不存在 archive-YYYY-MM.json，
 * 则扫描该月 bm_*.json 生成归档快照。严格跳过当前月，天然幂等。
 */
export async function archiveFavorites(config: WebDAVConfig): Promise<ArchiveResult> {
  const result: ArchiveResult = { archived: [], skipped: [], errors: [] }
  const months = await listFavoritesMonths(config)

  for (const m of months) {
    if (m.isCurrent) {
      result.skipped.push(`${m.ym} (当月跳过)`)
      continue
    }

    // 归档已存在则跳过（存在即完整，不补漏、不回扫）
    try {
      const existing = await stat(config, `${m.dirPath}/archive-${m.ym}.json`)
      if (existing) {
        result.skipped.push(m.ym)
        continue
      }
    } catch {
      // 视为不存在，继续归档
    }

    try {
      const children = await listDirectory(config, m.dirPath)
      const bmFiles = children.filter((c) => !c.isCollection && BM_FILE_RE.test(c.name))
      const bookmarks: RawFavoritesBookmark[] = []
      for (const f of bmFiles) {
        try {
          const raw = await getFileContents(config, `${m.dirPath}/${f.name}`)
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) bookmarks.push(...(parsed as RawFavoritesBookmark[]))
          else if (parsed && typeof parsed === 'object') bookmarks.push(parsed as RawFavoritesBookmark)
        } catch {
          // 忽略单个文件错误
        }
      }
      await putFileContents(config, `${m.dirPath}/archive-${m.ym}.json`, JSON.stringify(bookmarks, null, 2))
      result.archived.push(m.ym)
    } catch (e) {
      result.errors.push({ ym: m.ym, message: e instanceof Error ? e.message : String(e) })
    }
  }

  return result
}

/**
 * 将收藏 data 合并进主书签 store：
 * - 按 URL 去重
 * - 冲突时主书签优先（保留其标题/图标等元数据），并集双方 tags
 */
export function mergeFavoritesIntoStore(
  store: BookmarksStore,
  favorites: Record<string, BookmarkEntry>,
): BookmarksStore {
  if (!favorites || Object.keys(favorites).length === 0) return store
  const data = { ...store.data }
  for (const [url, entry] of Object.entries(favorites)) {
    const existing = data[url]
    if (existing) {
      const tagSet = new Set(existing.tags)
      entry.tags.forEach((t) => tagSet.add(t))
      data[url] = { ...existing, tags: Array.from(tagSet) }
    } else {
      data[url] = entry
    }
  }
  return { ...store, data }
}
