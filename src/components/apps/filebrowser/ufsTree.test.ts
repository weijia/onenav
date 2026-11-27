import { describe, expect, it } from 'vitest'
import {
  buildUfsTree,
  countUfsTagged,
  filterUfsTree,
  normalizeRel,
  normalizeUfsNode,
  parseBundleText,
  sourceLabel,
  ufsTagKey,
  type UfsNode,
} from './ufsTree'

const metaLine = JSON.stringify({
  v: 2,
  kind: 'ufs-bundle',
  id: 'vol:disk1/Photos',
  name: 'Photos',
  type: 'dir',
  source: { kind: 'volume', volumeId: 'disk1', rel: 'Photos' },
  addedAt: 1764000000000,
  rootNodeId: 'd:',
  summary: { dirs: 2, files: 3, size: 300, partial: false, hashFailed: 1 },
})

function node(partial: Partial<UfsNode> & { rel: string; type: 'dir' | 'file' }): UfsNode {
  return { name: partial.rel.split('/').pop() || 'root', ...partial } as UfsNode
}

describe('normalizeRel', () => {
  it('反斜杠转正斜杠并去掉首尾斜杠', () => {
    expect(normalizeRel('\\Photos\\2024\\')).toBe('Photos/2024')
    expect(normalizeRel('/a/b//')).toBe('a/b')
    expect(normalizeRel(undefined)).toBe('')
  })
})

describe('parseBundleText', () => {
  it('首行 meta + 每行节点', () => {
    const text = [
      metaLine,
      JSON.stringify({ type: 'dir', rel: '2024', name: '2024' }),
      JSON.stringify({ type: 'file', rel: '2024/a.jpg', name: 'a.jpg', size: 10, hash: 'abc' }),
    ].join('\n')
    const { meta, nodes, broken } = parseBundleText(text)
    expect(meta?.id).toBe('vol:disk1/Photos')
    expect(meta?.summary?.hashFailed).toBe(1)
    expect(nodes).toHaveLength(2)
    expect(nodes[1].hash).toBe('abc')
    expect(broken).toBe(0)
  })

  it('坏行只计数，CRLF 与空行不影响解析', () => {
    const text = [metaLine, '', '{坏行', 'null', JSON.stringify({ type: 'file', rel: 'x.txt', name: 'x.txt' })].join(
      '\r\n',
    )
    const { meta, nodes, broken } = parseBundleText(text)
    expect(meta).not.toBeNull()
    expect(broken).toBe(2)
    expect(nodes).toHaveLength(1)
  })

  it('首行不是合法 bundle 时 meta 为 null', () => {
    const { meta, nodes } = parseBundleText(`${JSON.stringify({ hello: 1 })}\n${JSON.stringify({ type: 'dir', rel: 'd', name: 'd' })}`)
    expect(meta).toBeNull()
    expect(nodes).toHaveLength(1)
  })
})

describe('normalizeUfsNode', () => {
  it('缺 name 时用 rel 末段兜底；非法 type 丢弃', () => {
    expect(normalizeUfsNode({ type: 'file', rel: 'a/b.txt' })?.name).toBe('b.txt')
    expect(normalizeUfsNode({ type: 'link', rel: 'a' })).toBeNull()
    expect(normalizeUfsNode({ type: 'file', rel: '' })).toBeNull()
  })
})

describe('buildUfsTree', () => {
  // rel 以快照根为基准：根节点 rel 为空串（名称 Photos），其余相对根
  const nodes: UfsNode[] = [
    node({ type: 'dir', rel: '', name: 'Photos' }),
    node({ type: 'dir', rel: '2024', name: '2024' }),
    node({ type: 'file', rel: '2024/a.jpg', name: 'a.jpg', size: 100, hash: 'h1' }),
    node({ type: 'file', rel: '2024/b.jpg', name: 'b.jpg', size: 200, hash: 'h2', hashError: 'boom' }),
    node({ type: 'file', rel: 'Other/c.txt', name: 'c.txt', size: 300 }),
  ]

  it('按 rel 重建层级并补缺失父目录', () => {
    const { root, stats } = buildUfsTree(nodes, null)
    expect(root.children.map((c) => c.name)).toEqual(['2024', 'Other'])
    const other = root.children[1]
    expect(other.synth).toBe(true)
    expect(other.children[0].name).toBe('c.txt')
    expect(stats.synthDirs).toBe(1)
    expect(stats.files).toBe(3)
    expect(stats.size).toBe(600)
    expect(stats.hashFailed).toBe(1)
  })

  it('目录统计自底向上聚合，哈希失败数与下界标记向上传递', () => {
    const { root } = buildUfsTree(nodes, null)
    const y2024 = root.children[0]
    expect(y2024.fileCount).toBe(2)
    expect(y2024.totalSize).toBe(300)
    expect(y2024.hashFailed).toBe(1)
    expect(root.fileCount).toBe(3)
    expect(root.totalSize).toBe(600)
    expect(root.partialTree).toBe(false)
  })

  it('同 rel 重复只保留第一个并计数', () => {
    const { root, stats } = buildUfsTree(
      [
        node({ type: 'file', rel: 'a.txt', name: 'a.txt', size: 1 }),
        node({ type: 'file', rel: 'a.txt', name: 'a-dup.txt', size: 2 }),
      ],
      null,
    )
    expect(stats.duplicates).toBe(1)
    expect(root.children).toHaveLength(1)
    expect(root.children[0].name).toBe('a.txt')
  })

  it('单文件快照的根就是文件', () => {
    const { root, stats } = buildUfsTree(
      [node({ type: 'file', rel: '', name: 'movie.mp4', size: 10 })],
      { id: 'x', name: 'movie.mp4', type: 'file' },
    )
    expect(root.type).toBe('file')
    expect(root.size).toBe(10)
    expect(root.children).toHaveLength(0)
    expect(stats.files).toBe(1)
  })
})

