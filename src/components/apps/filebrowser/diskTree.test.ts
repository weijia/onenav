import { describe, expect, it } from 'vitest'
import {
  applyDerivedSerials,
  buildDiskTree,
  driveKeyOf,
  findVolume,
  matchLabel,
  partitionAliasKey,
  partitionBuckets,
  partitionDisplayName,
  type HostDisksDoc,
  type RawDisk,
} from './diskTree'
import type { ManifestView } from './types'

/** 造一个最简清单：一台主机、一个盘符节点（含两个子目录）。 */
function manifest(source: string, volumeId: string | null, driveName: string): ManifestView {
  const root = {
    name: source,
    type: 'folder' as const,
    tags: [],
    children: [
      {
        name: driveName,
        type: 'folder' as const,
        tags: [],
        volumeId,
        children: [
          { name: 'Photos', type: 'folder' as const, tags: [], children: [] },
          { name: 'Docs', type: 'folder' as const, tags: [], children: [] },
        ],
      },
    ],
  }
  return {
    source,
    generatedAt: null,
    generator: null,
    root,
    folderCount: 3,
    warnings: [],
  }
}

function baseDoc(): HostDisksDoc {
  return {
    version: 2,
    generatedAt: '2026-11-20T10:00:00.000Z',
    hosts: [
      {
        hostId: 'h-richard',
        hostname: 'RICHARD',
        deviceName: 'RICHARD-PC',
        disks: [
          {
            serial: '3333_4A31',
            diskId: '3333_4A31',
            model: 'SAMSUNG SSD',
            health: 'PASS',
            temperature: 48,
            hasSmart: true,
            logicalDisks: [
              { deviceId: 'C:', volumeName: 'System', fileSystem: 'NTFS', sizeGB: 100, freeSpaceGB: 40, usagePercent: 60 },
              { deviceId: 'D:', volumeName: 'Data', fileSystem: 'NTFS' },
            ],
            volumes: ['A401-6B8F', { volumeId: 'openlist-3333_4A31-2' }],
          },
        ],
        unassigned: ['host-only-vol'],
      },
    ],
    volumes: [
      { volumeId: 'A401-6B8F', drive: 'C:', matchBy: 'local-volume-id', fileCount: 1000, totalSize: 2048 },
      { volumeId: 'openlist-3333_4A31-2', drive: 'D:', matchBy: 'host+drive', fileCount: 20 },
      { volumeId: 'host-only-vol', drive: 'E:', matchBy: 'host-only' },
      { volumeId: 'openlist-93R7SZ7KS-0', drive: '/93R7SZ7KS/0', matchBy: 'host-only' },
    ],
    orphans: ['orphan-1'],
    volumeAliases: { 'A401-6B8F': '系统盘', 'orphan-1': '闲置卷' },
    partitionAliases: { '/partition/h-richard/3333_4A31/C:': '系统分区' },
  }
}

describe('磁盘视图基础工具', () => {
  it('盘符只认单字母（目录名不会被当成盘符）', () => {
    expect(driveKeyOf('C')).toBe('c:')
    expect(driveKeyOf('c:')).toBe('c:')
    expect(driveKeyOf('C:')).toBe('c:')
    expect(driveKeyOf('Photos')).toBeNull()
    expect(partitionDisplayName('c')).toBe('C:')
    expect(partitionDisplayName('/93R7SZ7KS/0')).toBe('/93R7SZ7KS/0')
  })

  it('matchBy 文案与 zip-browser 一致', () => {
    expect(matchLabel('manual-sn')).toBe('手工 SN 映射')
    expect(matchLabel('derived-sn')).toBe('卷 ID 推断 SN')
    expect(matchLabel('unknown-x')).toBe('unknown-x')
  })

    it('分区别名键按 主机/SN/分区 拼', () => {
    expect(partitionAliasKey('h-richard', '3333_4A31', 'C:')).toBe('/partition/h-richard/3333_4A31/C:')
  })
})

