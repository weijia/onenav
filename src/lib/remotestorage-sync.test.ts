// createSyncSafeDb 回归测试：
// universal-sync-v2 的 filterPushDiff 直接调用 doc._id.startsWith(...)，
// 只要 allDocs 返回的某个 row.doc 缺少字符串 _id，整次同步就会抛
// TypeError: Cannot read properties of undefined (reading 'startsWith') 中断。

import { describe, it, expect, vi } from 'vitest'
import { createSyncSafeDb } from './remotestorage-sync'

function fakeDb(rows: any[], docs: Record<string, any> = {}) {
  return {
    allDocs: vi.fn(async () => ({ rows, total_rows: rows.length, offset: 0 })),
    get: vi.fn(async (id: string) => {
      if (docs[id]) return docs[id]
      const err: any = new Error('missing')
      err.status = 404
      throw err
    }),
    put: vi.fn(),
    bulkDocs: vi.fn(),
    info: vi.fn(async () => ({ doc_count: rows.length })),
    marker: 'real-db',
  } as any
}

describe('createSyncSafeDb（防止脏 row 让整次同步崩溃）', () => {
  it('正常 rows 原样返回，不触发修复', async () => {
    const rows = [
      { id: 'bm:a', doc: { _id: 'bm:a', _rev: '1-a' } },
      { id: 'bk:tx:1', doc: { _id: 'bk:tx:1', _rev: '2-b' } },
    ]
    const db = fakeDb(rows)
    const safe = createSyncSafeDb(db)
    const res: any = await (safe as any).allDocs({ include_docs: true })

    expect(res.rows).toHaveLength(2)
    expect(res.rows[0].doc._id).toBe('bm:a')
    expect(db.get).not.toHaveBeenCalled()
  })

  it('缺 _id 的 row：用 row.id 重新 get 修复后保留', async () => {
    const rows = [
      { id: 'app:golf', doc: { hello: 'no-id' } },
      { id: 'bm:b', doc: { _id: 'bm:b' } },
    ]
    const realDoc = { _id: 'app:golf', _rev: '3-c', data: 1 }
    const db = fakeDb(rows, { 'app:golf': realDoc })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const safe = createSyncSafeDb(db)
    const res: any = await (safe as any).allDocs({ include_docs: true })

    expect(db.get).toHaveBeenCalledWith('app:golf', { revs: true })
    expect(res.rows).toHaveLength(2)
    const fixed = res.rows.find((r: any) => r.id === 'app:golf')
    expect(fixed.doc).toEqual(realDoc)
    // 每条 row 的 doc 都必须有字符串 _id，否则引擎会崩
    for (const row of res.rows) expect(typeof row.doc._id).toBe('string')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('修复 1 个'))
    warn.mockRestore()
  })

  it('重新 get 也取不回时才跳过该 row，并打印 row.id', async () => {
    const rows = [
      { id: 'bad:doc', doc: { no: '_id' } },
      { id: 'bm:c', doc: { _id: 'bm:c' } },
    ]
    const db = fakeDb(rows)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const safe = createSyncSafeDb(db)
    const res: any = await (safe as any).allDocs({ include_docs: true })

    expect(res.rows).toHaveLength(1)
    expect(res.rows[0].doc._id).toBe('bm:c')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('跳过缺少 _id'), 'bad:doc', expect.any(Array))
    warn.mockRestore()
  })

  it('delete 产生的 doc:null row 原样保留（filterPushDiff 自带 !doc 判断）', async () => {
    const rows = [
      { id: 'bm:d', doc: null, value: { rev: '2-x', deleted: true } },
      { id: 'bm:e', doc: { _id: 'bm:e' } },
    ]
    const db = fakeDb(rows)
    const safe = createSyncSafeDb(db)
    const res: any = await (safe as any).allDocs({ include_docs: true })

    expect(res.rows).toHaveLength(2)
    expect(db.get).not.toHaveBeenCalled()
  })

  it('其他方法与属性透传给真实 db', async () => {
    const db = fakeDb([])
    const safe = createSyncSafeDb(db)

    expect((safe as any).marker).toBe('real-db')
    await expect((safe as any).info()).resolves.toEqual({ doc_count: 0 })
    await (safe as any).put({ _id: 'x' })
    expect(db.put).toHaveBeenCalledWith({ _id: 'x' })
  })
})
