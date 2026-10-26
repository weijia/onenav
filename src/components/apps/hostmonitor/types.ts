// 设备监控应用的归一化数据类型。
// 数据来源：my-data 文档定义的主机/磁盘遥测，存储于 RemoteStorage 的 ufs-nodes/ 目录。
// 原始文件三类：(a) 主机心跳 {uuid}.json、(a) 磁盘 SMART {serial}.json、(b) 主机明细 {uuid}_disks.json。

/** 任意原始 JSON 文件（字段宽容，运行时再做类型收窄） */
export type RawNodeFile = Record<string, unknown>

// ── 原始结构（仅声明实际用到的字段）──

/** (a) 主机心跳状态：ufs-nodes/{uuid}.json（home_cloud update_my_status 写入） */
export interface HostHeartbeatRaw {
  uuid: string
  name?: string
  status?: string
  local_ip?: string
  last_access: number | string
  last_access_str?: string
  mqtt?: {
    enabled?: boolean
    broker?: string
    topic?: string
    username?: string
    password?: string
    secret?: string
    client_id?: string
  }
}

/** (a) 磁盘 SMART：ufs-nodes/{serial}.json（home_cloud disk_info 写入，type:"disk"） */
export interface DiskSmartRaw {
  type: 'disk'
  uuid?: string
  host_uuid: string
  host_name?: string
  model?: string
  serial: string
  capacity?: string
  interface?: string
  temperature?: number
  health?: string
  name?: string
  firmware?: string
  attributes?: Array<Record<string, unknown>>
}

/** (b) 主机磁盘+分区明细：ufs-nodes/{uuid}_disks.json（home_cloud 运行时产出） */
export interface HostDetailRaw {
  host_info: {
    device_uuid: string
    device_name?: string
    hostname?: string
    platform?: string
    platform_version?: string
    machine?: string
    serial_number?: string
  }
  collection_time?: string
  last_updated?: string
  physical_disks?: Array<Record<string, unknown>>
  logical_disks?: Array<Record<string, unknown>>
  disk_partition_mappings?: Array<Record<string, unknown>>
}

// ── 归一化输出 ──

/** 敏感字段（Q8：密码遮罩 + 点击揭示，不剔除） */
export interface SensitiveField {
  label: string
  value: string
  sensitive: true
}

/** 逻辑盘（来自主机明细 disk_partition_mappings + logical_disks） */
export interface LogicalDiskView {
  deviceId: string
  volumeName: string
  fileSystem: string
  sizeGB: number | null
  freeSpaceGB: number | null
  usedSpaceGB: number | null
  usagePercent: number | null
  driveType: number | null
}

/** 单块磁盘视图：融合 SMART（a）与 明细物理盘/逻辑盘（b） */
export interface DiskView {
  serial: string
  model: string | null
  name: string | null
  capacity: string | null
  interfaceType: string | null
  temperature: number | null
  health: string | null
  firmware: string | null
  /** 来自明细的物理盘信息 */
  deviceId: string | null
  mediaType: string | null
  partitions: number | null
  status: string | null
  /** 该物理盘映射出的逻辑盘 */
  logicalDisks: LogicalDiskView[]
  hasSmart: boolean
  hasDetail: boolean
}

/** 单台主机视图 */
export interface HostView {
  uuid: string
  name: string | null
  online: boolean
  localIp: string | null
  lastAccessMs: number | null
  lastAccessStr: string | null
  platform: string | null
  hostname: string | null
  machine: string | null
  platformVersion: string | null
  serialNumber: string | null
  disks: DiskView[]
  hasDetail: boolean
  /** 来自主机心跳 mqtt 的敏感字段（Q8）；home_cloud 心跳通常不含，此处保留兜底 */
  sensitive: SensitiveField[]
}

/**
 * 控制节点视图（来自 ufs-nodes 中的节点控制对象，含 capabilities/inbox/mqtt）。
 * 按 Q3 不并入主机监控列表，但按 Q8 单独展示其敏感 mqtt 凭证（密码遮罩 + 点击揭示）。
 * 若存在同 device_uuid 的 {uuid}_disks.json 明细，则关联展示其磁盘/分区。
 */
export interface ControlNodeView {
  uuid: string
  name: string | null
  online: boolean
  lastAccessMs: number | null
  lastAccessStr: string | null
  /** 来自 mqtt 的敏感字段（Q8） */
  sensitive: SensitiveField[]
  /** 关联 {uuid}_disks.json 明细得到的磁盘视图（可能为空） */
  disks: DiskView[]
  hasDetail: boolean
}
