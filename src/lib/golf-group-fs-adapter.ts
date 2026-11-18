/**
 * 把 zen-fs-config 数据组的文件视图（group.fs.promises）适配成
 * universal-sync-v2 需要的 IFileSystem。
 *
 * 两者差异：
 *  - chroot fs 的 stat 返回 { mode, size, mtimeMs }，IFileSystem 要 { isFile(), isDirectory(), mtime, size }。
 *    目录判定用 mode & 0o40000（S_IFDIR = 16384），与 zen-fs-config 内部一致。
 *  - chroot fs 路径相对组根；universal-sync-v2 会带 basePath 前缀（本场景固定 '/golf'），
 *    这里把 basePath 视为组内目录，不做剥离——数据组 fs 根 '/' 可写，'golf/data/...' 自然成目录。
 */
import type { AppDataGroup } from 'zen-fs-config'

const S_IFDIR = 0o40000

export interface IFileSystem {
  readFile(path: string, encoding: string): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  readdir(path: string): Promise<string[]>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; mtime: Date; size?: number }>
  unlink(path: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  exists(path: string): Promise<boolean>
  rmdir?(path: string): Promise<void>
}

/** group.fs.promises 的最小形状 */
interface GroupPromisesFs {
  readFile(path: string, encoding?: string): Promise<any>
  writeFile(path: string, data: string | Uint8Array, options?: any): Promise<void>
  readdir(path: string): Promise<string[]>
  stat(path: string): Promise<{ mode?: number; size?: number; mtimeMs?: number }>
  mkdir(path: string, options?: any): Promise<any>
  unlink(path: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  exists(path: string): Promise<boolean>
  rmdir?(path: string): Promise<void>
}

function normalizePath(p: string): string {
  const withSlash = p.startsWith('/') ? p : `/${p}`
  return withSlash.replace(/\/+/g, '/')
}

export function adaptDataGroupFs(group: AppDataGroup): IFileSystem {
  const p = (group as any).fs?.promises as GroupPromisesFs | undefined
  if (!p) throw new Error('数据组没有可用的 fs.promises，无法适配同步引擎')

  return {
    async readFile(path, encoding) {
      const data = await p.readFile(normalizePath(path), encoding || 'utf8')
      if (typeof data === 'string') return data
      if (data instanceof Uint8Array) return new TextDecoder().decode(data)
      return String(data)
    },
    async writeFile(path, data) {
      await p.writeFile(normalizePath(path), data)
    },
    async readdir(path) {
      const entries = await p.readdir(normalizePath(path))
      return entries.map((e) => (typeof e === 'string' ? e : String((e as any).name ?? e)))
    },
    async mkdir(path, options) {
      const full = normalizePath(path)
      if (options?.recursive) {
        // 部分后端（如 InMemory）的 mkdir 不认 recursive，逐级创建并忽略 EEXIST。
        const parts = full.split('/').filter(Boolean)
        let cur = ''
        for (const part of parts) {
          cur += `/${part}`
          try {
            await p.mkdir(cur)
          } catch (e: any) {
            if (e?.code !== 'EEXIST' && !/exist/i.test(String(e?.message ?? e))) throw e
          }
        }
        return
      }
      await p.mkdir(full)
    },
    async stat(path) {
      const s = await p.stat(normalizePath(path))
      const mode = typeof s.mode === 'number' ? s.mode : 0
      const isDir = (mode & S_IFDIR) === S_IFDIR
      const size = typeof s.size === 'number' ? s.size : 0
      return {
        isFile: () => !isDir,
        isDirectory: () => isDir,
        mtime: new Date(typeof s.mtimeMs === 'number' ? s.mtimeMs : Date.now()),
        size,
      }
    },
    async unlink(path) {
      await p.unlink(normalizePath(path))
    },
    async rename(oldPath, newPath) {
      await p.rename(normalizePath(oldPath), normalizePath(newPath))
    },
    async exists(path) {
      return p.exists(normalizePath(path))
    },
    async rmdir(path) {
      if (p.rmdir) await p.rmdir(normalizePath(path))
    },
  }
}
