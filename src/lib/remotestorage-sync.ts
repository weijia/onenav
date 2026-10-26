/**
 * RemoteStorage 同步模块
 * 
 * 使用 universal-sync-v2 将 PouchDB 数据同步到 RemoteStorage
 */

import { RemoteStorageFileSystem, type RemoteStorageConfig } from './remotestorage-fs'
import { resolveOneNavSyncConflict } from './bookmark-conflicts'
import { showSyncToast, type SyncToast } from './sync-notify'
import { updateSyncStatus, type SyncStatusState } from './sync-status'
import { getStorageCredentials, getSavedStorageCredentials, getLibraryStorageCredentials, getRemoteStorage } from './remotestorage-connection'

let SyncEngine: any = null

async function getSyncEngine(): Promise<any> {
  if (!SyncEngine) {
    // 动态导入 universal-sync-v2 浏览器版本
    const module = await import('universal-sync-v2/browser')
    SyncEngine = module.SyncEngine
  }
  return SyncEngine
}

let isConfigured = false
let syncInProgress = false
let currentFs: RemoteStorageFileSystem | null = null

/**
 * RemoteStorage 连接配置
 */
export interface RemoteStorageConnectionConfig {
  href: string
  token: string
  timeout?: number
}

/**
 * 同步选项
 */
export interface RemoteStorageSyncOptions {
  maxFileSize?: number
  mergeThreshold?: number
  autoMerge?: boolean
  /** 进度回调：业务层可借此展示「服务器剩余 N 个文件」「本地 M 条待上传」等（可选，不传则使用默认 toast） */
  onProgress?: (progress: any) => void
  /** 是否显示内置进度 toast（默认 true）；若自行传入 onProgress 处理展示可设 false */
  showToast?: boolean
}

/**
 * 将 universal-sync-v2 的 SyncProgress 转成全局同步状态 store 的增量。
 * 与 bindProgressToast 并行：toast 负责一次性浮层，store 负责页面内常驻同步胶囊。
 */
function syncProgressToStatus(p: any): Partial<SyncStatusState> {
  const s: Partial<SyncStatusState> = {}
  if (p?.phase === 'pull') {
    s.status = 'syncing'
    s.phase = 'pull'
    if (p.remoteFilesTotal) {
      s.filesRead = p.remoteFilesRead ?? 0
      s.filesTotal = p.remoteFilesTotal
      s.ratio = Math.min(1, (p.remoteFilesRead ?? 0) / p.remoteFilesTotal)
      s.message = p.message || `读取 ${p.remoteFilesRead ?? 0}/${p.remoteFilesTotal} 个文件`
    } else {
      s.message = p.message || '拉取远端数据…'
    }
  } else if (p?.phase === 'push') {
    s.status = 'syncing'
    s.phase = 'push'
    if (p.localFilesTotal) {
      s.filesRead = p.localFilesWritten ?? 0
      s.filesTotal = p.localFilesTotal
      s.ratio = Math.min(1, (p.localFilesWritten ?? 0) / p.localFilesTotal)
      s.message = p.message || `上传 ${p.localFilesWritten ?? 0}/${p.localFilesTotal} 个文件`
    } else {
      s.message = p.message || '上传本地数据…'
    }
  } else if (p?.phase === 'done' || p?.phase === 'skip') {
    s.status = 'synced'
    s.ratio = 1
    s.message = p.message || '已同步'
  } else if (p?.phase === 'error') {
    s.status = 'error'
    s.ratio = 1
    s.message = p.message || '同步失败'
  }
  return s
}

/**
 * 将 universal-sync-v2 的 SyncProgress 转成 toast 提示。
 * 计算各阶段的进度比例：
 *  - pull：remoteFilesRead / remoteFilesTotal
 *  - push：localFilesWritten / localFilesTotal
 */
