// 磁盘视图的纯数据层：把数据组里的主机磁盘文档（host-disks.v2.json）与 /struct 目录清单
// 合成「主机 → 磁盘 → 逻辑分区 → 卷 →（卷内目录树）」的四层结构。
//
// 规则与 zip-browser 的 host-disks 视图一致：
// - 分区是入口（遥测事实），关联卷是它下面的清单记录（0..N 条）；
// - 盘符对不上任何分区的卷进该磁盘的「未归属分区」（不隐藏）；
// - 挂在主机但没有任何磁盘的卷进该主机的「未归属的卷」；
// - 没有主机归属的卷进末尾「未归属主机的卷」；
// - 没有任何磁盘信息、但卷 ID 形如 openlist-<SN>-<单个数字> 的卷，渲染时现算推断 SN
//   并尽量挂到真实磁盘下（纯函数、不写文档）。
// - 清单里有、文档里没有的卷也单独留一组，保证数据不丢。

import type { FolderNodeView, ManifestView } from './types'
import { deriveSerialFromVolumeId } from './volumeSerial'

export interface RawLogicalDisk {
  deviceId?: string
  volumeName?: string
  fileSystem?: string
  sizeGB?: number
  freeSpaceGB?: number
  usagePercent?: number
}

export interface RawDisk {
  serial?: string
  diskId?: string
  diskUuid?: string
  aliasIds?: string[]
  deviceId?: string
  model?: string
  health?: string
  temperature?: number | null
  hasSmart?: boolean
  capacity?: string
  mediaType?: string
  logicalDisks?: RawLogicalDisk[]
  /** 挂在盘下的卷：字符串 volumeId 或 { volumeId } 对象 */
  volumes?: Array<string | { volumeId?: string }>
}

export interface RawHost {
  hostId?: string
  hostname?: string
  deviceName?: string
  deviceUuid?: string
  local?: boolean
  disks?: RawDisk[]
  unassigned?: string[]
}

export interface RawVolume {
  volumeId?: string
  drive?: string
  sourceHost?: string
  fileCount?: number
  totalSize?: number
  matchBy?: string
  manualSerial?: string
  derivedSerial?: string
  localVolumeId?: string | null
  telemetry?: {
    serial?: string
    deviceId?: string
    volumeName?: string
    fileSystem?: string
    model?: string
    hostname?: string
  } | null
}

export interface HostDisksDoc {
  version?: number
  generatedAt?: string
  hosts?: RawHost[]
  volumes?: RawVolume[]
  orphans?: string[]
  volumeAliases?: Record<string, string>
  partitionAliases?: Record<string, string>
  [key: string]: unknown
}

export type SerialSource = 'telemetry' | 'manual' | 'derived' | 'none'

export interface VolumeNode {
  volumeId: string
  drive: string
  alias: string
  /** 展示用 matchBy 文案 */
  matchLabel: string
  serial: string
  serialSource: SerialSource
  fileCount?: number
  totalSize?: number
  /** 清单里这个卷的盘符节点（含目录树）；文档有、清单没有时为 undefined */
  tree?: FolderNodeView
  /** 清单里该卷的分片基名（未挂清单时为 undefined 的替代信息） */
  shardBases?: string[]
}

export interface PartitionNode {
  deviceId: string
  alias: string
  logical?: RawLogicalDisk
  volumes: VolumeNode[]
}

export interface DiskNode {
  serial: string
  model: string
  capacity: string
  health: string
  temperature: number | null
  hasSmart: boolean
  mediaType: string
  partitions: PartitionNode[]
  /** 盘符对不上任何逻辑分区的卷 */
  looseVolumes: VolumeNode[]
}

export interface HostNode {
  hostId: string
  /** 显示名：hostname（与清单 source 对齐），缺失回退 deviceName / hostId */
  name: string
  deviceName: string
  local: boolean
  disks: DiskNode[]
  /** 挂在这台主机、但没匹配到磁盘的卷 */
  unassigned: VolumeNode[]
}

export interface UnlistedGroup {
  /** 分组标题：清单里的主机名（可能不在磁盘文档里） */
  host: string
  volumes: VolumeNode[]
}

