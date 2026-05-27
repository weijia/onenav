/**
 * 从 RemoteStorage 加载数据到 PouchDB
 * 
 * 这是 syncToRemoteStorage 的反向操作：
 * - 从 RemoteStorage 读取 universal-sync-v2 存储的文件
 * - 解析并恢复到 PouchDB
 */

import { RemoteStorageFileSystem } from './remotestorage-fs'
import type { RemoteStorageConfig } from './remotestorage-fs'

interface ManifestEntry {
  id: string
  partition: string
  file: string
}

interface Manifest {
  version: number
  entries: ManifestEntry[]
  lastUpdated: number
}

/**
 * 从 RemoteStorage 加载数据到 PouchDB
 */
export async function loadFromRemoteStorage(
  db: PouchDB.Database,
  config: RemoteStorageConfig
): Promise<{ count: number; errors: string[] }> {
  const fs = new RemoteStorageFileSystem(config)
  const errors: string[] = []
  let count = 0

  try {
    // 1. 读取 manifest 文件
    const manifestPath = '/onenav/manifest.json'
    let manifest: Manifest | null = null
    
    try {
      const manifestData = await fs.readFile(manifestPath, 'utf8')
      manifest = JSON.parse(manifestData as string)
    } catch (err) {
      errors.push(`无法读取 manifest: ${err}`)
      return { count: 0, errors }
    }

    if (!manifest || !manifest.entries) {
      errors.push('manifest 格式无效')
      return { count: 0, errors }
    }

    // 2. 按分区读取数据文件
    const docs: any[] = []
    
    for (const entry of manifest.entries) {
      try {
        const filePath = `/onenav/${entry.partition}/${entry.file}`
        const fileData = await fs.readFile(filePath, 'utf8')
        const fileDocs = JSON.parse(fileData as string)
        
        if (Array.isArray(fileDocs)) {
          docs.push(...fileDocs)
        } else if (fileDocs && typeof fileDocs === 'object') {
          docs.push(fileDocs)
        }
      } catch (err) {
        errors.push(`读取文件失败 ${entry.file}: ${err}`)
      }
    }

    // 3. 写入 PouchDB
    if (docs.length > 0) {
      // 先清空现有数据（可选，根据需求）
      // await clearPouchDB(db)
      
      // 批量写入
      const results = await db.bulkDocs(docs)
      
      // 统计成功数量
      count = results.filter((r: any) => r.ok).length
      
      // 收集错误
      results.forEach((r: any, i: number) => {
        if (!r.ok && r.error) {
          errors.push(`写入 doc ${docs[i]?._id}: ${r.error}`)
        }
      })
    }

    return { count, errors }
  } catch (err) {
    errors.push(`加载失败: ${err}`)
    return { count, errors }
  }
}

/**
 * 检查 RemoteStorage 是否有数据
 */
export async function hasRemoteStorageData(
  config: RemoteStorageConfig
): Promise<boolean> {
  const fs = new RemoteStorageFileSystem(config)
  
  try {
    const manifestPath = '/onenav/manifest.json'
    await fs.readFile(manifestPath, 'utf8')
    return true
  } catch {
    return false
  }
}
