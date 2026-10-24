// 解析/归一化层：把 ufs-nodes/ 下的原始 JSON 分类为
// 主机心跳 / 磁盘 SMART / 节点控制(单独展示) / 主机明细，并融合为 HostView[] 与 ControlNodeView[]。
//
// 分类规则（Q3，按「最具体优先」顺序，避免边界误判）：
//   1. type === "disk"                       → 磁盘 SMART
//   2. 含 host_info(含 device_uuid)          → 主机明细（{uuid}_disks.json）
//   3. 含 capabilities / inbox / mqtt 任一    → 节点控制对象（不并入主机监控列表，按 Q8 单独展示）
//   4. 其余                                  → 主机心跳
// 已知边界：节点控制对象若未设 capabilities/inbox/mqtt，会被当作主机心跳展示（Q3 已确认接受此风险）。
// 优化：先用 detail/disk 引用的 uuid 构成 knownHostUuids，心跳文件的 uuid 命中该集合时更可靠地判为主机。

import type {
  ControlNodeView,
  DiskSmartRaw,
  DiskView,
  HostDetailRaw,
  HostHeartbeatRaw,
  HostView,
  LogicalDiskView,
  RawNodeFile,
  SensitiveField,
} from './types'

/** 在线阈值：30 分钟（与 ufs-nodes 文档一致，Q6） */
const ONLINE_THRESHOLD_MS = 30 * 60 * 1000

type FileKind = 'disk' | 'detail' | 'node-control' | 'heartbeat'

