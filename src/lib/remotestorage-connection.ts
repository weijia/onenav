/**
 * RemoteStorage 连接管理模块
 * 
 * 基于 remotestoragejs 实现完整的 OAuth 登录流程：
 * 1. 用户输入 user@host 地址
 * 2. Webfinger 发现存储端点
 * 3. OAuth 授权重定向
 * 4. 回调获取 token
 * 5. 连接成功后可用于同步
 */

import RemoteStorage from 'remotestoragejs'

// localStorage key for persisting connection info across page reloads
const RS_CREDENTIALS_KEY = 'onenav:rs-credentials'

// 单例
let rsInstance: RemoteStorage | null = null

export type ConnectionStatus = 'disconnected' | 'connecting' | 'authing' | 'connected' | 'error'

export interface RSConnectionInfo {
  status: ConnectionStatus
  userAddress?: string
  storageHref?: string
  token?: string
  error?: string
}

type StatusChangeCallback = (info: RSConnectionInfo) => void

const listeners: Set<StatusChangeCallback> = new Set()

function notifyListeners(info: RSConnectionInfo) {
  listeners.forEach(cb => cb(info))
}

/**
 * 连接成功后自动双向同步：先 pull（把服务器配置/书签拉回本地），再 push（把本地配置上传到服务器）。
 * 这能解决「授权后首次加载时本地 cfg:app 缺失导致 404」的问题——push 之后远端就有了配置。
 * 通过动态 import 避免与 remotestorage-sync 形成循环依赖。
 */
async function triggerAutoSyncAfterConnect(): Promise<void> {
  try {
    const creds = getStorageCredentials()
    if (!creds) return
    const { getPouchDB } = await import('./pouchdb')
    const { syncToRemoteStorage } = await import('./remotestorage-sync')
    const db = await getPouchDB()
    console.log('[RS Connection] 连接成功，自动双向同步（pull + push）…')
    await syncToRemoteStorage(db, creds, { showToast: true })
  } catch (err) {
    console.error('[RS Connection] 自动同步失败（已忽略）:', err)
  }
}

function saveCredentials(userAddress: string, href: string, token: string): void {
  try {
    localStorage.setItem(RS_CREDENTIALS_KEY, JSON.stringify({ userAddress, href, token }))
  } catch {
    // ignore
  }
}

