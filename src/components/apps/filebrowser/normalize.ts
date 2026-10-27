// 归一化层：把原始目录结构清单（RawManifest）收敛为已校验、已过滤的 FolderNodeView 树。
// 过滤规则遵循 dir-struct-manifest-format.md：清单只描述「目录结构」，读取侧过滤掉 type:"file" 的节点。

import type { FolderNodeView, ManifestView, RawManifest } from './types'

interface RawFolderNode {
  name?: unknown
  type?: unknown
  tags?: unknown
  children?: unknown
}

function toStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/**
 * 将一个原始节点收敛为 FolderNodeView；非法节点返回 null 被跳过。
 * - 缺 name：跳过（告警）
 * - type === 'file'：跳过（格式约定：清单不含文件）
 * - 其余（无 type 或 'folder'）：视作 folder
 */
function normalizeFolderNode(raw: unknown, warnings: string[]): FolderNodeView | null {
  if (!raw || typeof raw !== 'object') return null
  const node = raw as RawFolderNode

  const name = toStr(node.name)
  if (name == null) {
    warnings.push('发现缺少 name 的节点，已跳过')
    return null
  }

  const type = toStr(node.type) ?? 'folder'
  if (type === 'file') return null // 过滤文件节点

  const tags = Array.isArray(node.tags)
    ? node.tags.filter((t): t is string => typeof t === 'string')
    : []

  const childrenRaw = Array.isArray(node.children) ? node.children : []
  const children: FolderNodeView[] = []
  for (const c of childrenRaw) {
    const cn = normalizeFolderNode(c, warnings)
    if (cn) children.push(cn)
  }

  return { name, type: 'folder', tags, children }
}

/** 递归统计文件夹节点数（含自身） */
function countFolders(node: FolderNodeView): number {
  let n = 1
  for (const c of node.children) n += countFolders(c)
  return n
}

/**
 * 收敛单个原始清单为 ManifestView；缺合法 root 节点时返回 null（该清单被跳过）。
 */
export function normalizeManifest(raw: unknown): ManifestView | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as RawManifest
  const warnings: string[] = []

  const root = normalizeFolderNode(obj.root, warnings)
  if (!root) {
    // 缺少合法 root 节点（root.type 必须为 folder），跳过该清单。
    return null
  }

  const source = toStr(obj.source) ?? root.name
  const generatedAt = toStr(obj.generatedAt)
  const generator = toStr(obj.generator)

  return {
    source,
    generatedAt,
    generator,
    root,
    folderCount: Math.max(0, countFolders(root) - 1), // 不含根（主机）自身
    warnings,
  }
}

/**
 * 收敛多个原始清单；非法清单被静默跳过。
 * 结果按 source 升序，保证多主机展示顺序稳定。
 */
export function normalizeManifests(raws: unknown[]): ManifestView[] {
  const out: ManifestView[] = []
  for (const r of raws) {
    const m = normalizeManifest(r)
    if (m) out.push(m)
  }
  out.sort((a, b) => a.source.localeCompare(b.source))
  return out
}

/**
 * 按关键词筛选目录树：返回只包含「匹配节点及其祖先链」的树。
 * - 节点名命中关键词：保留该节点；其子节点仅保留同样命中的分支（避免倾倒无关子树）。
 * - 节点名未命中：仅当存在命中的后代时才保留（作为祖先路径）。
 */
export function filterTree(node: FolderNodeView, query: string): FolderNodeView | null {
  const q = query.trim().toLowerCase()
  const kids = node.children
    .map((c) => filterTree(c, query))
    .filter((c): c is FolderNodeView => c !== null)

  const selfMatch = node.name.toLowerCase().includes(q)
  if (selfMatch) {
    return { ...node, children: kids }
  }
  if (kids.length > 0) {
    return { ...node, children: kids }
  }
  return null
}