function bindProgressToast(toast: SyncToast, onProgress?: (p: any) => void): (p: any) => void {
  return (p: any) => {
    let msg = p.message
    let ratio: number | undefined
    if (p.phase === 'pull') {
      if (p.remoteFilesTotal && p.remoteFilesRead != null) {
        ratio = p.remoteFilesTotal ? p.remoteFilesRead / p.remoteFilesTotal : undefined
        msg = msg || `已从服务器读取 ${p.remoteFilesRead}/${p.remoteFilesTotal} 个文件（剩余 ${p.remoteFilesTotal - p.remoteFilesRead} 个待读取）`
      } else if (p.localPendingToApply != null) {
        msg = msg || `本地有 ${p.localPendingToApply} 条记录待写入`
      }
    } else if (p.phase === 'push') {
      if (p.localFilesTotal && p.localFilesWritten != null) {
        ratio = p.localFilesTotal ? p.localFilesWritten / p.localFilesTotal : undefined
        msg = msg || `已上传 ${p.localFilesWritten}/${p.localFilesTotal} 个文件（剩余 ${p.localFilesTotal - p.localFilesWritten} 个待上传）`
      } else if (p.localDocsTotal != null) {
        msg = msg || `本地有 ${p.localDocsTotal} 条记录待上传`
      }
    }
    if (msg) toast.update(msg, ratio)
    if (p.phase === 'done') toast.finish(p.message || '同步完成')
    if (p.phase === 'skip') toast.finish(p.message || '无需同步（无变更）')
    if (p.phase === 'error') toast.error(p.message || '同步出错')
    onProgress?.(p)
  }
}

/**
 * 配置 RemoteStorage 文件系统
 */
export async function configureRemoteStorage(config: RemoteStorageConnectionConfig): Promise<void> {
  if (isConfigured && currentFs) {
    return
  }

  const rsConfig: RemoteStorageConfig = {
    href: config.href,
    token: config.token,
    timeout: config.timeout || 30000,
  }

  currentFs = new RemoteStorageFileSystem(rsConfig)
  isConfigured = true
}

/**
 * 为同步引擎包装 PouchDB 的 allDocs。
 *
 * universal-sync-v2 的 filterPushDiff 直接调用 `doc._id.startsWith(...)`，
 * 只要库里存在一个缺少字符串 _id 的 doc（历史脏数据 / PouchDB 偶发不一致），
 * 整次同步就会抛 `TypeError: Cannot read properties of undefined (reading 'startsWith')` 中断，
 * 表现为「独立应用页永远同步失败」。
 *
 * 处理策略：
 *  1. 正常 row 原样返回；
 *  2. 缺 _id 的 row 用 row.id 重新 get 一次，能取回完整文档就替换（不丢用户记录）；
 *  3. 仍取不回才跳过，并打印 row.id 便于定位脏数据。
 *
 * 用 Proxy 只拦截 allDocs，其余方法与属性（get/put/bulkDocs/info 等，
 * LocalCache 还会用 get/put 写缓存文档）全部原样转发给真实 db。
 */
export function createSyncSafeDb(db: PouchDB.Database): PouchDB.Database {
  const guardedAllDocs = async (opts: any = {}) => {
    const res: any = await db.allDocs(opts)
    if (!opts?.include_docs || !Array.isArray(res?.rows)) return res

    const rows: any[] = []
    let repaired = 0
    for (const row of res.rows) {
      const doc = row?.doc
      if (!doc || typeof doc._id === 'string') {
        rows.push(row)
        continue
      }
      // include_docs 返回的 doc 缺 _id：用 row.id 重新读取一次
      const real = await db.get(row.id, { revs: true } as any).catch(() => null)
      if (real && typeof (real as any)._id === 'string') {
        rows.push({ ...row, doc: real })
        repaired++
      } else {
        console.warn('[RS Sync] 跳过缺少 _id 的异常文档:', row.id, Object.keys(doc))
      }
    }
    if (repaired > 0) {
      console.warn(`[RS Sync] 修复 ${repaired} 个 allDocs 返回的异常文档（缺 _id，已用 row.id 重新读取）`)
    }
    res.rows = rows
    return res
  }

  // 用 Proxy 只拦截 allDocs，其余方法/属性全部转发到真实 db（LocalCache 还会用 get/put）
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'allDocs') return guardedAllDocs
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as PouchDB.Database
}

/**
 * 清理本地 PouchDB 中历史遗留的 sync_conflict 文档。
 *
 * 背景：旧版冲突解析器对非书签文档的冲突返回 keep-conflict，每个冲突都会生成一个
 * 存双方完整快照的大 sync_conflict 文档（约 11KB），且该文档本身又是「非书签文档」，
 * 再次冲突会再次 keep-conflict → 正反馈雪崩（2026-10 在服务器上炸出上万个冲突文档、数百 MB）。
 * 冲突解析已改为确定性解决不再新生成；这里兜底清除本地存量，避免其在服务器瘦身后
 * 又被当作「新增文档」重新 push 回服务器。
 */
