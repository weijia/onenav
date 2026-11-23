// 主机磁盘文档读取层：从文件浏览器已挂载的同一数据组里读 host-disks/host-disks.v2.json，
// 得到「主机 → 磁盘 → 逻辑分区 → 卷」的归并事实（zip-browser 写回的那份）。
//
// 只读、不写回：目录视图与磁盘视图共用同一份 /struct 清单，磁盘视图只是换一个入口浏览。
// 文档缺失（数据组里还没生成过主机磁盘视图）时返回 error，由 UI 提示，不影响目录视图。

import { getDirStructGroup } from '@/lib/dir-struct-group'

/** 按优先级尝试的路径：主文档 → 镜像 → 旧路径 */
export const HOST_DISKS_PATHS = [
  '/host-disks/host-disks.v2.json',
  '/host-disks/host-disks.mirror.json',
  '/host-disks/host-disks.json',
] as const

interface PromisesFs {
  readFile(path: string, encoding?: string): Promise<any>
}

export interface HostDisksLoadResult {
  doc: Record<string, unknown> | null
  /** 实际读到的是哪个路径（用于提示数据来自镜像/旧格式） */
  path: string | null
  error: string
}

/** 与 /struct 读取一致：数据组后端的 readFile 只认 'utf-8'，并再兜一层 Uint8Array 解码。 */
async function readText(fs: PromisesFs, path: string): Promise<string> {
  const data = await fs.readFile(path, 'utf-8')
  if (typeof data === 'string') return data
  try {
    const u8 =
      data instanceof Uint8Array
        ? data
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data as any)
    return new TextDecoder('utf-8').decode(u8)
  } catch {
    return String(data)
  }
}

/**
 * 读主机磁盘文档。同步组未连接 / 文件不存在 / 解析失败都不抛错，
 * 统一通过返回值里的 error 说明原因，便于 UI 与缓存态共存。
 */
export async function fetchHostDisksDoc(): Promise<HostDisksLoadResult> {
  const group = getDirStructGroup()
  const fs = (group as any)?.fs?.promises as PromisesFs | undefined
  if (!fs) return { doc: null, path: null, error: '未连接数据同步组' }

  const missing: string[] = []
  for (const path of HOST_DISKS_PATHS) {
    try {
      const text = await readText(fs, path)
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        missing.push(`${path}（形态不是对象）`)
        continue
      }
      return { doc: parsed as Record<string, unknown>, path, error: '' }
    } catch (err) {
      const e = err as any
      const code = String(e?.code || e?.errno || '')
      if (/ENOENT|404|not found/i.test(`${code} ${e?.message || ''}`)) {
        missing.push(path)
        continue
      }
      // 鉴权/网络错误：换路径也没用，直接返回原因
      return { doc: null, path: null, error: `读取 ${path} 失败：${e?.message || String(err)}` }
    }
  }
  return {
    doc: null,
    path: null,
    error: `数据组里没有主机磁盘文档（已尝试 ${missing.length} 个路径）`,
  }
}
