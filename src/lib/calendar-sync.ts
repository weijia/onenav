/**
 * 日历独立库的 v2 同步链路。
 *
 *   PouchDB(onenav-calendar) --universal-sync-v2--> DataGroup.fs（zen-fs-config v2）
 *       --数据组自己的 SyncPair--> 远端后端（RemoteStorage / Gitee / WebDAV）
 *
 * 同步文件系统由 zen-fs-config v2 的 `AppRepo.getDefaultDataGroup()` / `getDataGroup(id)` 提供；
 * UI 侧用 `SyncGroupConfiguratorV2` 配置后端并把同一份 repo 传进来（一个 appId 只允许一个连接）。
 * 主库（书签/配置）的 RemoteStorage 同步与本链路无关。
 *
 * 同步触发由 PouchDB 的 live changes feed 统一驱动（覆盖任何绕过 store 的写入）：
 * 每次成功同步后记录 `db.info().update_seq` 作为水位，change 事件的 seq 不超过水位时
 * 视为本引擎自己拉回的文档，直接忽略，避免「拉回 → change → 再同步」的循环。
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
let changesFeed: { on(event: string, handler: (arg: any) => void): unknown; cancel?: () => void } | null = null
/** 已完成同步的 PouchDB 序列号；change.seq <= 该值说明是本引擎拉回的，不再触发同步。 */
let syncedSeq = 0
let pendingChangeSeq = 0

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

function stopCalendarChanges(): void {
  if (changesFeed && typeof changesFeed.cancel === 'function') changesFeed.cancel()
  changesFeed = null
}

/** 连续多次写入合并成一轮同步；执行前再用水位过滤掉已被同步覆盖的 change。 */
function queueSyncAndFlush(seq = 0): void {
  if (typeof seq === 'number' && seq > pendingChangeSeq) pendingChangeSeq = seq
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncTimer = null
    const seq = pendingChangeSeq
    pendingChangeSeq = 0
    if (seq > 0 && seq <= syncedSeq) return
    void syncCalendarNow().then((ok) => {
      if (ok) void flushCalendarGroup()
    })
  }, 1500)
}

/** 挂载后监听 PouchDB 变更：任何 cal: 文档写入都会触发同步，不依赖调用方走 store。 */
async function startCalendarChanges(): Promise<void> {
  stopCalendarChanges()
  const db = await getCalendarPouchDB()
  if (typeof (db as any).changes !== 'function') return
  try {
    const info = await db.info()
    if (typeof info.update_seq === 'number') syncedSeq = info.update_seq
  } catch {
    syncedSeq = 0
  }
  const feed = (db as any).changes({ since: 'now', live: true, include_docs: false })
  feed.on('change', (change: any) => {
    if (typeof change?.id !== 'string' || !change.id.startsWith('cal:')) return
    if (typeof change.seq === 'number' && change.seq <= syncedSeq) return
    queueSyncAndFlush(change.seq)
  })
  feed.on('error', (err: unknown) => {
    lastError = `PouchDB changes 监听失败：${String(err)}`
  })
  changesFeed = feed
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

  // 打开页面 / 切换数据组时：先让数据组与远端双向同步（远端文件落到 fs），
  // 再让 SyncEngine 读取 fs 把变更拉进 PouchDB；否则首轮只读到本地旧数据。
  const remoteReady = await flushCalendarGroup()
  const remoteError = lastError
  const localReady = await syncCalendarNow()
  if (!remoteReady && remoteError && localReady) {
    lastError = `远端同步失败：${remoteError}；本地已同步`
  }
  await startCalendarChanges()
}

/** 断开/切换连接时清理订阅、changes feed 与定时器。 */
export function detachCalendarRepo(): void {
  if (unsubscribe) unsubscribe()
  unsubscribe = null
  stopCalendarChanges()
  pendingChangeSeq = 0
  syncedSeq = 0
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
    // 抬高水位：本次同步（含从 fs 拉回的文档）产生的 change 不再触发下一轮。
    const info = await db.info()
    if (typeof info.update_seq === 'number') syncedSeq = info.update_seq
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

/** 让数据组立刻与远端双向同步一轮（pull 远端文件到 fs + push 本地文件到远端）。 */
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