async function purgeLocalSyncConflicts(db: PouchDB.Database): Promise<void> {
  const res = await db
    .allDocs({
      startkey: 'sync_conflict:',
      endkey: 'sync_conflict:\uffff',
      include_docs: true,
    } as any)
    .catch(() => null)
  const rows = res?.rows ?? []
  const docs = rows.map((r: any) => r.doc).filter((d: any) => d && typeof d._rev === 'string')
  if (docs.length === 0) return
  for (let i = 0; i < docs.length; i += 200) {
    const batch = docs
      .slice(i, i + 200)
      .map((d: any) => ({ _id: d._id, _rev: d._rev, _deleted: true }))
    await db.bulkDocs(batch as any).catch((e) => console.warn('[RS Sync] 清理 sync_conflict 失败:', e))
  }
  console.log(`[RS Sync] 已清理本地 ${docs.length} 个 sync_conflict 文档`)
}

/**
 * 将 PouchDB 同步到 RemoteStorage
 */
export async function syncToRemoteStorage(
  db: PouchDB.Database,
  config: RemoteStorageConnectionConfig,
  options: RemoteStorageSyncOptions = {}
): Promise<void> {
  if (syncInProgress) {
    throw new Error('同步正在进行中')
  }

  try {
    syncInProgress = true

    await configureRemoteStorage(config)

    if (!currentFs) {
      throw new Error('文件系统未初始化')
    }

    const Engine = await getSyncEngine()

    // 通知全局同步状态 store：开始同步（页面内的同步胶囊据此出现）
    updateSyncStatus({ status: 'syncing', phase: undefined, message: '准备同步…', ratio: 0 })

    const toast = options.showToast === false ? null : showSyncToast('准备同步…')
    const toastHandler = toast ? bindProgressToast(toast, options.onProgress) : options.onProgress
    // 统一的进度回调：既更新全局 store（常驻胶囊），也驱动 toast（一次性浮层）与业务回调。
    const onProgress = (p: any) => {
      updateSyncStatus(syncProgressToStatus(p))
      toastHandler?.(p)
    }

    const engine = new Engine(createSyncSafeDb(db), currentFs as any, {
      basePath: '/onenav',
      maxFileSize: options.maxFileSize ?? 500 * 1024,
      mergeThreshold: options.mergeThreshold ?? 50 * 1024,
      autoMerge: options.autoMerge ?? true,
      conflictResolver: resolveOneNavSyncConflict,
      onProgress,
    })

    await engine.initialize()
    await engine.sync()
    // 同步落定后清除本地遗留的 sync_conflict 文档，避免其被再次 push 回服务器
    await purgeLocalSyncConflicts(db)
    // 收尾：置为已同步（done/skip 阶段已置过，幂等覆盖）
    updateSyncStatus({ status: 'synced', message: '已同步', ratio: 1 })
  } catch (err) {
    if (options.showToast !== false) {
      showSyncToast('同步失败').error(String(err))
    }
    updateSyncStatus({ status: 'error', message: '同步失败', ratio: 1 })
    throw err
  } finally {
    syncInProgress = false
  }
}

/**
 * 创建同步引擎实例
 */
export async function createSyncEngine(
  db: PouchDB.Database,
  config: RemoteStorageConnectionConfig,
  options: RemoteStorageSyncOptions = {}
): Promise<any> {
  await configureRemoteStorage(config)

  if (!currentFs) {
    throw new Error('文件系统未初始化')
  }

  const Engine = await getSyncEngine()

  const toast = options.showToast === false ? null : showSyncToast('准备同步…')
  const onProgress = toast ? bindProgressToast(toast, options.onProgress) : options.onProgress

  const engine = new Engine(createSyncSafeDb(db), currentFs as any, {
    basePath: '/onenav',
    maxFileSize: options.maxFileSize ?? 500 * 1024,
    mergeThreshold: options.mergeThreshold ?? 50 * 1024,
    autoMerge: options.autoMerge ?? true,
    conflictResolver: resolveOneNavSyncConflict,
    onProgress,
  })

  await engine.initialize()
  return engine
}

