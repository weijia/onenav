// 日历事件本地存储行为验证：同步由 calendar-sync 的 changes feed 驱动，这里只测 store 本身。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  db: null as any,
}))

vi.mock('@/lib/calendar-db', () => ({
  CAL_PREFIX: 'cal:',
  CAL_END: 'cal:\uffff',
  calendarDocId: (date: string, id: string) => `cal:${date}:${id}`,
  getCalendarDb: async () => h.db,
  isCalendarDoc: (d: any) =>
    !!d &&
    typeof d._id === 'string' &&
    d._id.startsWith('cal:') &&
    !d.deleted &&
    typeof d.date === 'string' &&
    typeof d.title === 'string',
}))

import { loadAllEvents, loadEventsByDate, loadEventsByMonth, putEvent, removeEvent } from './calendar-store'

function makeDb() {
  const docs = new Map<string, any>()
  let rev = 0
  const db = {
    async put(doc: any) {
      const next = { ...doc, _rev: `1-${++rev}` }
      docs.set(doc._id, next)
      return { ok: true, id: doc._id, rev: next._rev }
    },
    async remove(doc: any) {
      docs.delete(doc._id)
      return { ok: true }
    },
    async get(id: string) {
      const doc = docs.get(id)
      if (!doc) throw Object.assign(new Error('missing'), { status: 404 })
      return doc
    },
    async allDocs(opts: { startkey?: string; endkey?: string } = {}) {
      const rows = Array.from(docs.values())
        .filter((d) => !opts.startkey || d._id >= opts.startkey)
        .filter((d) => !opts.endkey || d._id <= opts.endkey)
        .map((doc) => ({ id: doc._id, doc }))
      return { rows }
    },
  }
  return { db, docs }
}

const baseInput = {
  date: '2026-11-25',
  title: '周会',
  body: '讨论日历应用',
  allDay: false,
  startTime: '09:30',
  endTime: '10:00',
  category: 'work',
  color: '#38bdf8',
}

beforeEach(() => {
  const { db } = makeDb()
  h.db = db
})

describe('日历事件存储', () => {
  it('写入按日期前缀建文档', async () => {
    const saved = await putEvent(baseInput)
    expect(saved.id).toMatch(/^\d+-\w+$/)
    const res = await h.db.allDocs({ startkey: 'cal:', endkey: 'cal:\uffff' })
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0].id).toMatch(/^cal:2026-11-25:/)
    const all = await loadAllEvents()
    expect(all).toHaveLength(1)
    expect(all[0].title).toBe('周会')
  })

  it('按月/按日查询只返回对应日期的事件，软删除不再出现', async () => {
    await putEvent(baseInput)
    await putEvent({ ...baseInput, date: '2026-11-26', title: '第二天' })
    await putEvent({ ...baseInput, date: '2026-12-01', title: '下月' })

    expect((await loadEventsByMonth(2026, 11)).map((e) => e.title)).toEqual(['周会', '第二天'])
    expect((await loadEventsByDate('2026-11-26')).map((e) => e.title)).toEqual(['第二天'])

    const [first] = await loadEventsByDate('2026-11-25')
    await removeEvent(first)
    expect((await loadAllEvents()).map((e) => e.title)).toEqual(['第二天', '下月'])
  })

  it('更新事件保留 createdAt，改日期时迁移文档 id', async () => {
    const saved = await putEvent(baseInput)
    const updated = await putEvent({ ...baseInput, id: saved.id, date: '2026-11-27', title: '改期' })
    expect(updated.createdAt).toBe(saved.createdAt)
    expect((await loadEventsByDate('2026-11-25'))).toHaveLength(0)
    expect((await loadEventsByDate('2026-11-27')).map((e) => e.title)).toEqual(['改期'])
  })
})
