// golf 数据同步「端到端」回归测试（真 zen-fs-config 配置仓 + 真 SyncEngine）。
//
// 复现用户场景：appId=golf 下有两个数据组——
//   - `default`（空组，历史 connect() 自动建的）
//   - c5b50d9d-…（真正装了 /golf 数据的组）
// 断言：
//   1. 解析会选中 c5b50d9d 而不是列表第一个；
//   2. 同步引擎把本地 PouchDB 文档写进「被选中的那个组」的 /golf 下，
//      空组里不会出现任何文件。
//
// 使用 Node Folder 后端 + PouchDB memory 适配器，不需要网络与真实 RS 账号。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { collectDataGroupCandidates, ensureDataGroup, resolveDataGroup } from './fs-config-backends'
import { adaptDataGroupFs } from './golf-group-fs-adapter'
import { createSyncSafeDb } from './remotestorage-sync'

const REAL_GROUP = 'c5b50d9d-0174-4599-ba20-239d32375de2'
const EMPTY_GROUP = 'default'

// pouchdb-browser 的 UMD 包会访问全局 `self`；Node 测试环境里补上（仅测试用）
if (typeof (globalThis as any).self === 'undefined') (globalThis as any).self = globalThis

let base = ''
let emptyDir = ''
let realDir = ''
let repo: any = null
let db: any = null

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'onenav-golf-it-'))
  emptyDir = path.join(base, 'remote-empty')
  realDir = path.join(base, 'remote-real')
  await mkdir(emptyDir, { recursive: true })
  await mkdir(realDir, { recursive: true })

  const { createConfigRepo } = await import('zen-fs-config')
  repo = await createConfigRepo('golf', {
    folderPath: path.join(base, 'config'),
    nodeId: 'it-node',
  })
  // 先建空组（模拟历史默认组），再建真正有数据的组
  await repo.createAppDataGroup(EMPTY_GROUP, [
    { id: 'be-empty', type: 'Folder', options: { path: emptyDir } },
  ])
  const real = await repo.createAppDataGroup(REAL_GROUP, [
    { id: 'be-real', type: 'Folder', options: { path: realDir } },
  ])
  // 在真组的 /golf 下预置一份「远端已有数据」分片，模拟「这个组才是装了数据的那个」。
  // universal-sync-v2 的格式：/golf/data/YYYY/MM/DD/data-<ts>-<suffix>.json
  const now = new Date()
  const shard = `/golf/data/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(
    now.getDate(),
  ).padStart(2, '0')}`
  await real.fs.promises.mkdir(shard, { recursive: true }).catch(() => {})
  await real.fs.promises.writeFile(
    `${shard}/data-seed-0001.json`,
    JSON.stringify({
      version: '2.0.0',
      timestamp: now.getTime(),
      documents: [{ _id: 'seed-doc', _rev: '1-0123456789abcdef0123456789abcdef', v: 1 }],
    }),
  )
})

afterEach(async () => {
  try {
    if (db) await db.destroy()
  } catch {
    /* 忽略 */
  }
  db = null
  try {
    await repo?.dispose?.()
  } catch {
    /* 忽略 */
  }
  repo = null
  if (base) await rm(base, { recursive: true, force: true }).catch(() => {})
})

