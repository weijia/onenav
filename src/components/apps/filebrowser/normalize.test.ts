import { describe, expect, it } from 'vitest'
import { countTaggedNodes, filterTree, normalizeManifest, normalizeManifests } from './normalize'
import type { FolderNodeView, FsNodeView } from './types'

// 构造一个文件夹节点，便于测试
function folder(
  name: string,
  children: FsNodeView[] = [],
  tags: string[] = [],
): FolderNodeView {
  return { name, type: 'folder', tags, children }
}

// 子节点访问器：文件节点没有 children
function kids(node: FsNodeView): FsNodeView[] {
  return node.type === 'folder' ? node.children : []
}

function validManifest(rootChildren: FsNodeView[], over: Record<string, unknown> = {}) {
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

  it('保留 type:"file" 节点且不影响目录计数', () => {
    const raw = validManifest([
      folder('C:', [
        // 混入一个 file 节点，应被保留
        { name: 'readme.txt', type: 'file', tags: [], children: [] } as unknown as FolderNodeView,
        folder('code'),
      ]),
    ])
    const m = normalizeManifest(raw)!
    const c = kids(m.root.children[0])
    expect(c).toHaveLength(2)
    expect(c[0].type).toBe('file')
    expect(c[1].name).toBe('code')
    // 文件夹：根 + C: + code = 3，folderCount 不含根 = 2（文件不计入）
    expect(m.folderCount).toBe(2)
  })

  it('文件节点保留大小/占用/mtime 且无子节点', () => {
    const raw = validManifest([
      folder('C:', [
        {
          name: 'photo.jpg',
          type: 'file',
          size: 2048,
          sizeOnDisk: 4096,
          mtime: 1760000000000,
        } as unknown as FolderNodeView,
      ]),
    ])
    const m = normalizeManifest(raw)!
    const file = kids(m.root.children[0])[0]
    expect(file.type).toBe('file')
    expect(file.name).toBe('photo.jpg')
    expect(file.tags).toEqual([])
    expect('children' in file).toBe(false)
    if (file.type === 'file') {
      expect(file.size).toBe(2048)
      expect(file.sizeOnDisk).toBe(4096)
      expect(file.mtime).toBe(1760000000000)
    }
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
    const c = kids(r!)
    expect(c).toHaveLength(1)
    expect(c[0].name).toBe('Projects')
    expect(kids(c[0])).toHaveLength(1)
    expect(kids(c[0])[0].name).toBe('onenav')
  })

  it('未命中节点但有命中后代：作为祖先路径保留', () => {
    const r = filterTree(buildTree(), 'my-data')
    const c = kids(r!)
    expect(c[0].name).toBe('Projects')
    expect(kids(c[0])[0].name).toBe('my-data')
    // Tools 未命中且无命中后代 → 不出现
    expect(c).toHaveLength(1)
  })

  it('完全无命中返回 null', () => {
    expect(filterTree(buildTree(), 'zzz-nope')).toBeNull()
  })

  it('非空查询不区分大小写', () => {
    const r = filterTree(buildTree(), 'ONENAV')
    expect(r).not.toBeNull()
    expect(kids(kids(r!)[0])[0].name).toBe('onenav')
  })

  it('文件节点可按文件名筛选并作为叶子保留', () => {
    const tree: FolderNodeView = folder('C:', [
      {
        name: 'notes.md',
        type: 'file',
        tags: [],
        size: 120,
      },
      folder('Tools'),
    ])
    const r = filterTree(tree, 'notes')
    expect(r).not.toBeNull()
    const c = kids(r!)
    expect(c).toHaveLength(1)
    expect(c[0].type).toBe('file')
    expect(c[0].name).toBe('notes.md')
  })
})

