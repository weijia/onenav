// 设备监控 normalize 层单元测试（P5）。
// 覆盖：文件分类（Q3）、主机/磁盘/明细融合、30 分钟在线判定（Q6）、
//       节点控制对象单独展示（Q8 敏感字段遮罩）、空输入健壮性。
// 不依赖远程存储，使用样本 JSON 直接验证归一化逻辑。

import { describe, it, expect } from 'vitest'
import { normalizeUfsNodes } from './normalize'
import type { HostView } from './types'

// ── 样本数据（对齐 my-data 文档格式）──

// (a) 主机心跳：home_cloud update_my_status 写入（注意：home_cloud 心跳本身不含 mqtt）
const heartbeat = {
  uuid: 'host-1',
  name: 'm10',
  status: 'active',
  local_ip: '192.168.1.20',
  last_access: Date.now() - 60 * 1000, // 1 分钟前 → 在线
  last_access_str: '2024-07-02 12:09:03',
}

// 离线主机（last_access 超过 30 分钟）
const heartbeatOffline = {
  uuid: 'host-2',
  name: 'm11',
  status: 'active',
  local_ip: '192.168.1.21',
  last_access: Date.now() - 40 * 60 * 1000, // 40 分钟前 → 离线
}

// (a) 磁盘 SMART：home_cloud disk_info 写入，type:"disk"
const diskSmart = {
  uuid: 'disk-rec-1',
  host_uuid: 'host-1',
  host_name: 'm10',
  type: 'disk',
  status: 'active',
  last_access: Date.now() - 60 * 1000,
  name: 'm10/\\\\.\\PHYSICALDRIVE0',
  model: 'Samsung SSD 980 PRO 1TB',
  serial: 'S5GXNF0R123456',
  capacity: '931.51 GB',
  interface: 'csmi',
  temperature: 38,
  health: 'PASSED',
  firmware: '1B2QGXA7',
}

// (b) 主机明细：home_cloud 运行时产出 {uuid}_disks.json
const hostDetail = {
  host_info: {
    device_uuid: 'host-1',
    device_name: 'm10',
    hostname: 'DESKTOP-ABC',
    platform: 'Windows',
    platform_version: '10.0.19045',
    machine: 'AMD64',
    serial_number: 'ABC123-XYZ',
  },
  collection_time: '2024-07-02T12:09:03',
  physical_disks: [
    {
      DeviceID: '\\\\.\\PHYSICALDRIVE0',
      Caption: 'Samsung SSD 980 PRO 1TB',
      Model: 'Samsung SSD 980 PRO 1TB',
      SerialNumber: 'S5GXNF0R123456',
      SizeGB: 931.51,
      InterfaceType: 'SCSI',
      MediaType: 'SSD',
      Partitions: 4,
      Status: 'OK',
      FirmwareRevision: '1B2QGXA7',
    },
  ],
  logical_disks: [
    { DeviceID: 'C:', VolumeName: 'System', FileSystem: 'NTFS', SizeGB: 930.5, FreeSpaceGB: 420.3, UsedSpaceGB: 510.2, UsagePercent: 54.83, DriveType: 3 },
  ],
  disk_partition_mappings: [
    {
      PhysicalDisk: '\\\\.\\PHYSICALDRIVE0',
      PhysicalDiskModel: 'Samsung SSD 980 PRO 1TB',
      PhysicalDiskSerial: 'S5GXNF0R123456',
      Partition: 'Disk #0, Partition #1',
      LogicalDisk: 'C:',
      VolumeName: 'System',
    },
  ],
}

// 节点控制对象（含 mqtt 敏感字段）：按 Q3 不并入主机列表，按 Q8 单独展示并遮罩敏感字段
const nodeControl = {
  uuid: 'node-ctrl-1',
  name: '客厅控制板',
  status: 'online',
  last_access: Date.now() - 10 * 1000,
  capabilities: [{ id: 'power', type: 'action', label: '电源控制' }],
  inbox: [],
  mqtt: {
    enabled: true,
    broker: 'tcp://broker.emqx.io:1883',
    topic: 'ufsd/cmd',
    username: 'device-001',
    password: 'broker-pass',
    secret: 'aes-decrypt-key',
    client_id: 'go-daemon-node',
  },
}

function findHost(hosts: HostView[], uuid: string): HostView | undefined {
  return hosts.find((h) => h.uuid === uuid)
}