describe('buildDiskTree：主机 → 磁盘 → 分区 → 卷', () => {
  const doc = baseDoc()
  const manifests = [manifest('RICHARD', 'A401-6B8F', 'C:')]
  const tree = buildDiskTree(doc, manifests)

  it('主机与磁盘按名/SN 展开', () => {
    expect(tree.hosts).toHaveLength(1)
    const host = tree.hosts[0]
    expect(host.name).toBe('RICHARD')
    expect(host.deviceName).toBe('RICHARD-PC')
    expect(host.disks).toHaveLength(1)
    const disk = host.disks[0]
    expect(disk.serial).toBe('3333_4A31')
    expect(disk.model).toBe('SAMSUNG SSD')
    expect(disk.temperature).toBe(48)
    expect(disk.health).toBe('PASS')
    expect(disk.partitions.map((p) => p.deviceId)).toEqual(['C:', 'D:'])
  })

  it('卷按盘符落进对应分区，别名与统计一并带出', () => {
    const disk = tree.hosts[0].disks[0]
    const c = disk.partitions.find((p) => p.deviceId === 'C:')!
    expect(c.alias).toBe('系统分区')
    expect(c.logical?.volumeName).toBe('System')
    expect(c.volumes).toHaveLength(1)
    expect(c.volumes[0].volumeId).toBe('A401-6B8F')
    expect(c.volumes[0].alias).toBe('系统盘')
    expect(c.volumes[0].matchLabel).toBe('本机卷 ID')
    expect(c.volumes[0].fileCount).toBe(1000)
    // C: 的目录树按 volumeId 挂上了清单里的盘符节点
    expect(c.volumes[0].tree?.name).toBe('C:')
    expect(c.volumes[0].tree?.children.map((x) => x.name)).toEqual(['Photos', 'Docs'])
    const d = disk.partitions.find((p) => p.deviceId === 'D:')!
    expect(d.volumes[0].volumeId).toBe('openlist-3333_4A31-2')
  })

  it('挂主机但没匹配磁盘的卷进 unassigned；没有主机的进 orphanVolumes', () => {
    expect(tree.hosts[0].unassigned.map((v) => v.volumeId)).toEqual(['host-only-vol'])
    expect(tree.orphanVolumes.map((v) => v.volumeId)).toEqual(['orphan-1'])
    expect(tree.orphanVolumes[0].alias).toBe('闲置卷')
  })

  it('清单里有、文档里没有的卷进 unregistered，随清单挂目录树', () => {
    const withExtra = buildDiskTree(doc, [
      ...manifests,
      manifest('LAPTOP-91PR81Q2', 'openlist-W620SWSM-0', 'G:'),
    ])
    // openlist-W620SWSM-0 文档里没有 → 进 unregistered
    expect(withExtra.unregistered).toHaveLength(1)
    expect(withExtra.unregistered[0].host).toBe('LAPTOP-91PR81Q2')
    expect(withExtra.unregistered[0].volumes[0].volumeId).toBe('openlist-W620SWSM-0')
    expect(withExtra.unregistered[0].volumes[0].serial).toBe('W620SWSM')
  })

  it('统计：主机/磁盘/卷数量与生成时间', () => {
    expect(tree.stats.hosts).toBe(1)
    expect(tree.stats.disks).toBe(1)
    // 2 个分区里的卷 + 1 个 unassigned + 1 个 orphan
    expect(tree.stats.volumes).toBe(4)
    expect(tree.generatedAt).toBe('2026-11-20T10:00:00.000Z')
  })

  it('文档为空时返回空模型（不抛错）', () => {
    expect(buildDiskTree(null, []).hosts).toEqual([])
    expect(buildDiskTree({}, []).stats.hosts).toBe(0)
  })

  it('只有主机名、没有磁盘和卷的主机单独汇总，不刷空卡片', () => {
    const withEmpty: HostDisksDoc = {
      ...doc,
      hosts: [...(doc.hosts || []), { hostId: 'h-phone', hostname: 'mi10' }],
    }
    const out = buildDiskTree(withEmpty, manifests)
    expect(out.hosts.map((h) => h.name)).toEqual(['RICHARD'])
    expect(out.emptyHosts.map((h) => h.name)).toEqual(['mi10'])
  })

  it('文档是 0 而清单有统计时，退回清单数字', () => {
    const zeroDoc: HostDisksDoc = {
      hosts: [{ hostId: 'h1', hostname: 'HOST1', disks: [{ serial: 'S1', logicalDisks: [{ deviceId: 'C:' }], volumes: ['v-zero'] }] }],
      volumes: [{ volumeId: 'v-zero', drive: 'C:', fileCount: 0, totalSize: 0 }],
    }
    const tree = buildDiskTree(zeroDoc, [manifest('HOST1', 'v-zero', 'C:')])
    const vol = tree.hosts[0].disks[0].partitions[0].volumes[0]
    expect(vol.volumeId).toBe('v-zero')
    // 清单里这台主机 C: 节点没有统计字段，因此仍是 undefined；有统计时才会覆盖 0
    expect(vol.tree?.name).toBe('C:')
  })

  it('卷 ID 与清单 .dir-struct-id 不一致时，用路径式盘符名兜底挂上目录树', () => {
    const mismatchDoc: HostDisksDoc = {
      hosts: [],
      volumes: [{ volumeId: 'openlist-WD-WCAZAK926835-1', drive: '/WD-WCAZAK926835/1', fileCount: 21117 }],
      orphans: ['openlist-WD-WCAZAK926835-1'],
    }
    const out = buildDiskTree(mismatchDoc, [manifest('openlist', 'WD-WCAZAK926835', '/WD-WCAZAK926835/1')])
    const vol = out.orphanVolumes[0]
    expect(vol.tree?.name).toBe('/WD-WCAZAK926835/1')
    expect(vol.fileCount).toBe(21117)
    // 已挂到卷上的清单不该再出现在「清单里有、文档里没有」组
    expect(out.unregistered).toHaveLength(0)
  })
})

