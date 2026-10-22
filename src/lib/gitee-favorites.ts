/**
 * Gitee 公共收藏源
 *
 * 用 Gitee 公开仓库的 contents API **匿名只读** 一个 Markdown 文件（如 favorites.md），
 * 把里面的链接解析成书签。不需要 access_token —— Gitee 对公开仓库允许匿名访问
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
  path: 'favorites.md',
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

export interface ParsedMarkdownLink {
  url: string
  title: string
  /** 所属分组（最近一个标题） */
  group: string
}

/**
 * 解析 Markdown 里的链接。
 *
 * - `#` / `##` 标题作为分组标签，其下条目归入该分组
 * - `- [标题](链接)` 是标准写法；`- <链接>` 或 `- 链接` 也支持
 * - 代码块、HTML 注释、空行一律忽略，便于在文件里写格式说明
 */
export function parseMarkdownLinks(markdown: string): ParsedMarkdownLink[] {
  const out: ParsedMarkdownLink[] = []
  let group = '收藏'
  let inFence = false

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim()

    // 代码块围栏：```text 也可能带语言，单独判断结尾要注意已经是 trim 后的结果
    if (line.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (!line) continue
    if (line.startsWith('<!--')) continue

    const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(line)
    if (heading) {
      const name = heading[1].trim()
      if (name) group = name
      continue
    }

    const item = /^[-*+]\s+(.*)$/.exec(line)
    if (!item) continue
    const body = item[1].trim()

    const linked = /^\[([^\]]*)\]\(\s*<?([^)\s>]+)>?/.exec(body)
    if (linked) {
      const url = linked[2]
      if (isHttpUrl(url)) {
        out.push({ url, title: linked[1].trim() || hostOf(url), group })
      }
      continue
    }

    const bare = /^<?\s*(https?:\/\/[^\s>]+)>?$/.exec(body)
    if (bare && isHttpUrl(bare[1])) {
      out.push({ url: bare[1], title: hostOf(bare[1]), group })
    }
  }

  return out
}

/**
 * 读取 Gitee 公共仓库里的收藏文件，返回以 URL 为 key 的书签表。
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
  const json = await res.json()
  if (typeof json?.content !== 'string' || json.encoding !== 'base64') {
    throw new Error('Gitee 返回的内容格式不是预期的 base64')
  }

  const markdown = decodeBase64Utf8(json.content)
  const links = parseMarkdownLinks(markdown)

  const result: Record<string, BookmarkEntry> = {}
  const now = Date.now()
  for (const link of links) {
    if (result[link.url]) continue // 同一 URL 只保留首次出现
    result[link.url] = {
      tags: [link.group],
      meta: {
        url: link.url,
        title: link.title,
        created: now,
        updated: now,
      },
    }
  }
  return result
}
