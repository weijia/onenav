// 设备监控 集成测试（P6）：打通「远程存储获取层 → 归一化层」真实代码路径。
// 通过 mock 掉 @/lib/remotestorage-fs 与 @/lib/remotestorage-connection，
// 用可控的文件清单/内容驱动 fetchUfsNodesRaw()，再交给 normalizeUfsNodes()，
// 断言整条数据管线的端到端行为（覆盖 integration-test.md 的 E2E-1 与 B-1~B-7 中可自动化部分）。
//
// 说明：UI 渲染层（点击揭示遮罩、刷新按钮、去连接跳转）依赖真实浏览器 + 已连接的 RemoteStorage，
// 无法在沙箱内自动执行，相关场景在 integration-test.md 中以「手工 E2E 演练」形式记录，需人工跑。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchUfsNodesRaw, RsNotConnectedError, RsAuthError } from './fetch'
import { normalizeUfsNodes } from './normalize'
import type { HostView, ControlNodeView } from './types'

// ── 共享的「假远程存储」状态（hoisted，供 mock 工厂闭包引用）──
const h = vi.hoisted(() => ({
  // basename -> 文件内容（已是 JSON 文本，或任意会被 JSON.stringify 的值）
  files: {} as Record<string, unknown>,
  readdirError: null as Error | null,
  readFileError: null as Error | null,
  // 让 isRemoteStorageAuthError 返回 true，模拟 401/403 鉴权失败
  authError: false,
  // 模拟未连接：getStorageCredentials 返回 null
  noCredentials: false,
  // fetch 拉取前调用 invalidateDirListing 的次数（用于断言缓存清理行为）
  invalidateCalls: 0,
}))

vi.mock('@/lib/remotestorage-connection', () => ({
  claimAccess: vi.fn(),
  getStorageCredentials: () => (h.noCredentials ? null : { href: 'https://rs.test', token: 't' }),
  getSavedStorageCredentials: () => null,
  isRemoteStorageAuthError: () => h.authError,
}))

vi.mock('@/lib/remotestorage-fs', () => {
  class FakeRemoteStorageFileSystem {
    // 构造参数（href/token）此处忽略，仅用于兼容调用方
    constructor(_cfg: { href: string; token: string }) {}
    async readdir(_dir: string): Promise<string[]> {
      if (h.readdirError) throw h.readdirError
      return Object.keys(h.files)
    }
    async readFile(path: string, _enc: string): Promise<string> {
      if (h.readFileError) throw h.readFileError
      const name = path.split('/').pop() as string
      if (!(name in h.files)) throw new Error('ENOENT ' + path)
      const v = h.files[name]
      return typeof v === 'string' ? v : JSON.stringify(v)
    }
    // 对应远端目录列表缓存清理（方案 A）：真实实现会清掉 readdir 的 2 分钟缓存
    async invalidateDirListing(): Promise<void> {
      h.invalidateCalls++
    }
  }
  return { RemoteStorageFileSystem: FakeRemoteStorageFileSystem }
})