export interface DiskTreeResult {
  hosts: HostNode[]
  /** 文档里有、但既没有磁盘也没有卷记录的主机（只在末尾汇总一行展示，避免刷屏） */
  emptyHosts: HostNode[]
  /** 没有主机归属的卷（文档 orphans） */
  orphanVolumes: VolumeNode[]
  /** 清单里有、磁盘文档里没有的卷（按主机分组） */
  unregistered: UnlistedGroup[]
  generatedAt: string | null
  stats: { hosts: number; disks: number; volumes: number }
  /** 文档里没有、只能按卷 ID 判断来源的卷数量 */
  inferredVolumes: number
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim())
const lower = (v: unknown): string => text(v).toLowerCase()

const MATCH_LABELS: Record<string, string> = {
  'manual-sn': '手工 SN 映射',
  'manual-sn-unverified': '手工映射 · 遥测未见',
  'derived-sn': '卷 ID 推断 SN',
  'derived-sn-unverified': '卷 ID 推断 · 遥测未见',
  'local-volume-id': '本机卷 ID',
  'local-only': '本机卷 · 清单未见',
  'host+drive': '主机名+盘符',
  'host-only': '仅主机名',
  unmatched: '未关联',
}

export function matchLabel(matchBy: string): string {
  return MATCH_LABELS[matchBy] || matchBy
}

/** 严格盘符：'C' / 'C:' / 'c:' → 'c:'；目录名首字母不会被当成盘符。 */
export function driveKeyOf(value: unknown): string | null {
  const m = /^\s*([A-Za-z])(?::)?\s*$/.exec(text(value))
  return m ? `${m[1].toLowerCase()}:` : null
}

/** 展示用分区名：盘符大写带冒号，其它形态原样。 */
export function partitionDisplayName(deviceId: unknown): string {
  const key = driveKeyOf(deviceId)
  return key ? `${key[0].toUpperCase()}:` : text(deviceId)
}

export function hostKeyOf(host: RawHost | null | undefined): string {
  return text(host?.hostId) || text(host?.deviceUuid) || text(host?.hostname) || text(host?.deviceName)
}

/** 分区没有稳定 ID，用「主机键 + 磁盘 SN + deviceId」当别名键（与 zip-browser 相同）。 */
export function partitionAliasKey(hostKey: string, serial: string, deviceId: string): string {
  return `/partition/${hostKey}/${serial}/${deviceId}`
}

export function findVolume(doc: HostDisksDoc, volumeId: string): RawVolume | null {
  const key = lower(volumeId)
  if (!key) return null
  return (doc.volumes || []).find((v) => lower(v?.volumeId) === key) || null
}

/** 按「卷挂在哪块磁盘下」反查磁盘（遥测缺 serial/deviceId 时用）。 */
export function findDiskByVolume(doc: HostDisksDoc, volumeId: string): { host: RawHost; disk: RawDisk } | null {
  const key = lower(volumeId)
  if (!key) return null
  for (const host of doc.hosts || []) {
    for (const disk of host.disks || []) {
      const ids = (disk.volumes || []).map((v) => lower(typeof v === 'string' ? v : v?.volumeId))
      if (ids.includes(key)) return { host, disk }
    }
  }
  return null
}

export function findDiskBySerial(doc: HostDisksDoc, serial: string): { host: RawHost; disk: RawDisk } | null {
  const key = lower(serial)
  if (!key) return null
  for (const host of doc.hosts || []) {
    for (const disk of host.disks || []) {
      const ids = [disk.serial, disk.diskId, disk.diskUuid, ...(disk.aliasIds || [])].map(lower).filter(Boolean)
      if (ids.includes(key)) return { host, disk }
    }
  }
  return null
}

/**
 * 给「没有任何磁盘信息」的 openlist 卷按卷 ID 推断磁盘 SN，并把能对上真实磁盘的卷挂到该盘下。
 * 纯函数、不写文档：同一份文档在任何端都算出相同结果。
 */
