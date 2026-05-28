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

function clearCredentials(): void {
  try {
    localStorage.removeItem(RS_CREDENTIALS_KEY)
  } catch {
    // ignore
  }
}

/**
 * 获取或创建 RemoteStorage 实例
 * 如果之前有保存的凭证，自动恢复连接
 */
export function getRemoteStorage(): RemoteStorage {
  if (!rsInstance) {
    rsInstance = new RemoteStorage({ logging: false, cache: true })
    
    // 尝试自动恢复连接
    const saved = loadCredentials()
    if (saved) {
      console.log('[RS Connection] 发现保存的凭证，尝试恢复连接:', saved.userAddress)
      // remotestoragejs 会从自己的 localStorage 恢复 connected 状态
      // 如果已经 connected，不需要额外操作
      if (!rsInstance.connected) {
        // 使用 connectWithToken 恢复
        rsInstance.on('connected', () => {
          console.log('[RS Connection] 连接恢复成功')
          notifyListeners({
            status: 'connected',
            userAddress: saved.userAddress,
            storageHref: saved.href,
            token: saved.token,
          })
        })
        rsInstance.on('error', (err: any) => {
          console.error('[RS Connection] 连接恢复失败:', err)
          clearCredentials()
        })
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
      userAddress: (rs as any).userAddress,
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
 * 使用 user@host 地址连接（完整 OAuth 流程）
 */
export function connectWithUserAddress(userAddress: string): void {
  const rs = getRemoteStorage()

  notifyListeners({ status: 'connecting', userAddress })

  rs.on('connecting', () => {
    notifyListeners({ status: 'connecting', userAddress })
  })

  rs.on('authing', () => {
    notifyListeners({ status: 'authing', userAddress })
  })

  rs.on('connected', () => {
    const remote = rs.remote as any
    // 保存凭证以便页面刷新后自动恢复
    if (remote?.href && remote?.token && (rs as any).userAddress) {
      saveCredentials((rs as any).userAddress, remote.href, remote.token)
    }
    notifyListeners({
      status: 'connected',
      userAddress: (rs as any).userAddress,
      storageHref: remote?.href,
      token: remote?.token,
    })
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

  rs.on('connected', () => {
    const remote = rs.remote as any
    // 保存凭证
    if (remote?.href && remote?.token) {
      saveCredentials(userAddress, remote.href, remote.token)
    }
    notifyListeners({
      status: 'connected',
      userAddress: (rs as any).userAddress,
      storageHref: remote?.href,
      token: remote?.token,
    })
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
 * 获取当前连接信息
 */
export function getConnectionInfo(): RSConnectionInfo {
  const rs = getRemoteStorage()
  if (rs.connected) {
    const remote = rs.remote as any
    return {
      status: 'connected',
      userAddress: (rs as any).userAddress,
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
