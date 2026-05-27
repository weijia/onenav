/**
 * 简化的 RemoteStorage 文件系统实现
 * 用于与 universal-sync-v2 集成
 * 
 * RemoteStorage 路径格式：
 * - href: https://storage.5apps.com/weijia/
 * - 模块路径: /onenav/（由 universal-sync-v2 的 basePath 提供）
 * - 最终 URL: href + 模块路径 + 文件路径
 */

export interface RemoteStorageConfig {
  /** RemoteStorage 存储地址，如 https://storage.5apps.com/weijia/ */
  href: string
  /** Bearer token */
  token: string
  /** 请求超时（毫秒） */
  timeout?: number
}

/**
 * 简单的文件系统接口，兼容 universal-sync-v2 的 IFileSystem
 */
export interface SimpleFileSystem {
  readFile(path: string, encoding?: string): Promise<string | Uint8Array>
  writeFile(path: string, data: string | Uint8Array): Promise<void>
  unlink(path: string): Promise<void>
  readdir(path: string): Promise<string[]>
  mkdir(path: string): Promise<void>
  rmdir(path: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  stat(path: string): Promise<{ size: number; mtimeMs: number; isDirectory(): boolean; isFile(): boolean }>
  exists(path: string): Promise<boolean>
}

export class RemoteStorageFileSystem implements SimpleFileSystem {
  private baseUrl: string
  private token: string
  private timeout: number

  constructor(config: RemoteStorageConfig) {
    // 确保 baseUrl 不以 / 结尾
    this.baseUrl = config.href.endsWith('/') ? config.href.slice(0, -1) : config.href
    this.token = config.token
    this.timeout = config.timeout || 30000
  }

  /**
   * 构建完整 URL
   * path 格式: /onenav/data/2026/05/manifest.json
   * 最终 URL: https://storage.5apps.com/weijia/onenav/data/2026/05/manifest.json
   */
  private buildUrl(path: string): string {
    // 去掉 path 开头的斜杠
    const normalizedPath = path.startsWith('/') ? path.slice(1) : path
    return this.baseUrl + '/' + normalizedPath
  }

  private async makeRequest(url: string, options: RequestInit = {}): Promise<Response> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)
    
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          ...options.headers,
        },
        signal: controller.signal,
      })
      clearTimeout(timeoutId)
      return response
    } catch (error) {
      clearTimeout(timeoutId)
      throw error
    }
  }

  async readFile(path: string, encoding?: string): Promise<string | Uint8Array> {
    const url = this.buildUrl(path)
    const response = await this.makeRequest(url, { method: 'GET' })
    if (!response.ok) {
      throw new Error(`Failed to read file: ${response.status} ${response.statusText}`)
    }
    
    if (encoding === 'utf8' || encoding === 'utf-8') {
      return await response.text()
    }
    
    const arrayBuffer = await response.arrayBuffer()
    return new Uint8Array(arrayBuffer)
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const url = this.buildUrl(path)
    
    // RemoteStorage 要求正确的 Content-Type
    let contentType = 'application/json'
    if (path.endsWith('.json')) {
      contentType = 'application/json'
    } else if (typeof data === 'string') {
      contentType = 'text/plain; charset=utf-8'
    } else {
      contentType = 'application/octet-stream'
    }
    
    const response = await this.makeRequest(url, {
      method: 'PUT',
      body: data as BodyInit,
      headers: {
        'Content-Type': contentType,
      },
    })
    
    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Failed to write file: ${response.status} ${response.statusText} - ${errorText}`)
    }
  }

  async unlink(path: string): Promise<void> {
    const url = this.buildUrl(path)
    const response = await this.makeRequest(url, { method: 'DELETE' })
    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to delete file: ${response.status}`)
    }
  }

  async readdir(path: string): Promise<string[]> {
    const url = this.buildUrl(path)
    const response = await this.makeRequest(url, {
      method: 'GET',
      headers: { 'Accept': 'application/ld+json' },
    })
    
    if (!response.ok) {
      if (response.status === 404) {
        return [] // 目录不存在，返回空数组
      }
      throw new Error(`Failed to read directory: ${response.status}`)
    }

    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/ld+json') || contentType.includes('application/json')) {
      try {
        const listing = await response.json()
        const items: string[] = []
        if (listing['@graph']) {
          for (const item of listing['@graph']) {
            if (item['@id'] && item['@id'] !== './') {
              const name = item['@id'].replace(/\/$/, '')
              if (name) items.push(name)
            }
          }
        }
        return items
      } catch {
        return []
      }
    }
    return []
  }

  async mkdir(_path: string): Promise<void> {
    // RemoteStorage 不需要显式创建目录，写入文件时自动创建
  }

  async rmdir(_path: string): Promise<void> {
    // 空实现，RemoteStorage 会自动处理
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const content = await this.readFile(oldPath)
    await this.writeFile(newPath, content)
    await this.unlink(oldPath)
  }

  async stat(path: string): Promise<{ size: number; mtimeMs: number; isDirectory(): boolean; isFile(): boolean }> {
    const url = this.buildUrl(path)
    const response = await this.makeRequest(url, { method: 'HEAD' })
    
    if (!response.ok) {
      throw new Error(`Failed to stat: ${response.status}`)
    }

    const contentLength = response.headers.get('content-length')
    const lastModified = response.headers.get('last-modified')
    const size = contentLength ? parseInt(contentLength, 10) : 0
    const mtime = lastModified ? new Date(lastModified).getTime() : Date.now()

    return {
      size,
      mtimeMs: mtime,
      isDirectory: () => false,
      isFile: () => true,
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path)
      return true
    } catch {
      return false
    }
  }
}