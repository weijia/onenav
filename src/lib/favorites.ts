import type { WebDAVConfig, BookmarkEntry, BookmarksStore, RawFavoritesBookmark, ArchiveResult } from '@/types'
import { getFileContents, putFileContents, listDirectory, stat } from '@/lib/webdav'
import { isRemoteStorageAuthError } from '@/lib/remotestorage-connection'

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
      created: raw.createdAt,
      updated: raw.updatedAt,
    },
  }
}

/**
 * 收藏源文件系统抽象：WebDAV 与 RemoteStorage 各自实现，
 * 加载/归档核心逻辑只写一份。路径均为相对 favorites 根的路径（不含前导斜杠）。
 */
export interface FavoritesFs {
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  /** 列举目录内容；isDir 表示是否为集合/目录 */
  listDir(path: string): Promise<Array<{ name: string; isDir: boolean }>>
  /** 判断文件/目录是否存在 */
  exists(path: string): Promise<boolean>
}

interface MonthDir {
  ym: string
  dirPath: string
  isCurrent: boolean
}

/** 列举收藏根下所有 年份 / YYYY-MM 月份目录 */
export async function listFavoritesMonthsGeneric(fs: FavoritesFs): Promise<MonthDir[]> {
  let years: { name: string; isDir: boolean }[]
  try {
    years = await fs.listDir(FAVORITES_ROOT)
  } catch (e) {
    if (isRemoteStorageAuthError(e)) throw e
    return []
  }
  const yearDirs = years.filter((c) => c.isDir && /^\d{4}$/.test(c.name))
  const currentYM = getCurrentYM()
  const out: MonthDir[] = []

  for (const y of yearDirs) {
    const yearPath = `${FAVORITES_ROOT}/${y.name}`
    let months
    try {
      months = await fs.listDir(yearPath)
    } catch (e) {
      if (isRemoteStorageAuthError(e)) throw e
      continue
    }
    const monthDirs = months.filter((c) => c.isDir && /^\d{4}-\d{2}$/.test(c.name))
    for (const mo of monthDirs) {
      out.push({
        ym: mo.name,
        dirPath: `${yearPath}/${mo.name}`,
        isCurrent: mo.name === currentYM,
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
export async function loadFavoritesBookmarksGeneric(fs: FavoritesFs): Promise<Record<string, BookmarkEntry>> {
  const result: Record<string, BookmarkEntry> = {}
  const months = await listFavoritesMonthsGeneric(fs)

  for (const m of months) {
    let raws: RawFavoritesBookmark[] = []

    if (!m.isCurrent) {
      // 优先读取归档快照
      try {
        const raw = await fs.readFile(`${m.dirPath}/archive-${m.ym}.json`)
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) raws = parsed as RawFavoritesBookmark[]
      } catch (e) {
        if (isRemoteStorageAuthError(e)) throw e
        raws = [] // 归档缺失，回退扫描单文件
      }
    }

    if (raws.length === 0) {
      // 扫描单文件 bm_*.json
      try {
        const children = await fs.listDir(m.dirPath)
        const bmFiles = children.filter((c) => !c.isDir && BM_FILE_RE.test(c.name))
        for (const f of bmFiles) {
          try {
            const raw = await fs.readFile(`${m.dirPath}/${f.name}`)
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed)) raws.push(...(parsed as RawFavoritesBookmark[]))
            else if (parsed && typeof parsed === 'object') raws.push(parsed as RawFavoritesBookmark)
          } catch (e) {
            if (isRemoteStorageAuthError(e)) throw e
            // 单个文件失败不影响其余
          }
        }
      } catch (e) {
        if (isRemoteStorageAuthError(e)) throw e
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
export async function archiveFavoritesGeneric(fs: FavoritesFs): Promise<ArchiveResult> {
  const result: ArchiveResult = { archived: [], skipped: [], errors: [] }
  const months = await listFavoritesMonthsGeneric(fs)

  for (const m of months) {
    if (m.isCurrent) {
      result.skipped.push(`${m.ym} (当月跳过)`)
      continue
    }

    // 归档已存在则跳过（存在即完整，不补漏、不回扫）
    try {
      const existing = await fs.exists(`${m.dirPath}/archive-${m.ym}.json`)
      if (existing) {
        result.skipped.push(m.ym)
        continue
      }
    } catch (e) {
      if (isRemoteStorageAuthError(e)) throw e
      // 视为不存在，继续归档
    }

    try {
      const children = await fs.listDir(m.dirPath)
      const bmFiles = children.filter((c) => !c.isDir && BM_FILE_RE.test(c.name))
      const bookmarks: RawFavoritesBookmark[] = []
      for (const f of bmFiles) {
        try {
          const raw = await fs.readFile(`${m.dirPath}/${f.name}`)
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) bookmarks.push(...(parsed as RawFavoritesBookmark[]))
          else if (parsed && typeof parsed === 'object') bookmarks.push(parsed as RawFavoritesBookmark)
        } catch (e) {
          if (isRemoteStorageAuthError(e)) throw e
          // 忽略单个文件错误
        }
      }
      await fs.writeFile(`${m.dirPath}/archive-${m.ym}.json`, JSON.stringify(bookmarks, null, 2))
      result.archived.push(m.ym)
    } catch (e) {
      result.errors.push({ ym: m.ym, message: e instanceof Error ? e.message : String(e) })
    }
  }

  return result
}

/** WebDAV 适配器 */
function webdavFavoritesFs(config: WebDAVConfig): FavoritesFs {
  return {
    readFile: (p) => getFileContents(config, p),
    writeFile: (p, c) => putFileContents(config, p, c),
    listDir: async (p) => (await listDirectory(config, p)).map((d) => ({ name: d.name, isDir: d.isCollection })),
    exists: async (p) => (await stat(config, p)) !== null,
  }
}

// WebDAV 入口（保持旧签名，供 MainPage / SettingsDialog 调用）
export function loadFavoritesBookmarks(config: WebDAVConfig): Promise<Record<string, BookmarkEntry>> {
  return loadFavoritesBookmarksGeneric(webdavFavoritesFs(config))
}

export function archiveFavorites(config: WebDAVConfig): Promise<ArchiveResult> {
  return archiveFavoritesGeneric(webdavFavoritesFs(config))
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

/**
 * 合并两个收藏数据集（按 URL，已有数据优先并集 tags）。
 * 用于把多个收藏源（WebDAV / RemoteStorage）汇总到同一个 ref。
 */
export function mergeFavoritesData(
  existing: Record<string, BookmarkEntry> | null,
  incoming: Record<string, BookmarkEntry>,
): Record<string, BookmarkEntry> {
  if (!incoming || Object.keys(incoming).length === 0) return existing || {}
  const result: Record<string, BookmarkEntry> = { ...(existing || {}) }
  for (const [url, entry] of Object.entries(incoming)) {
    const ex = result[url]
    if (ex) {
      const tagSet = new Set(ex.tags)
      entry.tags.forEach((t) => tagSet.add(t))
      result[url] = { ...ex, tags: Array.from(tagSet) }
    } else {
      result[url] = entry
    }
  }
  return result
}
