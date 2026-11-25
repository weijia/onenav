// 日历 v2 同步链路集成测试：PouchDB --universal-sync-v2--> DataGroup.fs（zen-fs-config v2 提供的文件系统）。
// 用临时 Folder 后端代替远端，PouchDB 用 memory 适配器，不依赖网络。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
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

    const dayDir = '/calendar/data/2026/11/25'
    const files = await group.fs.promises.readdir(dayDir)
    expect(files.length).toBeGreaterThan(0)
    const shard = JSON.parse(await group.fs.promises.readFile(`${dayDir}/${files[0]}`, 'utf8'))
    expect(shard.documents.some((d: any) => d._id === 'cal:2026-11-25:event-1')).toBe(true)

    // 再放一个「远端已有」的分片，syncCalendarNow 应把它拉回 PouchDB。
    const remoteId = 'cal:2026-11-26:event-2'
    await group.fs.promises.writeFile(
      `${dayDir}/data-remote-0001.json`,
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

    const allFiles = await readdir(path.join(base, 'config')).catch(() => [])
    expect(Array.isArray(allFiles)).toBe(true)
    expect(typeof (await readFile(path.join(base, 'config', '.meta', 'group.json'), 'utf8'))).toBe('string')
  })
})
