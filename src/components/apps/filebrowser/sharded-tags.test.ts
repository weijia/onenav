// 分片标签读写测试：与 zip-browser/web/tags-sharded.js 的片格式逐字对齐。
// 用内存 fs 驱动真实读写代码，断言：跨年枚举、按片名排序重放、旧整表片基线、
// diff 只追加变化、不修改已有片、清空用 remove 事件表达。

import { describe, expect, it } from 'vitest'
import {
  appendShard,
  appendTagDiff,
  listShards,
  readShardedMap,
  replayTagMap,
  safeKey,
  stamp,
  type GroupPromisesFs,
  type Shard,
} from './sharded-tags'

/** 最小内存 fs：文件与目录都放进同一张表，readdir 列直接子项 */
function makeFs(seed: Record<string, string> = {}): GroupPromisesFs & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(seed))
  const fs = {
    files,
    async readFile(path: string, _encoding?: string) {
      if (!files.has(path)) {
        const e: any = new Error(`ENOENT: ${path}`)
        e.code = 'ENOENT'
        throw e
      }
      return files.get(path)!
    },
    async writeFile(path: string, data: string | Uint8Array) {
      files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
    },
    async unlink(path: string) {
      files.delete(path)
    },
    async readdir(dir: string) {
      const prefix = `${dir.replace(/\/$/, '')}/`
      const out = new Set<string>()
      for (const p of files.keys()) {
        if (!p.startsWith(prefix)) continue
        const rest = p.slice(prefix.length)
        const first = rest.split('/')[0]
        if (first) out.add(first)
      }
      return [...out]
    },
    async mkdir(path: string) {
      // 内存 fs 不需要真的建目录；writeFile 时父目录自然存在
      void path
    },
  }
  return fs
}

function shard(name: string, doc: Record<string, unknown>): Shard {
  return { name, path: `ufs-tags/k/2026/${name}`, doc }
}

describe('safeKey', () => {
  it('折叠下划线、去首尾、截断，与 zip-browser 一致', () => {
    expect(safeKey('RemoteStorage-1')).toBe('RemoteStorage-1')
    expect(safeKey('a::b//c')).toBe('a_b_c')
    expect(safeKey('  __x__  ')).toBe('x')
  })
})

describe('stamp', () => {
  it('固定时钟与随机数产生确定性片名', () => {
    // 2026-11-27 12:34:56，随机 0xabcdef → 六位十六进制
    const s = stamp(new Date(2026, 10, 27, 12, 34, 56).getTime(), 0xabcdef / 0xffffff)
    expect(s).toMatch(/^20261127-123456-[0-9a-f]{6}$/)
  })
})

describe('replayTagMap', () => {
  it('旧整表片作基线，新事件片按序覆盖', () => {
    const map = replayTagMap([
      shard('0000-legacy.json', { tags: { '': ['public'], 'a.jpg': ['旅行'] } }),
      shard('tags-20261127-010000-aaaaaa.json', {
        events: [
          { op: 'set', rel: 'a.jpg', tags: ['public', '精选'] },
          { op: 'set', rel: 'b.jpg', tags: ['public'] },
        ],
      }),
      shard('tags-20261127-020000-bbbbbb.json', {
        events: [{ op: 'remove', rel: 'a.jpg' }],
      }),
    ])
    expect(map['']).toEqual(['public'])
    expect(map['a.jpg']).toBeUndefined()
    expect(map['b.jpg']).toEqual(['public'])
  })

  it('乱序 input 不影响结果：读取侧按片名排序后再重放', () => {
    const shards = [
      shard('tags-20261127-020000-bbbbbb.json', { events: [{ op: 'remove', rel: 'x' }] }),
      shard('0000-legacy.json', { tags: { x: ['public'] } }),
      shard('tags-20261127-010000-aaaaaa.json', { events: [{ op: 'set', rel: 'x', tags: ['精选'] }] }),
    ]
    shards.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
    expect(replayTagMap(shards).x).toBeUndefined()
  })
})

