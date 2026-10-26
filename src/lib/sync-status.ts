/**
 * 全局 RemoteStorage 同步状态（轻量 pub/sub，无框架依赖）。
 *
 * 任何走 syncToRemoteStorage 的同步（应用页 bootstrap 初始同步、保存后的自动同步、主页/设置里的手动同步）
 * 都会把当前进度写入这里；页面组件（如记账页的同步状态胶囊）订阅后即可渲染：
 *   - syncing：显示「同步中 · 读取 X/Y 文件」与进度条
 *   - synced / error：显示「已同步 / 同步失败」
 *
 * 设计上只存最新一份状态，不做历史队列，订阅即返回当前值，避免竞态丢事件。
 */

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error'

export interface SyncStatusState {
  status: SyncStatus
  /** 当前阶段：pull=拉取远端，push=上传本地 */
  phase?: 'pull' | 'push'
  /** 人类可读的进度文案（如「读取 3/10 个文件」） */
  message?: string
  /** 0..1 完成比例；未进入可归一化阶段时为 undefined */
  ratio?: number
  filesRead?: number
  filesTotal?: number
  /** 该状态产生的时间戳（ms） */
  at: number
}

let state: SyncStatusState = { status: 'idle', at: 0 }
const listeners = new Set<(s: SyncStatusState) => void>()

/** 读取当前同步状态（订阅前可先取一次避免初值错位）。 */
export function getSyncStatus(): SyncStatusState {
  return state
}

/** 写入同步状态增量；字段缺省则沿用上次值。 */
export function updateSyncStatus(patch: Partial<SyncStatusState>): void {
  state = { ...state, ...patch, at: Date.now() }
  for (const fn of listeners) fn(state)
}

/**
 * 订阅同步状态。返回取消订阅函数。
 * 订阅时会立即以当前状态回调一次，供组件初始化渲染。
 */
export function subscribeSyncStatus(fn: (s: SyncStatusState) => void): () => void {
  listeners.add(fn)
  fn(state)
  return () => {
    listeners.delete(fn)
  }
}
