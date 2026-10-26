/**
 * RemoteStorage 文件系统实现（onenav 侧适配层）
 *
 * 底层使用 `zen-fs-remotestoragejs` 包（直连 RemoteStorage 的 zen-fs 后端），
 * 并通过 `zen-fs-cache` 的 `CachedFileSystem` 包一层"按时间戳重校验"的缓存
 * （ETag / Last-Modified / 304），缓存持久化到 IndexedDB。
 *
 * 对外仍暴露与 universal-sync-v2 `IFileSystem` 完全兼容的接口，因此
 * sync / load / favorites 三处调用方无需改动。
 */

import {
  RemoteStorageFileSystem as ZenRsFileSystem,
  adaptFileSystem,
} from 'zen-fs-remotestoragejs'
import { CachedFileSystem, IdbCacheStore } from 'zen-fs-cache'

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
  readFile(path: string, encoding: string): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  readdir(path: string): Promise<string[]>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; mtime: Date }>
  unlink(path: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  exists(path: string): Promise<boolean>
}

/**
 * onenav 使用的 RemoteStorage 文件系统：包 + 缓存 的组合。
 *
 * 缓存键前缀 `onenav-rs:` 用于隔离 IndexedDB 中的不同数据源。
 */
export class RemoteStorageFileSystem implements IFileSystem {
  private adapter: IFileSystem
  /** 目录列表缓存的存储层：用于在同步前清掉陈旧的 readdir 结果 */
  private cacheStore: IdbCacheStore
  /** 缓存键前缀，keys() 返回的是带前缀的键，剥离后才能交给 delete() */
  private cachePrefix = 'onenav-rs:'

  constructor(config: RemoteStorageConfig) {
    const rsfs = new ZenRsFileSystem({
      href: config.href,
      token: config.token,
      timeout: config.timeout || 30000,
    })

    // 缓存层：每次读取都带条件请求做时间戳重校验；
    // ttlMs 设为 2 分钟——2 分钟内直接命中 IndexedDB 缓存零网络往返，
    // 超时后再发一次条件请求（未变更则廉价 304），写操作会立即失效对应键，
    // 因此多端写入的可见延迟 ≈ 2 分钟，对书签同步完全可接受。
    this.cacheStore = new IdbCacheStore(this.cachePrefix)
    const cached = new CachedFileSystem(rsfs, this.cacheStore, {
      ttlMs: 2 * 60 * 1000,
    })

    this.adapter = adaptFileSystem(cached) as unknown as IFileSystem
  }

  /**
   * 清除所有「目录列表（readdir）」缓存。
   *
   * 为什么需要它：
   * CachedFileSystem.readdir 会把目录清单（dir:<path>）持久化到 IndexedDB 并按 ttlMs 缓存。
   * 而写入文件只会失效**直接父目录**的 dir 键（内部 invalidateMeta 的行为），
   * 祖先目录链（如 /onenav/data、/onenav/data/2026、/onenav/data/2026/10）不会被失效。
   * 后果：push 新建了「新的月份/日期目录」后，紧接着的 pull 仍会命中旧的目录清单，
   * 看不到新目录 → `listAllDataFiles()` 拿不到新文件 → 表现为「能 push 但 pull 不到」。
   *
   * 因此每次同步开始前清一次目录缓存，保证 pull 总能枚举到最新的远端目录结构。
   * 只删 dir: 键、保留 file: 键，所以不会让已缓存的文件内容白白重读。
   */
  async invalidateDirListing(): Promise<void> {
    try {
      // keys() 在实现中存在，但包的 .d.ts 未声明，故做能力检测后再用
      const store = this.cacheStore as unknown as { keys?: () => Promise<string[]> }
      if (typeof store.keys !== 'function') {
        console.warn('[RS FS] 缓存 store 不支持枚举键，跳过目录缓存清理')
        return
      }
      const keys = (await store.keys()) ?? []
      let removed = 0
      for (const raw of keys) {
        const key = raw.startsWith(this.cachePrefix) ? raw.slice(this.cachePrefix.length) : raw
        if (!key.startsWith('dir:')) continue
        await this.cacheStore.delete(key)
        removed++
      }
      if (removed > 0) {
        console.log(`[RS FS] 已清除 ${removed} 项远端目录列表缓存，确保本次 pull 能看到最新文件`)
      }
    } catch (err) {
      // 清缓存失败不应阻断同步：最坏情况是沿用旧目录清单
      console.warn('[RS FS] 清除目录列表缓存失败（已忽略）:', err)
    }
  }

  readFile(path: string, encoding: string): Promise<string> {
    return this.adapter.readFile(path, encoding)
  }

  writeFile(path: string, data: string): Promise<void> {
    return this.adapter.writeFile(path, data)
  }

  readdir(path: string): Promise<string[]> {
    return this.adapter.readdir(path)
  }

  mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    return this.adapter.mkdir(path, options)
  }

  stat(path: string) {
    return this.adapter.stat(path)
  }

  unlink(path: string): Promise<void> {
    return this.adapter.unlink(path)
  }

  rename(oldPath: string, newPath: string): Promise<void> {
    return this.adapter.rename(oldPath, newPath)
  }

  exists(path: string): Promise<boolean> {
    return this.adapter.exists(path)
  }
}
