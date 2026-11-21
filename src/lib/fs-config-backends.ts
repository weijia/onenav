/**
 * zen-fs-config 浏览器后端注册（公共）。
 *
 * zen-fs-config 内置 InMemory / IndexedDB 两种本地后端；要让用户能在
 * SyncGroupConfigurator 里选 RemoteStorage 作为数据组同步后端，必须先注册。
 * 后端类型注册表是模块级全局，重复 register 同一 type 是安全的（覆盖），
 * 本模块用 guard 保证只执行一次。
 *
 * RemoteStorage 实现复用 onenav 已装的 zen-fs-remotestoragejs；
 * WebFinger 解析 user@host → storage URL，与 admin 端行为一致。
 * Gitee 必须在这里覆盖注册：zen-fs-config 内置工厂用变量式 import(pkg)，
 * Vite 无法静态分析，浏览器端必然报 "is not available"。
 *
 * 本模块与具体 appId 无关，golf / dir-struct-gen(filebrowser) 共用同一套注册。
 */
import { registerBackend, connect, wrapZenFSFileSystem } from 'zen-fs-config'
import type { AppDataGroup } from 'zen-fs-config'

let registered = false

async function resolveStorageUrl(userAddress: string): Promise<string> {
  if (/^https?:\/\//.test(userAddress)) return userAddress.replace(/\/$/, '')
  const at = userAddress.lastIndexOf('@')
  if (at < 0) throw new Error(`RemoteStorage 地址无效：${userAddress}（应为 URL 或 user@host）`)
  const user = userAddress.slice(0, at)
  const host = userAddress.slice(at + 1)
  const res = await fetch(`https://${host}/.well-known/webfinger?resource=acct:${user}@${host}`, {
    headers: { Accept: 'application/json' },
    credentials: 'omit',
  })
  if (!res.ok) throw new Error(`WebFinger 解析失败：${res.status}`)
  const links: any[] = (await res.json()).links || []
  const link = links.find((l) =>
    l?.rel === 'http://remotestorage.io/spec/version' ||
    l?.rel === 'remotestorage' ||
    l?.rel === 'http://tools.ietf.org/id/draft-dejong-remotestorage' ||
    /^http:\/\/tools\.ietf\.org\/id\/draft-dejong-remotestorage-\d+$/.test(l?.rel || '') ||
    l?.properties?.['http://remotestorage.io/spec/version'],
  )
  if (!link?.href) throw new Error('WebFinger 响应中没有 RemoteStorage 存储地址')
  return link.href.replace(/\/$/, '')
}

/** 本地后端类型：这类后端不跨设备同步，组里只有它们时不算「已连上可用数据组」。 */
const LOCAL_BACKEND_TYPES = new Set(['IndexedDB', 'InMemory'])

/** 取数据组当前已连接后端列表（兼容 listBackends / listDeclaredBackends）。 */
function listGroupBackends(group: any): any[] {
  if (!group) return []
  const connected = typeof group.listBackends === 'function' ? group.listBackends() : []
  const declared = typeof group.listDeclaredBackends === 'function' ? group.listDeclaredBackends() : []
  return [...(connected || []), ...(declared || [])]
}

/** 组里是否存在非本地（远端）后端。 */
function hasRemoteBackend(group: any): boolean {
  return listGroupBackends(group).some((b) => b && !LOCAL_BACKEND_TYPES.has(b.type))
}

/**
 * 从 config-ui 的 onConnected 数据里解析出可用的数据组实例。
 * config-sync 模式只给 repo（数据组在内部 groupInstances，未 emit）；
 * data-sync 模式给 dataGroup。
 *
 * 多个候选组时优先选「带已连接远端后端」的组；纯本地/空组排后，避免误选到
 * 只有 IndexedDB/InMemory 的空组导致读侧报未连接。
 */
export async function resolveDataGroup(
  connected: any,
  appId: string,
  opts?: { preferGroupId?: string; preferPath?: string },
): Promise<AppDataGroup | null> {
  const direct = connected?.dataGroup as AppDataGroup | undefined
  if (direct?.fs?.promises) return direct

  const candidates: AppDataGroup[] = []
  const repo = connected?.repo as any
  if (repo?.listAppDataGroups && repo?.getAppDataGroup) {
    try {
      const descriptors = await repo.listAppDataGroups()
      for (const d of descriptors) {
        const g = await repo.getAppDataGroup(d.id)
        if (g?.fs?.promises) candidates.push(g)
      }
    } catch {
      /* 落到 connect 兜底 */
    }
  }
  if (candidates.length === 0) {
    try {
      const result = await connect(appId)
      for (const g of result.appDataGroups || []) {
        if (g?.fs?.promises) candidates.push(g)
      }
    } catch (e) {
      console.warn(`[${appId}] 无法解析数据组实例:`, e)
    }
  }
  if (candidates.length === 0) return null

  // 首选指定 id，但必须「确实有内容」才采纳：残留组（描述符已删/远端未绑定）
  // 也会被实例化出来，选中它读侧就会永远空态。
  const preferPath = opts?.preferPath
  if (opts?.preferGroupId) {
    const named = candidates.find((g) => (g as any).groupId === opts.preferGroupId)
    if (named && (!preferPath || (await groupHasPath(named, preferPath)))) return named
  }
  // 其次按内容选：哪个组的 preferPath 下有文件就用哪个（顺序不影响结果）。
  if (preferPath) {
    for (const g of candidates) {
      if (await groupHasPath(g, preferPath)) return g
    }
  }
  // 兜底：优先带远端后端的组；其次任意带 fs 的组。
  return candidates.find((g) => hasRemoteBackend(g)) ?? candidates[0]
}

/** 组在 preferPath 下是否至少有一个条目（读失败/未连接都算空）。 */
export async function groupHasPath(group: any, path: string): Promise<boolean> {
  try {
    const p = group?.fs?.promises
    if (!p?.readdir) return false
    const names = await p.readdir(path)
    return Array.isArray(names) ? names.length > 0 : false
  } catch {
    return false
  }
}

/** 注册 RemoteStorage 后端类型（幂等）。 */
export function registerFsConfigBackends(): void {
  if (registered) return
  registered = true

  registerBackend('RemoteStorage', async (options: Record<string, unknown>) => {
    const rs = await import('zen-fs-remotestoragejs')
    const Ctor = (rs as any).RemoteStorageFileSystem || (rs as any).default
    if (typeof Ctor !== 'function') throw new Error('zen-fs-remotestoragejs 未导出 RemoteStorageFileSystem')
    const rawHref = String(options.href ?? '')
    const token = String(options.token ?? '')
    if (!rawHref || !token) throw new Error('RemoteStorage 后端需要 href 与 token')
    const href = await resolveStorageUrl(rawHref)
    const basePath = (options.basePath as string) || undefined
    // RemoteStorageFileSystem 本身实现了 zen-fs 的 FileSystem 接口，且
    // config-ui 的 createBackend 会识别并返回它；不要再用 wrapZenFSFileSystem
    // 包一层（{ fs: instance } 不是合法的 mount config，会导致
    // "Invalid mount configuration"）。与 zen-fs-config 内置 RemoteStorage 注册
    // 保持一致：直接 new 出实例返回，preciseMtime/persistCache 启用以获得精确 mtime。
    return new Ctor({
      href,
      token,
      basePath,
      preciseMtime: true,
      persistCache: true,
    })
  }, {
    type: 'RemoteStorage',
    label: 'RemoteStorage',
    icon: '☁',
    fields: [
      { key: 'href', label: '存储地址 (URL 或 user@host)', type: 'text' },
      { key: 'token', label: 'Bearer token', type: 'password' },
      { key: 'basePath', label: '基准路径 (可选)', type: 'text' },
    ],
    defaultOptions: { basePath: '' },
    identityFields: ['href', 'basePath'],
  })

  // Gitee：zen-fs-config 内置的 Gitee 工厂走的是 importOptionalBackend(pkg)，
  // 即 `await import(pkg)` 这种「变量形式的动态导入」。Vite 无法静态分析，
  // 打包后浏览器拿到的是裸模块名 "zen-fs-gitee"，直接抛
  // Failed to resolve module specifier → 上层显示
  // "Backend package \"zen-fs-gitee\" is not available"。npm install 装上了也没用。
  // 这里用字面量 import('zen-fs-gitee')，让 Vite 把它收成独立 chunk，
  // 再按内置注册的语义（描述符 + wrapZenFSFileSystem）覆盖同一 type。
  registerBackend('Gitee', async (options: Record<string, unknown>) => {
    const mod: any = await import('zen-fs-gitee')
    const Gitee = mod?.Gitee ?? mod?.default
    // zen-fs-gitee 导出的是后端描述符对象（name/options/isAvailable/create），
    // 不是类构造器，@zenfs/core 的 resolveMountConfig 直接接受描述符。
    if (!Gitee || (typeof Gitee !== 'function' && typeof Gitee.create !== 'function')) {
      throw new Error('zen-fs-gitee 未导出可用的 Gitee 后端（缺少 Gitee 描述符）')
    }
    const token = String(options.token ?? '')
    const owner = String(options.owner ?? '')
    const repo = String(options.repo ?? '')
    if (!owner || !repo) throw new Error('Gitee 后端需要 owner 与 repo')
    return wrapZenFSFileSystem({
      backend: Gitee,
      token,
      owner,
      repo,
      branch: options.branch,
      baseUrl: (options.baseUrl as string) || undefined,
    })
  }, {
    type: 'Gitee',
    label: 'Gitee',
    icon: '🦊',
    fields: [
      { key: 'owner', label: 'Owner', type: 'text', placeholder: 'weijia', required: true },
      { key: 'repo', label: 'Repo', type: 'text', placeholder: 'my-configs', required: true },
      { key: 'branch', label: 'Branch', type: 'text', placeholder: 'master' },
      { key: 'token', label: 'Token', type: 'password', placeholder: 'gitee token' },
      { key: 'baseUrl', label: 'API URL', type: 'text', placeholder: 'https://gitee.com/api/v5' },
    ],
    defaultOptions: { owner: '', repo: '', branch: 'master', token: '', baseUrl: '' },
    accountFields: ['token', 'owner', 'baseUrl'],
    identityFields: ['owner', 'repo', 'branch', 'baseUrl'],
  })
}