export function applyDerivedSerials(doc: HostDisksDoc): HostDisksDoc {
  if (!doc || !Array.isArray(doc.volumes) || !Array.isArray(doc.hosts)) return doc
  const serials = new Map<string, string>()
  const moves: Array<{ volumeId: string; hostKey: string; diskSerial: string }> = []
  for (const v of doc.volumes) {
    const id = text(v?.volumeId)
    if (!id) continue
    const tel = v.telemetry || {}
    // 已有磁盘信息的就不猜：遥测带 SN、手工填过、或已挂在某块盘下
    if (text(tel.serial) || text(v.manualSerial) || findDiskByVolume(doc, id)) continue
    const serial = deriveSerialFromVolumeId(id)
    if (!serial) continue
    serials.set(lower(id), serial)
    const hit = findDiskBySerial(doc, serial)
    if (hit) moves.push({ volumeId: id, hostKey: hostKeyOf(hit.host), diskSerial: text(hit.disk.serial) })
  }
  if (!serials.size) return doc

  const hosts = (doc.hosts || []).map((host) => {
    const key = hostKeyOf(host)
    const disks = (host.disks || []).map((disk) => {
      const adds = moves
        .filter((m) => m.hostKey === key && lower(m.diskSerial) === lower(disk.serial))
        .map((m) => m.volumeId)
      if (!adds.length) return disk
      const current = (disk.volumes || []).map((x) => lower(typeof x === 'string' ? x : x?.volumeId))
      const fresh = adds.filter((id) => !current.includes(lower(id)))
      return fresh.length ? { ...disk, volumes: [...(disk.volumes || []), ...fresh] } : disk
    })
    return { ...host, disks }
  })

  const volumes = doc.volumes.map((v) => {
    const serial = serials.get(lower(v.volumeId))
    return serial ? { ...v, derivedSerial: serial } : v
  })

  return { ...doc, hosts, volumes }
}

/** 分区归组：遥测里的 logicalDisks 是入口，关联卷按盘符落桶。 */
export function partitionBuckets(
  doc: HostDisksDoc,
  disk: RawDisk,
  makeVolume: (volumeId: string, fallback?: { deviceId?: string }) => VolumeNode | null,
): { partitions: Array<{ key: string; deviceId: string; logical?: RawLogicalDisk; volumes: VolumeNode[] }>; loose: VolumeNode[] } {
  const buckets = new Map<string, { key: string; deviceId: string; logical?: RawLogicalDisk; volumes: VolumeNode[] }>()
  const ensure = (deviceId: unknown) => {
    const key = driveKeyOf(deviceId) || lower(deviceId)
    if (!key) return null
    if (!buckets.has(key)) {
      buckets.set(key, { key, deviceId: partitionDisplayName(deviceId), volumes: [] })
    }
    return buckets.get(key)!
  }
  for (const logical of disk.logicalDisks || []) {
    const bucket = ensure(logical?.deviceId)
    if (bucket && !bucket.logical) bucket.logical = logical
  }
  const loose: VolumeNode[] = []
  const records = (disk.volumes || []).map((item) => {
    const id = text(typeof item === 'string' ? item : item?.volumeId)
    const found = findVolume(doc, id)
    return makeVolume(id, { deviceId: text(found?.telemetry?.deviceId) || text(found?.drive) })
  })
  for (const rec of records) {
    if (!rec) continue
    const key = driveKeyOf(rec.drive) || driveKeyOf(findVolume(doc, rec.volumeId)?.telemetry?.deviceId)
    const bucket = key ? buckets.get(key) : null
    if (bucket) bucket.volumes.push(rec)
    else loose.push(rec)
  }
  const partitions = [...buckets.values()].sort((a, b) => a.deviceId.localeCompare(b.deviceId, undefined, { numeric: true }))
  for (const p of partitions) p.volumes.sort((a, b) => a.volumeId.localeCompare(b.volumeId, undefined, { numeric: true }))
  loose.sort((a, b) => a.volumeId.localeCompare(b.volumeId, undefined, { numeric: true }))
  return { partitions, loose }
}

/** 清单侧索引：volumeId → 盘符节点（含目录树），并留「主机::盘符」「盘符名」两份兜底索引。 */
interface ManifestIndex {
  byVolumeId: Map<string, FolderNodeView>
  byHostDrive: Map<string, FolderNodeView>
  /** 盘符名 → 节点（仅用于 /WD-xxx/1 这类可唯一定位的路径式盘符） */
  byDriveName: Map<string, FolderNodeView>
  hostOfVolume: Map<string, string>
}

