// 数据获取层：从 onenav 同账号 RemoteStorage 读取目录结构清单。
// 复用 onenav 现有 OAuth 连接（Q1=A），无需额外配置。
//
// 存储模型（dir-struct-manifest-format.md v2）：
//   app_data/folders/<host>.json        — 主机索引 { version:2, source, mounts:[{letter,volumeId,file}] }
//   app_data/folders/<volumeKey>.json   — 某块物理盘的卷子树 { volumeId, name, type:'folder', children, sources }
//   app_data/folder-deepen/<key>.json   — 深挖标记 { marks:[ "E:/Photos/2024", ... ] }
// 其中 volumeKey = 卷的 .dir-struct-id（UUID，跨主机一致）；同一块盘在多主机上只存一份卷文件，
// 主机索引只记录挂载关系，从根本上避免「同盘多主机重复保存」。
//
// 兼容：仍支持 v1 单文件整树清单（含 root 字段，无 mounts）。
//
// 本读取侧把上述结构「拼装」回 { root, source, ... } 形态（与 normalize 输入一致），
// 因此对 FileBrowserApp / normalize 其余逻辑透明。

import { RemoteStorageFileSystem } from '@/lib/remotestorage-fs'
import {
  claimAccess,
  getStorageCredentials,
  getSavedStorageCredentials,
  isRemoteStorageAuthError,
} from '@/lib/remotestorage-connection'
import type { RawManifest } from './types'

/** 未连接 RemoteStorage（无凭据） */
export class RsNotConnectedError extends Error {
  code = 'NOT_CONNECTED'
  constructor(message = '未连接 RemoteStorage') {
    super(message)
    this.name = 'RsNotConnectedError'
  }
}

/** 鉴权失败（401/403），需要重新连接 */
export class RsAuthError extends Error {
  code = 'AUTH'
  constructor(message = 'RemoteStorage 鉴权失败') {
    super(message)
    this.name = 'RsAuthError'
  }
}

// 目录结构清单默认存储目录（与 dir-struct-manifest-format.md 的 rsBase 默认值一致）。
const FOLDERS_DIR = 'app_data/folders'
const DEEPEN_DIR = 'app_data/folder-deepen'

/** app_data 读权限不足时的错误说明：已连接，但当前令牌缺作用域，需断开重连换取新令牌 */
const FOLDERS_AUTH_MSG =
  'RemoteStorage 已连接，但当前令牌缺少 app_data 目录的权限（服务端 401）。' +
  '请在主页断开 RemoteStorage 并重新连接一次以授予该权限。'

// RemoteStorage 路径只允许安全字符，其余替换为下划线（与 dir-struct-gen 的 sanitizeKey 一致）。
function sanitizeKey(s: string): string {
  return (s || '').replace(/[^A-Za-z0-9._-]/g, '_')
}

/** 构建一个 RS 文件系统实例；未连接则抛 RsNotConnectedError */
function getFS(): RemoteStorageFileSystem {
  const credentials = getStorageCredentials() || getSavedStorageCredentials()
  if (!credentials) throw new RsNotConnectedError()
  return new RemoteStorageFileSystem({ href: credentials.href, token: credentials.token })
}

/**
 * 列出并读取 app_data/folders/ 下全部 .json，分类拼装为原始清单数组：
 * - 含 mounts 数组 → 主机索引，按需拼装其引用的卷文件成完整树；
 * - 含 volumeId + children 且非 mounts/root → 卷文件，收入卷映射；
 * - 含 root 字段 → legacy v1 整树清单，原样透传。
 *
 * 单文件解析/读取失败会被跳过，不导致整页崩溃。
 */
