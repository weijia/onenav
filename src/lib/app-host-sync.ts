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
 *  0. getRemoteStorage()：先建立 remotestoragejs 实例，让 wireclient 从自己的 localStorage
 *     （remotestorage:wireclient）恢复连接——凭据可能只存在那里，而 onenav:rs-credentials 缺失；
 *  1. 完全没有凭据 → 返回 true（本地/WebDAV 模式，不发起同步）；
 *  2. 有凭据 →
 *     a. ensureStorageReady()：等连接就绪，使后续 scheduleAutoSync 里的
 *        getStorageCredentials() 有值；
 *     b. syncToRemoteStorage()：做一次初始双向同步——
 *        · 把 `isConfigured` 置 true（修复「写后不同步」的核心）；
 *        · pull 远端数据进 PouchDB（应用首次打开即可见跨设备数据）；
 *        · push 本地数据到远端（把本地已有应用数据首次上云）。
 *
 * @returns true：RS 同步已就绪（含无凭据场景）；false：同步失败（应用仍以本地模式运行，不阻塞）。
 */
import { getRemoteStorage } from '@/lib/remotestorage-connection'
import { syncToRemoteStorage, ensureStorageReady } from '@/lib/remotestorage-sync'
import { getPouchDB } from '@/lib/pouchdb'

/** 应用页面监听的事件名：RemoteStorage 同步完成后触发，用于重新加载数据 */
export const DATA_CHANGED_EVENT = 'onenav:rs-data-changed'

export async function bootstrapAppRemoteStorage(): Promise<boolean> {
  // 先建立 remotestoragejs 实例：wireclient 会从自己的 localStorage（remotestorage:wireclient）
  // 异步恢复 href+token 并触发 connected，从而让 getStorageCredentials() 有值。
  // 这一步必须在判断凭据之前完成——否则当 onenav:rs-credentials 缺失（老用户/新部署）
  // 但 remotestorage:wireclient 仍有数据时，会直接判为「本地模式」、永不连接、永不同步。
  getRemoteStorage()

  // 等待连接就绪（从 remotestorage:wireclient 恢复，或 onenav:rs-credentials 直连）
  const creds = await ensureStorageReady()
  console.log('[app-host-sync] 启动引导；可用的 RemoteStorage 凭据:', creds ? '有' : '无')
  if (!creds) {
    console.log('[app-host-sync] 无可用 RemoteStorage 凭据 → 本地模式，不发起同步（如需同步请先在设置页连接 RemoteStorage）')
    // 诊断用：区分「从未连接过」与「凭据只存在库内 key」两种情况
    try {
      console.log('[app-host-sync] 凭据诊断:', {
        'onenav:rs-credentials': localStorage.getItem('onenav:rs-credentials') ? '存在' : '缺失',
        'remotestorage:wireclient': localStorage.getItem('remotestorage:wireclient') ? '存在' : '缺失',
      })
    } catch {
      // localStorage 不可用（隐私模式等）时忽略
    }
    return true // 无凭据：应用按本地/WebDAV 模式工作
  }

  try {
    // 初始双向同步：pull 远端数据进 PouchDB + push 本地数据到远端
    const db = await getPouchDB()
    console.log('[app-host-sync] 开始初始双向同步（pull + push）…')
    // 显式传 onProgress：本处 showToast=false，若不传 onProgress 则 pull 阶段
    // （远端发现多少文件、读入多少、待写入多少）完全没有日志，无法判断是否真的拉到了数据。
    await syncToRemoteStorage(db, creds, {
      showToast: false,
      onProgress: (p: any) => {
        if (p?.phase === 'pull') {
          if (p.message) console.log(`[app-host-sync][pull] ${p.message}`)
        } else if (p?.phase === 'push') {
          if (p.message) console.log(`[app-host-sync][push] ${p.message}`)
        } else if (p?.phase === 'done' || p?.phase === 'skip' || p?.phase === 'error') {
          console.log(`[app-host-sync][${p.phase}] ${p.message ?? ''}`)
        }
      },
    })
    console.log('[app-host-sync] 初始同步完成')
    // 通知应用主体重新读取：初始同步可能晚于 AppHost 的 5s 渲染超时完成，
    // 此时应用已按「本地旧数据」渲染完毕，需要主动触发一次重新加载才能看到远端数据。
    notifyDataChanged()
    return true
  } catch (e) {
    console.error('[app-host-sync] RemoteStorage 初始同步失败（已忽略，继续本地模式）:', e)
    return false
  }
}

/**
 * 广播「远端数据已同步到本地」事件，应用页面监听后重新读取即可看到远端数据。
 *
 * 为什么需要它：AppHost 用 5s 超时做渲染门控，远端文件较多时 pull 可能超过 5s，
 * 应用主体会带着「尚未 pull 完」的本地数据先行渲染，而多数应用（如记账）只在挂载时
 * 读一次 PouchDB、不订阅 changes，导致 pull 完成后界面仍是旧数据。
 */
function notifyDataChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(DATA_CHANGED_EVENT))
  } catch {
    // 非浏览器环境（单测等）忽略
  }
}
