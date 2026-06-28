/**
 * Share Inbox - onenav-temp/ 共享书签池
 *
 * 写入：手机分享链接时保存到 RemoteStorage onenav-temp/
 * 读取：启动时导入本地不存在的 URL（已存在则忽略）
 */

import { RemoteStorageFileSystem, type RemoteStorageConfig } from './remotestorage-fs'
import { saveBookmark, getAllBookmarks, getPouchDB, PREFIX } from './pouchdb'
import type { BookmarkDoc } from './pouchdb'

const INBOX_DIR = 'onenav-temp'
const PENDING_KEY = PREFIX.CONFIG + 'pending-shares'

/** 简单的字符串 hash */
function hashUrl(url: string): string {
  let hash = 0
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i)
    hash = ((hash << 5) - hash + char) | 0
  }
  return Math.abs(hash).toString(36).slice(0, 8)
}

/** 生成收件箱文件名 */
function inboxFilename(url: string): string {
  return `${Date.now()}_${hashUrl(url)}.json`
}

/** 写入分享链接到 RemoteStorage onenav-temp/ */
export async function writeSharedLink(
  fs: RemoteStorageFileSystem,
  url: string,
  title: string
): Promise<void> {
  const data = JSON.stringify({
    url,
    title: title || url,
    sharedAt: Date.now(),
  }, null, 2)
  const filename = `${INBOX_DIR}/${inboxFilename(url)}`
  await fs.writeFile(filename, data)
  console.log('[ShareInbox] 已写入:', filename)
}

/** 读取 onenav-temp/ 中的所有链接 */
export async function readAllSharedLinks(
  fs: RemoteStorageFileSystem
): Promise<Array<{ url: string; title: string; sharedAt: number }>> {
  try {
    const files = await fs.readdir(INBOX_DIR)
    const results: Array<{ url: string; title: string; sharedAt: number }> = []

    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const content = await fs.readFile(`${INBOX_DIR}/${file}`, 'utf8')
        const data = JSON.parse(content)
        if (data.url) {
          results.push({
            url: data.url,
            title: data.title || data.url,
            sharedAt: data.sharedAt || 0,
          })
        }
      } catch (err) {
        console.error('[ShareInbox] 解析文件失败:', file, err)
      }
    }

    return results
  } catch (err) {
    console.error('[ShareInbox] 读取收件箱失败:', err)
    return []
  }
}

/**
 * 处理收件箱：导入本地不存在的 URL
 * @returns { imported: number, ignored: number }
 */
export async function processInbox(
  fs: RemoteStorageFileSystem
): Promise<{ imported: number; ignored: number }> {
  const links = await readAllSharedLinks(fs)
  if (links.length === 0) return { imported: 0, ignored: 0 }

  // 获取本地已有书签的 URL 集合
  const existing = await getAllBookmarks()
  const existingUrls = new Set(existing.map((b: BookmarkDoc) => b.url))

  let imported = 0
  let ignored = 0

  for (const link of links) {
    if (existingUrls.has(link.url)) {
      ignored++
      continue
    }

    await saveBookmark({
      url: link.url,
      title: link.title,
      tags: [],
      description: '',
      icon: '',
      clicks: 0,
      createdAt: link.sharedAt || Date.now(),
      updatedAt: Date.now(),
    })
    imported++
  }

  console.log(`[ShareInbox] 导入完成: ${imported} 条新书签, ${ignored} 条已存在被忽略`)
  return { imported, ignored }
}

// ==================== 网络中断降级：本地 pending 队列 ====================

interface PendingShare {
  url: string
  title: string
  sharedAt: number
}

/** 保存到本地 pending 队列（网络失败时） */
export async function savePendingShare(url: string, title: string): Promise<void> {
  try {
    const db = await getPouchDB()
    let doc: any = await db.get(PENDING_KEY).catch(() => null)
    const shares: PendingShare[] = doc?.shares || []
    shares.push({ url, title, sharedAt: Date.now() })

    const newDoc = {
      _id: PENDING_KEY,
      type: 'pending-shares',
      shares,
      updatedAt: Date.now(),
    }

    if (doc?._rev) {
      await db.put({ ...newDoc, _rev: doc._rev })
    } else {
      await db.put(newDoc)
    }
    console.log('[ShareInbox] 已保存到 pending 队列:', url)
  } catch (err) {
    console.error('[ShareInbox] 保存 pending 失败:', err)
  }
}

/** 上传本地 pending 队列到 RemoteStorage */
export async function uploadPendingShares(fs: RemoteStorageFileSystem): Promise<number> {
  try {
    const db = await getPouchDB()
    const doc: any = await db.get(PENDING_KEY).catch(() => null)
    if (!doc?.shares?.length) return 0

    let uploaded = 0
    for (const share of doc.shares as PendingShare[]) {
      try {
        await writeSharedLink(fs, share.url, share.title)
        uploaded++
      } catch (err) {
        console.error('[ShareInbox] 上传 pending 失败:', share.url, err)
      }
    }

    // 清空 pending
    await db.remove(doc._id, doc._rev)
    console.log('[ShareInbox] pending 队列已清空, 上传:', uploaded)
    return uploaded
  } catch (err) {
    console.error('[ShareInbox] 处理 pending 队列失败:', err)
    return 0
  }
}

/** 创建 RemoteStorageFileSystem 实例 */
export function createInboxFS(credentials: RemoteStorageConfig): RemoteStorageFileSystem {
  return new RemoteStorageFileSystem(credentials)
}
