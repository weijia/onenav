import { describe, expect, it } from 'vitest'
import { filterTree, normalizeManifest, normalizeManifests } from './normalize'
import type { FolderNodeView } from './types'

// 构造一个文件夹节点，便于测试
function folder(
  name: string,
  children: FolderNodeView[] = [],
  tags: string[] = [],
): FolderNodeView {
  return { name, type: 'folder', tags, children }
}

function validManifest(rootChildren: FolderNodeView[], over: Record<string, unknown> = {}) {
  return {
    version: 1,
    generatedAt: '2026-10-24T12:00:00.000Z',
    generator: 'fluentos-dir-struct-gen',
    source: 'LAPTOP-A',
    root: { name: 'LAPTOP-A', type: 'folder', children: rootChildren },
    ...over,
  }
}

describe('normalizeManifest', () => {
  it('解析合法清单并计算 folderCount（不含根）', () => {
    const m = normalizeManifest(
      validManifest([folder('C:', [folder('Projects', [folder('app')])]), folder('D:')]),
    )
    expect(m).not.toBeNull()
    expect(m!.source).toBe('LAPTOP-A')
    expect(m!.generatedAt).toBe('2026-10-24T12:00:00.000Z')
    // 根 + C: + Projects + app + D: = 5，folderCount 不含根 = 4
    expect(m!.folderCount).toBe(4)
  })

  it('缺失 root 时返回 null（跳过非法清单）', () => {
    expect(normalizeManifest({ source: 'X' })).toBeNull()
    expect(normalizeManifest(null)).toBeNull()
    expect(normalizeManifest('not-an-object')).toBeNull()
  })

  it('过滤 type:"file" 节点', () => {
    const raw = validManifest([
      folder('C:', [
        // 混入一个 file 节点，应被忽略
        { name: 'readme.txt', type: 'file', tags: [], children: [] } as unknown as FolderNodeView,
        folder('code'),
      ]),
    ])
    const m = normalizeManifest(raw)!
    expect(m.root.children[0].children).toHaveLength(1)
    expect(m.root.children[0].children[0].name).toBe('code')
  })

  it('缺 name 的子节点被跳过并记录告警', () => {
    const raw = validManifest([
      { type: 'folder', tags: [], children: [] } as unknown as FolderNodeView,
      folder('Keep'),
    ])
    const m = normalizeManifest(raw)!
    expect(m.warnings.length).toBeGreaterThan(0)
    expect(m.root.children).toHaveLength(1)
    expect(m.root.children[0].name).toBe('Keep')
  })

  it('保留 tags 数组', () => {
    const m = normalizeManifest(validManifest([folder('Projects', [], ['git', 'node'])]))!
    expect(m.root.children[0].tags).toEqual(['git', 'node'])
  })

  it('缺 source 时回退到 root.name', () => {
    const m = normalizeManifest({ root: { name: 'PC-9', type: 'folder', children: [] } })!
    expect(m.source).toBe('PC-9')
  })
})

describe('normalizeManifests', () => {
  it('跳过非法清单并按 source 升序排序', () => {
    const out = normalizeManifests([
      validManifest([], { source: 'ZZZ' }),
      { noRoot: true }, // 非法
      validManifest([], { source: 'AAA' }),
    ])
    expect(out).toHaveLength(2)
    expect(out[0].source).toBe('AAA')
    expect(out[1].source).toBe('ZZZ')
  })
})

describe('filterTree', () => {
  // 每个用例自建一棵树，避免共享状态。结构：C:[Projects:[onenav, my-data], Tools]
  function buildTree(): FolderNodeView {
    return folder('C:', [folder('Projects', [folder('onenav'), folder('my-data')]), folder('Tools')])
  }

  it('命中节点：返回该节点，子节点仅保留命中的分支', () => {
    const r = filterTree(buildTree(), 'onenav')
    expect(r).not.toBeNull()
    expect(r!.name).toBe('C:')
    // C: 下只有 Projects 命中分支保留
    expect(r!.children).toHaveLength(1)
    expect(r!.children[0].name).toBe('Projects')
    expect(r!.children[0].children).toHaveLength(1)
    expect(r!.children[0].children[0].name).toBe('onenav')
  })

  it('未命中节点但有命中后代：作为祖先路径保留', () => {
    const r = filterTree(buildTree(), 'my-data')
    expect(r!.children[0].name).toBe('Projects')
    expect(r!.children[0].children[0].name).toBe('my-data')
    // Tools 未命中且无命中后代 → 不出现
    expect(r!.children).toHaveLength(1)
  })

  it('完全无命中返回 null', () => {
    expect(filterTree(buildTree(), 'zzz-nope')).toBeNull()
  })

  it('非空查询不区分大小写', () => {
    const r = filterTree(buildTree(), 'ONENAV')
    expect(r).not.toBeNull()
    expect(r!.children[0].children[0].name).toBe('onenav')
  })
})
