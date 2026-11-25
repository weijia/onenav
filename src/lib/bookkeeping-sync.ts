/**
 * 记账独立同步链路（与 golf-sync.ts 同一范式）。
 *
 *   记账 PouchDB 库  --universal-sync-v2-->  zen-fs-config 数据组 fs  --数据组 SyncPair-->  后端
 *
 * 与主库同步（remotestorage-sync.ts：主库 → RS fs → /onenav）完全独立：
 *  - 不同 PouchDB 库（onenav-bookkeeping vs onenav）
 *  - 不同 IFileSystem（记账数据组 fs vs RS fs）
 *  - 不同 basePath（/bookkeeping vs /onenav），LocalCache 的 _local/ 键因此隔离
 *
 * 数据组实例由 config-ui 的 onConnected 回调交出（live 引用），不在这里另建 repo。
 * 记账数据只经数据同步组同步，不再写入主库（配置同步链路）。
 */
import type { AppDataGroup } from 'zen-fs-config'
import { adaptDataGroupFs } from './golf-group-fs-adapter'
import { getBookkeepingPouchDB } from './bookkeeping-db'
import { createSyncSafeDb } from './remotestorage-sync'

const BASE_PATH = '/bookkeeping'

/** 记账数据组一次双向同步结束后派发：页面收到后重新读取独立库 */
export const BOOKKEEPING_SYNCED_EVENT = 'bookkeeping:synced'

let activeGroup: AppDataGroup | null = null
let syncing = false
let timer: ReturnType<typeof setTimeout> | null = null
let lastError: string | null = null

export function isBookkeepingGroupReady(): boolean {
  return activeGroup !== null
}

export function getBookkeepingSyncError(): string | null {
  return lastError
}

/** config-ui 连上数据组后调用：保存 live 引用并做一次初始双向同步 */
export async function attachBookkeepingDataGroup(group: AppDataGroup, autoPull = true): Promise<void> {
  activeGroup = group
  lastError = null
  if (autoPull) await syncBookkeepingNow()
}

/** 数据组断开/切换时清理 */
export function detachBookkeepingDataGroup(): void {
  activeGroup = null
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

export async function syncBookkeepingNow(): Promise<boolean> {
  if (!activeGroup) {
    lastError = '数据同步组未连接'
    return false
  }
  if (syncing) return false
  syncing = true
  try {
    const { SyncEngine } = await import('universal-sync-v2/browser')
    const db = await getBookkeepingPouchDB()
    const engine = new SyncEngine(createSyncSafeDb(db), adaptDataGroupFs(activeGroup), {
      basePath: BASE_PATH,
      maxFileSize: 500 * 1024,
      mergeThreshold: 50 * 1024,
      autoMerge: false,
    })
    await engine.initialize()
    await engine.sync()
    lastError = null
    window.dispatchEvent(new CustomEvent(BOOKKEEPING_SYNCED_EVENT))
    return true
  } catch (e) {
    lastError = String(e)
    console.error('[bookkeeping-sync] 同步到数据组失败:', e)
    return false
  } finally {
    syncing = false
  }
}

/** 保存数据后 debounce 触发同步；数据组未连接时静默跳过（仍写本地独立库） */
export function scheduleBookkeepingSync(delay = 1500): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    void syncBookkeepingNow()
  }, delay)
}
