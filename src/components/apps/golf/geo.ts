/**
 * 高尔夫球场地图 —— 地理计算工具
 *
 * 单位约定：内部一律用【米】计算与存储，仅在展示时按用户选择的单位换算成码。
 * 坐标约定：传入/传出的坐标均为 GCJ-02，与 types.ts 的存储约定一致。
 */

import type { DistanceLine } from './types'

/** 1 码 = 0.9144 米 */
export const YARD_IN_METERS = 0.9144

export type DistanceUnit = 'yard' | 'meter'

const EARTH_RADIUS_M = 6371008.8

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

/** 两点球面距离（Haversine），返回米 */
export function distanceMeters(a: [number, number], b: [number, number]): number {
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const dLat = lat2 - lat1
  const dLng = toRad(b[0] - a[0])
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function metersToYards(m: number): number {
  return m / YARD_IN_METERS
}

export function yardsToMeters(y: number): number {
  return y * YARD_IN_METERS
}

/** 按单位把米格式化成展示文案 */
export function formatDistance(meters: number, unit: DistanceUnit): string {
  const value = unit === 'yard' ? metersToYards(meters) : meters
  const suffix = unit === 'yard' ? '码' : '米'
  if (value < 1000) return `${Math.round(value)} ${suffix}`
  return `${(value / 1000).toFixed(2)} 千${suffix}`
}

/** 线段的距离（米），用于码数线标注 */
export function lineDistanceMeters(line: Pick<DistanceLine, 'from' | 'to'>): number {
  return distanceMeters(line.from, line.to)
}

/** 折线总长度（米），用于多边形周长等 */
export function polylineLengthMeters(path: [number, number][]): number {
  let total = 0
  for (let i = 1; i < path.length; i++) total += distanceMeters(path[i - 1], path[i])
  return total
}

// ───────────────────────────────────────────────────────────
// GCJ-02 ↔ WGS-84 互转
//
// 背景：国内地图（高德/腾讯）使用 GCJ-02（俗称火星坐标），在 WGS-84 基础上加了非线性偏移；
// 国外源（OSM / Google）使用 WGS-84。两者相差约 50~500 米。
// 本项目数据统一存 GCJ-02；当底图 provider 为 wgs84 时，渲染前把坐标转成 WGS-84 再上图，
// 这样去国外球场打球、切到 OSM 底图时标记也不会偏。
//
// 算法为业界通用的公开近似实现（基于克拉索夫斯基椭球参数），
// 正向精度约 1 米内，反向采用一次近似反解，精度同样在米级，满足球场标注需求。
// ───────────────────────────────────────────────────────────

const PI = Math.PI
const KRASOVSKY_A = 6378245.0 // 长半轴
const KRASOVSKY_EE = 0.00669342162296594323 // 偏心率平方

/** 粗略判断是否在中国境内（境外不做偏移） */
function outOfChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLat(x: number, y: number): number {
  let ret =
    -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0
  return ret
}

function transformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0
  return ret
}

/** 计算该纬度上的经纬度偏移量（度） */
function delta(lng: number, lat: number): [number, number] {
  let dLat = transformLat(lng - 105.0, lat - 35.0)
  let dLng = transformLng(lng - 105.0, lat - 35.0)
  const radLat = toRad(lat)
  let magic = Math.sin(radLat)
  magic = 1 - KRASOVSKY_EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180.0) / (((KRASOVSKY_A * (1 - KRASOVSKY_EE)) / (magic * sqrtMagic)) * PI)
  dLng = (dLng * 180.0) / ((KRASOVSKY_A / sqrtMagic) * Math.cos(radLat) * PI)
  return [dLng, dLat]
}

/** WGS-84 → GCJ-02 */
export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat]
  const [dLng, dLat] = delta(lng, lat)
  return [lng + dLng, lat + dLat]
}

/**
 * GCJ-02 → WGS-84（一次近似反解）。
 * 迭代两次可进一步提升精度，但对球场标注（米级）而言一次已足够，故取简单实现。
 */
export function gcj02ToWgs84(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat]
  const [dLng, dLat] = delta(lng, lat)
  return [lng - dLng, lat - dLat]
}

/** 按底图坐标系把存储的 GCJ-02 坐标转换成该底图可用坐标 */
export function toDisplayCoord(
  lng: number,
  lat: number,
  crs: 'gcj02' | 'wgs84',
): [number, number] {
  return crs === 'wgs84' ? gcj02ToWgs84(lng, lat) : [lng, lat]
}

// ───────────────────────────────────────────────────────────
// 瓦片坐标（供「预缓存当前视野」使用）
// ───────────────────────────────────────────────────────────

/** 经纬度 → 瓦片编号（Web Mercator / XYZ 方案） */
export function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = Math.pow(2, z)
  const x = Math.floor(((lng + 180) / 360) * n)
  const latRad = toRad(lat)
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  )
  return { x, y }
}

/** 根据视野边界与缩放级别，枚举需要下载的瓦片编号 */
export function tilesInBounds(
  bounds: { south: number; west: number; north: number; east: number },
  z: number,
): { x: number; y: number; z: number }[] {
  const max = Math.pow(2, z) - 1
  const clamp = (v: number) => Math.max(0, Math.min(max, v))
  const sw = lngLatToTile(bounds.west, bounds.south, z)
  const ne = lngLatToTile(bounds.east, bounds.north, z)
  const x0 = clamp(Math.min(sw.x, ne.x))
  const x1 = clamp(Math.max(sw.x, ne.x))
  const y0 = clamp(Math.min(sw.y, ne.y))
  const y1 = clamp(Math.max(sw.y, ne.y))
  const out: { x: number; y: number; z: number }[] = []
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) out.push({ x, y, z })
  }
  return out
}
