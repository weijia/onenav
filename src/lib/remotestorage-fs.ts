/**
 * RemoteStorage 文件系统实现
 * 完全兼容 universal-sync-v2 的 IFileSystem 接口
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
 * IFileSystem 接口（来自 universal-sync-v2）
 */
export interface IFileSystem {
  readFile(path: string, encoding: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; mtime: Date }>;
  unlink(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export class RemoteStorageFileSystem implements IFileSystem {
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
   */
  private buildUrl(path: string): string {
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

  async readFile(path: string, _encoding: string): Promise<string> {
    const url = this.buildUrl(path)
    const response = await this.makeRequest(url, { method: 'GET' })
    if (!response.ok) {
      throw new Error(`Failed to read file: ${response.status} ${response.statusText}`)
    }
    return await response.text()
  }

  async writeFile(path: string, data: string): Promise<void> {
    const url = this.buildUrl(path)
    
    const contentType = path.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8'
    
    const response = await this.makeRequest(url, {
      method: 'PUT',
      body: data,
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
        return []
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

  async mkdir(_path: string, _options?: { recursive?: boolean }): Promise<void> {
    // RemoteStorage 不需要显式创建目录
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const content = await this.readFile(oldPath, 'utf8')
    await this.writeFile(newPath, content)
    await this.unlink(oldPath)
  }

  async stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; mtime: Date }> {
    const url = this.buildUrl(path)
    const response = await this.makeRequest(url, { method: 'HEAD' })
    
    if (!response.ok) {
      throw new Error(`Failed to stat: ${response.status}`)
    }

    const lastModified = response.headers.get('last-modified')
    const mtime = lastModified ? new Date(lastModified) : new Date()

    return {
      isDirectory: () => false,
      isFile: () => true,
      mtime,
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