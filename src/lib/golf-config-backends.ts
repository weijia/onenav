/**
 * zen-fs-config 浏览器后端注册。
 *
 * zen-fs-config 内置 InMemory / IndexedDB 两种本地后端；要让用户能在
 * SyncGroupConfigurator 里选 RemoteStorage 作为数据组同步后端，必须先在这里注册。
 * 后端类型注册表是模块级全局，重复 register 同一 type 是安全的（覆盖），
 * 但本模块用 guard 保证只执行一次。
 *
 * RemoteStorage 实现复用 onenav 已装的 zen-fs-remotestoragejs；
 * WebFinger 解析 user@host → storage URL，与 admin 端行为一致。
 */
import { registerBackend, wrapZenFSFileSystem, connect } from 'zen-fs-config'
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

/**
 * 从 config-ui 的 onConnected 数据里解析出可用的数据组实例。
 * config-sync 模式只给 repo（数据组在内部 groupInstances，未 emit）；
 * data-sync 模式给 dataGroup。兜底用 connect('golf') 重新加载。
 */
export async function resolveGolfDataGroup(connected: any): Promise<AppDataGroup | null> {
  const direct = connected?.dataGroup as AppDataGroup | undefined
  if (direct?.fs?.promises) return direct
  const repo = connected?.repo as any
  if (repo?.listAppDataGroups && repo?.getAppDataGroup) {
    try {
      const descriptors = await repo.listAppDataGroups()
      for (const d of descriptors) {
        const g = await repo.getAppDataGroup(d.id)
        if (g?.fs?.promises) return g
      }
    } catch { /* 落到 connect 兜底 */ }
  }
  try {
    const result = await connect('golf')
    const groups = result.appDataGroups || []
    return groups.find((g) => g?.fs?.promises) || null
  } catch (e) {
    console.warn('[golf] 无法解析数据组实例:', e)
    return null
  }
}

export function registerGolfBackends(): void {
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
    // zen-fs-remotestoragejs 提供 fs.promises 风格 API，wrap 成 zen-fs-config 的 BackendInstance。
    const instance = new Ctor({ href, token, basePath })
    return wrapZenFSFileSystem({ fs: instance })
  }, {
    type: 'RemoteStorage',
    label: 'RemoteStorage',
    icon: '\u2601',
    fields: [
      { key: 'href', label: '存储地址 (URL 或 user@host)', type: 'text' },
      { key: 'token', label: 'Bearer token', type: 'password' },
      { key: 'basePath', label: '基准路径 (可选)', type: 'text' },
    ],
    defaultOptions: { basePath: '' },
    identityFields: ['href', 'basePath'],
  })
}
