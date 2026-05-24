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
  const url = `${baseUrl}${fullPath}`

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