describe('normalizeUfsNodes', () => {
  it('按 Q3 规则分类并融合主机 / 磁盘 / 明细（节点控制单独分离）', () => {
    const { hosts, controlNodes } = normalizeUfsNodes([heartbeat, diskSmart, hostDetail, nodeControl])
    const h1 = findHost(hosts, 'host-1')
    expect(h1).toBeDefined()
    expect(h1!.name).toBe('m10')
    expect(h1!.online).toBe(true)
    expect(h1!.localIp).toBe('192.168.1.20')
    expect(h1!.platform).toBe('Windows')
    expect(h1!.hostname).toBe('DESKTOP-ABC')
    expect(h1!.lastAccessStr).toBe('2024-07-02 12:09:03')
    // 磁盘：SMART + 明细融合
    expect(h1!.disks).toHaveLength(1)
    const d = h1!.disks[0]
    expect(d.serial).toBe('S5GXNF0R123456')
    expect(d.model).toBe('Samsung SSD 980 PRO 1TB')
    expect(d.capacity).toBe('931.51 GB')
    expect(d.interfaceType).toBe('csmi')
    expect(d.temperature).toBe(38)
    expect(d.health).toBe('PASSED')
    expect(d.hasSmart).toBe(true)
    expect(d.hasDetail).toBe(true)
    // 分区映射
    expect(d.logicalDisks).toHaveLength(1)
    expect(d.logicalDisks[0].deviceId).toBe('C:')
    expect(d.logicalDisks[0].usagePercent).toBe(54.83)
    // 节点控制对象不进入主机列表，单独成 controlNodes
    expect(hosts.find((h) => h.uuid === 'node-ctrl-1')).toBeUndefined()
    expect(controlNodes).toHaveLength(1)
    expect(controlNodes[0].uuid).toBe('node-ctrl-1')
  })

  it('仅心跳无明细时，主机仍展示，磁盘来自 SMART（且仅有磁盘 host_uuid 的主机也被纳入）', () => {
    const { hosts } = normalizeUfsNodes([heartbeatOffline, diskSmart])
    const h1 = findHost(hosts, 'host-1')
    expect(h1).toBeDefined()
    expect(h1!.hasDetail).toBe(false)
    expect(h1!.disks).toHaveLength(1)
    expect(h1!.disks[0].hasDetail).toBe(false)
    expect(hosts.find((h) => h.uuid === 'host-2')).toBeDefined()
  })

  it('明细存在但无 SMART 时，物理盘仍补充展示', () => {
    const { hosts } = normalizeUfsNodes([heartbeat, hostDetail])
    const h1 = findHost(hosts, 'host-1')
    expect(h1!.disks).toHaveLength(1)
    const d = h1!.disks[0]
    expect(d.serial).toBe('S5GXNF0R123456')
    expect(d.hasSmart).toBe(false)
    expect(d.hasDetail).toBe(true)
    expect(d.model).toBeNull()
    expect(d.deviceId).toBe('\\\\.\\PHYSICALDRIVE0')
  })

  it('30 分钟在线判定（Q6）：在线优先排序', () => {
    const { hosts } = normalizeUfsNodes([heartbeatOffline, heartbeat])
    expect(hosts).toHaveLength(2)
    expect(hosts[0].uuid).toBe('host-1')
    expect(hosts[0].online).toBe(true)
    expect(hosts[1].uuid).toBe('host-2')
    expect(hosts[1].online).toBe(false)
  })

  it('节点控制对象（Q8）：敏感 mqtt 字段被标记 sensitive', () => {
    const { controlNodes } = normalizeUfsNodes([nodeControl])
    expect(controlNodes).toHaveLength(1)
    const labels = controlNodes[0].sensitive.map((s) => s.label)
    expect(labels).toContain('MQTT 密码')
    expect(labels).toContain('AES 密钥')
    const pw = controlNodes[0].sensitive.find((s) => s.label === 'MQTT 密码')
    expect(pw!.value).toBe('broker-pass')
    expect(pw!.sensitive).toBe(true)
    // 无 mqtt 的主机不应有敏感字段
    const { hosts } = normalizeUfsNodes([heartbeat])
    expect(hosts[0].sensitive).toHaveLength(0)
  })

  it('空输入 / 畸形输入返回空结果，不崩溃', () => {
    expect(normalizeUfsNodes([]).hosts).toEqual([])
    expect(normalizeUfsNodes([]).controlNodes).toEqual([])
    const { hosts, controlNodes } = normalizeUfsNodes([null, 123, 'str', { foo: 'bar' }])
    expect(hosts).toEqual([])
    expect(controlNodes).toEqual([])
  })
})
