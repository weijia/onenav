/**
 * 日历事件存储层（独立库 onenav-calendar，每条事件一个 `cal:` 文档）。
 *
 * store 只负责本地写入；同步由 calendar-sync 注册的 PouchDB changes feed 统一驱动。
 * 事件不写主库、不写 WebDAV。
 * 由 v2 数据同步组（zen-fs-config v2 的 AppRepo → DataGroup.fs）提供远端文件系统。
 */
import { CAL_PREFIX, CAL_END, calendarDocId, getCalendarDb, isCalendarDoc } from './calendar-db'
import { monthRange } from './calendar-date'
import { compareEvents, type CalendarEvent } from './calendar-model'

export type CalendarEventInput = Omit<CalendarEvent, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }

function randId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function docToEvent(doc: any): CalendarEvent {
  const { _id: _ignoredId, _rev: _ignoredRev, ...rest } = doc
  return rest as CalendarEvent
}

function readDocs(rows: any[]): CalendarEvent[] {
  return rows
    .map((r) => r?.doc)
    .filter(isCalendarDoc)
    .map(docToEvent)
    .sort(compareEvents)
}

/** 读取全部未删除事件。 */
export async function loadAllEvents(): Promise<CalendarEvent[]> {
  const db = await getCalendarDb()
  const res = await db.allDocs({ startkey: CAL_PREFIX, endkey: CAL_END, include_docs: true })
  return readDocs(res.rows)
}

/** 读取某一天的事件。 */
export async function loadEventsByDate(date: string): Promise<CalendarEvent[]> {
  const db = await getCalendarDb()
  const startkey = `${CAL_PREFIX}${date}:`
  const res = await db.allDocs({ startkey, endkey: `${startkey}\uffff`, include_docs: true })
  return readDocs(res.rows)
}

/** 读取某个月的事件（month 为 1–12）。 */
export async function loadEventsByMonth(year: number, month: number): Promise<CalendarEvent[]> {
  const db = await getCalendarDb()
  const { start, end } = monthRange(year, month)
  const res = await db.allDocs({ startkey: start, endkey: end, include_docs: true })
  return readDocs(res.rows)
}

/** 新增或更新一条事件（id 存在即更新；日期变化会迁到新的文档 id）。 */
export async function putEvent(input: CalendarEventInput): Promise<CalendarEvent> {
  const db = await getCalendarDb()
  let existing: any = null
  if (input.id) {
    // 旧 id 可能在别的日期下：按 id 在 cal: 全范围找一次，以便改日期时迁移文档。
    const found = await db.allDocs({ startkey: CAL_PREFIX, endkey: CAL_END, include_docs: true })
    existing = found.rows.find((r: any) => r?.doc?.id === input.id && r.doc.date)?.doc ?? null
  }

  const now = Date.now()
  const id = input.id || randId()
  const event: CalendarEvent = {
    ...input,
    id,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  const docId = calendarDocId(event.date, id)

  if (existing && existing._id !== docId) await db.remove(existing)

  await db.put({
    _id: docId,
    ...event,
    ...(existing && existing._id === docId ? { _rev: existing._rev } : {}),
  })
  return event
}

/** 软删除：保留文档并打 deleted 标记，由 store 过滤，同步引擎负责把删除传播到远端。 */
export async function removeEvent(event: CalendarEvent): Promise<void> {
  const db = await getCalendarDb()
  const docId = calendarDocId(event.date, event.id)
  const doc = await db.get(docId).catch(() => null)
  if (!doc) return
  await db.put({ ...doc, deleted: true, updatedAt: Date.now() })
}