export async function fetchDirStructManifests(): Promise<RawManifest[]> {
  // best-effort：登记 app_data 读写权限（供后续重新授权时带上 scope）
  try {
    claimAccess('app_data', 'rw')
  } catch {
    // 忽略：claim 失败不应阻断读取
  }

  const fs = getFS()

  // 清掉目录列表缓存，确保本次能枚举到最新远端的 app_data/folders 结构。
  try {
    await fs.invalidateDirListing()
  } catch (e) {
    console.warn('[filebrowser] 清除 app_data/folders 目录缓存失败（已忽略）:', e)
  }

  // readdir 对结尾斜杠的要求因服务器而异：先试无斜杠，再试有斜杠。
  let names: string[] = []
  for (const dir of [FOLDERS_DIR, `${FOLDERS_DIR}/`]) {
    try {
      const list = await fs.readdir(dir)
      if (list.length > 0) {
        names = list
        break
      }
    } catch (e) {
      if (isRemoteStorageAuthError(e)) throw new RsAuthError(FOLDERS_AUTH_MSG)
      // 否则忽略，尝试带斜杠；目录不存在也会走到这里，最终得到空列表 → 空态
    }
  }

  const jsonNames = names
    .map((n) => n.replace(/^\.\//, '')) // zen-fs 可能返回带 ./ 前缀的条目
    .filter((n) => n.endsWith('.json'))

  // 读取全部 json 文件
  const files: { name: string; raw: unknown }[] = []
  for (const n of jsonNames) {
    const p = `${FOLDERS_DIR}/${n}`
    try {
      const text = await fs.readFile(p, 'utf8')
      try {
        files.push({ name: n.replace(/\.json$/, ''), raw: JSON.parse(text) })
      } catch {
        console.warn('[filebrowser] 清单解析失败，已跳过:', p)
      }
    } catch (e) {
      if (isRemoteStorageAuthError(e)) throw new RsAuthError(FOLDERS_AUTH_MSG)
      console.warn('[filebrowser] 清单读取失败，已跳过:', p, e)
    }
  }

  // 分类
  const volumeMap = new Map<string, any>()
  const hostIndexes: any[] = []
  const legacy: any[] = []
  for (const f of files) {
    const raw = f.raw as Record<string, unknown> | null
    if (!raw || typeof raw !== 'object') continue
    if (Array.isArray(raw.mounts)) {
      hostIndexes.push(raw)
    } else if (
      typeof raw.volumeId === 'string' &&
      Array.isArray(raw.children) &&
      !raw.root
    ) {
      volumeMap.set(f.name, raw)
    } else if (raw.root && typeof raw.root === 'object') {
      legacy.push(raw)
    }
    // 其余形态：跳过
  }

  const out: RawManifest[] = []
  // legacy v1：原样透传
  for (const l of legacy) out.push(l)
  // 主机索引：拼装引用的卷文件
  for (const hi of hostIndexes) {
    const children: any[] = []
    const root: Record<string, unknown> = {
      name: typeof hi.source === 'string' ? hi.source : 'unknown',
      type: 'folder',
      children,
    }
    const mounts = Array.isArray(hi.mounts) ? (hi.mounts as any[]) : []
    for (const m of mounts) {
      const vf = volumeMap.get(m.file) ?? (typeof m.volumeId === 'string' ? volumeMap.get(sanitizeKey(m.volumeId)) : undefined)
      if (vf) children.push(vf)
    }
    out.push({
      source: typeof hi.source === 'string' ? hi.source : 'unknown',
      generatedAt: typeof hi.generatedAt === 'string' ? hi.generatedAt : undefined,
      generator: typeof hi.generator === 'string' ? hi.generator : undefined,
      root,
    })
  }
  return out
}

/**
 * 读取某块盘的深挖标记（app_data/folder-deepen/<key>.json）。
 * 404 / 解析失败 / 未连接 → 返回空数组（不抛错，避免阻断浏览）。
 */
export async function getFolderDeepenMarks(key: string): Promise<string[]> {
  try {
    const fs = getFS()
    const p = `${DEEPEN_DIR}/${sanitizeKey(key)}.json`
    const text = await fs.readFile(p, 'utf8')
    try {
      const obj = JSON.parse(text)
      if (obj && Array.isArray(obj.marks)) {
        return (obj.marks as unknown[]).filter((m): m is string => typeof m === 'string')
      }
      return []
    } catch {
      return []
    }
  } catch (e) {
    if (isRemoteStorageAuthError(e)) {
      // 权限问题仅告警，不打断浏览
      console.warn('[filebrowser] 读取深挖标记权限不足:', e)
      return []
    }
    return []
  }
}

/**
 * 写回某块盘的深挖标记（app_data/folder-deepen/<key>.json）。
 * 权限错误（401）抛 RsAuthError，由调用方提示去重连；其它错误原样抛出。
 */
export async function putFolderDeepenMarks(key: string, paths: string[]): Promise<void> {
  const fs = getFS()
  const p = `${DEEPEN_DIR}/${sanitizeKey(key)}.json`
  try {
    await fs.writeFile(p, JSON.stringify({ marks: paths }))
  } catch (e) {
    if (isRemoteStorageAuthError(e)) throw new RsAuthError(FOLDERS_AUTH_MSG)
    throw e
  }
}
