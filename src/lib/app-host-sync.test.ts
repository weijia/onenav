// 独立应用页 RemoteStorage 同步引导（AppHost 挂载时调用）行为验证测试。
//
// 修复目标：各独立应用页（bookkeeping/golf/hostmonitor）从不建立 RemoteStorage 连接，
// 导致 isRemoteStorageConfigured() 恒为 false、写后数据不 push 到后端。
// 本测试验证 bootstrapAppRemoteStorage()：
//  - 无可用凭据 → 直接就绪（本地/WebDAV 模式），不发起同步；
//  - 有凭据 → 建立实例连接并触发一次初始双向同步（pull + push）；
//  - 同步失败 → 返回 false 而不抛错（应用降级为本地模式）。
// 关键：getRemoteStorage() 必须在凭据判断之前调用，让 wireclient 从 remotestorage:wireclient
// 恢复连接，覆盖 onenav:rs-credentials 缺失但 remotestorage:wireclient 仍有数据的场景。

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  // ensureStorageReady 返回的凭据（null = 无可用凭据）
  readyCreds: null as null | { href: string; token: string },
  // syncToRemoteStorage 是否被调用、收到的参数
  syncCalls: [] as Array<{ href: string; token: string; opts: unknown }>,
  // getRemoteStorage 被调用次数
  remoteStorageCalls: 0,
  // ensureStorageReady 被调用次数
  ensureReadyCalls: 0,
  // 让 syncToRemoteStorage 抛错，模拟网络/鉴权失败
  syncError: false,
  // getPouchDB 是否被调用
  pouchCalls: 0,
}))

vi.mock('@/lib/remotestorage-connection', () => ({
  getRemoteStorage: () => {
    h.remoteStorageCalls++
  },
}))

vi.mock('@/lib/remotestorage-sync', () => ({
  ensureStorageReady: async () => {
    h.ensureReadyCalls++
    return h.readyCreds
  },
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
  h.readyCreds = null
  h.syncCalls = []
  h.remoteStorageCalls = 0
  h.ensureReadyCalls = 0
  h.syncError = false
  h.pouchCalls = 0
})

describe('bootstrapAppRemoteStorage（AppHost 挂载时的 RS 同步引导）', () => {
  it('C-1 无可用凭据：建立实例后就绪，不触发同步（本地/WebDAV 模式）', async () => {
    h.readyCreds = null
    const ok = await bootstrapAppRemoteStorage()
    expect(ok).toBe(true)
    // 关键：无论是否有凭据，都必须先建立 RS 实例（让 wireclient 恢复连接）
    expect(h.remoteStorageCalls).toBe(1)
    expect(h.ensureReadyCalls).toBe(1)
    expect(h.syncCalls).toHaveLength(0)
    expect(h.pouchCalls).toBe(0)
  })

  it('C-2 有可用凭据：建立实例连接 + 触发一次初始双向同步（pull+push）', async () => {
    h.readyCreds = { href: 'https://rs.test/me', token: 'tok-abc' }
    const ok = await bootstrapAppRemoteStorage()
    expect(ok).toBe(true)
    expect(h.remoteStorageCalls).toBe(1)
    expect(h.ensureReadyCalls).toBe(1)
    // 用 ensureStorageReady 返回的凭据做初始同步，且不弹 toast
    expect(h.syncCalls).toHaveLength(1)
    expect(h.syncCalls[0].href).toBe('https://rs.test/me')
    expect(h.syncCalls[0].token).toBe('tok-abc')
    // 额外传入 onProgress：独立页无 toast，靠它把 pull/push 进度打到控制台便于排查
    const opts = h.syncCalls[0].opts as Record<string, unknown>
    expect(opts.showToast).toBe(false)
    expect(typeof opts.onProgress).toBe('function')
    expect(h.pouchCalls).toBe(1)
  })

  it('C-3 同步失败（网络/鉴权）：返回 false 而不抛错，应用降级为本地模式', async () => {
    h.readyCreds = { href: 'https://rs.test/me', token: 'tok-abc' }
    h.syncError = true
    await expect(bootstrapAppRemoteStorage()).resolves.toBe(false)
    expect(h.syncCalls).toHaveLength(1)
  })
})
