/**
 * dir-struct-gen 数据同步组持有模块（文件浏览器读侧）。
 *
 * 与 zip-browser 写侧共用同一个 appId 数据组：
 *   appId = 'dir-struct-gen'
 * 清单写在组内逻辑根下：/struct、/folder-deepen、/file-tags。
 * 远端后端（RemoteStorage / Gitee 等）由 SyncGroupConfigurator 配置，
 * 后端自己的基准路径在后端配置里指定，读侧不再维护基目录前缀。
 *
 * 数据组实例由 config-ui 的 onConnected 回调交出（live 引用），
 * 不在这里另建 repo。
 */
import type { AppDataGroup } from 'zen-fs-config'

/** 文件浏览器使用的同步组 appId，与 dir-struct-gen / zip-browser 写侧一致。 */
export const DIR_STRUCT_APP_ID = 'dir-struct-gen'

let activeGroup: AppDataGroup | null = null

/** 数据组是否已连接（有可用 fs 视图）。 */
export function isDirStructGroupReady(): boolean {
  return activeGroup !== null && !!activeGroup.fs?.promises
}

/** 取当前活动数据组；未连接返回 null。 */
export function getDirStructGroup(): AppDataGroup | null {
  return activeGroup
}

/** config-ui 连上数据组后调用：保存 live 引用。 */
export function attachDirStructGroup(group: AppDataGroup | null): void {
  activeGroup = group
}

/** 数据组断开/切换时清理。 */
export function detachDirStructGroup(): void {
  activeGroup = null
}
