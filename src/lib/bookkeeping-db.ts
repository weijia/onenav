/**
 * 记账独立 PouchDB 数据库 + 旧主库数据迁移。
 *
 * 拆库背景：oneNav 主库 `onenav` 是「配置同步」链路（书签 / 配置 / 点击统计，经
 * universal-sync-v2 同步到 RemoteStorage 的 /onenav）。记账数据此前也以 `bk:*` 文档
 * 混在主库里，等同于「应用数据存在配置同步组里」。现在改为：
 *
 *   记账 PouchDB 库 `onenav-bookkeeping`  --universal-sync-v2-->  zen-fs-config 数据组 fs
 *
 * 与 golf 的做法一致（见 golf-db.ts / golf-sync.ts）：应用数据落在自己的数据同步组，
 * 主库只保留配置类文档。这样：
 *  - 记账记录的读写与同步不再和书签/配置耦合（清配置库不影响记账，反之亦然）；
 *  - 数据组的后端、同步节奏、冲突策略由记账自己的「数据同步组」面板控制。
 *
 * 旧数据迁移：主库里历史 `bk:*` 文档（以及更早的 `app:bookkeeping` 单文档）在加载时
 * 增量复制到独立库。规则：
 *  - **不删除主库旧文档**——多设备场景下，每台设备都要能从自己的本地主库完成迁移；
 *    删除后主库同步的墓碑会让还没迁移的设备丢数据。
 *  - 本机记一份「已迁移过的 id」清单（localStorage）：之后用户删掉的记录不会被下一次
 *    迁移从主库「复活」（否则删除后重新出现在台账里）。清单只记在本地，不随同步传播。
 */
import { getPouchDB } from '@/lib/pouchdb'

const DB_NAME = 'onenav-bookkeeping'
/** 旧单文档（{ transactions, prices }）的 id，迁移后由 store 再拆成 bk: 多文档 */
const LEGACY_APP_DOC_ID = 'app:bookkeeping'
/** 本机「已迁移 id」清单（只增不减；本地记录，避免已删记录被复活） */
const MIGRATED_IDS_KEY = 'onenav:bookkeeping-migrated-ids'
/** 旧单文档是否已迁移 */
const LEGACY_MIGRATED_KEY = 'onenav:bookkeeping-legacy-migrated'

export const BK_PREFIX = 'bk:'
export const BK_END = BK_PREFIX + '\uffff'

let bkDb: any = null

/** 记账独立库句柄（供 store 与同步引擎共用）。 */
export async function getBookkeepingDb(): Promise<any> {
  if (!bkDb) {
    const PouchDB = (await import('pouchdb-browser')).default
    bkDb = new PouchDB(DB_NAME)
    console.log('[bookkeeping-db] 独立库初始化完成')
  }
  return bkDb
}

/** 供 SyncEngine 使用的原始库句柄。 */
export async function getBookkeepingPouchDB(): Promise<any> {
  return getBookkeepingDb()
}

function readMigratedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(MIGRATED_IDS_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function appendMigratedIds(ids: string[]): void {
  if (ids.length === 0) return
  try {
    const set = readMigratedIds()
    for (const id of ids) set.add(id)
    localStorage.setItem(MIGRATED_IDS_KEY, JSON.stringify(Array.from(set)))
  } catch {
    // localStorage 不可用时忽略（下次可能重复复制，但不会丢数据）
  }
}

/**
 * 把主库里历史记账文档增量复制到独立库。
 *
 * 幂等且可重复调用（每次加载先跑一遍）：
 *  - 只查两边的 id 列表（不带 docs，开销小）；
 *  - 只复制「本机没迁移过、且独立库也没有」的文档；
 *  - 不设一次性总开关：某台设备先打开记账页时主库可能还没从远端拉全，
 *    后续同步到的新文档要能在下一次读取时补迁移。
 *
 * @returns 本次复制过去的文档条数（0 表示无新数据）
 */
export async function migrateBookkeepingDocsFromMain(): Promise<number> {
  try {
    const target = await getBookkeepingDb()
    const main = await getPouchDB()

    const migrated = readMigratedIds()
    const [mainRows, targetRows] = await Promise.all([
      main.allDocs({ startkey: BK_PREFIX, endkey: BK_END }),
      target.allDocs({ startkey: BK_PREFIX, endkey: BK_END }),
    ])
    const targetIds = new Set<string>(targetRows.rows.map((r: any) => r.id))
    const missingIds: string[] = mainRows.rows
      .map((r: any) => r.id)
      .filter((id: string) => !targetIds.has(id) && !migrated.has(id))

    let copied = 0
    if (missingIds.length > 0) {
      const res = await main.allDocs({ keys: missingIds, include_docs: true })
      const docs = res.rows
        .map((r: any) => r.doc)
        .filter(Boolean)
        .map((d: any) => {
          const { _rev, ...rest } = d
          return rest
        })
      if (docs.length > 0) {
        await target.bulkDocs(docs)
        copied += docs.length
        appendMigratedIds(docs.map((d: any) => d._id))
      }
    }

    // 更早的单文档 app:bookkeeping（{ transactions, prices }）也搬过去，
    // 后续由 store 的 migrateLegacy() 拆成 bk: 多文档。搬过一次就不再重复。
    let legacyMigrated = false
    try {
      legacyMigrated = !!localStorage.getItem(LEGACY_MIGRATED_KEY)
    } catch {
      legacyMigrated = false
    }
    if (!legacyMigrated) {
      const existingLegacy = await target.get(LEGACY_APP_DOC_ID).catch(() => null)
      if (!existingLegacy) {
        const legacy = await main.get(LEGACY_APP_DOC_ID).catch(() => null)
        if (legacy) {
          const { _rev, ...rest } = legacy
          await target.put(rest)
          copied++
        }
      }
      try {
        localStorage.setItem(LEGACY_MIGRATED_KEY, '1')
      } catch {
        // 忽略
      }
    }

    if (copied > 0) {
      console.log(`[bookkeeping-db] 已从主库迁移 ${copied} 个历史记账文档到独立库`)
    }
    return copied
  } catch (e) {
    console.warn('[bookkeeping-db] 从主库迁移记账数据失败（忽略，继续用独立库）:', e)
    return 0
  }
}
