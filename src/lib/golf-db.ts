/**
 * golf 独立 PouchDB 数据库。
 *
 * 拆库背景：onenav 的通用同步（universal-sync-v2）把整个主库 `onenav` 同步到
 * RemoteStorage 的 /onenav 路径。为了让两个高尔夫页面改走 zen-fs-config 数据同步组，
 * golf 数据独立成一个 PouchDB 库 `onenav-golf`，配自己的 SyncEngine → 数据组 fs。
 *
 * 两个独立 Vite 入口页面同源，共享同一个 IndexedDB 库，天然读写同一份数据。
 */
const GOLF_DB_NAME = 'onenav-golf'
const GOLF_DOC_ID = 'app:golf'
const MIGRATED_FLAG = 'onenav:golf-db-migrated'

let golfDb: any = null

async function getGolfDb(): Promise<any> {
  if (!golfDb) {
    const PouchDB = (await import('pouchdb-browser')).default
    golfDb = new PouchDB(GOLF_DB_NAME)
  }
  return golfDb
}

export async function loadGolfData(): Promise<unknown | null> {
  try {
    const db = await getGolfDb()
    const doc = await db.get(GOLF_DOC_ID).catch(() => null)
    return doc ? doc.data : null
  } catch {
    return null
  }
}

export async function saveGolfData(data: unknown): Promise<void> {
  const db = await getGolfDb()
  const existing = await db.get(GOLF_DOC_ID).catch(() => null)
  const doc = {
    _id: GOLF_DOC_ID,
    type: 'app-data',
    appId: 'golf',
    data,
    updatedAt: Date.now(),
  }
  await db.put(existing ? { ...doc, _rev: existing._rev } : doc)
}

/** 供 SyncEngine 使用的原始库句柄 */
export async function getGolfPouchDB(): Promise<any> {
  return getGolfDb()
}

/**
 * 一次性迁移：把旧主库 `onenav` 里的 app:golf 文档搬到 golf 独立库。
 * 只在独立库尚无该文档时执行，绝不覆盖用户已有数据。
 */
export async function migrateLegacyGolfData(): Promise<{ migrated: boolean; reason?: string }> {
  try {
    const target = await getGolfDb()
    const existing = await target.get(GOLF_DOC_ID).catch(() => null)
    if (existing) return { migrated: false, reason: '独立库已有数据' }
    if (typeof localStorage !== 'undefined' && localStorage.getItem(MIGRATED_FLAG)) {
      return { migrated: false, reason: '已迁移过' }
    }
    const { getPouchDB } = await import('@/lib/pouchdb')
    const mainDb = await getPouchDB()
    const legacy: any = await mainDb.get(GOLF_DOC_ID).catch(() => null)
    if (legacy?.data !== undefined) {
      await target.put({
        _id: GOLF_DOC_ID,
        type: 'app-data',
        appId: 'golf',
        data: legacy.data,
        updatedAt: legacy.updatedAt || Date.now(),
      })
      if (typeof localStorage !== 'undefined') localStorage.setItem(MIGRATED_FLAG, '1')
      return { migrated: true }
    }
    if (typeof localStorage !== 'undefined') localStorage.setItem(MIGRATED_FLAG, '1')
    return { migrated: false, reason: '旧库无 golf 数据' }
  } catch (e) {
    console.warn('[golf-db] 迁移旧数据失败（忽略，使用独立库当前数据）:', e)
    return { migrated: false, reason: String(e) }
  }
}
