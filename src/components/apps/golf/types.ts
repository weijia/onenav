/**
 * 高尔夫球场地图 —— 数据模型与类型注册表
 *
 * 【坐标系约定】
 *   所有持久化存储的坐标一律为【GCJ-02】（火星坐标系），与高德底图一致。
 *   当底图切换到国外源（OSM 等 WGS-84）时，仅在"渲染前"用 geo.ts 的 gcj02ToWgs84 转换，
 *   存储层始终保持 GCJ-02，避免同一份数据出现两种坐标系的二义性。
 *
 * 【可扩展性】
 *   设施类型、区域类型、底图源均采用"注册表"模式（与记账应用的 PRICE_TYPES 同思路）：
 *   新增一种类型 = 联合类型加一项 + 注册表加一条，列表/图层开关/图标渲染自动适配。
 */

// ───────────────────────────────────────────────────────────
// 基础工具
// ───────────────────────────────────────────────────────────

/** 生成局部唯一 id（前缀 + 时间 + 随机，够用即可，不需要 uuid 依赖） */
export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

// ───────────────────────────────────────────────────────────
// 球洞
// ───────────────────────────────────────────────────────────

export interface Hole {
  /** 洞号，1..N（通常 1-18，也支持 9 洞 / 27 洞） */
  number: number
  /** 标准杆 Par 3 / 4 / 5 */
  par: 3 | 4 | 5
  /** 差点指数 Stroke Index，1..18 */
  strokeIndex: number
  note?: string
}

// ───────────────────────────────────────────────────────────
// 设施标记点
// ───────────────────────────────────────────────────────────

export type FacilityType =
  | 'tee' // Tee 台（按分级不同颜色）
  | 'green' // 果岭
  | 'bunker' // 沙坑
  | 'fairway' // 球道指示点
  | 'rest' // 休息区
  | 'restroom' // 洗手间
  | 'cartpath' // 电瓶车道
  | 'water' // 水障碍（点标记）
  | 'distance' // 码数桩

/** Tee 台分级，由难到易：黑 → 金 → 蓝 → 白 → 红 */
export type TeeLevel = 'black' | 'gold' | 'blue' | 'white' | 'red'

export interface FacilityPoint {
  id: string
  /** 所属洞号；不填表示不属于具体某洞（例如全场共用的洗手间） */
  hole?: number
  type: FacilityType
  /**
   * 子类型：
   *  - tee      → TeeLevel（black/gold/blue/white/red）
   *  - bunker   → 'fairway' | 'green'（球道沙坑 / 果岭沙坑）
   *  - distance → 存码数值字符串，如 '150'
   */
  subtype?: string
  name?: string
  note?: string
  /** GCJ-02 经度 */
  lng: number
  /** GCJ-02 纬度 */
  lat: number
}

// ───────────────────────────────────────────────────────────
// 区域（多边形 / 圆形）
// ───────────────────────────────────────────────────────────

export type AreaType =
  | 'water' // 水域
  | 'bunker' // 沙坑群
  | 'rough' // 长草区
  | 'ob' // 界外
  | 'woods' // 树林
  | 'closed' // 禁区 / 施工区

export interface AreaShape {
  id: string
  hole?: number
  type: AreaType
  name?: string
  note?: string
  kind: 'polygon' | 'circle'
  /** 多边形顶点（GCJ-02，[lng, lat]） */
  path?: [number, number][]
  /** 圆形中心（GCJ-02） */
  center?: [number, number]
  /** 圆形半径（米） */
  radius?: number
}

// ───────────────────────────────────────────────────────────
// 码数线 / 测距线
// ───────────────────────────────────────────────────────────

export interface DistanceLine {
  id: string
  hole?: number
  /** 文字标注，如 "150 yds" */
  label?: string
  from: [number, number]
  to: [number, number]
}

// ───────────────────────────────────────────────────────────
// 图层偏好（存 localStorage，不入库同步，避免多端互相覆盖）
// ───────────────────────────────────────────────────────────

export interface LayerPrefs {
  /** 设施类型 → 是否显示 */
  facilityTypes: Record<string, boolean>
  /** 洞号 → 是否显示 */
  holes: Record<string, boolean>
  /** 区域类型 → 是否显示 */
  areaTypes: Record<string, boolean>
  /** 码数线总开关 */
  showDistanceLines: boolean
  /** 当前底图 provider id */
  basemap: string
}

// ───────────────────────────────────────────────────────────
// 球场数据根（一个球场一份，用 useAppData('golf') 存取）
// ───────────────────────────────────────────────────────────

export interface GolfData {
  courseName: string
  /** 地图中心 [lng, lat]（GCJ-02） */
  center: [number, number]
  zoom: number
  holes: Hole[]
  facilities: FacilityPoint[]
  areas: AreaShape[]
  lines: DistanceLine[]
}

// ───────────────────────────────────────────────────────────
// 设施类型注册表
// ───────────────────────────────────────────────────────────

