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
    return { action: 'keep-conflict', reason: 'non-bookmark conflict' }
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
