// 书签数据处理回归测试：覆盖「条目缺 tags 字段时不抛错」（修复
// "Cannot read properties of undefined (reading 'includes')"）。
import { describe, it, expect } from 'vitest'
import { isDeleted, filterByTag, getAllTags, filterByMultipleTags } from './bookmarks'
import type { BookmarksStore } from '@/types'

// 一个含「缺 tags 条目」的 store（模拟同步来的旧格式/异常数据）
const store: BookmarksStore = {
  meta: { databaseVersion: 1, created: 1, updated: 1 },
  data: {
    'https://a.com': {
      // 故意缺 tags
      meta: { title: 'A' },
      tags: undefined as unknown as string[],
    },
    'https://b.com': {
      meta: { title: 'B' },
      tags: ['work', 'dev'],
    },
    'https://c.com': {
      meta: { title: 'C', deleted: 123 },
      tags: ['work'],
    },
  },
}

describe('bookmarks 缺 tags 健壮性', () => {
  it('isDeleted 对缺 tags 的条目不抛错，返回 false', () => {
    expect(() => isDeleted({ meta: {}, tags: undefined } as any)).not.toThrow()
    expect(isDeleted({ meta: {}, tags: undefined } as any)).toBe(false)
  })

  it('filterByTag 跳过缺 tags 条目而不崩溃', () => {
    const r = filterByTag(store, 'work')
    const urls = r.map((b) => b.url)
    expect(urls).toContain('https://b.com')
    expect(urls).not.toContain('https://a.com') // 缺 tags，被跳过
    expect(urls).not.toContain('https://c.com') // 已删除，被跳过
  })

  it('getAllTags 忽略缺 tags 条目', () => {
    const tags = getAllTags(store)
    expect(tags).toContain('work')
    expect(tags).toContain('dev')
  })

  it('filterByMultipleTags 对缺 tags 条目返回空（不抛错）', () => {
    const r = filterByMultipleTags(store, ['dev'])
    expect(r.map((b) => b.url)).toEqual(['https://b.com'])
  })
})
