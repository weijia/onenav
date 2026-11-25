/**
 * golf 数据同步组的后端注册入口。
 *
 * 实际注册表在 fs-config-backends.ts（RemoteStorage + Gitee 等），
 * golf / filebrowser 共用同一套，避免两份重复实现各自漏注册某个后端。
 *
 * 历史背景：早期本文件自己注册 RemoteStorage，但没注册 Gitee，
 * 导致 golf 数据组选「🦊 Gitee」时报
 * "Backend package \"zen-fs-gitee\" is not available"。
 */
import type { AppDataGroup } from 'zen-fs-config'
import { registerFsConfigBackends, resolveDataGroup } from './fs-config-backends'

/** golf 数据组的逻辑数据目录（组内 basePath） */
const GOLF_DATA_PATH = '/golf'

/**
 * 从 config-ui 的 onConnected 数据里解析出可用的数据组实例。
 *
 * 注意：不要再用「取列表第一个组」的老写法——一个 appId 下存在历史 `default`
 * 空组时会挂错，数据写进空组。统一交给 resolveDataGroup：
 * 本机偏好组 → `/golf` 下已有内容的组 → 唯一远端组。
 */
export async function resolveGolfDataGroup(connected: any): Promise<AppDataGroup | null> {
  return resolveDataGroup(connected, 'golf', { preferPath: GOLF_DATA_PATH })
}

export function registerGolfBackends(): void {
  registerFsConfigBackends()
}