export function isRemoteStorageConfigured(): boolean {
  // 「已配置」= 本地存在可恢复的 RemoteStorage 凭据（持久化于 localStorage，跨页面共享）。
  // 之前依赖模块变量 isConfigured（仅在本会话手动触发过同步才为 true），
  // 导致独立页面（bookkeeping/golf/hostmonitor）永远判定为未配置而跳过自动 push。
  // 改用凭据判据后，「是否已配置」跨页面一致，独立页面保存数据后也能自动同步。
  return getStorageCredentials() !== null || getSavedStorageCredentials() !== null
}

export function isSyncing(): boolean {
  return syncInProgress
}

export function resetRemoteStorageConfig(): void {
  isConfigured = false
  syncInProgress = false
  currentFs = null
}

/**
 * 等待 RemoteStorage 连接就绪并返回 { href, token }。
 *
 * 为什么需要它：
 * 独立页面（bookkeeping/golf/hostmonitor）打开时，remotestoragejs 会从 localStorage
 * 异步恢复连接；此刻直接读 getStorageCredentials() 往往还是 null（连接尚未完成），
 * 导致自动 push 被漏掉。本函数保证在「已配置但连接恢复中」的情况下也能等到凭据。
 *
 * 三种情况：
 *  1. 已连接 → 立即返回凭据；
 *  2. 本地完全没有任何凭据（从未配置过） → 立即返回 null，不空等；
 *  3. 有凭据但连接尚在恢复 → 监听 connected 事件，最多等 8s，超时/失败返回 null。
 *     其中凭据可能只存在 remotestoragejs 自己的 `remotestorage:wireclient`，
 *     它由库在实例创建后用 setTimeout(0) 异步恢复，因此这种情况最多等 2s。
 *
 * 已导出，供 app-host-sync 的 bootstrap 引导复用：先建立实例再等连接就绪，
 * 覆盖「remotestorage:wireclient 有数据但 onenav:rs-credentials 缺失」的场景。
 */
export async function ensureStorageReady(): Promise<{ href: string; token: string } | null> {
  const connected = getStorageCredentials()
  if (connected) return connected

  // 先建立实例，触发 wireclient 的异步恢复（若有库内凭据）
  const rs = getRemoteStorage()
  if (rs.connected) return getStorageCredentials()

  const saved = getSavedStorageCredentials()
  const library = getLibraryStorageCredentials()
  // 应用级与库级都没有凭据 → 确实未配置，立即返回（不拖慢本地模式）
  if (!saved && !library) return null

  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (c: { href: string; token: string } | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try { (rs as any).off('connected', onConnected) } catch { /* noop */ }
      try { (rs as any).off('error', onError) } catch { /* noop */ }
      resolve(c)
    }
    const onConnected = () => finish(getStorageCredentials())
    const onError = () => finish(null)
    // 库内凭据只需等一个事件循环；应用级凭据的 connect() 会走 WebFinger 发现，给足 8s
    timer = setTimeout(() => finish(null), saved ? 8000 : 2000)
    rs.on('connected', onConnected)
    rs.on('error', onError)
  })
}

let autoSyncTimer: ReturnType<typeof setTimeout> | null = null
/**
 * 保存数据后的「自动同步」：若已配置 RemoteStorage，则 debounce 后自动 push 一次。
 * 这样本地书签/配置/记账/高尔夫等保存后会自动上传到服务器（无需手动点同步）。
 * 使用 debounce 合并短时间内多次保存（例如批量导入书签），避免频繁触发同步。
 * 通过 ensureStorageReady 等待连接恢复，使独立页面（bookkeeping/golf/hostmonitor）
 * 也能在连接异步恢复完成后自动 push。
 */
export async function scheduleAutoSync(db: PouchDB.Database, delay = 1500): Promise<void> {
  if (autoSyncTimer) clearTimeout(autoSyncTimer)
  autoSyncTimer = setTimeout(async () => {
    autoSyncTimer = null
    try {
      const creds = await ensureStorageReady()
      if (!creds) {
        console.log('[RS Sync] 自动同步跳过：RemoteStorage 未连接或不可用')
        return
      }
      console.log('[RS Sync] 自动同步（保存后 push）…')
      await syncToRemoteStorage(db, creds, { showToast: true })
    } catch (err) {
      console.error('[RS Sync] 自动同步失败（已忽略）:', err)
    }
  }, delay)
}
