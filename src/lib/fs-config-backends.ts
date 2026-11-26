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
import {
  registerBackend,
  wrapZenFSFileSystem,
  listDataGroupCandidates,
  groupHasPath,
  getPreferredDataGroupId as getLibPreferredDataGroupId,
  setPreferredDataGroupId as setLibPreferredDataGroupId,
  resolveDataGroup as libResolveDataGroup,
  ensureDataGroup as libEnsureDataGroup,
  DATA_GROUP_PREFERENCE_PREFIX,
} from 'zen-fs-config'
import type {
  AppDataGroup,
  DataGroupCandidate as LibDataGroupCandidate,
  DataGroupSource,
  EnsureDataGroupResult as LibEnsureDataGroupResult,
} from 'zen-fs-config'

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

// ---------------------------------------------------------------------------
// 数据组选择（候选枚举 / 解析 / 补建默认组）
//
// 实现已上移到 zen-fs-config 0.9.5：`listDataGroupCandidates` / `resolveDataGroup`
// / `ensureDataGroup` / `groupHasPath` / `getPreferredDataGroupId`。本文件只保留
// 一层薄适配：
//  - 参数名兼容旧调用（第三个位置参数 `path`、选项里的 `preferPath`）；
//  - 本机偏好键迁移：新键 `zen-fs-config:data-group:{appId}`，读取时兼容旧键
//    `onenav:data-group:{appId}`，读到旧值后补写新键；写入时清掉旧键。
// 页面调用写法不变。
// ---------------------------------------------------------------------------

/** 旧版（onenav 自己）的偏好键前缀，仅用于一次性迁移。 */
const LEGACY_PREFERENCE_PREFIX = 'onenav:data-group:'
const PREFERENCE_READ_PREFIXES = [DATA_GROUP_PREFERENCE_PREFIX, LEGACY_PREFERENCE_PREFIX]

export function getPreferredDataGroupId(appId: string): string | null {
  const id = getLibPreferredDataGroupId(appId, { readPrefixes: PREFERENCE_READ_PREFIXES })
  if (id) {
    try {
      // 读到旧键就补一份新键，下次不再依赖旧前缀
      if (localStorage.getItem(`${LEGACY_PREFERENCE_PREFIX}${appId}`)) {
        setLibPreferredDataGroupId(appId, id)
      }
    } catch { /* localStorage 不可用 */ }
  }
  return id
}

export function setPreferredDataGroupId(appId: string, id: string | null): void {
  setLibPreferredDataGroupId(appId, id)
  try {
    localStorage.removeItem(`${LEGACY_PREFERENCE_PREFIX}${appId}`)
  } catch { /* localStorage 不可用 */ }
}

export type DataGroupCandidate = LibDataGroupCandidate
export type EnsureDataGroupResult = LibEnsureDataGroupResult

/** 列出候选（第三个参数是「应用数据目录」，沿用旧签名）。 */
export async function collectDataGroupCandidates(
  connected: DataGroupSource,
  appId: string,
  path?: string,
): Promise<DataGroupCandidate[]> {
  return listDataGroupCandidates(connected, appId, path ? { path } : {})
}

export interface ResolveOptions {
  /** 显式指定的组 id（缺省读本机偏好） */
  preferGroupId?: string | null
  /** 旧参数名：应用自己的数据目录 */
  preferPath?: string
}

/** 解析要挂载的组：偏好 → 有数据 → 唯一远端 → 单候选，其余返回 null。 */
export async function resolveDataGroup(
  connected: DataGroupSource,
  appId: string,
  opts: ResolveOptions = {},
): Promise<AppDataGroup | null> {
  return libResolveDataGroup(connected, appId, {
    preferGroupId: opts.preferGroupId,
    path: opts.preferPath,
    preference: { readPrefixes: PREFERENCE_READ_PREFIXES },
  })
}

export interface EnsureOptions extends ResolveOptions {
  allowCreateLocal?: boolean
}

