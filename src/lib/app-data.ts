/**
 * 内置小应用的数据存取与同步层。
 *
 * 同步策略：
 *  - RemoteStorage：应用数据以 PouchDB 文档（app:<appId>）存储，RemoteStorage 同步引擎对整个 PouchDB 整库同步，
 *    因此应用数据会自动随 RemoteStorage 跨设备同步（保存后由 scheduleAutoSync 触发 push）。
 *  - WebDAV：额外把每个应用数据落盘到 app_data/onenav/apps/<appId>.json（在配置目录同级），
 *    加载时以本地 PouchDB 为优先，缺失时回退 WebDAV 并写回本地缓存。
 */
import { useEffect, useState, useCallback, useRef } from 'react'
import { saveAppDataToPouch, loadAppDataFromPouch, getPouchDB } from '@/lib/pouchdb'
import { loadWebDAVConfig } from '@/lib/config'
import { createDirectory, putFileContents, getFileContents } from '@/lib/webdav'
import { isRemoteStorageConfigured, scheduleAutoSync } from '@/lib/remotestorage-sync'

const APPS_DIR = 'app_data/onenav/apps'

/** 保存应用数据：写入本地 PouchDB，并尽量同步到 WebDAV 与 RemoteStorage */
export async function saveAppData(appId: string, data: unknown): Promise<void> {
  await saveAppDataToPouch(appId, data)

  const wdav = loadWebDAVConfig()
  if (wdav) {
    try {
      await createDirectory(wdav, 'app_data')
      await createDirectory(wdav, 'app_data/onenav')
      await createDirectory(wdav, 'app_data/onenav/apps')
      await putFileContents(wdav, `${APPS_DIR}/${appId}.json`, JSON.stringify({ appId, data, updatedAt: Date.now() }))
    } catch (e) {
      console.error('[AppData] WebDAV 保存失败:', e)
    }
  }

  if (isRemoteStorageConfigured()) {
    try {
      const database = await getPouchDB()
      await scheduleAutoSync(database)
    } catch (e) {
      console.error('[AppData] RemoteStorage 自动同步失败（已忽略）:', e)
    }
  }
}

/** 读取应用数据：本地 PouchDB 优先，缺失时回退 WebDAV 并写回本地缓存 */
export async function loadAppData(appId: string): Promise<unknown> {
  const local = await loadAppDataFromPouch(appId)
  if (local !== null && local !== undefined) return local

  const wdav = loadWebDAVConfig()
  if (wdav) {
    try {
      const raw = await getFileContents(wdav, `${APPS_DIR}/${appId}.json`)
      const parsed = JSON.parse(raw)
      const data = parsed.data
      if (data !== undefined) {
        await saveAppDataToPouch(appId, data)
      }
      return data ?? null
    } catch {
      return null
    }
  }
  return null
}

/** React Hook：加载并读写某个应用的数据 */
export function useAppData<T>(appId: string, fallback: T): {
  data: T
  loading: boolean
  save: (data: T) => Promise<void>
} {
  const [data, setData] = useState<T>(fallback)
  const [loading, setLoading] = useState(true)
  const fallbackRef = useRef(fallback)
  fallbackRef.current = fallback

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    loadAppData(appId)
      .then((d) => { if (!cancelled) setData((d as T) ?? fallbackRef.current) })
      .catch(() => { if (!cancelled) setData(fallbackRef.current) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [appId])

  const save = useCallback(async (next: T) => {
    setData(next)
    await saveAppData(appId, next)
  }, [appId])

  return { data, loading, save }
}
