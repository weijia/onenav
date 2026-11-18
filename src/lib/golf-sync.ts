/**
 * golf 独立同步链路。
 *
 *   golf PouchDB 库  --universal-sync-v2-->  zen-fs-config 数据组 fs  --数据组 SyncPair-->  后端
 *
 * 与 onenav 主库同步（remotestorage-sync.ts：主库 → RS fs → /onenav）完全独立：
 *  - 不同 PouchDB 库（onenav-golf vs onenav）
 *  - 不同 IFileSystem（数据组 fs vs RS fs）
 *  - 不同 basePath（/golf vs /onenav），LocalCache 的 _local/ 键因此隔离
 *
 * 数据组实例由 config-ui 的 onConnected 回调交出（live 引用），不在这里另建 repo。
 */
import type { AppDataGroup } from 'zen-fs-config'
import { adaptDataGroupFs } from './golf-group-fs-adapter'
import { getGolfPouchDB } from './golf-db'
import { createSyncSafeDb } from './remotestorage-sync'

const BASE_PATH = '/golf'

let activeGroup: AppDataGroup | null = null
let syncing = false
let timer: ReturnType<typeof setTimeout> | null = null
let lastError: string | null = null

export function isGolfGroupReady(): boolean {
  return activeGroup !== null
}

export function getGolfSyncError(): string | null {
  return lastError
}

/** config-ui 连上数据组后调用：保存 live 引用并做一次初始双向同步 */
export async function attachGolfDataGroup(group: AppDataGroup, autoPull = true): Promise<void> {
  activeGroup = group
  lastError = null
  if (autoPull) await syncGolfNow()
}

/** 数据组断开/切换时清理 */
export function detachGolfDataGroup(): void {
  activeGroup = null
  if (timer) { clearTimeout(timer); timer = null }
}

export async function syncGolfNow(): Promise<boolean> {
  if (!activeGroup) {
    lastError = '数据同步组未连接'
    return false
  }
  if (syncing) return false
  syncing = true
  try {
    const { SyncEngine } = await import('universal-sync-v2/browser')
    const db = await getGolfPouchDB()
    const engine = new SyncEngine(createSyncSafeDb(db), adaptDataGroupFs(activeGroup), {
      basePath: BASE_PATH,
      maxFileSize: 500 * 1024,
      mergeThreshold: 50 * 1024,
      autoMerge: false,
    })
    await engine.initialize()
    await engine.sync()
    lastError = null
    window.dispatchEvent(new CustomEvent('golf:synced'))
    return true
  } catch (e) {
    lastError = String(e)
    console.error('[golf-sync] 同步到数据组失败:', e)
    return false
  } finally {
    syncing = false
  }
}

/** 保存数据后 debounce 触发同步；数据组未连接时静默跳过（仍写本地独立库） */
export function scheduleGolfSync(delay = 1500): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { void syncGolfNow() }, delay)
}
