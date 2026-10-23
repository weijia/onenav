/**
 * Gitee 公共收藏源
 *
 * 用 Gitee 公开仓库的 contents API **匿名只读** 一个 JSON 文件（favorites.json），
 * 把它解析成书签。不需要 access_token —— Gitee 对公开仓库允许匿名访问
 * （同一 IP 60 次/小时），且响应带 `Access-Control-Allow-Origin: *`，浏览器可直连，
 * 因此这里不引入任何密钥配置。
 *
 * 数据只存在于内存并与收藏源合并渲染，不会写入本地 PouchDB，
 * 也就不会被同步到用户的 WebDAV / RemoteStorage。
 */

import type { BookmarkEntry } from '@/types'

export interface GiteeFavoritesSource {
  owner: string
  repo: string
  /** 仓库内文件路径 */
  path: string
  /** 分支 / ref */
  branch: string
}

export const DEFAULT_GITEE_FAVORITES_SOURCE: GiteeFavoritesSource = {
  owner: 'weijia432',
  repo: 'public-links',
  path: 'favorites.json',
  branch: 'master',
}

const STORAGE_KEY = 'onenav:giteeFavoritesSource'

/** 读取收藏源配置（可在控制台里覆盖，便于换仓库调试） */
export function loadGiteeFavoritesSource(): GiteeFavoritesSource {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_GITEE_FAVORITES_SOURCE
    const parsed = JSON.parse(raw) as Partial<GiteeFavoritesSource>
    return { ...DEFAULT_GITEE_FAVORITES_SOURCE, ...parsed }
  } catch {
    return DEFAULT_GITEE_FAVORITES_SOURCE
  }
}

/** Gitee 的 content 是带换行的 base64，且通常是 UTF-8 中文 */
function decodeBase64Utf8(b64: string): string {
  const clean = b64.replace(/\s/g, '')
  const bin = atob(clean)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** 归一化后的收藏条目 */
export interface ParsedFavoriteItem {
  url: string
  title: string
  /** 所属分组 / 标签，至少一项 */
  tags: string[]
}

/** favorites.json 里的一条链接 */
interface RawLink {
  title?: unknown
  name?: unknown
  url?: unknown
  href?: unknown
  link?: unknown
  tags?: unknown
}

/** favorites.json 的一个分组 */
interface RawGroup {
  title?: unknown
  name?: unknown
  tag?: unknown
  links?: unknown
  items?: unknown
}

/** favorites.json 的整体结构 */
export interface RawFavoritesFile {
  version?: unknown
  defaultTag?: unknown
  groups?: unknown
  links?: unknown
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function tagList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value]
  return list
    .map((t) => str(t))
    .filter((t): t is string => !!t)
}

/**
 * 把 favorites.json 的内容归一化成条目列表。
 *
 * 支持两种写法，可同时使用：
 *
 * ```json
 * {
 *   "defaultTag": "收藏",
 *   "groups": [{ "title": "应用", "links": [{ "title": "MyTodo", "url": "https://..." }] }],
 *   "links": [{ "title": "独立条目", "url": "https://...", "tags": ["常用"] }]
 * }
 * ```
 *
 * - `groups`：每条 link 归入所在分组（分组名作为 tag，同时并入 link 自带的 tags）
 * - `links`：平铺条目，用自带 tags，没有则落到 `defaultTag`（默认「收藏」）
 * - 非法条目（缺 URL / 不是 http(s)）直接跳过，不会因为一条脏数据整体失败
 */
export function parseFavoritesJson(file: RawFavoritesFile): ParsedFavoriteItem[] {
  const defaultTag = str(file.defaultTag) || '收藏'
  const out: ParsedFavoriteItem[] = []

  const push = (raw: unknown, groupTags: string[]) => {
    if (!raw || typeof raw !== 'object') return
    const link = raw as RawLink
    const url = str(link.url) || str(link.href) || str(link.link)
    if (!isHttpUrl(url)) return
    const title = str(link.title) || str(link.name) || hostOf(url)
    const tags = [...groupTags, ...tagList(link.tags)]
    const deduped = Array.from(new Set(tags.filter(Boolean)))
    out.push({ url, title, tags: deduped.length ? deduped : [defaultTag] })
  }

  if (Array.isArray(file.groups)) {
    for (const g of file.groups) {
      if (!g || typeof g !== 'object') continue
      const group = g as RawGroup
      const groupTags = tagList([str(group.title) || str(group.name) || str(group.tag)]).filter(Boolean)
      const links = Array.isArray(group.links)
        ? group.links
        : Array.isArray(group.items)
          ? group.items
          : []
      for (const link of links) push(link, groupTags)
    }
  }

  if (Array.isArray(file.links)) {
    for (const link of file.links) push(link, [])
  }

  return out
}

/**
 * 读取 Gitee 公共仓库里的收藏 JSON，返回以 URL 为 key 的书签表。
 * 失败会抛错，由调用方决定如何降级（一般是打个日志后忽略）。
 */
export async function loadGiteeFavorites(
  source: GiteeFavoritesSource = loadGiteeFavoritesSource()
): Promise<Record<string, BookmarkEntry>> {
  const filePath = source.path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
  const url =
    `https://gitee.com/api/v5/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}` +
    `/contents/${filePath}?ref=${encodeURIComponent(source.branch)}`

  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    throw new Error(`Gitee 读取失败: ${res.status} ${res.statusText}`)
  }
  const payload = await res.json()
  // 路径不存在时 Gitee 返回 200 + `[]`（不是 404），这里一并识别成「没这个文件」
  if (Array.isArray(payload)) {
    throw new Error(`Gitee 上找不到 ${source.path}（可能还没推送到 ${source.branch} 分支）`)
  }
  if (typeof payload?.content !== 'string' || payload.encoding !== 'base64') {
    throw new Error('Gitee 返回的内容格式不是预期的 base64')
  }

  const text = decodeBase64Utf8(payload.content)
  let parsed: RawFavoritesFile
  try {
    parsed = JSON.parse(text) as RawFavoritesFile
  } catch (e) {
    throw new Error(`favorites.json 解析失败: ${(e as Error).message}`)
  }

  const items = parseFavoritesJson(parsed)

  const result: Record<string, BookmarkEntry> = {}
  const now = Date.now()
  for (const item of items) {
    if (result[item.url]) continue // 同一 URL 只保留首次出现
    result[item.url] = {
      tags: item.tags,
      meta: {
        url: item.url,
        title: item.title,
        created: now,
        updated: now,
      },
    }
  }
  return result
}