/** 确保至少有一个可用数据组；只有「零描述符」时才补建本机 default 组。 */
export async function ensureDataGroup(
  connected: DataGroupSource,
  appId: string,
  opts: EnsureOptions = {},
): Promise<EnsureDataGroupResult> {
  return libEnsureDataGroup(connected, appId, {
    preferGroupId: opts.preferGroupId,
    path: opts.preferPath,
    allowCreateLocal: opts.allowCreateLocal,
    preference: { readPrefixes: PREFERENCE_READ_PREFIXES },
  })
}

export { groupHasPath }

/** 注册 RemoteStorage 后端类型（幂等）。 */
export function registerFsConfigBackends(): void {
  if (registered) return
  registered = true

  // GitHub：与 Gitee 同理，内置工厂的变量式 import 在 Vite 打包后无法解析。用
  // 字面量 import 让 Vite 收进 chunk，并按内置 GitHub 注册的语义覆盖同一 type。
  registerBackend('GitHub', async (options: Record<string, unknown>) => {
    const mod: any = await import('zen-fs-github')
    const Github = mod?.Github ?? mod?.default
    if (!Github || (typeof Github !== 'function' && typeof Github.create !== 'function')) {
      throw new Error('zen-fs-github 未导出可用的 Github 后端')
    }
    const token = String(options.token ?? '')
    const owner = String(options.owner ?? '')
    const repo = String(options.repo ?? '')
    if (!owner || !repo) throw new Error('GitHub 后端需要 owner 与 repo')
    const backend: any = await wrapZenFSFileSystem({
      backend: Github,
      token,
      owner,
      repo,
      branch: options.branch,
      baseUrl: (options.baseUrl as string) || undefined,
    })

    // shouldSync: 用 branches/commits 的 tree SHA 判断远端是否变化，避免每轮
    // 都全量拉取。与 zen-fs-config-ui / admin 的 GitHub 注册保持一致。
    const branch = String(options.branch ?? 'main')
    const baseUrl = String(options.baseUrl ?? '').trim() || 'https://api.github.com'
    const cacheKey = `zen-fs-github-sync:${owner}/${repo}/${branch}`
    backend.shouldSync = async (): Promise<boolean> => {
      try {
        const headers: Record<string, string> = { Accept: 'application/vnd.github.v3+json' }
        if (token) headers.Authorization = `Bearer ${token}`
        const base = baseUrl.replace(/\/$/, '')
        const branchRes = await fetch(`${base}/repos/${owner}/${repo}/branches/${branch}`, { headers })
        if (!branchRes.ok) return true
        const commitSha = (await branchRes.json())?.commit?.sha
        if (!commitSha) return true
        const commitRes = await fetch(`${base}/repos/${owner}/${repo}/git/commits/${commitSha}`, { headers })
        if (!commitRes.ok) return true
        const treeSha = (await commitRes.json())?.tree?.sha
        if (!treeSha) return true
        const cached = localStorage.getItem(cacheKey)
        if (cached === treeSha) return false
        localStorage.setItem(cacheKey, treeSha)
        return true
      } catch {
        return true
      }
    }
    return backend
  }, {
    type: 'GitHub',
    label: 'GitHub',
    icon: '🐙',
    fields: [
      { key: 'owner', label: 'Owner', type: 'text', placeholder: 'weijia', required: true },
      { key: 'repo', label: 'Repo', type: 'text', placeholder: 'my-configs', required: true },
      { key: 'branch', label: 'Branch', type: 'text', placeholder: 'main' },
      { key: 'token', label: 'Token', type: 'password', placeholder: 'ghp_xxxx' },
      { key: 'baseUrl', label: 'API URL', type: 'text', placeholder: 'https://api.github.com' },
    ],
    defaultOptions: { owner: '', repo: '', branch: 'main', token: '', baseUrl: '' },
    accountFields: ['token', 'owner', 'baseUrl'],
    identityFields: ['owner', 'repo', 'branch', 'baseUrl'],
  })

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