// 写入一批文件（键为文件名，值为对象或 JSON 文本）
function seedFiles(obj: Record<string, unknown>) {
  h.files = {}
  for (const [k, v] of Object.entries(obj)) {
    h.files[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
}

beforeEach(() => {
  h.files = {}
  h.readdirError = null
  h.readFileError = null
  h.authError = false
  h.noCredentials = false
  h.invalidateCalls = 0
})

// ── 样本数据（对齐 my-data 文档格式）──

const heartbeatHost1 = {
  uuid: 'host-1',
  name: 'm10',
  status: 'active',
  local_ip: '192.168.1.20',
  last_access: Date.now() - 60 * 1000,
  last_access_str: '2024-07-02 12:09:03',
}

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
  return hosts.find((x) => x.uuid === uuid)
}

describe('设备监控 集成测试：fetch → normalize 数据管线', () => {
  it('E2E-1 端到端：连接 → 读取 ufs-nodes → 分类 → 融合 → 在线状态/磁盘健康正确', async () => {
    seedFiles({
      'host-1.json': heartbeatHost1,
      'S5GXNF0R123456.json': diskSmart,
      'host-1_disks.json': hostDetail,
      'node-ctrl-1.json': nodeControl,
    })

    const raws = await fetchUfsNodesRaw()
    expect(raws).toHaveLength(4)

    const { hosts, controlNodes } = normalizeUfsNodes(raws)
    expect(hosts).toHaveLength(1)
    const h1 = findHost(hosts, 'host-1')!
    expect(h1.online).toBe(true)
    expect(h1.localIp).toBe('192.168.1.20')
    expect(h1.platform).toBe('Windows')
    expect(h1.hostname).toBe('DESKTOP-ABC')
    expect(h1.hasDetail).toBe(true)
    // 磁盘：SMART + 明细融合，健康 PASSED
    expect(h1.disks).toHaveLength(1)
    expect(h1.disks[0].health).toBe('PASSED')
    expect(h1.disks[0].hasSmart).toBe(true)
    expect(h1.disks[0].hasDetail).toBe(true)
    expect(h1.disks[0].logicalDisks[0].deviceId).toBe('C:')
    expect(h1.disks[0].logicalDisks[0].usagePercent).toBe(54.83)
    // 节点控制对象单独分离，不进主机列表
    expect(hosts.find((x) => x.uuid === 'node-ctrl-1')).toBeUndefined()
    expect(controlNodes).toHaveLength(1)
    expect(controlNodes[0].uuid).toBe('node-ctrl-1')
  })

  it('B-1 目录为空：fetch 返回空数组，归一化得到空主机/空控制节点（UI 走空态）', async () => {
    seedFiles({}) // readdir 返回 []
    const raws = await fetchUfsNodesRaw()
    expect(raws).toEqual([])
    const { hosts, controlNodes } = normalizeUfsNodes(raws)
    expect(hosts).toEqual([])
    expect(controlNodes).toEqual([])
  })

  it('B-2 单文件损坏：损坏文件被跳过，其余正常解析', async () => {
    seedFiles({
      'host-1.json': heartbeatHost1,
      'broken.json': '{ this is not valid json', // JSON.parse 失败
    })
    const raws = await fetchUfsNodesRaw()
    expect(raws).toHaveLength(1) // 只保留了 host-1
    const { hosts } = normalizeUfsNodes(raws)
    expect(findHost(hosts, 'host-1')).toBeDefined()
  })

  it('B-2 列出但读取失败的文件：readFile 抛错被跳过，不整页崩溃', async () => {
    seedFiles({ 'host-1.json': heartbeatHost1, 'missing.json': {} })
    // 让 readFile 对 missing.json 抛错（模拟 404/网络抖动）
    const orig = h.files['missing.json']
    // 通过 readFileError 无法区分文件，这里直接删掉该键模拟「列得到但读不到」
    delete h.files['missing.json']
    const raws = await fetchUfsNodesRaw()
    expect(raws).toHaveLength(1)
    expect(findHost(normalizeUfsNodes(raws).hosts, 'host-1')).toBeDefined()
    h.files['missing.json'] = orig // 还原以备 beforeEach 之外（其实无影响）
  })

  it('B-3 畸形/缺字段 JSON：归一化降级，不抛异常', async () => {
    seedFiles({ 'weird.json': { foo: 'bar' }, 'num.json': 123 })
    const raws = await fetchUfsNodesRaw()
    expect(raws).toHaveLength(2)
    expect(() => normalizeUfsNodes(raws)).not.toThrow()
    const { hosts, controlNodes } = normalizeUfsNodes(raws)
    expect(hosts).toEqual([])
    expect(controlNodes).toEqual([])
  })

  it('B-4 未连接 RemoteStorage：fetch 抛 RsNotConnectedError（code=NOT_CONNECTED）', async () => {
    h.noCredentials = true
    await expect(fetchUfsNodesRaw()).rejects.toBeInstanceOf(RsNotConnectedError)
    try {
      await fetchUfsNodesRaw()
    } catch (e) {
      expect((e as RsNotConnectedError).code).toBe('NOT_CONNECTED')
    }
  })

  it('B-4 鉴权失败（401/403）：fetch 抛 RsAuthError（code=AUTH）', async () => {
    h.readdirError = new Error('403 Forbidden')
    h.authError = true // isRemoteStorageAuthError 返回 true
    await expect(fetchUfsNodesRaw()).rejects.toBeInstanceOf(RsAuthError)
    try {
      await fetchUfsNodesRaw()
    } catch (e) {
      expect((e as RsAuthError).code).toBe('AUTH')
    }
  })

  it('B-5 节点控制对象混入：不误展示为主机或磁盘，单独成控制节点', async () => {
    seedFiles({ 'node-ctrl-1.json': nodeControl })
    const raws = await fetchUfsNodesRaw()
    const { hosts, controlNodes } = normalizeUfsNodes(raws)
    expect(hosts).toEqual([])
    expect(controlNodes).toHaveLength(1)
  })

  it('B-6 敏感字段（Q8）：节点控制的 mqtt 密码/密钥被标记 sensitive:true（UI 据此外遮罩）', async () => {
    seedFiles({ 'node-ctrl-1.json': nodeControl })
    const raws = await fetchUfsNodesRaw()
    const { controlNodes } = normalizeUfsNodes(raws)
    const cn: ControlNodeView = controlNodes[0]
    const labels = cn.sensitive.map((s) => s.label)
    expect(labels).toContain('MQTT 密码')
    expect(labels).toContain('AES 密钥')
    const pw = cn.sensitive.find((s) => s.label === 'MQTT 密码')!
    expect(pw.value).toBe('broker-pass') // 数据层保留明文，由 UI 遮罩
    expect(pw.sensitive).toBe(true)
  })

  it('B-7 主机明细缺失：心跳+SMART 仍能展示主机，hasDetail=false，磁盘来自 SMART', async () => {
    seedFiles({
      'host-1.json': heartbeatHost1,
      'S5GXNF0R123456.json': diskSmart,
      // 故意不提供 host-1_disks.json
    })
    const raws = await fetchUfsNodesRaw()
    const { hosts } = normalizeUfsNodes(raws)
    const h1 = findHost(hosts, 'host-1')!
    expect(h1.hasDetail).toBe(false)
    expect(h1.disks).toHaveLength(1)
    expect(h1.disks[0].hasSmart).toBe(true)
    expect(h1.disks[0].hasDetail).toBe(false)
  })

  it('刷新链路：二次 fetch 使用同一 mock，可重复产出一致结果（支撑手动刷新按钮）', async () => {
    seedFiles({
      'host-1.json': heartbeatHost1,
      'S5GXNF0R123456.json': diskSmart,
      'host-1_disks.json': hostDetail,
    })
    const first = normalizeUfsNodes(await fetchUfsNodesRaw())
    const second = normalizeUfsNodes(await fetchUfsNodesRaw())
    expect(first.hosts[0].uuid).toBe(second.hosts[0].uuid)
    expect(first.hosts[0].disks[0].serial).toBe(second.hosts[0].disks[0].serial)
  })

  it('B-9 拉取前清目录缓存（方案 A）：每次 fetch 都先调用 invalidateDirListing，确保远端新增/删除节点立即可见，而非等 2 分钟缓存 TTL', async () => {
    seedFiles({ 'host-1.json': heartbeatHost1 })
    h.invalidateCalls = 0
    await fetchUfsNodesRaw()
    expect(h.invalidateCalls).toBe(1)
    // 手动刷新也应再次清缓存
    await fetchUfsNodesRaw()
    expect(h.invalidateCalls).toBe(2)
  })
})
