/**
 * 从 RemoteStorage 加载数据到 PouchDB
 * 
 * universal-sync-v2 存储格式：
 * - manifest-index.json: 分区索引
 * - data/YYYY/MM/manifest.json: 分区 manifest
 * - data/YYYY/MM/data-{seq}-{ts}.json: 数据文件（包含原始 PouchDB 文档）
 */

import { RemoteStorageFileSystem } from './remotestorage-fs'
import type { RemoteStorageConfig } from './remotestorage-fs'
import { getPouchDB } from './pouchdb'

interface DataFileMetadata {
  filename: string
  startSeq: number
  endSeq: number
  timestamp: number
  documentCount: number
}

interface PartitionManifest {
  version: string
  lastSequence: number
  lastTimestamp: number
  files: DataFileMetadata[]
}

interface ManifestIndex {
  version: string
  partitions: Record<string, {
    manifestPath: string
    lastSequence: number
    lastTimestamp: number
  }>
}

/**
 * 从 RemoteStorage 加载数据到 PouchDB
 */
export async function loadFromRemoteStorage(
  _db: PouchDB.Database,
  config: RemoteStorageConfig
): Promise<{ count: number; errors: string[] }> {
  const errors: string[] = []
  let count = 0
  const fs = new RemoteStorageFileSystem(config)

  try {
    // 1. 读取 manifest-index.json
    let index: ManifestIndex | null = null
    try {
      console.log('[RS Load] 尝试读取 manifest-index.json...')
      const indexData = await fs.readFile('/onenav/manifest-index.json', 'utf8')
      console.log('[RS Load] manifest-index.json 内容:', indexData)
      index = JSON.parse(indexData as string)
      console.log('[RS Load] 解析后的 index:', index)
    } catch (err) {
      console.log('[RS Load] manifest-index.json 不存在或读取失败:', err)
    }

    // 2. 收集所有数据文件
    const dataFiles: Array<{ partition: string; file: DataFileMetadata }> = []

    if (index?.partitions) {
      console.log('[RS Load] 发现分区:', Object.keys(index.partitions))
      for (const [partition] of Object.entries(index.partitions)) {
        try {
          const pmPath = `/onenav/data/${partition}/manifest.json`
          console.log(`[RS Load] 读取分区 manifest: ${pmPath}`)
          const pmData = await fs.readFile(pmPath, 'utf8')
          const pm: PartitionManifest = JSON.parse(pmData as string)
          console.log(`[RS Load] 分区 ${partition} 有 ${pm.files?.length || 0} 个文件`)
          for (const f of pm.files) {
            dataFiles.push({ partition, file: f })
          }
        } catch (err) {
          console.error(`[RS Load] 读取分区 ${partition} manifest 失败:`, err)
          errors.push(`读取分区 ${partition} manifest 失败: ${err}`)
        }
      }
    } else {
      console.log('[RS Load] index.partitions 为空或不存在')
    }

    if (dataFiles.length === 0) {
      console.log('[RS Load] 没有找到数据文件')
      return { count: 0, errors }
    }

    console.log(`[RS Load] 找到 ${dataFiles.length} 个数据文件`)

    // 3. 读取所有数据文件中的文档
    const allDocs: any[] = []
    for (const { partition, file } of dataFiles) {
      try {
        const filePath = `/onenav/data/${partition}/${file.filename}`
        const fileData = await fs.readFile(filePath, 'utf8')
        const docs = JSON.parse(fileData as string)
        if (Array.isArray(docs)) {
          allDocs.push(...docs)
        }
      } catch (err) {
        errors.push(`读取文件 ${file.filename} 失败: ${err}`)
      }
    }

    console.log(`[RS Load] 共 ${allDocs.length} 条文档`)

    // 4. 写入 PouchDB
    if (allDocs.length > 0) {
      const db = await getPouchDB()
      const results = await db.bulkDocs(allDocs)
      count = results.filter((r: any) => r.ok).length

      results.forEach((r: any, i: number) => {
        if (!r.ok && r.error && r.error !== 'conflict') {
          errors.push(`写入 ${allDocs[i]?._id}: ${r.error}`)
        }
      })
    }

    console.log(`[RS Load] 成功写入 ${count} 条文档`)
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
    await fs.readFile('/onenav/manifest-index.json', 'utf8')
    return true
  } catch {
    // ignore
  }

  try {
    await fs.readFile('/onenav/manifest.json', 'utf8')
    return true
  } catch {
    // ignore
  }

  return false
}
