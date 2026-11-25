/**
 * 日历独立 PouchDB 库。
 *
 * 与主库 `onenav`（书签/配置）完全隔离：事件按条存 `cal:<YYYY-MM-DD>:<id>` 文档，
 * 经 universal-sync-v2 同步到 zen-fs-config v2 数据同步组的文件系统（basePath `/calendar`）。
 * 删除用 `deleted: true` 软删除，由 store 过滤，避免同步时被远端 resurrect。
 */
const DB_NAME = 'onenav-calendar'

export const CAL_PREFIX = 'cal:'
export const CAL_END = CAL_PREFIX + '\uffff'

let calendarDb: any = null

/** 日历独立库句柄（供 store 与同步引擎共用）。 */
export async function getCalendarDb(): Promise<any> {
  if (!calendarDb) {
    const PouchDB = (await import('pouchdb-browser')).default
    calendarDb = new PouchDB(DB_NAME)
    console.log('[calendar-db] 独立库初始化完成')
  }
  return calendarDb
}

/** 供 SyncEngine 使用的原始库句柄。 */
export async function getCalendarPouchDB(): Promise<any> {
  return getCalendarDb()
}

/** 一条事件的 PouchDB 文档 id：日期前缀让按日/按月范围查询变成前缀查询。 */
export function calendarDocId(date: string, id: string): string {
  return `${CAL_PREFIX}${date}:${id}`
}

/** 是否是一条未删除的日历文档。 */
export function isCalendarDoc(doc: any): boolean {
  return (
    !!doc &&
    typeof doc._id === 'string' &&
    doc._id.startsWith(CAL_PREFIX) &&
    !doc.deleted &&
    typeof doc.date === 'string' &&
    typeof doc.title === 'string'
  )
}
