/**
 * 从 RemoteStorage 加载 universal-sync-v2 存储的数据
 * 
 * 存储结构：
 * /onenav/manifest-index.json          → 分区索引
 * /onenav/manifest.json                → 根 manifest（兼容旧格式）
 * /onenav/data/2026/05/manifest.json   → 分区 manifest
 * /onenav/data/2026/05/data-1-1234.json → 数据文件
 */

import { RemoteStorageFileSystem } from './remotestorage-fs'
import type { RemoteStorageConfig } from './remotestorage-fs'

interface DataFileMetadata {
  filename: string
  startSeq: number
  endSeq: number
  timestamp: number
  documentCount: number
  mergedFrom?: string[]
  partition?: string
}

interface ManifestContent {
  version: string
  lastSequence: number
  lastTimestamp: number
  files: DataFileMetadata[]
}

interface ManifestIndexContent {
  version: string
  partitions: {
    [partition: string]: {
      manifestPath: string
      lastSequence: number
      lastTimestamp: number
    }
  }
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
    // 收集所有数据文件
    const dataFiles: DataFileMetadata[] = []

    // 1. 尝试读取 manifest-index.json（新格式）
    let indexContent: ManifestIndexContent | null = null
    try {
      const indexPath = '/onenav/manifest-index.json'
      const indexData = await fs.readFile(indexPath, 'utf8')
      indexContent = JSON.parse(indexData as string)
    } catch {
      // manifest-index.json 不存在，尝试旧格式
    }

    if (indexContent && indexContent.partitions) {
      // 新格式：按分区读取 manifest
      for (const [partition, info] of Object.entries(indexContent.partitions)) {
        try {
          const partitionManifestPath = `/onenav/data/${partition}/manifest.json`
          const pmData = await fs.readFile(partitionManifestPath, 'utf8')
          const pm = JSON.parse(pmData as string) as ManifestContent
          for (const f of pm.files) {
            f.partition = partition
            dataFiles.push(f)
          }
        } catch (err) {
          errors.push(`读取分区 ${partition} manifest 失败: ${err}`)
        }
      }
    }

    // 2. 尝试读取根 manifest.json（旧格式或补充）
    try {
      const rootManifestPath = '/onenav/manifest.json'
      const rmData = await fs.readFile(rootManifestPath, 'utf8')
      const rm = JSON.parse(rmData as string) as ManifestContent
      for (const f of rm.files) {
        // 避免重复
        if (!dataFiles.some(df => df.filename === f.filename)) {
          dataFiles.push(f)
        }
      }
    } catch {
      // 根 manifest 不存在，忽略
    }

    if (dataFiles.length === 0) {
      errors.push('没有找到任何数据文件')
      return { count: 0, errors }
    }

    console.log(`[RS Load] 找到 ${dataFiles.length} 个数据文件`)

    // 3. 读取每个数据文件中的文档
    const allDocs: any[] = []

    for (const fileMeta of dataFiles) {
      try {
        let filePath: string
        if (fileMeta.partition) {
          filePath = `/onenav/data/${fileMeta.partition}/${fileMeta.filename}`
        } else {
          filePath = `/onenav/${fileMeta.filename}`
        }

        const fileData = await fs.readFile(filePath, 'utf8')
        const docs = JSON.parse(fileData as string)

        if (Array.isArray(docs)) {
          allDocs.push(...docs)
        }
      } catch (err) {
        errors.push(`读取数据文件 ${fileMeta.filename} 失败: ${err}`)
      }
    }

    console.log(`[RS Load] 共 ${allDocs.length} 条文档`)

    // 4. 写入 PouchDB
    if (allDocs.length > 0) {
      const results = await db.bulkDocs(allDocs)
      count = results.filter((r: any) => r.ok).length

      results.forEach((r: any, i: number) => {
        if (!r.ok && r.error && r.error !== 'conflict') {
          errors.push(`写入 ${allDocs[i]?._id}: ${r.error}`)
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

  // 检查 manifest-index.json 或 manifest.json 是否存在
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