function asString(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  return null
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** 毫秒时间戳；兼容秒级时间戳 */
function toMs(v: unknown): number | null {
  const n = asNumber(v)
  if (n == null) return null
  return n < 1e12 ? n * 1000 : n
}

/** 把原始对象数组分类为带 kind 的解析结果 */
function classify(raws: unknown[], knownHostUuids: Set<string>): Array<{ kind: FileKind; raw: RawNodeFile }> {
  const out: Array<{ kind: FileKind; raw: RawNodeFile }> = []
  for (const raw of raws) {
    const o = (raw ?? null) as RawNodeFile | null
    if (!o || typeof o !== 'object') continue
    let kind: FileKind
    if (o['type'] === 'disk') {
      kind = 'disk'
    } else if (o['host_info'] && typeof o['host_info'] === 'object') {
      kind = 'detail'
    } else if ('capabilities' in o || 'inbox' in o || 'mqtt' in o) {
      kind = 'node-control'
    } else {
      // 其余：若 uuid 在已知主机集合中（被 detail/disk 引用），优先判为主机心跳
      const uuid = asString(o['uuid'])
      kind = uuid && knownHostUuids.has(uuid) ? 'heartbeat' : 'heartbeat'
    }
    out.push({ kind, raw: o })
  }
  return out
}

/** 收集被 detail/disk 引用的主机 uuid（用于心跳消歧，以及补全仅有磁盘无心跳的主机） */
function collectKnownHostUuids(raws: unknown[]): Set<string> {
  const set = new Set<string>()
  for (const raw of raws) {
    const o = raw as RawNodeFile | null
    if (!o || typeof o !== 'object') continue
    if (o['type'] === 'disk') {
      const h = asString(o['host_uuid'])
      if (h) set.add(h)
    } else if (o['host_info'] && typeof o['host_info'] === 'object') {
      const du = asString((o['host_info'] as RawNodeFile)['device_uuid'])
      if (du) set.add(du)
    }
  }
  return set
}

function isOnline(lastAccessMs: number | null): boolean {
  return lastAccessMs != null && Date.now() - lastAccessMs <= ONLINE_THRESHOLD_MS
}

function buildSensitiveFields(hb: HostHeartbeatRaw | undefined): SensitiveField[] {
  const mqtt = hb?.mqtt
  if (!mqtt || typeof mqtt !== 'object') return []
  const map: Array<[string, keyof NonNullable<HostHeartbeatRaw['mqtt']>]> = [
    ['MQTT 密码', 'password'],
    ['AES 密钥', 'secret'],
    ['Broker', 'broker'],
    ['Topic', 'topic'],
    ['用户名', 'username'],
    ['ClientID', 'client_id'],
  ]
  const out: SensitiveField[] = []
  for (const [label, key] of map) {
    const v = asString(mqtt[key])
    if (v) out.push({ label, value: v, sensitive: true })
  }
  return out
}

/** 根据物理盘序列号 + 设备 ID，从明细的映射与逻辑盘表构造逻辑盘视图 */
function buildLogicalDisks(
  physicalSerial: string,
  physicalDeviceId: string | null,
  detail: HostDetailRaw | undefined,
): LogicalDiskView[] {
  if (!detail) return []
  const mappings = Array.isArray(detail['disk_partition_mappings'])
    ? (detail['disk_partition_mappings'] as RawNodeFile[])
    : []
  const logicals = Array.isArray(detail['logical_disks']) ? (detail['logical_disks'] as RawNodeFile[]) : []
  const logicalByDevice = new Map<string, RawNodeFile>()
  for (const l of logicals) {
    const dev = asString(l['DeviceID'])
    if (dev) logicalByDevice.set(dev, l)
  }
  const result: LogicalDiskView[] = []
  for (const m of mappings) {
    const ps = asString(m['PhysicalDiskSerial'])
    const pd = asString(m['PhysicalDisk'])
    const matched = ps === physicalSerial || (physicalDeviceId != null && pd === physicalDeviceId)
    if (!matched) continue
    const ld = asString(m['LogicalDisk'])
    if (!ld) continue
    const l = logicalByDevice.get(ld)
    if (!l) continue
    result.push({
      deviceId: ld,
      volumeName: asString(l['VolumeName']) ?? '',
      fileSystem: asString(l['FileSystem']) ?? '',
      sizeGB: asNumber(l['SizeGB']),
      freeSpaceGB: asNumber(l['FreeSpaceGB']),
      usedSpaceGB: asNumber(l['UsedSpaceGB']),
      usagePercent: asNumber(l['UsagePercent']),
      driveType: asNumber(l['DriveType']),
    })
  }
  return result
}

function findPhysicalDisk(serial: string, detail: HostDetailRaw | undefined): RawNodeFile | undefined {
  if (!detail || !Array.isArray(detail['physical_disks'])) return undefined
  return (detail['physical_disks'] as RawNodeFile[]).find((p) => asString(p['SerialNumber']) === serial)
}

function buildDiskView(serial: string, smart: DiskSmartRaw | undefined, detail: HostDetailRaw | undefined): DiskView {
  const pm = findPhysicalDisk(serial, detail)
  const physicalDeviceId = pm ? asString(pm['DeviceID']) : null
  const logicalDisks = buildLogicalDisks(serial, physicalDeviceId, detail)
  return {
    serial,
    model: smart ? asString(smart['model']) : null,
    name: smart ? asString(smart['name']) : null,
    capacity: smart ? asString(smart['capacity']) : null,
    interfaceType: smart ? asString(smart['interface']) : pm ? asString(pm['InterfaceType']) : null,
    temperature: smart ? asNumber(smart['temperature']) : null,
    health: smart ? asString(smart['health']) : null,
    firmware: smart ? asString(smart['firmware']) : null,
    deviceId: physicalDeviceId,
    mediaType: pm ? asString(pm['MediaType']) : null,
    partitions: pm ? asNumber(pm['Partitions']) : null,
    status: pm ? asString(pm['Status']) : null,
    logicalDisks,
    hasSmart: !!smart,
    hasDetail: !!pm,
  }
}

function buildHostView(
  uuid: string,
  hb: HostHeartbeatRaw | undefined,
  detail: HostDetailRaw | undefined,
  disks: Map<string, DiskSmartRaw>,
): HostView {
  const lastAccessMs = hb ? toMs(hb['last_access']) : null
  const online = isOnline(lastAccessMs)

  const info = detail?.['host_info']
  const name = asString(info?.['device_name']) ?? (hb ? asString(hb['name']) : null)

  // SMART 磁盘（host_uuid 命中）
  const smartDisks: DiskSmartRaw[] = []
  for (const d of disks.values()) {
    if (asString(d['host_uuid']) === uuid) smartDisks.push(d)
  }
  const diskViews: DiskView[] = smartDisks.map((d) => buildDiskView(asString(d['serial'])!, d, detail))

  // 明细里有物理盘但无对应 SMART：补充展示
  if (detail && Array.isArray(detail['physical_disks'])) {
    for (const p of detail['physical_disks'] as RawNodeFile[]) {
      const serial = asString(p['SerialNumber'])
      if (!serial || diskViews.some((dv) => dv.serial === serial)) continue
      diskViews.push(buildDiskView(serial, undefined, detail))
    }
  }

  return {
    uuid,
    name,
    online,
    localIp: hb ? asString(hb['local_ip']) : null,
    lastAccessMs,
    lastAccessStr: hb ? asString(hb['last_access_str']) : null,
    platform: asString(info?.['platform']),
    hostname: asString(info?.['hostname']),
    machine: asString(info?.['machine']),
    platformVersion: asString(info?.['platform_version']),
    serialNumber: asString(info?.['serial_number']),
    disks: diskViews,
    hasDetail: !!detail,
    sensitive: buildSensitiveFields(hb),
  }
}

function buildControlNode(raw: RawNodeFile): ControlNodeView {
  const nc = raw as unknown as HostHeartbeatRaw
  const lastAccessMs = toMs(nc['last_access'])
  return {
    uuid: asString(nc['uuid']) ?? '',
    name: asString(nc['name']),
    online: isOnline(lastAccessMs),
    lastAccessMs,
    lastAccessStr: asString(nc['last_access_str']),
    sensitive: buildSensitiveFields(nc),
  }
}

export interface NormalizeResult {
  hosts: HostView[]
  controlNodes: ControlNodeView[]
}

/** 归一化入口：原始 JSON 数组 → 主机监控列表 + 控制节点列表 */
export function normalizeUfsNodes(raws: unknown[]): NormalizeResult {
  const knownHostUuids = collectKnownHostUuids(raws)
  const parsed = classify(raws, knownHostUuids)

  const heartbeats = new Map<string, HostHeartbeatRaw>()
  const disks = new Map<string, DiskSmartRaw>() // key: serial
  const details = new Map<string, HostDetailRaw>() // key: device_uuid
  const controlNodes: ControlNodeView[] = []

  for (const p of parsed) {
    if (p.kind === 'heartbeat') {
      const h = p.raw as unknown as HostHeartbeatRaw
      const uuid = asString(h['uuid'])
      if (uuid) heartbeats.set(uuid, h)
    } else if (p.kind === 'disk') {
      const d = p.raw as unknown as DiskSmartRaw
      const serial = asString(d['serial'])
      if (serial) disks.set(serial, d)
    } else if (p.kind === 'detail') {
      const dt = p.raw as unknown as HostDetailRaw
      const du = asString(dt['host_info']?.['device_uuid'])
      if (du) details.set(du, dt)
    } else if (p.kind === 'node-control') {
      controlNodes.push(buildControlNode(p.raw))
    }
  }

  // 主机集合：心跳 + 明细 + 仅出现在磁盘 host_uuid 中的主机（防御：尚未写入心跳时也能展示）
  const hostUuids = new Set<string>([
    ...heartbeats.keys(),
    ...details.keys(),
    ...[...disks.values()]
      .map((d) => asString(d['host_uuid']))
      .filter((u): u is string => !!u),
  ])

  const hosts: HostView[] = []
  for (const uuid of hostUuids) {
    hosts.push(buildHostView(uuid, heartbeats.get(uuid), details.get(uuid), disks))
  }

  // 在线优先、last_access 倒序
  hosts.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1
    return (b.lastAccessMs ?? 0) - (a.lastAccessMs ?? 0)
  })
  controlNodes.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1
    return (b.lastAccessMs ?? 0) - (a.lastAccessMs ?? 0)
  })

  return { hosts, controlNodes }
}

/** 磁盘信息过滤模式：全部 / 仅含磁盘信息 / 仅无磁盘信息 */
export type DiskInfoFilter = 'all' | 'with-disk' | 'no-disk'

/** 判断主机是否含磁盘信息（存在任意磁盘记录：SMART 或明细中的物理盘） */
export function hostHasDiskInfo(host: HostView): boolean {
  return host.disks.length > 0
}

/** 按是否含磁盘信息过滤主机列表（控制节点不参与过滤） */
export function filterHostsByDiskInfo(hosts: HostView[], mode: DiskInfoFilter): HostView[] {
  if (mode === 'all') return hosts
  const keep = mode === 'with-disk' ? hostHasDiskInfo : (h: HostView) => !hostHasDiskInfo(h)
  return hosts.filter(keep)
}