describe('filterTree 标签筛选', () => {
  // 结构（真实结构：根为「主机」，其子为盘符 C:）：
  // HOST > C:[Projects:[onenav(work), my-data(doc)] (dev), Tools(util)]
  function buildHostTree(): FolderNodeView {
    return folder('HOST', [
      folder('C:', [
        folder('Projects', [folder('onenav', [], ['work']), folder('my-data', [], ['doc'])], ['dev']),
        folder('Tools', [], ['util']),
      ]),
    ])
  }

  it('按清单自带标签筛选（tag 命中即保留，祖先链保留）', () => {
    const r = filterTree(buildHostTree(), '', { tag: 'dev' })
    expect(r).not.toBeNull()
    // HOST > C: > Projects（dev 在 Projects 上）
    const c = kids(r!)
    expect(c).toHaveLength(1)
    expect(c[0].name).toBe('C:')
    const projects = kids(c[0]).find((n) => n.name === 'Projects')!
    expect(projects).toBeDefined()
  })

  it('按用户标签筛选需配合 userTagsByKey 与 source（按盘符命名空间定位）', () => {
    const r = filterTree(buildHostTree(), '', {
      tag: 'work',
      source: 'HOST',
      userTagsByKey: { 'HOST::C:': { 'C:/Projects/onenav': ['work'] } },
      basePath: [],
    })
    expect(r).not.toBeNull()
    const c = kids(r!)
    expect(c).toHaveLength(1) // 仅 C:
    const cDrive = c[0]
    expect(cDrive.name).toBe('C:')
    const projects = kids(cDrive).find((n) => n.name === 'Projects')!
    expect(kids(projects).some((n) => n.name === 'onenav')).toBe(true)
    // Tools 未命中且无命中后代 → 不出现
    expect(kids(cDrive).some((n) => n.name === 'Tools')).toBe(false)
  })

  it('关键词与标签组合为「或」关系', () => {
    const r = filterTree(buildHostTree(), 'Tools', {
      tag: 'dev',
      source: 'HOST',
      userTagsByKey: { 'HOST::C:': { 'C:/Projects/onenav': ['work'] } },
      basePath: [],
    })
    // C: 下 Tools 关键词命中 + Projects 因标签 dev 命中，两者都应保留
    const c = kids(r!)
    const cDrive = c[0]
    expect(cDrive.name).toBe('C:')
    expect(kids(cDrive).some((n) => n.name === 'Tools')).toBe(true)
    expect(kids(cDrive).some((n) => n.name === 'Projects')).toBe(true)
  })
})

describe('filterTree 隐私标签（hidePrivate）', () => {
  // 根为「主机」，子为盘符；Secrets / Photos 带 'private' 标签。
  function buildHostTreePriv(): FolderNodeView {
    return folder('HOST', [
      folder('C:', [
        folder('Projects', [folder('onenav'), folder('my-data')]),
        folder('Secrets', [folder('diary')], ['private']),
      ]),
      folder('D:', [folder('Photos', [], ['private'])]),
    ])
  }

  it('hidePrivate 默认 false 时隐私目录保留', () => {
    const r = filterTree(buildHostTreePriv(), '', { source: 'HOST', basePath: [] })
    const c = kids(r!).find((n) => n.name === 'C:')!
    expect(kids(c).some((n) => n.name === 'Secrets')).toBe(true)
    const d = kids(r!).find((n) => n.name === 'D:')!
    expect(kids(d).some((n) => n.name === 'Photos')).toBe(true)
  })

  it('hidePrivate 为 true 时隐私目录（含子树）被整体隐藏', () => {
    const r = filterTree(buildHostTreePriv(), '', {
      source: 'HOST',
      basePath: [],
      hidePrivate: true,
    })
    const c = kids(r!).find((n) => n.name === 'C:')!
    expect(kids(c).some((n) => n.name === 'Secrets')).toBe(false)
    expect(kids(c).some((n) => n.name === 'Projects')).toBe(true)
    const d = kids(r!).find((n) => n.name === 'D:')!
    expect(kids(d).some((n) => n.name === 'Photos')).toBe(false)
  })

  it('hidePrivate 也覆盖用户标签中的 private', () => {
    const tree = folder('HOST', [
      folder('C:', [folder('Bank', [folder('statements')]), folder('Public')]),
    ])
    const r = filterTree(tree, '', {
      source: 'HOST',
      basePath: [],
      hidePrivate: true,
      userTagsByKey: { 'HOST::C:': { 'C:/Bank': ['private'] } },
    })
    const c = kids(r!).find((n) => n.name === 'C:')!
    expect(kids(c).some((n) => n.name === 'Bank')).toBe(false)
    expect(kids(c).some((n) => n.name === 'Public')).toBe(true)
  })
})

