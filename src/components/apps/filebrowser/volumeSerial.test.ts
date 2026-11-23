import { describe, expect, it } from 'vitest'
import { deriveSerialFromVolumeId, volumeSerialInfo } from './volumeSerial'

describe('deriveSerialFromVolumeId', () => {
  it('取 openlist-<中间>-<单个数字> 的中间段', () => {
    expect(deriveSerialFromVolumeId('openlist-93R7SZ7KS-0')).toBe('93R7SZ7KS')
    expect(deriveSerialFromVolumeId('openlist-93R7SZ7KS-5')).toBe('93R7SZ7KS')
    expect(deriveSerialFromVolumeId('openlist-849EC7K9T-9')).toBe('849EC7K9T')
    expect(deriveSerialFromVolumeId('openlist-091031PB42041SH42VMM-6')).toBe('091031PB42041SH42VMM')
  })

  it('末尾多位编号 / 中间带来源名的一律不猜', () => {
    expect(deriveSerialFromVolumeId('openlist-h99-130')).toBe('')
    expect(deriveSerialFromVolumeId('openlist-baidu-130')).toBe('')
    expect(deriveSerialFromVolumeId('openlist-h99-159')).toBe('')
  })

  it('不符合形态的卷 ID / 空值返回空串', () => {
    expect(deriveSerialFromVolumeId('openlist-kuake')).toBe('')
    expect(deriveSerialFromVolumeId('openlist-yike-richard432')).toBe('')
    expect(deriveSerialFromVolumeId('openlist::C')).toBe('')
    expect(deriveSerialFromVolumeId('openlist--0')).toBe('')
    expect(deriveSerialFromVolumeId('A401-6B8F')).toBe('')
    expect(deriveSerialFromVolumeId('')).toBe('')
    expect(deriveSerialFromVolumeId(null)).toBe('')
    expect(deriveSerialFromVolumeId(undefined)).toBe('')
  })

  it('大小写与首尾空格不影响结果', () => {
    expect(deriveSerialFromVolumeId('  OPENLIST-93R7SZ7KS-2 ')).toBe('93R7SZ7KS')
  })
})

describe('volumeSerialInfo', () => {
  it('文件里自带 SN 时优先用真值，不推断', () => {
    expect(volumeSerialInfo('openlist-93R7SZ7KS-1', 'W620SWSM')).toEqual({
      serial: 'W620SWSM',
      source: 'telemetry',
    })
  })

  it('没有磁盘信息时按卷 ID 推断', () => {
    expect(volumeSerialInfo('openlist-93R7SZ7KS-1')).toEqual({
      serial: '93R7SZ7KS',
      source: 'derived',
    })
  })

  it('两条路都没有时为空', () => {
    expect(volumeSerialInfo('A401-6B8F', '')).toEqual({ serial: '', source: 'none' })
  })
})