describe('golf 多组场景（真实配置仓）', () => {
  it('I-1 选择 /golf 下有数据的组，而不是列表第一个空组', async () => {
    const cands = await collectDataGroupCandidates({ repo }, 'golf', '/golf')
    const ids = cands.map((c) => c.id)
    expect(ids).toContain(EMPTY_GROUP)
    expect(ids).toContain(REAL_GROUP)
    expect(cands.find((c) => c.id === REAL_GROUP)?.hasData).toBe(true)
    expect(cands.find((c) => c.id === EMPTY_GROUP)?.hasData).toBe(false)

    const picked = await resolveDataGroup({ repo }, 'golf', { preferPath: '/golf' })
    expect((picked as any)?.groupId).toBe(REAL_GROUP)
  })

  it('I-2 同步引擎把 PouchDB 文档写进被选中的组，空组保持为空', async () => {
    const group = await resolveDataGroup({ repo }, 'golf', { preferPath: '/golf' })
    expect(group).toBeTruthy()

    // PouchDB memory 适配器
    const PouchDBMod: any = (await import('pouchdb-browser')).default
    const memory: any = (await import('pouchdb-adapter-memory')).default
    PouchDBMod.plugin(memory)
    db = new PouchDBMod(`golf-it-${Date.now()}`, { adapter: 'memory' })
    await db.put({ _id: 'course-1', name: '余山', holes: 18 })

    const { SyncEngine } = await import('universal-sync-v2/browser')
    const engine = new SyncEngine(createSyncSafeDb(db), adaptDataGroupFs(group as any), {
      basePath: '/golf',
      maxFileSize: 500 * 1024,
      mergeThreshold: 50 * 1024,
      autoMerge: false,
    })
    await engine.initialize()
    await engine.sync()

    // 引擎写到数据组本地 fs（再 flush 才会到远端后端）
    const localAll: string[] = []
    const gfs: any = (group as any).fs.promises
    async function gwalk(dir: string, prefix = ''): Promise<void> {
      const entries = await gfs.readdir(dir).catch(() => [] as string[])
      for (const name of entries) {
        const rel = prefix ? `${prefix}/${name}` : name
        const st = await gfs.stat(`${dir}/${name}`).catch(() => null)
        const isDir = st && ((st.mode & 0o40000) === 0o40000)
        if (isDir) await gwalk(`${dir}/${name}`, rel)
        else localAll.push(`${dir}/${name}`)
      }
    }
    await gwalk('/golf')
    console.log('[it] group files after sync:', localAll)
    let localFound = false
    for (const p of localAll) {
      const raw = await gfs.readFile(p, 'utf8')
      if (String(raw).includes('course-1')) localFound = true
    }
    expect(localFound).toBe(true)

    // flush 把组内本地改动推到远端后端（页面里由数据组的自动同步做）
    const flushed: any[] = ((await (group as any).flush?.()) || []) as any[]
    console.log('[it] flush result:', JSON.stringify(flushed))
    await new Promise((r) => setTimeout(r, 500))

    // 断言 1：flush 确实把这个组的新分片推到了它的后端（无错误）
    const created = flushed.flatMap((r) => (r.changes || []).filter((c: any) => c.type === 'created'))
    expect(created.some((c: any) => String(c.path).startsWith('/golf/data/'))).toBe(true)
    expect(flushed.every((r) => (r.errors || []).length === 0)).toBe(true)

    // 断言 2：远端后端里能读到这份分片（Folder 后端是编号 blob 存储，按内容找）
    let remoteFound = false
    for (const n of await readdir(realDir)) {
      const raw = await readFile(path.join(realDir, n), 'utf8').catch(() => null)
      if (raw && raw.includes('course-1')) remoteFound = true
    }
    expect(remoteFound).toBe(true)

    // 断言 3：空组里不应出现 course-1（它的 blob 只应有自己的 .meta）
    let emptyHasCourse = false
    for (const n of await readdir(emptyDir)) {
      const raw = await readFile(path.join(emptyDir, n), 'utf8').catch(() => null)
      if (raw && raw.includes('course-1')) emptyHasCourse = true
    }
    expect(emptyHasCourse).toBe(false)
  }, 15000)

  it('I-3 从组里回读（pull）：远端文件能拉回本地 PouchDB', async () => {
    const group = await resolveDataGroup({ repo }, 'golf', { preferPath: '/golf' })
    const PouchDBMod: any = (await import('pouchdb-browser')).default
    const memory: any = (await import('pouchdb-adapter-memory')).default
    PouchDBMod.plugin(memory)
    db = new PouchDBMod(`golf-it-pull-${Date.now()}`, { adapter: 'memory' })

    // 再往组里放一份「远端」文件，然后 pull
    const { SyncEngine } = await import('universal-sync-v2/browser')
    const engine = new SyncEngine(createSyncSafeDb(db), adaptDataGroupFs(group as any), {
      basePath: '/golf',
      maxFileSize: 500 * 1024,
      mergeThreshold: 50 * 1024,
      autoMerge: false,
    })
    await engine.initialize()
    await engine.pull()

    const doc = await db.get('seed-doc').catch(() => null)
    expect(doc).toBeTruthy()
    expect((doc as any).v).toBe(1)
  })

  it('I-4 空配置仓 → ensureDataGroup 自动建本机默认组，且组 fs 可写', async () => {
    const { createConfigRepo } = await import('zen-fs-config')
    const repo2 = await createConfigRepo('golf-default-it', {
      folderPath: path.join(base, 'config-default'),
      nodeId: 'it-node',
    })
    try {
      const r = await ensureDataGroup({ repo: repo2 }, 'golf-default-it', { preferPath: '/golf' })
      expect(r.created).toBe(true)
      expect(r.group).toBeTruthy()

      await r.group!.fs.promises.mkdir('/golf', { recursive: true }).catch(() => {})
      await r.group!.fs.promises.writeFile('/golf/ensure-test.json', '{"ok":true}')
      const names = await r.group!.fs.promises.readdir('/golf')
      expect(names.map(String)).toContain('ensure-test.json')

      const cands = await collectDataGroupCandidates({ repo: repo2 }, 'golf-default-it', '/golf')
      expect(cands[0]).toMatchObject({ id: 'default', hasRemote: false })
      expect(cands[0].localStore).toBe('zen-fs-config-data-golf-default-it')
    } finally {
      await repo2.dispose?.()
    }
  }, 15000)
})
