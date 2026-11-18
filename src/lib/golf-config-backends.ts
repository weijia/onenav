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
import { connect } from 'zen-fs-config'
import type { AppDataGroup } from 'zen-fs-config'
import { registerFsConfigBackends } from './fs-config-backends'

/**
 * 从 config-ui 的 onConnected 数据里解析出可用的数据组实例。
 * config-sync 模式只给 repo（数据组在内部 groupInstances，未 emit）；
 * data-sync 模式给 dataGroup。兜底用 connect('golf') 重新加载。
 */
export async function resolveGolfDataGroup(connected: any): Promise<AppDataGroup | null> {
  const direct = connected?.dataGroup as AppDataGroup | undefined
  if (direct?.fs?.promises) return direct
  const repo = connected?.repo as any
  if (repo?.listAppDataGroups && repo?.getAppDataGroup) {
    try {
      const descriptors = await repo.listAppDataGroups()
      for (const d of descriptors) {
        const g = await repo.getAppDataGroup(d.id)
        if (g?.fs?.promises) return g
      }
    } catch { /* 落到 connect 兜底 */ }
  }
  try {
    const result = await connect('golf')
    const groups = result.appDataGroups || []
    return groups.find((g) => g?.fs?.promises) || null
  } catch (e) {
    console.warn('[golf] 无法解析数据组实例:', e)
    return null
  }
}

export function registerGolfBackends(): void {
  registerFsConfigBackends()
}
