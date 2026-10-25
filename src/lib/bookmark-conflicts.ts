import type { BookmarkEntry } from '@/types'

type ConflictDecision =
  | { action: 'use-local'; reason?: string }
  | { action: 'use-remote'; reason?: string }
  | { action: 'merge'; doc: Record<string, unknown>; reason?: string }
  | { action: 'keep-conflict'; reason?: string }

function isBookmarkDoc(doc: any): boolean {
  return doc?.type === 'bookmark' || (typeof doc?._id === 'string' && doc._id.startsWith('bm:'))
}

export function getBookmarkUpdatedAt(doc: any): number {
  return Number(
    doc?.updatedAt ??
      doc?.meta?.updated ??
      doc?.lastClickedAt ??
      doc?.createdAt ??
      doc?.meta?.created ??
      0,
  ) || 0
}

export function getEntryUpdatedAt(entry: BookmarkEntry): number {
  return Number(entry.meta?.updated ?? entry.meta?.created ?? 0) || 0
}

export function mergeBookmarkDocs(localDoc: any, remoteDoc: any): Record<string, unknown> {
  const localTime = getBookmarkUpdatedAt(localDoc)
  const remoteTime = getBookmarkUpdatedAt(remoteDoc)
  const newer = remoteTime > localTime ? remoteDoc : localDoc
  const older = newer === remoteDoc ? localDoc : remoteDoc
  const tags = Array.from(new Set([...(older?.tags || []), ...(newer?.tags || [])]))
  const createdAtValues = [localDoc?.createdAt, remoteDoc?.createdAt].filter((v) => typeof v === 'number' && v > 0)

  return {
    ...older,
    ...newer,
    tags,
    clicks: Math.max(Number(localDoc?.clicks || 0), Number(remoteDoc?.clicks || 0)),
    lastClickedAt: Math.max(Number(localDoc?.lastClickedAt || 0), Number(remoteDoc?.lastClickedAt || 0)) || undefined,
    createdAt: createdAtValues.length > 0 ? Math.min(...createdAtValues) : (newer?.createdAt || Date.now()),
    updatedAt: Math.max(localTime, remoteTime, Number(newer?.updatedAt || 0)),
    deleted: Boolean(newer?.deleted),
  }
}

export function resolveOneNavSyncConflict(localDoc: any, remoteDoc: any, context: any): ConflictDecision {
  if (!isBookmarkDoc(localDoc) || !isBookmarkDoc(remoteDoc)) {
    if (context?.reason === 'remote-newer') return { action: 'use-remote', reason: 'remote revision is newer' }
    if (context?.reason === 'local-newer') return { action: 'use-local', reason: 'local revision is newer' }
    // 其余（conflict / unknown / 同代）对非书签文档一律确定性解决，绝不 keep-conflict。
    // 背景：keep-conflict 会把冲突双方的完整内容写进一个大的 sync_conflict 文档（约 11KB），
    // 而 sync_conflict 文档本身又是「非书签文档」，再次冲突会再次 keep-conflict → 正反馈雪崩。
    // 2026-10-16 即因此一次同步生成上万冲突文档、数百 MB，导致 onenav 目录异常膨胀、同步极慢、
    // 记账页首拉取超时后读到空库（「能存不能读」）。这里改为确定性选择远端，阻断该风暴。
    return { action: 'use-remote', reason: 'non-bookmark conflict resolved deterministically (prefer remote)' }
  }

  const localTime = getBookmarkUpdatedAt(localDoc)
  const remoteTime = getBookmarkUpdatedAt(remoteDoc)
  const merged = mergeBookmarkDocs(localDoc, remoteDoc)

  if (remoteTime > localTime) {
    return { action: 'merge', doc: merged, reason: 'remote bookmark updatedAt is newer' }
  }

  if (localTime > remoteTime) {
    return { action: 'merge', doc: merged, reason: 'local bookmark updatedAt is newer' }
  }

  return { action: 'merge', doc: merged, reason: 'bookmark timestamps are equal, merged fields' }
}