export interface FacilityTypeMeta {
  label: string
  /** 主色（用于图标底色与列表色块） */
  color: string
  /** 图标内字符（divIcon 内联 SVG 用，做形状+字符区分，非纯色圆点） */
  glyph: string
  /** 可选子类型（分级） */
  subtypes?: { value: string; label: string; color: string }[]
}

/** Tee 台分级颜色：黑 / 金 / 蓝 / 白 / 红 */
const TEE_LEVELS: { value: string; label: string; color: string }[] = [
  { value: 'black', label: '黑 Tee', color: '#111827' },
  { value: 'gold', label: '金 Tee', color: '#d97706' },
  { value: 'blue', label: '蓝 Tee', color: '#2563eb' },
  { value: 'white', label: '白 Tee', color: '#e5e7eb' },
  { value: 'red', label: '红 Tee', color: '#dc2626' },
]

export const FACILITY_TYPES: Record<FacilityType, FacilityTypeMeta> = {
  tee: { label: 'Tee 台', color: '#2563eb', glyph: 'T', subtypes: TEE_LEVELS },
  green: { label: '果岭', color: '#16a34a', glyph: 'G' },
  bunker: {
    label: '沙坑',
    color: '#eab308',
    glyph: 'B',
    subtypes: [
      { value: 'fairway', label: '球道沙坑', color: '#eab308' },
      { value: 'green', label: '果岭沙坑', color: '#f59e0b' },
    ],
  },
  fairway: { label: '球道', color: '#0ea5e9', glyph: 'F' },
  rest: { label: '休息区', color: '#a855f7', glyph: 'R' },
  restroom: { label: '洗手间', color: '#8b5cf6', glyph: 'W' },
  cartpath: { label: '电瓶车道', color: '#6b7280', glyph: 'P' },
  water: { label: '水障碍', color: '#1e3a8a', glyph: 'H' },
  distance: { label: '码数桩', color: '#f97316', glyph: 'Y' },
}

export const FACILITY_TYPE_KEYS = Object.keys(FACILITY_TYPES) as FacilityType[]

/** 取某个设施点的实际显示色：tee 按分级、bunker 按子类，其余用类型主色 */
export function facilityColor(f: FacilityPoint): string {
  const meta = FACILITY_TYPES[f.type]
  if (meta.subtypes && f.subtype) {
    return meta.subtypes.find((s) => s.value === f.subtype)?.color ?? meta.color
  }
  return meta.color
}

/** 设施点的可读标题：优先自定义名称，否则用类型(+分级)名 */
export function facilityTitle(f: FacilityPoint): string {
  if (f.name) return f.name
  const meta = FACILITY_TYPES[f.type]
  if (meta.subtypes && f.subtype) {
    const sub = meta.subtypes.find((s) => s.value === f.subtype)
    return sub ? sub.label : meta.label
  }
  if (f.type === 'distance') return `码数桩 ${f.subtype ?? ''}`.trim()
  return meta.label
}

// ───────────────────────────────────────────────────────────
// 区域类型注册表
// ───────────────────────────────────────────────────────────

export interface AreaTypeMeta {
  label: string
  /** 边框色 */
  color: string
  /** 填充色 */
  fillColor: string
  /** 填充不透明度 */
  fillOpacity: number
  /** 虚线样式（OB 用虚线边框） */
  dashArray?: string
}

export const AREA_TYPES: Record<AreaType, AreaTypeMeta> = {
  water: { label: '水域', color: '#1d4ed8', fillColor: '#3b82f6', fillOpacity: 0.35 },
  bunker: { label: '沙坑群', color: '#ca8a04', fillColor: '#facc15', fillOpacity: 0.45 },
  rough: { label: '长草区', color: '#4d7c0f', fillColor: '#84cc16', fillOpacity: 0.28 },
  ob: { label: '界外 OB', color: '#dc2626', fillColor: '#ef4444', fillOpacity: 0.06, dashArray: '6 6' },
  woods: { label: '树林', color: '#14532d', fillColor: '#166534', fillOpacity: 0.35 },
  closed: { label: '禁区/施工', color: '#6b7280', fillColor: '#9ca3af', fillOpacity: 0.35, dashArray: '4 4' },
}

export const AREA_TYPE_KEYS = Object.keys(AREA_TYPES) as AreaType[]

// ───────────────────────────────────────────────────────────
// 底图 provider 注册表
// ───────────────────────────────────────────────────────────

export interface BasemapProvider {
  id: string
  label: string
  /** 瓦片 URL 模板，支持 {z}/{x}/{y}/{s} */
  url: string
  /** 子域名串（高德为 1234） */
  subdomains: string
  /**
   * 瓦片坐标系：
   *  - 'gcj02'：国内高德，与存储一致，可直接使用
   *  - 'wgs84'：OSM 等国外源，渲染前需把存储的 GCJ-02 转成 WGS-84
   */
  crs: 'gcj02' | 'wgs84'
  maxZoom: number
  attribution: string
}

