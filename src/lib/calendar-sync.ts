/**
 * 日历独立库的 v2 同步链路。
 *
 *   PouchDB(onenav-calendar) --universal-sync-v2--> DataGroup.fs（zen-fs-config v2）
 *       --数据组自己的 SyncPair--> 远端后端（RemoteStorage / Gitee / WebDAV）
 *
 * 同步文件系统由 zen-fs-config v2 的 `AppRepo.getDefaultDataGroup()` / `getDataGroup(id)` 提供；
 * UI 侧用 `SyncGroupConfiguratorV2` 配置后端并把同一份 repo 传进来（一个 appId 只允许一个连接）。
 * 主库（书签/配置）的 RemoteStorage 同步与本链路无关。
 */
import type { AppDataGroup, AppRepo, DataGroup } from 'zen-fs-config'
import { adaptDataGroupFs } from './golf-group-fs-adapter'
import { getCalendarPouchDB } from './calendar-db'
import { createSyncSafeDb } from './remotestorage-sync'

const BASE_PATH = '/calendar'

/** 一次 PouchDB ↔ 数据组双向同步完成后派发：页面据此重读独立库。 */
export const CALENDAR_SYNCED_EVENT = 'calendar:synced'

let repo: AppRepo | null = null
let group: DataGroup | null = null
let unsubscribe: (() => void) | null = null
let syncing = false
let syncTimer: ReturnType<typeof setTimeout> | null = null
let pullTimer: ReturnType<typeof setTimeout> | null = null
let lastError: string | null = null

function notify(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CALENDAR_SYNCED_EVENT))
}

export function isCalendarGroupReady(): boolean {
  return group !== null
}

export function getCalendarSyncError(): string | null {
  return lastError
}

export function getCalendarRepo(): AppRepo | null {
  return repo
}

/** 挂载 v2 连接：保存同一份 repo，取默认数据组并做一次初始双向同步。 */
export async function attachCalendarRepo(next: AppRepo): Promise<void> {
  repo = next
  const picked = await next.getDefaultDataGroup()
  await attachCalendarGroup(picked)
}

/** 挂载指定数据组（多组场景下由用户选择）。重复调用会替换订阅。 */
export async function attachCalendarGroup(next: DataGroup): Promise<void> {
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  group = next
  lastError = null

  // 数据组与远端同步后，文件已落到 group.fs；再跑一次 SyncEngine 把远端变更 pull 进 PouchDB。
  unsubscribe = next.onSyncEvent?.((event: any) => {
    if (event?.type !== 'sync:end' && event?.type !== 'conflict') return
    if (pullTimer) clearTimeout(pullTimer)
    pullTimer = setTimeout(() => {
      void syncCalendarNow()
    }, 300)
  }) ?? null

  await syncCalendarNow()
}

/** 断开/切换连接时清理订阅与定时器。 */
export function detachCalendarRepo(): void {
  if (unsubscribe) unsubscribe()
  unsubscribe = null
  group = null
  repo = null
  if (syncTimer) clearTimeout(syncTimer)
  if (pullTimer) clearTimeout(pullTimer)
  syncTimer = null
  pullTimer = null
}

/** PouchDB ↔ 数据组文件系统的双向同步。数据组未连接时静默跳过（数据仍写本地库）。 */
export async function syncCalendarNow(): Promise<boolean> {
  if (!group) {
    lastError = '数据同步组未连接'
    return false
  }
  if (syncing) return false
  syncing = true
  try {
    const { SyncEngine } = await import('universal-sync-v2/browser')
    const db = await getCalendarPouchDB()
    const engine = new SyncEngine(createSyncSafeDb(db), adaptDataGroupFs(group as unknown as AppDataGroup), {
      basePath: BASE_PATH,
      maxFileSize: 500 * 1024,
      mergeThreshold: 50 * 1024,
      autoMerge: false,
    })
    await engine.initialize()
    await engine.sync()
    lastError = null
    notify()
    return true
  } catch (e) {
    lastError = String(e)
    console.error('[calendar-sync] 同步到数据组失败:', e)
    return false
  } finally {
    syncing = false
  }
}

/** 让数据组把自己立刻推到远端后端（按钮手动触发 / 写后自动触发）。 */
export async function flushCalendarGroup(): Promise<boolean> {
  if (!group) return false
  try {
    await group.flush()
    return true
  } catch (e) {
    lastError = String(e)
    console.error('[calendar-sync] 数据组 flush 失败:', e)
    return false
  }
}

/** 写后防抖：先落到数据组 fs，再让数据组把这一轮变更推到远端。 */
export function scheduleCalendarSync(delay = 1500): void {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    void syncCalendarNow().then((ok) => {
      if (ok) void flushCalendarGroup()
    })
  }, delay)
}
