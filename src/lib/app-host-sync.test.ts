// 独立应用页 RemoteStorage 同步引导（AppHost 挂载时调用）行为验证测试。
//
// 修复目标：各独立应用页（bookkeeping/golf/hostmonitor）从不建立 RemoteStorage 连接，
// 导致 isRemoteStorageConfigured() 恒为 false、写后数据不 push 到后端。
// 本测试验证 bootstrapAppRemoteStorage()：
//  - 无已保存凭据 → 直接就绪（本地/WebDAV 模式），不发起同步；
//  - 有凭据 → 建立实例连接并触发一次初始双向同步（置 isConfigured + pull + push）；
//  - 同步失败 → 返回 false 而不抛错（应用降级为本地模式）。
// 不修改业务源码，只新增本测试。

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  // 已保存的 RemoteStorage 凭据（null = 无）
  savedCreds: null as null | { userAddress: string; href: string; token: string },
  // syncToRemoteStorage 是否被调用、收到的参数
  syncCalls: [] as Array<{ href: string; token: string; opts: unknown }>,
  // getRemoteStorage 被调用次数
  remoteStorageCalls: 0,
  // 让 syncToRemoteStorage 抛错，模拟网络/鉴权失败
  syncError: false,
  // getPouchDB 是否被调用
  pouchCalls: 0,
}))

vi.mock('@/lib/remotestorage-connection', () => ({
  getSavedStorageCredentials: () => h.savedCreds,
  getRemoteStorage: () => {
    h.remoteStorageCalls++
  },
}))

vi.mock('@/lib/remotestorage-sync', () => ({
  syncToRemoteStorage: vi.fn(async (_db: unknown, config: { href: string; token: string }, opts?: unknown) => {
    h.syncCalls.push({ href: config.href, token: config.token, opts })
    if (h.syncError) throw new Error('ECONNRESET')
  }),
}))

vi.mock('@/lib/pouchdb', () => ({
  getPouchDB: async () => {
    h.pouchCalls++
    return { __fake: true }
  },
}))

import { bootstrapAppRemoteStorage } from './app-host-sync'

beforeEach(() => {
  h.savedCreds = null
  h.syncCalls = []
  h.remoteStorageCalls = 0
  h.syncError = false
  h.pouchCalls = 0
})

describe('bootstrapAppRemoteStorage（AppHost 挂载时的 RS 同步引导）', () => {
  it('C-1 无已保存凭据：立即就绪，不建立连接、不触发同步（本地/WebDAV 模式）', async () => {
    h.savedCreds = null
    const ok = await bootstrapAppRemoteStorage()
    expect(ok).toBe(true)
    expect(h.remoteStorageCalls).toBe(0)
    expect(h.syncCalls).toHaveLength(0)
    expect(h.pouchCalls).toBe(0)
  })

  it('C-2 有已保存凭据：建立实例连接 + 触发一次初始双向同步（置 isConfigured、pull+push）', async () => {
    h.savedCreds = { userAddress: 'me@rs.test', href: 'https://rs.test/me', token: 'tok-abc' }
    const ok = await bootstrapAppRemoteStorage()
    expect(ok).toBe(true)
    // 建立了 remotestoragejs 实例连接（供后续 scheduleAutoSync 的 getStorageCredentials() 使用）
    expect(h.remoteStorageCalls).toBeGreaterThanOrEqual(1)
    // 用已保存凭据做初始同步，且不弹 toast（避免每次打开应用都弹同步提示）
    expect(h.syncCalls).toHaveLength(1)
    expect(h.syncCalls[0].href).toBe('https://rs.test/me')
    expect(h.syncCalls[0].token).toBe('tok-abc')
    expect(h.syncCalls[0].opts).toEqual({ showToast: false })
    expect(h.pouchCalls).toBe(1)
  })

  it('C-3 同步失败（网络/鉴权）：返回 false 而不抛错，应用降级为本地模式', async () => {
    h.savedCreds = { userAddress: 'me@rs.test', href: 'https://rs.test/me', token: 'tok-abc' }
    h.syncError = true
    await expect(bootstrapAppRemoteStorage()).resolves.toBe(false)
    expect(h.syncCalls).toHaveLength(1)
  })
})