function loadCredentials(): { userAddress: string; href: string; token: string } | null {
  try {
    const raw = localStorage.getItem(RS_CREDENTIALS_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * 获取已保存的 RemoteStorage 凭据。
 * 这个方法不要求 remotestoragejs 当前处于 connected 状态，
 * 用于启动阶段直接访问文件系统，减少等待连接状态恢复的时间。
 */
export function getSavedStorageCredentials(): { userAddress: string; href: string; token: string } | null {
  return loadCredentials()
}

/**
 * 读取 remotestoragejs 库自身持久化的连接配置（localStorage key: `remotestorage:wireclient`）。
 *
 * 老用户（或从主页面授权后直接跳转应用页）的凭据可能只存在这个 key 里，
 * 而 `onenav:rs-credentials` 尚未写入。wireclient 会在实例创建后用 setTimeout(0)
 * 异步恢复连接，因此启动引导需要知道「库里有凭据」，才能多等一个事件循环再判定。
 */
export function getLibraryStorageCredentials(): { userAddress: string; href: string; token: string } | null {
  try {
    const raw = localStorage.getItem('remotestorage:wireclient')
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<{ userAddress: string; href: string; token: string }>
    if (parsed?.userAddress && parsed.href && parsed.token) {
      return { userAddress: parsed.userAddress, href: parsed.href, token: parsed.token }
    }
    return null
  } catch {
    return null
  }
}

function clearCredentials(): void {
  try {
    localStorage.removeItem(RS_CREDENTIALS_KEY)
  } catch {
    // ignore
  }
}

export function isRemoteStorageAuthError(error: unknown): boolean {
  const seen = new Set<unknown>()
  const authPattern = /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid token|expired token|access denied/i

  const check = (value: unknown): boolean => {
    if (value == null) return false
    if (typeof value === 'string') return authPattern.test(value)
    if (typeof value === 'number') return value === 401 || value === 403
    if (typeof value !== 'object') return false
    if (seen.has(value)) return false
    seen.add(value)

    const err = value as Record<string, unknown>
    return (
      check(err.status) ||
      check(err.statusCode) ||
      check(err.code) ||
      check(err.message) ||
      check(err.name) ||
      check(err.error) ||
      check(err.cause) ||
      check((err.response as Record<string, unknown> | undefined)?.status) ||
      check((err.response as Record<string, unknown> | undefined)?.statusText)
    )
  }

  return check(error)
}

export function clearRemoteStorageLogin(): void {
  try {
    if (rsInstance?.connected) {
      rsInstance.disconnect()
    }
  } catch {
    // ignore
  }
  clearCredentials()
  try {
    localStorage.removeItem('rsConfigured')
  } catch {
    // ignore
  }
  rsInstance = null
  notifyListeners({ status: 'disconnected' })
}

/**
 * 获取或创建 RemoteStorage 实例
 * 如果之前有保存的凭证，自动恢复连接
 */
export function getRemoteStorage(): RemoteStorage {
  if (!rsInstance) {
    rsInstance = new RemoteStorage({ logging: false, cache: true })

    const saved = loadCredentials()

    // 统一在「连接成功」时持久化应用级凭据（onenav:rs-credentials）。
    // 关键修复：之前只有 connectWithUserAddress/connectWithToken 的 connected 回调会保存凭据，
    // 而 OAuthCallback 可能在 connected 前就跳转主页、或 RS 自动重连不经过这两个函数，
    // 导致 onenav:rs-credentials 缺失 → 独立应用页 getSavedStorageCredentials() 恒为 null →
    // bootstrapAppRemoteStorage 直接 return（本地模式），写后同步永不发起。
    // 这里无论创建实例时是否已存有凭据，只要 RS 连接成功就保存，确保任意页面都能读到凭据。
    rsInstance.on('connected', () => {
      const remote = rsInstance!.remote as any
      // userAddress 存在于 wireclient（rs.remote）上，而非 rs 实例本身。
      // 之前误写为 (rsInstance as any).userAddress（恒为 undefined），
      // 导致 saveCredentials 的条件 `ua` 为假、onenav:rs-credentials 永不写入，
      // 独立应用页 getSavedStorageCredentials() 恒为 null → 本地模式、零同步。
      const ua = remote?.userAddress || saved?.userAddress
      if (remote?.href && remote?.token && ua) {
        saveCredentials(ua, remote.href, remote.token)
      }
      notifyListeners({
        status: 'connected',
        userAddress: ua,
        storageHref: remote?.href,
        token: remote?.token,
      })
    })
    rsInstance.on('error', (err: any) => {
      console.error('[RS Connection] 连接失败:', err)
      if (isRemoteStorageAuthError(err)) clearRemoteStorageLogin()
    })

    // 尝试自动恢复连接
    if (saved) {
      console.log('[RS Connection] 发现保存的凭证，尝试恢复连接:', saved.userAddress)
      // 必须在 connect 之前声明访问权限，否则 OAuth scope 不会被记录。
      // 虽然同步链路用 RemoteStorageFileSystem 直连（不依赖库内部 access），
      // 但补齐 claim 可避免 _rememberAuthorizedScope 收到空 scope 而误清已授权记录。
      claimDefaultAccess()
      // remotestoragejs 会从自己的 localStorage 恢复 connected 状态
      if (!rsInstance.connected) {
        rsInstance.connect(saved.userAddress, saved.token)
      } else {
        console.log('[RS Connection] remotestoragejs 已自动恢复连接')
      }
    }
  }
  return rsInstance
}

/**
 * 注册连接状态变化监听
 */
export function onStatusChange(callback: StatusChangeCallback): () => void {
  listeners.add(callback)
  // 立即通知当前状态
  const rs = getRemoteStorage()
  if (rs.connected) {
    const remote = rs.remote as any
    callback({
      status: 'connected',
      userAddress: remote?.userAddress,
      storageHref: remote?.href,
      token: remote?.token,
    })
  } else {
    callback({ status: 'disconnected' })
  }
  return () => listeners.delete(callback)
}

/**
 * 声明访问权限
 * 必须在 connect 之前调用
 */
export function claimAccess(moduleName: string, mode: string = 'rw'): void {
  const rs = getRemoteStorage()
  rs.access.claim(moduleName, mode as any)
}

/**
 * OneNav 默认需要的 RemoteStorage 权限。
 * - onenav: 主应用数据，同步 PouchDB 数据
 * - app_data: 读取 app_data/favorites 收藏书签目录
 * - ufs-nodes: 设备监控应用读取主机/磁盘遥测（home_cloud 写入，只读）
 *
 * 注意：所有 claim 必须在 rs.connect() 之前完成，否则不会进入 OAuth scope。
 * 新增模块（如 ufs-nodes）后，已连接的老用户需重新走一次完整 OAuth 连接
 * （断开 → 用 user@host 重新连接），新 scope 才会被写入 token。
 */
export function claimDefaultAccess(): void {
  claimAccess('onenav', 'rw')
  claimAccess('app_data', 'rw')
  claimAccess('ufs-nodes', 'r')
}

/**
 * 使用 user@host 地址连接（完整 OAuth 流程）
 */
export function connectWithUserAddress(userAddress: string): void {
  const rs = getRemoteStorage()
  claimDefaultAccess()

  notifyListeners({ status: 'connecting', userAddress })

  rs.on('connecting', () => {
    notifyListeners({ status: 'connecting', userAddress })
  })

  rs.on('authing', () => {
    notifyListeners({ status: 'authing', userAddress })
  })

  rs.on('connected', () => {
    const remote = rs.remote as any
    // 保存凭证以便页面刷新后自动恢复。
    // 注意：userAddress 在 wireclient（rs.remote）上，(rs as any).userAddress 恒为 undefined。
    // 优先用 remote.userAddress（连接后由库写入），兜底用入参 userAddress。
    const ua = remote?.userAddress || userAddress
    if (remote?.href && remote?.token && ua) {
      saveCredentials(ua, remote.href, remote.token)
    }
    notifyListeners({
      status: 'connected',
      userAddress: ua,
      storageHref: remote?.href,
      token: remote?.token,
    })
    void triggerAutoSyncAfterConnect()
  })

  rs.on('error', (err: any) => {
    notifyListeners({
      status: 'error',
      userAddress,
      error: err.message || String(err),
    })
  })

  rs.connect(userAddress)
}

/**
 * 使用已有 token 连接（跳过 OAuth）
 */
export function connectWithToken(userAddress: string, token: string): void {
  const rs = getRemoteStorage()
  claimDefaultAccess()

  rs.on('connected', () => {
    const remote = rs.remote as any
    // 保存凭证
    if (remote?.href && remote?.token) {
      saveCredentials(userAddress, remote.href, remote.token)
    }
    notifyListeners({
      status: 'connected',
      userAddress: remote?.userAddress || userAddress,
      storageHref: remote?.href,
      token: remote?.token,
    })
    void triggerAutoSyncAfterConnect()
  })

  rs.on('error', (err: any) => {
    notifyListeners({
      status: 'error',
      userAddress,
      error: err.message || String(err),
    })
  })

  rs.connect(userAddress, token)
}

/**
 * 断开连接
 */
export function disconnect(): void {
  const rs = getRemoteStorage()
  rs.disconnect()
  clearCredentials()
  notifyListeners({ status: 'disconnected' })
}

/**
 * 强制重新走完整 OAuth 以更新令牌作用域（用于「已连接但缺 ufs-nodes 作用域」的 401）。
 *
 * 关键点：remotestoragejs 在 connect 时若发现已存有该 user 的令牌，会直接复用旧令牌、
 * 跳过 OAuth。因此必须先 disconnect() 清掉库内旧 token，后续的 connect(userAddress)（不带 token）
 * 才会真正发起完整 OAuth 重定向；新令牌将带上 claimDefaultAccess() 中的 ufs-nodes:r。
 *
 * 调用后页面会跳转到服务商授权页，本函数不会返回。
 * @returns false 表示无已保存账号、无法自动重连（此时应走手动「去连接」引导）。
 */
export function reauthorizeForUfsNodes(): boolean {
  const saved = getSavedStorageCredentials()
  if (!saved?.userAddress) return false
  // 先断开：清掉 remotestoragejs 内部旧 token，确保后续 connect 触发完整 OAuth 而非复用旧令牌
  disconnect()
  connectWithUserAddress(saved.userAddress)
  return true
}

/**
 * 获取当前连接信息
 */
export function getConnectionInfo(): RSConnectionInfo {
  const rs = getRemoteStorage()
  if (rs.connected) {
    const remote = rs.remote as any
    return {
      status: 'connected',
      userAddress: remote?.userAddress,
      storageHref: remote?.href,
      token: remote?.token,
    }
  }
  return { status: 'disconnected' }
}

/**
 * 获取 storage href 和 token（用于文件系统操作）
 */
export function getStorageCredentials(): { href: string; token: string } | null {
  const rs = getRemoteStorage()
  if (!rs.connected) return null
  const remote = rs.remote as any
  if (!remote?.href || !remote?.token) return null
  return { href: remote.href, token: remote.token }
}