describe('filterUfsTree', () => {
  const tree = () =>
    buildUfsTree(
      [
        node({ type: 'dir', rel: '', name: 'Photos' }),
        node({ type: 'dir', rel: '2024', name: '2024' }),
        node({ type: 'file', rel: '2024/a.jpg', name: 'a.jpg', size: 100 }),
        node({ type: 'file', rel: '2024/b.jpg', name: 'b.jpg', size: 200 }),
        node({ type: 'file', rel: 'Notes/readme.txt', name: 'readme.txt', size: 5 }),
      ],
      null,
    ).root

  it('关键词命中叶子，保留祖先链', () => {
    const r = filterUfsTree(tree(), 'a.JPG', {}, null)
    expect(r?.children.map((c) => c.name)).toEqual(['2024'])
    const y2024 = r!.children[0]
    expect(y2024.children.map((c) => c.name)).toEqual(['a.jpg'])
    expect(y2024.fileCount).toBe(2) // 祖先统计保持原值（与目录视图一致）
  })

  it('标签命中文件与祖先目录', () => {
    const r = filterUfsTree(tree(), '', { '2024/b.jpg': ['旅行'], Notes: ['资料'] }, '旅行')
    expect(r?.children.map((c) => c.name)).toEqual(['2024'])
    expect(r!.children[0].children.map((c) => c.name)).toEqual(['b.jpg'])
  })

  it('无命中返回 null', () => {
    expect(filterUfsTree(tree(), 'zzz', {}, null)).toBeNull()
    expect(filterUfsTree(tree(), '', {}, '不存在')).toBeNull()
  })

  it('无筛选原样返回', () => {
    expect(filterUfsTree(tree(), '', {}, null)).not.toBeNull()
  })
})

describe('标签命名', () => {
  it('同一 id 稳定；清洗后相同前缀的 id 靠哈希区分', () => {
    expect(ufsTagKey('vol:disk1/Photos')).toBe(ufsTagKey('vol:disk1/Photos'))
    expect(ufsTagKey('local:C:/a')).not.toBe(ufsTagKey('local:C_/a'))
    expect(ufsTagKey('vol:disk1/Photos')).toMatch(/^vol_disk1_Photos-[a-z0-9]+$/)
  })
})

describe('sourceLabel', () => {
  it('三类来源的展示文案', () => {
    expect(sourceLabel({ kind: 'volume', volumeId: 'disk1', rel: 'Photos' })).toEqual({
      kind: '卷',
      detail: 'disk1/Photos',
    })
    expect(sourceLabel({ kind: 'local', path: 'D:/Photos' }).kind).toBe('本机')
    expect(sourceLabel({ kind: 'zip', zipPath: 'a.zip', entry: 'x/y' }).detail).toBe('a.zip#x/y')
    expect(sourceLabel(null).kind).toBe('未知')
  })
})

describe('countUfsTagged', () => {
  it('统计整棵树里带某标签的节点数', () => {
    const { root } = buildUfsTree(
      [
        node({ type: 'dir', rel: 'A', name: 'A' }),
        node({ type: 'file', rel: 'A/x.txt', name: 'x.txt' }),
      ],
      null,
    )
    const tags = { A: ['p'], 'A/x.txt': ['p', 'q'] }
    expect(countUfsTagged(root, tags, 'p')).toBe(2)
    expect(countUfsTagged(root, tags, 'q')).toBe(1)
  })
})
