import type { BookmarkEntry, ArchiveResult } from '@/types'
import { RemoteStorageFileSystem } from '@/lib/remotestorage-fs'
import { getSavedStorageCredentials, getStorageCredentials, isRemoteStorageAuthError } from '@/lib/remotestorage-connection'
import {
  listFavoritesMonthsGeneric,
  loadFavoritesBookmarksGeneric,
  archiveFavoritesGeneric,
} from '@/lib/favorites'
import type { FavoritesFs } from '@/lib/favorites'

/**
 * RemoteStorage 收藏源适配器。
 * 复用「原来的 RemoteStorage 连接」（remotestorage-connection 登录态），
 * 书签位于 RemoteStorage 存储空间下的 app_data/favorites（与 WebDAV 版路径一致）。
 */

/** RS 收藏功能是否可用：要求已连接 RemoteStorage 且拿到凭据 */
export function isRemoteStorageFavoritesAvailable(): boolean {
  return getStorageCredentials() !== null || getSavedStorageCredentials() !== null
}

function rsFavoritesFs(): FavoritesFs {
  const credentials = getStorageCredentials() || getSavedStorageCredentials()
  if (!credentials) {
    throw new Error('RemoteStorage 未配置，无法访问收藏源')
  }
  const fs = new RemoteStorageFileSystem({ href: credentials.href, token: credentials.token })
  const toEntries = (names: string[]) =>
    names.map((n) => {
      const name = n.replace(/^\.\//, '').replace(/\/$/, '')
      return { name, isDir: n.endsWith('/') }
    })
  return {
    readFile: (p) => fs.readFile(p, 'utf8'),
    writeFile: (p, c) => fs.writeFile(p, c),
    listDir: async (p) => {
      // 不同 RemoteStorage 服务器对文件夹列举的结尾斜杠要求不同：
      // 先按原样尝试，若为空（404 返回 []）再尝试带结尾斜杠，取非空结果。
      try {
        const a = toEntries(await fs.readdir(p))
        if (a.length > 0) return a
      } catch (e) {
        if (isRemoteStorageAuthError(e)) throw e
        // 忽略，尝试带斜杠
      }
      if (!p.endsWith('/')) {
        try {
          const b = toEntries(await fs.readdir(`${p}/`))
          if (b.length > 0) return b
        } catch (e) {
          if (isRemoteStorageAuthError(e)) throw e
          // 忽略
        }
      }
      return []
    },
    exists: (p) => fs.exists(p),
  }
}

export async function loadFavoritesBookmarksFromRS(): Promise<Record<string, BookmarkEntry>> {
  return loadFavoritesBookmarksGeneric(rsFavoritesFs())
}

export async function archiveFavoritesOnRS(): Promise<ArchiveResult> {
  return archiveFavoritesGeneric(rsFavoritesFs())
}

// 仅用于保持列表接口一致（供需要时调用，当前主流程直接用泛型函数）
export async function listFavoritesMonthsOnRS() {
  return listFavoritesMonthsGeneric(rsFavoritesFs())
}