export const BASEMAP_PROVIDERS: BasemapProvider[] = [
  {
    id: 'amap-vector',
    label: '高德矢量',
    // 高德公开矢量路网瓦片（免 Key，国内加载快）
    url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    subdomains: '1234',
    crs: 'gcj02',
    maxZoom: 18,
    attribution: '© 高德地图',
  },
  {
    id: 'amap-satellite',
    label: '高德卫星影像',
    url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    subdomains: '1234',
    crs: 'gcj02',
    maxZoom: 18,
    attribution: '© 高德地图',
  },
  {
    id: 'amap-terrain',
    label: '高德地形',
    url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=7&x={x}&y={y}&z={z}',
    subdomains: '1234',
    crs: 'gcj02',
    maxZoom: 18,
    attribution: '© 高德地图',
  },
  {
    id: 'osm',
    label: 'OSM（国外球场用）',
    // 国外源：WGS-84，渲染时会自动把 GCJ-02 数据转换过去
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: 'abc',
    crs: 'wgs84',
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors',
  },
]

export function getBasemap(id: string): BasemapProvider {
  return BASEMAP_PROVIDERS.find((p) => p.id === id) ?? BASEMAP_PROVIDERS[0]
}

// ───────────────────────────────────────────────────────────
// 默认数据：18 洞骨架 + 少量示例标记
// ───────────────────────────────────────────────────────────

/** 默认球场中心（上海），缩放 15 —— 需求指定 */
export const DEFAULT_CENTER: [number, number] = [121.18, 31.09]
export const DEFAULT_ZOOM = 15

/** 生成 18 洞骨架：Par 默认 4；SI 采用通行排布（前九奇数 1..17，后九偶数 2..18） */
function buildHoles(count = 18): Hole[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1
    return {
      number: n,
      par: 4,
      strokeIndex: n <= 9 ? 2 * n - 1 : 2 * (n - 9),
    }
  })
}

/** 以中心点为基准做小偏移，生成示例坐标（GCJ-02） */
function offset(lng: number, lat: number, dLng: number, dLat: number): [number, number] {
  return [lng + dLng, lat + dLat]
}

/**
 * 创建默认球场数据：18 洞 + 少量示例标记（1 号洞的黑/白 Tee、果岭、球道沙坑、码数桩，
 * 2 号洞的白 Tee 与果岭，外加一片示例水域），便于验收时直接对照效果。
 */
export function createDefaultGolfData(): GolfData {
  const [lng, lat] = DEFAULT_CENTER
  const holes = buildHoles(18)

  // 1 号洞示例：由南向北，Tee → 球道沙坑 → 码数桩 → 果岭
  const h1TeeBlack = offset(lng, lat, 0, -0.003)
  const h1TeeWhite = offset(lng, lat, 0.0004, -0.0022)
  const h1Bunker = offset(lng, lat, 0.0006, -0.0012)
  const h1Marker = offset(lng, lat, 0.0002, -0.0006)
  const h1Green = offset(lng, lat, 0.0008, 0.0006)

  // 2 号洞示例
  const h2TeeWhite = offset(lng, lat, 0.004, -0.001)
  const h2Green = offset(lng, lat, 0.0052, 0.0008)

  const facilities: FacilityPoint[] = [
    { id: uid('f'), hole: 1, type: 'tee', subtype: 'black', name: '1 号洞黑 Tee', lng: h1TeeBlack[0], lat: h1TeeBlack[1] },
    { id: uid('f'), hole: 1, type: 'tee', subtype: 'white', name: '1 号洞白 Tee', lng: h1TeeWhite[0], lat: h1TeeWhite[1] },
    { id: uid('f'), hole: 1, type: 'bunker', subtype: 'fairway', name: '1 号洞球道沙坑', lng: h1Bunker[0], lat: h1Bunker[1] },
    { id: uid('f'), hole: 1, type: 'distance', subtype: '150', name: '150 码桩', lng: h1Marker[0], lat: h1Marker[1] },
    { id: uid('f'), hole: 1, type: 'green', name: '1 号洞果岭', lng: h1Green[0], lat: h1Green[1] },
    { id: uid('f'), hole: 2, type: 'tee', subtype: 'white', name: '2 号洞白 Tee', lng: h2TeeWhite[0], lat: h2TeeWhite[1] },
    { id: uid('f'), hole: 2, type: 'green', name: '2 号洞果岭', lng: h2Green[0], lat: h2Green[1] },
  ]

  // 示例水域：1 号洞果岭东侧一小片
  const areas: AreaShape[] = [
    {
      id: uid('a'),
      hole: 1,
      type: 'water',
      name: '示例水塘',
      note: '可删除，仅用于展示区域样式',
      kind: 'polygon',
      path: [
        offset(lng, lat, 0.0018, 0.0002),
        offset(lng, lat, 0.0028, 0.0004),
        offset(lng, lat, 0.0026, 0.0014),
        offset(lng, lat, 0.0016, 0.0012),
      ],
    },
  ]

  return {
    courseName: '我的高尔夫球场',
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    holes,
    facilities,
    areas,
    lines: [],
  }
}
