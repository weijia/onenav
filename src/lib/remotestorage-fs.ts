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
    const cached = new CachedFileSystem(rsfs, new IdbCacheStore('onenav-rs:'), {
      ttlMs: 2 * 60 * 1000,
    })

    this.adapter = adaptFileSystem(cached) as unknown as IFileSystem
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