export function indexManifests(manifests: ManifestView[]): ManifestIndex {
  const byVolumeId = new Map<string, FolderNodeView>()
  const byHostDrive = new Map<string, FolderNodeView>()
  const byDriveName = new Map<string, FolderNodeView>()
  const hostOfVolume = new Map<string, string>()
  for (const m of manifests) {
    for (const child of m.root.children) {
      if (child.type !== 'folder') continue
      const vid = text(child.volumeId)
      if (vid && !byVolumeId.has(lower(vid))) {
        byVolumeId.set(lower(vid), child)
        hostOfVolume.set(lower(vid), m.source)
      }
      const key = `${lower(m.source)}::${lower(child.name)}`
      if (!byHostDrive.has(key)) byHostDrive.set(key, child)
      const nameKey = lower(child.name)
      if (!byDriveName.has(nameKey)) byDriveName.set(nameKey, child)
    }
  }
  return { byVolumeId, byHostDrive, byDriveName, hostOfVolume }
}

/**
 * 组装磁盘视图模型。manifests 为目录视图已读到的清单（仅用于挂卷内目录树）。
 */
export function buildDiskTree(doc: HostDisksDoc | null, manifests: ManifestView[]): DiskTreeResult {
  const empty: DiskTreeResult = {
    hosts: [],
    emptyHosts: [],
    orphanVolumes: [],
    unregistered: [],
    generatedAt: null,
    stats: { hosts: 0, disks: 0, volumes: 0 },
    inferredVolumes: 0,
  }
  if (!doc || !Array.isArray(doc.hosts)) return empty

  const withDerived = applyDerivedSerials(doc)
  const index = indexManifests(manifests)
  const volumeAliases = withDerived.volumeAliases || {}
  const partitionAliases = withDerived.partitionAliases || {}
  const consumed = new Set<string>()
  let inferredVolumes = 0

  const makeVolume = (
    volumeId: string,
    fallbackHost?: string,
    driveHint?: string,
  ): VolumeNode | null => {
    const id = text(volumeId)
    if (!id) return null
    const rec = findVolume(withDerived, id)
    const key = lower(id)
    const drive = text(rec?.drive) || text(driveHint)
    // 关联目录树：先按 volumeId（最准）；老清单里盘符节点的 .dir-struct-id 可能和
    // 文档里的卷 ID 不一致（如 openlist-WD-xxx-1 对 /WD-xxx/1），再用「主机::盘符」和
    // 路径式盘符名兜底，避免明明扫过却显示「没有目录结构」。
    const hostHint = text(rec?.sourceHost) || text(rec?.telemetry?.hostname) || fallbackHost
    const pathLikeDrive = /[/\\]/.test(drive) || !/^\s*[A-Za-z]:?\s*$/.test(drive)
    const tree =
      index.byVolumeId.get(key) ||
      (hostHint ? index.byHostDrive.get(`${lower(hostHint)}::${lower(drive)}`) : undefined) ||
      (pathLikeDrive ? index.byDriveName.get(lower(drive)) : undefined)
    if (tree) {
      consumed.add(key)
      const treeVid = text(tree.volumeId)
      if (treeVid) consumed.add(lower(treeVid))
    }
    const telSerial = text(rec?.telemetry?.serial)
    const manual = text(rec?.manualSerial)
    const derived = text(rec?.derivedSerial) || deriveSerialFromVolumeId(id)
    if (derived && !telSerial && !manual && !findDiskByVolume(withDerived, id)) inferredVolumes += 1
    const serial = telSerial || manual || derived
    const serialSource: SerialSource = telSerial ? 'telemetry' : manual ? 'manual' : derived ? 'derived' : 'none'
    const matchBy = text(rec?.matchBy)
    // 统计数字以文档为准；文档是 0/缺失但清单里有统计时退回清单（否则会出现「0 文件」却挂着大目录树）
    const docFileCount = typeof rec?.fileCount === 'number' ? rec.fileCount : undefined
    const docTotalSize = typeof rec?.totalSize === 'number' ? rec.totalSize : undefined
    const fileCount = docFileCount && docFileCount > 0 ? docFileCount : (tree?.fileCount ?? docFileCount)
    const totalSize = docTotalSize && docTotalSize > 0 ? docTotalSize : (tree?.totalSize ?? docTotalSize)
    return {
      volumeId: id,
      drive,
      alias: text(volumeAliases[id]) || text(volumeAliases[key]) || '',
      matchLabel: matchBy ? matchLabel(matchBy) : '',
      serial,
      serialSource,
      fileCount,
      totalSize,
      tree,
      shardBases: tree?.shardBases,
    }
  }

  const allHosts: HostNode[] = (withDerived.hosts || []).map((host) => {
    const hostKey = hostKeyOf(host)
    const name = text(host.hostname) || text(host.deviceName) || hostKey || '（未命名主机）'
    const disks: DiskNode[] = (host.disks || []).map((disk) => {
      const { partitions, loose } = partitionBuckets(withDerived, disk, (id) => makeVolume(id, name))
      const aliasOf = (deviceId: string) =>
        text(partitionAliases[partitionAliasKey(hostKey, text(disk.serial), deviceId)])
      return {
        serial: text(disk.serial) || text(disk.diskId) || '（未知 SN）',
        model: text(disk.model),
        capacity: text(disk.capacity),
        health: text(disk.health),
        temperature: typeof disk.temperature === 'number' ? disk.temperature : null,
        hasSmart: disk.hasSmart === true,
        mediaType: text(disk.mediaType),
        partitions: partitions.map((p) => ({
          deviceId: p.deviceId,
          alias: aliasOf(p.deviceId),
          logical: p.logical,
          volumes: p.volumes,
        })),
        looseVolumes: loose,
      }
    })
    disks.sort((a, b) => a.serial.localeCompare(b.serial, undefined, { numeric: true }))
    const unassigned = (host.unassigned || [])
      .map((id) => makeVolume(id, name))
      .filter((v): v is VolumeNode => !!v)
      .sort((a, b) => a.volumeId.localeCompare(b.volumeId, undefined, { numeric: true }))
    return { hostId: hostKey, name, deviceName: text(host.deviceName), local: host.local === true, disks, unassigned }
  })
  allHosts.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  // 文档里那些只登记了主机名、没有任何磁盘/卷信息的（多为手机/旁路由），
  // 单独汇总，避免整页十来张空卡片。
  const hosts = allHosts.filter((h) => h.disks.length > 0 || h.unassigned.length > 0)
  const emptyHosts = allHosts.filter((h) => h.disks.length === 0 && h.unassigned.length === 0)

  const orphanVolumes = (withDerived.orphans || [])
    .map((id) => makeVolume(id))
    .filter((v): v is VolumeNode => !!v)
    .sort((a, b) => a.volumeId.localeCompare(b.volumeId, undefined, { numeric: true }))

  // 清单里有、磁盘文档里没有的卷：按清单主机分组，保证不丢数据
  const unregisteredMap = new Map<string, VolumeNode[]>()
  for (const m of manifests) {
    for (const child of m.root.children) {
      if (child.type !== 'folder') continue
      const vid = text(child.volumeId)
      if (vid && consumed.has(lower(vid))) continue
      if (vid && findVolume(withDerived, vid)) continue
      const node: VolumeNode = {
        volumeId: vid || `${m.source}::${child.name}`,
        drive: text(child.name),
        alias: vid ? text(volumeAliases[vid]) : '',
        matchLabel: '清单里没有对应磁盘记录',
        serial: volumeSerialFor(child),
        serialSource: 'derived',
        fileCount: child.fileCount,
        totalSize: child.totalSize,
        tree: child,
        shardBases: child.shardBases,
      }
      const list = unregisteredMap.get(m.source) || []
      list.push(node)
      unregisteredMap.set(m.source, list)
    }
  }
  const unregistered: UnlistedGroup[] = [...unregisteredMap.entries()]
    .map(([host, volumes]) => ({
      host,
      volumes: volumes.sort((a, b) => a.volumeId.localeCompare(b.volumeId, undefined, { numeric: true })),
    }))
    .sort((a, b) => a.host.localeCompare(b.host))

  const diskCount = hosts.reduce((n, h) => n + h.disks.length, 0)
  const volumeCount =
    hosts.reduce(
      (n, h) =>
        n +
        h.disks.reduce(
          (d, disk) =>
            d + disk.partitions.reduce((p, part) => p + part.volumes.length, 0) + disk.looseVolumes.length,
          h.unassigned.length,
        ),
      0,
    ) + orphanVolumes.length

  return {
    hosts,
    emptyHosts,
    orphanVolumes,
    unregistered,
    generatedAt: text(withDerived.generatedAt) || null,
    stats: { hosts: hosts.length, disks: diskCount, volumes: volumeCount },
    inferredVolumes,
  }
}

/** 清单里的卷拿不到文档 SN 时，按卷 ID 规则现算（只用于展示）。 */
function volumeSerialFor(node: FolderNodeView): string {
  return deriveSerialFromVolumeId(node.volumeId) || ''
}
