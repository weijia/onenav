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
 * 获取或创建 RemoteStorage 实例
 */
export function getRemoteStorage(): RemoteStorage {
  if (!rsInstance) {
    rsInstance = new RemoteStorage({ logging: false, cache: true })
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
