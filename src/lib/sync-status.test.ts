import { describe, it, expect, vi } from 'vitest'
import { getSyncStatus, updateSyncStatus, subscribeSyncStatus } from './sync-status'

describe('sync-status store', () => {
  it('初始为 idle', () => {
    expect(getSyncStatus().status).toBe('idle')
  })

  it('update 会合并增量并刷新时间戳', () => {
    updateSyncStatus({ status: 'syncing', phase: 'pull', message: '读取 3/10 个文件', ratio: 0.3, filesRead: 3, filesTotal: 10 })
    const s = getSyncStatus()
    expect(s.status).toBe('syncing')
    expect(s.phase).toBe('pull')
    expect(s.message).toBe('读取 3/10 个文件')
    expect(s.ratio).toBe(0.3)
    expect(s.filesRead).toBe(3)
    expect(s.filesTotal).toBe(10)
    expect(s.at).toBeGreaterThan(0)
  })

  it('订阅立即回调当前值，并支持取消订阅', () => {
    updateSyncStatus({ status: 'syncing', message: '准备同步…' })
    const fn = vi.fn()
    const unsubscribe = subscribeSyncStatus(fn)
    // 订阅时立即回调一次当前状态
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn.mock.calls[0][0].status).toBe('syncing')

    updateSyncStatus({ status: 'synced', ratio: 1 })
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn.mock.calls[1][0].status).toBe('synced')

    unsubscribe()
    updateSyncStatus({ status: 'error', message: '同步失败' })
    expect(fn).toHaveBeenCalledTimes(2) // 取消后不再收到
  })

  it('update 未提供的字段沿用上次值', () => {
    updateSyncStatus({ status: 'synced', message: '已同步', ratio: 1 })
    updateSyncStatus({ status: 'idle' })
    const s = getSyncStatus()
    expect(s.status).toBe('idle')
    expect(s.ratio).toBe(1) // ratio 沿用上次
    expect(s.message).toBe('已同步') // message 沿用上次
  })
})