describe('filterTree 目录大小筛选', () => {
  const MB = 1024 * 1024

  function sized(name: string, over: Partial<FolderNodeView> = {}): FolderNodeView {
    return { ...folder(name), ...over }
  }

  // 真实结构：主机根 > 盘符 > 一级目录（只有一级及以下参与大小匹配）
  function buildSizedTree(): FolderNodeView {
    return folder('HOST', [
      folder('C:', [
        sized('Big', { totalSize: 800 * MB }),
        sized('Small', { totalSize: 100 * MB }),
        sized('OnDiskOnly', { totalSizeOnDisk: 900 * MB }),
        sized('PartialBig', { totalSize: 700 * MB, sizePartial: true }),
        sized('PartialSmall', { totalSize: 10 * MB, sizePartial: true }),
        sized('Nested', { totalSize: 600 * MB, children: [sized('Leaf', { totalSize: 10 * MB })] }),
        folder('NoStats'),
      ]),
    ])
  }

  function driveChildren(r: FsNodeView | null): string[] {
    return kids(kids(r!)[0]).map((n) => n.name)
  }

  it('大于阈值：命中目录保留，主机根/盘符仅作祖先路径', () => {
    const r = filterTree(buildSizedTree(), '', { sizeFilter: { op: 'gt', bytes: 500 * MB } })
    expect(r).not.toBeNull()
    expect(kids(r!)[0].name).toBe('C:')
    const names = driveChildren(r)
    expect(names).toContain('Big')
    expect(names).toContain('OnDiskOnly') // totalSize 缺失时回退 totalSizeOnDisk
    expect(names).toContain('PartialBig') // 下界已超阈值 → 实际必超，可命中
    expect(names).toContain('Nested')
    expect(names).not.toContain('Small')
    expect(names).not.toContain('NoStats') // 未统计大小不参与
  })

  it('盘符自身的累积大小不参与匹配，避免整棵树退化命中', () => {
    const tree = folder('HOST', [
      sized('C:', { totalSize: 50 * 1024 * MB, children: [folder('a')] }),
    ])
    expect(filterTree(tree, '', { sizeFilter: { op: 'gt', bytes: 500 * MB } })).toBeNull()
  })

  it('小于阈值：sizePartial（仅下界）的目录不参与，避免误报「实际小于」', () => {
    const r = filterTree(buildSizedTree(), '', { sizeFilter: { op: 'lt', bytes: 500 * MB } })
    const names = driveChildren(r)
    expect(names).toContain('Small')
    expect(names).toContain('Nested') // 其下 Leaf 命中 → 作为祖先链保留
    const nested = kids(kids(r!)[0]).find((n) => n.name === 'Nested')!
    expect(kids(nested).map((n) => n.name)).toContain('Leaf')
    expect(names).not.toContain('PartialSmall')
    expect(names).not.toContain('Big')
    expect(names).not.toContain('NoStats')
  })

  it('与关键词为「或」关系', () => {
    const r = filterTree(buildSizedTree(), 'Small', {
      sizeFilter: { op: 'gt', bytes: 500 * MB },
    })
    const names = driveChildren(r)
    expect(names).toContain('Big') // 大小命中
    expect(names).toContain('Small') // 关键词命中
  })

  it('sizeFilter 为 null / 未传时保持原行为（整棵树）', () => {
    const tree = buildSizedTree()
    expect(filterTree(tree, '', { sizeFilter: null })).toEqual(tree)
    expect(filterTree(tree, '')).toEqual(tree)
  })

  it('与 hidePrivate 叠加：隐私目录即使很大也不显示', () => {
    const tree = folder('HOST', [
      folder('C:', [
        sized('Big', { totalSize: 800 * MB }),
        sized('Secrets', { totalSize: 900 * MB, tags: ['private'] }),
      ]),
    ])
    const names = driveChildren(
      filterTree(tree, '', {
        sizeFilter: { op: 'gt', bytes: 500 * MB },
        hidePrivate: true,
      }),
    )
    expect(names).toContain('Big')
    expect(names).not.toContain('Secrets')
  })
})

describe('countTaggedNodes', () => {
  function buildHostTreePriv(): FolderNodeView {
    return folder('HOST', [
      folder('C:', [
        folder('Projects', [folder('onenav'), folder('my-data')]),
        folder('Secrets', [folder('diary')], ['private']),
      ]),
      folder('D:', [folder('Photos', [], ['private'])]),
    ])
  }

  it('统计含 private 标签的清单节点数（大小写不敏感）', () => {
    const ms = normalizeManifest(validManifest([buildHostTreePriv()]))!
    expect(countTaggedNodes([ms], 'private')).toBe(2)
    expect(countTaggedNodes([ms], 'PRIVATE')).toBe(2)
  })

  it('统计包含用户标签的 private 节点', () => {
    const ms: ReturnType<typeof normalizeManifest> = {
      source: 'HOST',
      generatedAt: null,
      generator: null,
      root: folder('HOST', [folder('C:', [folder('Bank', [folder('x')]), folder('Public')])]),
      folderCount: 0,
      warnings: [],
    }
    expect(
      countTaggedNodes([ms!], 'private', { 'HOST::C:': { 'C:/Bank': ['private'] } }),
    ).toBe(1)
  })
})
