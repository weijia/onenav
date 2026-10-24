// 数据获取层：从 onenav 同账号 RemoteStorage 读取 ufs-nodes/ 下全部 JSON 原始内容。
// 复用 onenav 现有 OAuth 连接（Q1=A），无需额外配置。

import { RemoteStorageFileSystem } from '@/lib/remotestorage-fs'
import {
  claimAccess,
  getStorageCredentials,
  getSavedStorageCredentials,
  isRemoteStorageAuthError,
} from '@/lib/remotestorage-connection'

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

// zen-fs 路径约定：无前导斜杠（与 app_data/favorites 一致）。
const UFS_DIR = 'ufs-nodes'

/**
 * 列出并读取 ufs-nodes/ 下全部 .json 文件，返回原始 JSON 数组。
 * 单文件解析/读取失败会被跳过，不导致整页崩溃。
 *
 * 关于 claim('ufs-nodes','r')：best-effort。token 已 mint 的情况下不会 retroactively 生效，
 * 仅保证下次重新授权时带上该 scope；若当前 token 无权限，读取会 403 并转成 RsAuthError。
 */
export async function fetchUfsNodesRaw(): Promise<unknown[]> {
  // best-effort：登记 ufs-nodes 只读权限（供后续重新授权时带上 scope）
  try {
    claimAccess('ufs-nodes', 'r')
  } catch {
    // 忽略：claim 失败不应阻断读取
  }

  const credentials = getStorageCredentials() || getSavedStorageCredentials()
  if (!credentials) {
    throw new RsNotConnectedError()
  }

  const fs = new RemoteStorageFileSystem({ href: credentials.href, token: credentials.token })

  // readdir 对结尾斜杠的要求因服务器而异：先试无斜杠，再试有斜杠。
  let names: string[] = []
  for (const dir of [UFS_DIR, `${UFS_DIR}/`]) {
    try {
      const list = await fs.readdir(dir)
      if (list.length > 0) {
        names = list
        break
      }
    } catch (e) {
      if (isRemoteStorageAuthError(e)) throw new RsAuthError(String(e))
      // 否则忽略，尝试带斜杠
    }
  }

  const jsonNames = names
    .map((n) => n.replace(/^\.\//, '')) // zen-fs 可能返回带 ./ 前缀的条目
    .filter((n) => n.endsWith('.json'))

  const raws: unknown[] = []
  for (const n of jsonNames) {
    const path = `${UFS_DIR}/${n}`
    try {
      const text = await fs.readFile(path, 'utf8')
      try {
        raws.push(JSON.parse(text))
      } catch {
        // 单文件 JSON 解析失败：跳过该文件
      }
    } catch (e) {
      if (isRemoteStorageAuthError(e)) throw new RsAuthError(String(e))
      // 单文件读取失败：跳过
    }
  }
  return raws
}
