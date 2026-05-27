/**
 * 简化的 RemoteStorage 文件系统实现
 * 用于与 universal-sync-v2 集成
 */

export interface RemoteStorageConfig {
  href: string
  token: string
  basePath?: string
  headers?: Record<string, string>
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
  private headers: Headers
  private timeout: number
  private basePath: string

  private config: RemoteStorageConfig

  constructor(config: RemoteStorageConfig) {
    this.config = config
    this.baseUrl = config.href.endsWith('/') ? config.href.slice(0, -1) : config.href
    this.basePath = config.basePath || '/public/'
    this.headers = new Headers({
      'Authorization': `Bearer ${config.token}`,
      'Content-Type': 'application/json',
      ...config.headers,
    })
    this.timeout = config.timeout || 30000
  }

  private buildUrl(path: string): string {
    const normalizedPath = path.startsWith('/') ? path.slice(1) : path
    const fullPath = this.basePath + normalizedPath
    return this.baseUrl + fullPath
  }

  private async makeRequest(url: string, options: RequestInit = {}): Promise<Response> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)
    
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Authorization': `Bearer ${this.config.token}`,
          ...this.headers,
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
      throw new Error(`Failed to read file: ${response.status}`)
    }
    
    if (encoding === 'utf8' || encoding === 'utf-8') {
      return await response.text()
    }
    
    const arrayBuffer = await response.arrayBuffer()
    return new Uint8Array(arrayBuffer)
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const url = this.buildUrl(path)
    
    const headers = new Headers(this.headers)
    if (typeof data === 'string') {
      headers.set('Content-Type', 'text/plain; charset=utf-8')
    } else {
      headers.set('Content-Type', 'application/octet-stream')
    }
    
    const response = await this.makeRequest(url, {
      method: 'PUT',
      body: data as BodyInit,
      headers,
    })
    
    if (!response.ok) {
      throw new Error(`Failed to write file: ${response.status}`)
    }
  }

  async unlink(_path: string): Promise<void> {
    const url = this.buildUrl(_path)
    const response = await this.makeRequest(url, { method: 'DELETE' })
    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to delete file: ${response.status}`)
    }
  }

  async readdir(_path: string): Promise<string[]> {
    const url = this.buildUrl(_path)
    const response = await this.makeRequest(url, {
      method: 'GET',
      headers: { 'Accept': 'application/ld+json' },
    })
    
    if (!response.ok) {
      throw new Error(`Failed to read directory: ${response.status}`)
    }

    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/ld+json')) {
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
    }
    return []
  }

  async mkdir(_path: string): Promise<void> {
    // RemoteStorage 不需要显式创建目录
  }

  async rmdir(_path: string): Promise<void> {
    // 空实现，RemoteStorage 会自动处理
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const content = await this.readFile(oldPath)
    await this.writeFile(newPath, content)
    await this.unlink(oldPath)
  }

  async stat(_path: string): Promise<{ size: number; mtimeMs: number; isDirectory(): boolean; isFile(): boolean }> {
    const url = this.buildUrl(_path)
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

  async exists(_path: string): Promise<boolean> {
    try {
      await this.stat(_path)
      return true
    } catch {
      return false
    }
  }
}
