/**
 * 独立应用页（apps/<id>/index.html）的 RemoteStorage 同步引导。
 *
 * 背景：书签、配置与各应用数据（bookkeeping、golf 等）都存 PouchDB，同步引擎（universal-sync-v2）
 * 对整库做双向同步。但每个独立应用页是各自独立的 Vite 入口 / 独立 JS 模块实例，页面本身从不
 * 建立 RemoteStorage 连接，导致 remotestorage-sync.ts 的模块级 `isConfigured` 恒为 false，
 * 各应用写后调用的 `scheduleAutoSync`（内部 `if (isRemoteStorageConfigured())`）永远被跳过
 * → 应用数据只落本地 PouchDB，从不 push 到 RemoteStorage 后端。
 *
 * 本函数在应用页挂载时由 AppHost 调用一次：
 *  1. 没有已保存的 RemoteStorage 凭据 → 直接返回 true（本地/WebDAV 模式，无需同步）；
 *  2. 有凭据 →
 *     a. getRemoteStorage()：建立 remotestoragejs 实例连接，使后续 scheduleAutoSync 里的
 *        getStorageCredentials() 有值；
 *     b. syncToRemoteStorage()：用已保存凭据做一次初始双向同步——
 *        · 把 `isConfigured` 置 true（修复「写后不同步」的核心）；
 *        · pull 远端数据进 PouchDB（应用首次打开即可见跨设备数据）；
 *        · push 本地数据到远端（把本地已有应用数据首次上云）。
 *
 * @returns true：RS 同步已就绪（含无凭据场景）；false：同步失败（应用仍以本地模式运行，不阻塞）。
 */
import { getSavedStorageCredentials, getRemoteStorage } from '@/lib/remotestorage-connection'
import { syncToRemoteStorage } from '@/lib/remotestorage-sync'
import { getPouchDB } from '@/lib/pouchdb'

export async function bootstrapAppRemoteStorage(): Promise<boolean> {
  const saved = getSavedStorageCredentials()
  console.log('[app-host-sync] 启动引导；已保存的 RemoteStorage 凭据:', saved ? saved.userAddress : '无')
  if (!saved) {
    console.log('[app-host-sync] 无 RemoteStorage 凭据 → 本地模式，不发起同步（如需同步请先在设置页连接 RemoteStorage）')
    return true // 无凭据：应用按本地/WebDAV 模式工作
  }

  try {
    // 建立 remotestoragejs 实例连接（供后续 scheduleAutoSync 的 getStorageCredentials() 使用）
    getRemoteStorage()
    // 初始双向同步：置 isConfigured=true + pull + push
    const db = await getPouchDB()
    console.log('[app-host-sync] 开始初始双向同步（pull + push）…')
    await syncToRemoteStorage(db, { href: saved.href, token: saved.token }, { showToast: false })
    console.log('[app-host-sync] 初始同步完成')
    return true
  } catch (e) {
    console.error('[app-host-sync] RemoteStorage 初始同步失败（已忽略，继续本地模式）:', e)
    return false
  }
}
