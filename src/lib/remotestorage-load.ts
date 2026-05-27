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
    // 1. 尝试读取 manifest-index.json（多分区格式）
    let index: ManifestIndex | null = null
    try {
      console.log('[RS Load] 尝试读取 manifest-index.json...')
      const indexData = await fs.readFile('/onenav/manifest-index.json', 'utf8')
      index = JSON.parse(indexData as string)
      console.log('[RS Load] 解析后的 index:', index)
    } catch (err) {
      console.log('[RS Load] manifest-index.json 不存在，尝试读取根 manifest.json')
    }

    // 2. 收集所有数据文件
    const dataFiles: Array<{ partition: string; file: DataFileMetadata }> = []

    if (index?.partitions) {
      // 多分区格式
      console.log('[RS Load] 发现分区:', Object.keys(index.partitions))
      for (const [partition] of Object.entries(index.partitions)) {
        try {
          const pmPath = `/onenav/data/${partition}/manifest.json`
          const pmData = await fs.readFile(pmPath, 'utf8')
          const pm: PartitionManifest = JSON.parse(pmData as string)
          for (const f of pm.files) {
            dataFiles.push({ partition, file: f })
          }
        } catch (err) {
          errors.push(`读取分区 ${partition} manifest 失败: ${err}`)
        }
      }
    } else {
      // 单分区格式：读取根目录 manifest.json
      try {
        console.log('[RS Load] 读取根目录 manifest.json...')
        const manifestData = await fs.readFile('/onenav/manifest.json', 'utf8')
        const manifest: PartitionManifest = JSON.parse(manifestData as string)
        console.log('[RS Load] 根 manifest:', manifest)
        for (const f of manifest.files) {
          // 根目录的文件没有分区，使用空字符串
          dataFiles.push({ partition: '', file: f })
        }
      } catch (err) {
        console.log('[RS Load] 根目录 manifest.json 也不存在:', err)
      }
    }

    if (dataFiles.length === 0) {
      console.log('[RS Load] 没有找到数据文件')
      return { count: 0, errors }
    }

    console.log(`[RS Load] 找到 ${dataFiles.length} 个数据文件`, dataFiles)

    // 3. 读取所有数据文件中的文档
    const allDocs: any[] = []
    for (const { partition, file } of dataFiles) {
      try {
        // 根据是否有分区决定路径
        const filePath = partition 
          ? `/onenav/data/${partition}/${file.filename}`
          : `/onenav/${file.filename}`
        console.log(`[RS Load] 读取文件: ${filePath}`)
        const fileData = await fs.readFile(filePath, 'utf8')
        const docs = JSON.parse(fileData as string)
        console.log(`[RS Load] 文件 ${file.filename} 包含 ${docs?.length || 0} 条文档`)
        if (Array.isArray(docs)) {
          allDocs.push(...docs)
        }
      } catch (err) {
        console.error(`[RS Load] 读取文件 ${file.filename} 失败:`, err)
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