describe('listShards', () => {
  it('跨年目录枚举所有 .json，按片名升序，忽略非年份目录与非 json 文件', () => {
    const fs = makeFs({
      'ufs-tags/k/2025/tags-20251231-235959-ffffff.json': '{}',
      'ufs-tags/k/2026/tags-20260101-000000-111111.json': '{}',
      'ufs-tags/k/2026/README.txt': 'ignore',
      'ufs-tags/k/notayear/tags-x.json': 'ignore',
      'ufs-tags/k/2026/broken.json': '{坏片',
    })
    return listShards(fs, 'ufs-tags/k').then((shards) => {
      expect(shards.map((s) => s.name)).toEqual([
        'tags-20251231-235959-ffffff.json',
        'tags-20260101-000000-111111.json',
      ])
    })
  })
})

describe('appendShard / appendTagDiff', () => {
  it('追加片只新建，目录按片的年份分桶', async () => {
    const fs = makeFs()
    const at = new Date(2026, 10, 27, 9, 0, 0).getTime()
    const p = await appendShard(fs, 'ufs-tags/k', 'tags', { version: 1, events: [] }, { at, random: 0 })
    expect(p).toBe('ufs-tags/k/2026/tags-20261127-090000-000000.json')
    expect(fs.files.has(p)).toBe(true)
  })

  it('diff 把变化的 rel 发 set、消失的 rel 发 remove，无变化不写片', async () => {
    const fs = makeFs()
    const old = { 'a.jpg': ['public'], 'b.jpg': ['精选'] }
    const next = { 'a.jpg': ['public'], 'c.jpg': ['public'] }
    const p = await appendTagDiff(fs, 'ufs-tags/k', 'tags', old, next, { bundleId: 'vol:x' }, {
      at: new Date(2026, 10, 27, 9, 0, 0).getTime(),
      random: 0,
    })
    expect(p).toBe('ufs-tags/k/2026/tags-20261127-090000-000000.json')
    const doc = JSON.parse(fs.files.get(p!)!)
    expect(doc.bundleId).toBe('vol:x')
    expect(doc.events).toEqual([
      { op: 'set', rel: 'c.jpg', tags: ['public'] },
      { op: 'remove', rel: 'b.jpg' },
    ])

    const before = fs.files.size
    const none = await appendTagDiff(fs, 'ufs-tags/k', 'tags', next, next, {}, { at: Date.now(), random: 0 })
    expect(none).toBeNull()
    expect(fs.files.size).toBe(before)
  })

  it('清空标签用 remove 事件表达，不删旧片', async () => {
    const fs = makeFs()
    const p = await appendTagDiff(fs, 'ufs-tags/k', 'tags', { '': ['public'] }, {}, {}, {
      at: new Date(2026, 10, 27, 9, 0, 0).getTime(),
      random: 0,
    })
    const doc = JSON.parse(fs.files.get(p!)!)
    expect(doc.events).toEqual([{ op: 'remove', rel: '' }])
  })
})

describe('readShardedMap', () => {
  it('旧单片 + 新事件片合并；新片转向量目录后旧片仍作基线', async () => {
    const fs = makeFs({
      // 旧单片：onenav 历史路径 /file-tags/<key>.json
      'file-tags/vol_x.json': JSON.stringify({ tags: { 'Photos/2024': ['public'] } }),
      // 新片：跨年 + 事件
      'file-tags/vol_x/2026/tags-20260101-000000-111111.json': JSON.stringify({
        events: [{ op: 'set', rel: 'Photos/2025', tags: ['public'] }],
      }),
      'file-tags/vol_x/2027/tags-20270101-000000-222222.json': JSON.stringify({
        events: [{ op: 'remove', rel: 'Photos/2024' }],
      }),
    })
    const map = await readShardedMap(fs, 'file-tags/vol_x', 'file-tags/vol_x.json')
    expect(map['Photos/2024']).toBeUndefined()
    expect(map['Photos/2025']).toEqual(['public'])
  })

  it('旧片损坏或不存在时按空表处理，不抛错', async () => {
    const fs = makeFs({ 'ufs-tags/k.json': '{坏片' })
    await expect(readShardedMap(fs, 'ufs-tags/k', 'ufs-tags/k.json')).resolves.toEqual({})
  })
})
