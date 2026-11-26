// 日历 v2 同步链路集成测试：PouchDB --universal-sync-v2--> DataGroup.fs（zen-fs-config v2 提供的文件系统）。
// 用临时 Folder 后端代替远端，PouchDB 用 memory 适配器，不依赖网络。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const h = vi.hoisted(() => ({ db: null as any }))

vi.mock('./calendar-db', () => ({
  getCalendarPouchDB: async () => h.db,
}))

import { attachCalendarRepo, detachCalendarRepo, syncCalendarNow } from './calendar-sync'

if (typeof (globalThis as any).self === 'undefined') (globalThis as any).self = globalThis

let base = ''
let repo: any = null
let db: any = null

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'onenav-calendar-v2-it-'))
  const { createConfigRepo } = await import('zen-fs-config')
  repo = await createConfigRepo('calendar-it', {
    folderPath: path.join(base, 'config'),
    nodeId: 'calendar-it-node',
  })

  const PouchDBMod: any = (await import('pouchdb-browser')).default
  const memory: any = (await import('pouchdb-adapter-memory')).default
  PouchDBMod.plugin(memory)
  db = new PouchDBMod(`calendar-it-${Date.now()}`, { adapter: 'memory' })
  h.db = db
})

afterEach(async () => {
  detachCalendarRepo()
  try {
    await db?.destroy()
  } catch {
    /* 忽略 */
  }
  db = null
  h.db = null
  try {
    await repo?.dispose?.()
  } catch {
    /* 忽略 */
  }
  repo = null
  if (base) await rm(base, { recursive: true, force: true }).catch(() => {})
})

describe('日历 v2 数据组同步', () => {
  // 分片目录按同步时刻生成，不能硬编码日期；递归列出 /calendar/data 下所有分片。
  const listShards = async (fsPromises: any, dir: string): Promise<string[]> => {
    const entries: string[] = await fsPromises.readdir(dir).catch(() => [])
    const files: string[] = []
    for (const entry of entries) {
      const full = `${dir}/${entry}`
      const children = await fsPromises.readdir(full).catch(() => null)
      if (children === null) files.push(full)
      else files.push(...(await listShards(fsPromises, full)))
    }
    return files
  }

  it('attachCalendarRepo 把 cal: 文档写进数据组 fs，并可从 fs 回读', async () => {
    const group = await repo.createAppDataGroup('default', [])
    await db.put({
      _id: 'cal:2026-11-25:event-1',
      date: '2026-11-25',
      title: '同步测试事件',
      body: '',
      allDay: true,
      startTime: '',
      endTime: '',
      category: 'note',
      color: '#fbbf24',
      createdAt: 1,
      updatedAt: 1,
    })

    // v2 的 AppRepo 只需给出 DataGroup；同步层只用它的 fs.promises 与 onSyncEvent。
    await attachCalendarRepo({
      appId: 'calendar',
      getDefaultDataGroup: async () => group,
    } as any)

    const shards = await listShards(group.fs.promises, '/calendar/data')
    expect(shards.length).toBeGreaterThan(0)
    const shard = JSON.parse(await group.fs.promises.readFile(shards[0], 'utf8'))
    expect(shard.documents.some((d: any) => d._id === 'cal:2026-11-25:event-1')).toBe(true)

    // 再放一个「远端已有」的分片，syncCalendarNow 应把它拉回 PouchDB。
    const shardDir = shards[0].slice(0, shards[0].lastIndexOf('/'))
    const remoteId = 'cal:2026-11-26:event-2'
    await group.fs.promises.writeFile(
      `${shardDir}/data-remote-0001.json`,
      JSON.stringify({
        version: '2.0.0',
        timestamp: Date.now(),
        documents: [
          {
            _id: remoteId,
            _rev: '1-0123456789abcdef0123456789abcdef',
            date: '2026-11-26',
            title: '远端事件',
            body: '',
            allDay: true,
            startTime: '',
            endTime: '',
            category: 'note',
            color: '#fbbf24',
            createdAt: 2,
            updatedAt: 2,
          },
        ],
      }),
    )
    await syncCalendarNow()
    const pulled = await db.get(remoteId)
    expect(pulled.title).toBe('远端事件')

    // 同步后本地文档与 fs 分片都仍存在。
    expect((await db.get('cal:2026-11-25:event-1')).title).toBe('同步测试事件')
    expect((await listShards(group.fs.promises, '/calendar/data')).length).toBeGreaterThanOrEqual(2)
  })

  it('挂载时先 flush 数据组，再把 fs 中的远端变更拉回 PouchDB', async () => {
    const group = await repo.createAppDataGroup('default', [])
    const calls: string[] = []
    const remoteId = 'cal:2026-11-30:boot'

    // 模拟真实数据组：flush() 把远端文件落到 fs；记录调用顺序以验证 flush 先于 SyncEngine。
    const wrapped: any = {
      fs: group.fs,
      onSyncEvent: (handler: any) => {
        const off = (group as any).onSyncEvent?.(handler)
        return typeof off === 'function' ? off : () => {}
      },
      flush: async () => {
        calls.push('flush')
        for (const dir of [
          '/calendar',
          '/calendar/data',
          '/calendar/data/2026',
          '/calendar/data/2026/11',
          '/calendar/data/2026/11/30',
        ]) {
          await group.fs.promises.mkdir(dir).catch(() => {})
        }
        await group.fs.promises.writeFile(
          '/calendar/data/2026/11/30/data-remote-0001.json',
          JSON.stringify({
            version: '2.0.0',
            timestamp: Date.now(),
            documents: [
              {
                _id: remoteId,
                _rev: '1-fedcba9876543210fedcba9876543210',
                date: '2026-11-30',
                title: '打开页面时拉取',
                body: '',
                allDay: true,
                startTime: '',
                endTime: '',
                category: 'note',
                color: '#fbbf24',
                createdAt: 4,
                updatedAt: 4,
              },
            ],
          }),
        )
        return []
      },
    }

    await attachCalendarRepo({
      appId: 'calendar',
      getDefaultDataGroup: async () => wrapped,
    } as any)

    expect(calls).toEqual(['flush'])
    expect((await db.get(remoteId)).title).toBe('打开页面时拉取')
  })

  it('PouchDB changes feed 会把绕过 store 的直接写入自动同步到数据组', async () => {
    const group = await repo.createAppDataGroup('default', [])
    await attachCalendarRepo({
      appId: 'calendar',
      getDefaultDataGroup: async () => group,
    } as any)

    // 故意绕过 calendar-store 直接写 PouchDB，验证同步由 changes feed 驱动。
    await db.put({
      _id: 'cal:2026-11-28:event-3',
      date: '2026-11-28',
      title: '绕过 store 的写入',
      body: '',
      allDay: true,
      startTime: '',
      endTime: '',
      category: 'note',
      color: '#fbbf24',
      createdAt: 3,
      updatedAt: 3,
    })

    await new Promise((resolve) => setTimeout(resolve, 2200))
    const shards = await listShards(group.fs.promises, '/calendar/data')
    const contents = await Promise.all(shards.map((p) => group.fs.promises.readFile(p, 'utf8')))
    expect(contents.some((text) => text.includes('cal:2026-11-28:event-3'))).toBe(true)
  })
})
