import type { WebDAVConfig } from '@/types'

function getAuthHeader(config: WebDAVConfig): string {
  return 'Basic ' + btoa(`${config.username}:${config.password}`)
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

export async function getFileContents(config: WebDAVConfig, path: string): Promise<string> {
  const baseUrl = normalizeUrl(config.url)
  const fullPath = path.startsWith('/') ? path : `/${path}`
  // 添加时间戳参数防止浏览器缓存
  const url = `${baseUrl}${fullPath}?_t=${Date.now()}`

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': getAuthHeader(config),
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch ${path}: ${response.status} ${response.statusText}`)
  }

  return response.text()
}

export async function putFileContents(config: WebDAVConfig, path: string, data: string): Promise<void> {
  const baseUrl = normalizeUrl(config.url)
  const fullPath = path.startsWith('/') ? path : `/${path}`
  const url = `${baseUrl}${fullPath}`

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': getAuthHeader(config),
      'Content-Type': 'application/json',
    },
    body: data,
  })

  if (!response.ok) {
    throw new Error(`Failed to put ${path}: ${response.status} ${response.statusText}`)
  }
}

/**
 * 创建 WebDAV 目录（如果不存在）
 */
export async function createDirectory(config: WebDAVConfig, path: string): Promise<void> {
  const baseUrl = normalizeUrl(config.url)
  const fullPath = path.startsWith('/') ? path : `/${path}`
  const url = `${baseUrl}${fullPath}`

  const response = await fetch(url, {
    method: 'MKCOL',
    headers: {
      'Authorization': getAuthHeader(config),
    },
  })

  // 201 Created 或 405 Method Not Allowed（目录已存在）都算成功
  if (response.status !== 201 && response.status !== 405) {
    throw new Error(`Failed to create directory ${path}: ${response.status} ${response.statusText}`)
  }
}

export async function stat(config: WebDAVConfig, path: string): Promise<{ etag: string; lastmod: string } | null> {
  const baseUrl = normalizeUrl(config.url)
  const fullPath = path.startsWith('/') ? path : `/${path}`
  const url = `${baseUrl}${fullPath}`

  const response = await fetch(url, {
    method: 'PROPFIND',
    headers: {
      'Authorization': getAuthHeader(config),
      'Depth': '0',
      'Content-Type': 'application/xml',
    },
  })

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    throw new Error(`Failed to stat ${path}: ${response.status} ${response.statusText}`)
  }

  const text = await response.text()
  const etagMatch = text.match(/<D:getetag>([^<]+)<\/D:getetag>/)
  const lastmodMatch = text.match(/<D:getlastmodified>([^<]+)<\/D:getlastmodified>/)

  return {
    etag: etagMatch?.[1] ?? '',
    lastmod: lastmodMatch?.[1] ?? '',
  }
}

/**
 * 测试 WebDAV 连接是否有效（访问根目录）
 */
export async function testConnection(config: WebDAVConfig): Promise<boolean> {
  const baseUrl = normalizeUrl(config.url)

  const response = await fetch(baseUrl, {
    method: 'PROPFIND',
    headers: {
      'Authorization': getAuthHeader(config),
      'Depth': '0',
      'Content-Type': 'application/xml',
    },
  })

  // 207 Multi-Status 是 PROPFIND 的成功响应
  // 200 OK 也表示连接成功
  return response.status === 207 || response.status === 200
}

export interface DirEntry {
  /** 条目名称（最后一段路径），如 "2026" 或 "bm_xxx.json" */
  name: string
  /** 相对 WebDAV 根的路径（不含前导斜杠），可直接用于本模块其它方法 */
  path: string
  isCollection: boolean
}

/**
 * 列举 WebDAV 目录内容（PROPFIND Depth:1）。
 * 返回的每个 entry.path 都是相对路径（不含前导斜杠），
 * 可直接用于 getFileContents / putFileContents / listDirectory。
 * 目录不存在（404）时返回空数组。
 */
export async function listDirectory(config: WebDAVConfig, path: string): Promise<DirEntry[]> {
  const baseUrl = normalizeUrl(config.url)
  const fullPath = path.startsWith('/') ? path : `/${path}`
  const url = `${baseUrl}${fullPath}`

  const body = '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>'

  const response = await fetch(url, {
    method: 'PROPFIND',
    headers: {
      'Authorization': getAuthHeader(config),
      'Depth': '1',
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body,
  })

  // 目录不存在视为空
  if (response.status === 404) return []
  if (!response.ok) {
    throw new Error(`Failed to list ${path}: ${response.status} ${response.statusText}`)
  }

  const text = await response.text()
  return parseMultistatus(config, text, fullPath)
}

function parseMultistatus(config: WebDAVConfig, xml: string, requestedPath: string): DirEntry[] {
  const base = normalizeUrl(config.url)
  let basePath = ''
  try {
    basePath = new URL(base).pathname.replace(/^\/+/, '').replace(/\/+$/, '')
  } catch {
    basePath = ''
  }

  const reqNorm = requestedPath.replace(/^\/+/, '').replace(/\/+$/, '')

  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const responses = doc.getElementsByTagNameNS('*', 'response')
  const entries: DirEntry[] = []

  for (let i = 0; i < responses.length; i++) {
    const resp = responses[i]
    const hrefEl =
      resp.getElementsByTagNameNS('*', 'href')[0] ||
      resp.getElementsByTagName('href')[0]
    if (!hrefEl || !hrefEl.textContent) continue

    let rawHref = decodeURIComponent(hrefEl.textContent)
    // 转为纯路径部分（兼容完整 URL 与纯路径两种 href 形式）
    let pathPart: string
    try {
      pathPart = new URL(rawHref).pathname
    } catch {
      pathPart = rawHref
    }
    pathPart = pathPart.replace(/^\/+/, '').replace(/\/+$/, '')

    // 去掉 WebDAV 根路径前缀
    if (basePath && pathPart.startsWith(basePath + '/')) {
      pathPart = pathPart.slice(basePath.length)
    } else if (basePath && pathPart === basePath) {
      pathPart = ''
    }
    pathPart = pathPart.replace(/^\/+/, '').replace(/\/+$/, '')

    // 跳过自身（Depth:1 的第一个 response 通常是目录本身）
    if (pathPart === reqNorm || pathPart === '') continue

    const name = pathPart.split('/').pop() || pathPart

    // 判断是否为集合（目录）
    const rtEl =
      resp.getElementsByTagNameNS('*', 'resourcetype')[0] ||
      resp.getElementsByTagName('resourcetype')[0]
    let isCollection = false
    if (rtEl) {
      isCollection =
        !!rtEl.getElementsByTagNameNS('*', 'collection')[0] ||
        !!rtEl.getElementsByTagName('collection')[0]
    }

    entries.push({ name, path: pathPart, isCollection })
  }

  return entries
}