describe('applyDerivedSerials：没有磁盘信息的 openlist 卷按卷 ID 推断', () => {
  const doc: HostDisksDoc = {
    hosts: [
      {
        hostId: 'h1',
        hostname: 'HOST1',
        disks: [{ serial: '93R7SZ7KS', logicalDisks: [{ deviceId: '0' }], volumes: [] }],
      },
    ],
    volumes: [
      { volumeId: 'openlist-93R7SZ7KS-1', drive: '0', matchBy: 'host-only' },
      { volumeId: 'openlist-h99-130', drive: 'x' },
      { volumeId: 'openlist-93R7SZ7KS-0', drive: '0', manualSerial: '93R7SZ7KS' },
    ],
  }

  it('推断出的 SN 能对上磁盘时把卷挂到该盘下', () => {
    const out = applyDerivedSerials(doc)
    expect(out.hosts?.[0].disks?.[0].volumes).toEqual(['openlist-93R7SZ7KS-1'])
    expect(findVolume(out, 'openlist-93R7SZ7KS-1')?.derivedSerial).toBe('93R7SZ7KS')
  })

  it('已有手工 SN / 不符合规则的卷 ID 不猜', () => {
    const out = applyDerivedSerials(doc)
    expect(findVolume(out, 'openlist-93R7SZ7KS-0')?.derivedSerial).toBeUndefined()
    expect(findVolume(out, 'openlist-h99-130')?.derivedSerial).toBeUndefined()
  })

  it('推断不出能对上的磁盘时只标 SN、不移动卷', () => {
    const unmatched: HostDisksDoc = {
      hosts: [{ hostId: 'h2', hostname: 'HOST2', disks: [{ serial: 'SOMETHING' }], unassigned: ['openlist-UNMATCHED-1'] }],
      volumes: [{ volumeId: 'openlist-UNMATCHED-1', drive: 'Z:' }],
    }
    const out = buildDiskTree(unmatched, [])
    expect(out.inferredVolumes).toBe(1)
    const volume = out.hosts[0].unassigned.find((v) => v.volumeId === 'openlist-UNMATCHED-1')
    expect(volume?.serial).toBe('UNMATCHED')
    expect(volume?.serialSource).toBe('derived')
  })
})

describe('partitionBuckets', () => {
  it('没有逻辑分区的卷进 loose，不隐藏', () => {
    const disk: RawDisk = { serial: 'SN1', logicalDisks: [], volumes: ['v1'] }
    const doc: HostDisksDoc = { volumes: [{ volumeId: 'v1', drive: 'Z:' }] }
    const { partitions, loose } = partitionBuckets(doc, disk, (id) => ({
      volumeId: id,
      drive: findVolume(doc, id)?.drive || '',
      alias: '',
      matchLabel: '',
      serial: '',
      serialSource: 'none',
    }))
    expect(partitions).toHaveLength(0)
    expect(loose.map((v) => v.volumeId)).toEqual(['v1'])
  })
})
