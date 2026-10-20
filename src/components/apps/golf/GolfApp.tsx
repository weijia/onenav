/**
 * 高尔夫球场地图 —— 主组件
 *
 * 负责：状态编排、绘制工具、搜索定位、GPS/导航、导入导出、管理模式门禁。
 * 数据层直接复用项目已有的 useAppData('golf')，因此自动获得
 * PouchDB 本地存储 + WebDAV + RemoteStorage 的多端同步，无需为此应用写同步代码。
 *
 * 【坐标约定】所有业务坐标都是 GCJ-02 [lng, lat]。
 * 唯一例外：浏览器 Geolocation 返回的是 WGS-84，因此定位回调里要转成 GCJ-02 再入库/计算。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import { Check, Circle, Menu, Plus, Ruler, Search, Square, X } from 'lucide-react'
import { useAppData } from '@/lib/app-data'
import {
  FACILITY_TYPES,
  AREA_TYPES,
  createDefaultGolfData,
  facilityTitle,
  getBasemap,
  uid,
  type AreaShape,
  type DistanceLine,
  type FacilityPoint,
  type GolfData,
  type LayerPrefs,
} from './types'
import { distanceMeters, formatDistance, wgs84ToGcj02, type DistanceUnit } from './geo'
import MapCanvas, { type DrawMode, type SelectedRef } from './MapCanvas'
import Sidebar, { type ViewMode } from './Sidebar'
import FeatureCard from './FeatureCard'
import { applyImport, parseImportText, precacheTiles, toGeoJSON, type ImportMode } from './io'

/** 管理模式固定口令（用户指定） */
const MANAGE_PASSWORD = '123'

const PREFS_KEY = 'golf.layerPrefs.v1'

function defaultPrefs(holeCount: number): LayerPrefs {
  const holes: Record<string, boolean> = {}
  for (let i = 1; i <= holeCount; i++) holes[String(i)] = true
  return {
    facilityTypes: {},
    holes,
    areaTypes: {},
    showDistanceLines: true,
    basemap: 'amap-vector',
  }
}

export default function GolfApp() {
  const fallback = useMemo(() => createDefaultGolfData(), [])
  const { data, loading, save } = useAppData<GolfData>('golf', fallback)

  // ── 视图状态 ───────────────────────────────────────────
  const [manageMode, setManageMode] = useState(false)
  const [pwdOpen, setPwdOpen] = useState(false)
  const [pwdInput, setPwdInput] = useState('')
  const [pwdError, setPwdError] = useState('')

  const [viewMode, setViewMode] = useState<ViewMode>('all')
  const [activeHole, setActiveHole] = useState<number | null>(null)
  const [unit, setUnit] = useState<DistanceUnit>('yard')

  const [layerPrefs, setLayerPrefs] = useState<LayerPrefs>(() => {
    try {
      const raw = localStorage.getItem(PREFS_KEY)
      if (raw) return { ...defaultPrefs(18), ...(JSON.parse(raw) as LayerPrefs) }
    } catch {
      // 忽略损坏的本地偏好
    }
    return defaultPrefs(18)
  })

  const [drawMode, setDrawMode] = useState<DrawMode>('none')
  const [newFacilityType, setNewFacilityType] = useState<FacilityPoint['type']>('tee')
  const [newFacilitySubtype, setNewFacilitySubtype] = useState<string>('white')
  const [newAreaType, setNewAreaType] = useState<AreaShape['type']>('water')
  const [tempPoints, setTempPoints] = useState<[number, number][]>([])

  const [selected, setSelected] = useState<SelectedRef | null>(null)
  const [flyTo, setFlyTo] = useState<{ lng: number; lat: number; zoom?: number; key: number } | null>(null)

  const [query, setQuery] = useState('')
  const [mobileOpen, setMobileOpen] = useState(false)
  const [online, setOnline] = useState(() => navigator.onLine)

  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importMode, setImportMode] = useState<ImportMode>('merge')
  const [importError, setImportError] = useState<string | null>(null)
  const [importInfo, setImportInfo] = useState<string | null>(null)

  const [precacheHint, setPrecacheHint] = useState<string | null>(null)

  // GPS / 导航
  const [userLocation, setUserLocation] = useState<{ lng: number; lat: number; accuracy: number } | null>(null)
  const [gpsActive, setGpsActive] = useState(false)
  const [gpsError, setGpsError] = useState<string | null>(null)
  const [navTarget, setNavTarget] = useState<{ lng: number; lat: number; label: string } | null>(null)
  const watchIdRef = useRef<number | null>(null)
  const mapRef = useRef<L.Map | null>(null)

  const provider = getBasemap(layerPrefs.basemap)

  // ── 副作用 ─────────────────────────────────────────────
  useEffect(() => {
    // 图层偏好存 localStorage：这是"个人视图偏好"，不随同步走，避免多端互相覆盖
    localStorage.setItem(PREFS_KEY, JSON.stringify(layerPrefs))
  }, [layerPrefs])

  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  // 退出管理模式时，清理所有进行中的绘制
  useEffect(() => {
    if (!manageMode) {
      setDrawMode('none')
      setTempPoints([])
    }
  }, [manageMode])

  // 卸载时停止 GPS
  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current)
    }
  }, [])

  /** 可见洞：单洞视图只看当前洞（同时仍尊重图层面板里该洞的勾选） */
  const visibleHoles = useMemo(() => {
    if (viewMode === 'hole' && activeHole !== null) {
      return { [String(activeHole)]: layerPrefs.holes[String(activeHole)] !== false }
    }
    return layerPrefs.holes
  }, [viewMode, activeHole, layerPrefs.holes])

  const visibleFacilityTypes = useMemo(() => layerPrefs.facilityTypes, [layerPrefs.facilityTypes])
  const visibleAreaTypes = useMemo(() => layerPrefs.areaTypes, [layerPrefs.areaTypes])

  // ── 数据变更 ───────────────────────────────────────────
  const commit = useCallback((next: GolfData) => { void save(next) }, [save])

  const patchFacility = useCallback(
    (id: string, patch: Partial<FacilityPoint>) => {
      commit({ ...data, facilities: data.facilities.map((f) => (f.id === id ? { ...f, ...patch } : f)) })
    },
    [data, commit],
  )
  const patchArea = useCallback(
    (id: string, patch: Partial<AreaShape>) => {
      commit({ ...data, areas: data.areas.map((a) => (a.id === id ? { ...a, ...patch } : a)) })
    },
    [data, commit],
  )
  const patchLine = useCallback(
    (id: string, patch: Partial<DistanceLine>) => {
      commit({ ...data, lines: data.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) })
    },
    [data, commit],
  )

  // ── 地图点击：按当前绘制模式解释 ─────────────────────────
  const handleMapClick = useCallback(
    (lng: number, lat: number) => {
      if (drawMode === 'marker' && manageMode) {
        const f: FacilityPoint = {
          id: uid('f'),
          hole: activeHole ?? undefined,
          type: newFacilityType,
          subtype:
            newFacilityType === 'tee'
              ? newFacilitySubtype
              : newFacilityType === 'bunker'
                ? 'fairway'
                : undefined,
          name: '',
          lng,
          lat,
        }
        commit({ ...data, facilities: [...data.facilities, f] })
        setSelected({ kind: 'facility', id: f.id })
        return
      }

      if (drawMode === 'polygon' && manageMode) {
        setTempPoints((pts) => [...pts, [lng, lat]])
        return
      }

      if (drawMode === 'circle' && manageMode) {
        // 点一下即为圆心，默认半径 50 米，之后可拖边缘手柄调整
        const a: AreaShape = {
          id: uid('a'),
          hole: activeHole ?? undefined,
          type: newAreaType,
          kind: 'circle',
          center: [lng, lat],
          radius: 50,
          name: '',
        }
        commit({ ...data, areas: [...data.areas, a] })
        setSelected({ kind: 'area', id: a.id })
        return
      }

      if (drawMode === 'measure') {
        // 临时测量：两点一段，再点重新开始（不入库）
        setTempPoints((pts) => (pts.length < 2 ? [...pts, [lng, lat]] : [[lng, lat]]))
        return
      }

      setSelected(null)
    },
    [drawMode, manageMode, activeHole, newFacilityType, newFacilitySubtype, newAreaType, data, commit],
  )

  /** 结束多边形绘制 */
  const finishPolygon = useCallback(() => {
    if (tempPoints.length < 3) {
      setTempPoints([])
      return
    }
    const a: AreaShape = {
      id: uid('a'),
      hole: activeHole ?? undefined,
      type: newAreaType,
      kind: 'polygon',
      path: tempPoints,
      name: '',
    }
    commit({ ...data, areas: [...data.areas, a] })
    setTempPoints([])
    setSelected({ kind: 'area', id: a.id })
  }, [tempPoints, activeHole, newAreaType, data, commit])

  /** 把当前测量线保存为码数线 */
  const saveMeasureAsLine = useCallback(() => {
    if (tempPoints.length < 2) return
    const meters = distanceMeters(tempPoints[0], tempPoints[1])
    const line: DistanceLine = {
      id: uid('l'),
      hole: activeHole ?? undefined,
      label: formatDistance(meters, unit),
      from: tempPoints[0],
      to: tempPoints[1],
    }
    commit({ ...data, lines: [...data.lines, line] })
    setTempPoints([])
  }, [tempPoints, activeHole, unit, data, commit])

  // ── 要素移动 / 顶点调整 ─────────────────────────────────
  const handleMoveFacility = useCallback(
    (id: string, lng: number, lat: number) => patchFacility(id, { lng, lat }),
    [patchFacility],
  )
  const handleMoveArea = useCallback(
    (id: string, lng: number, lat: number) => patchArea(id, { center: [lng, lat] }),
    [patchArea],
  )
  const handleMoveVertex = useCallback(
    (areaId: string, index: number, lng: number, lat: number) => {
      const area = data.areas.find((a) => a.id === areaId)
      if (!area?.path) return
      const path = area.path.map((p, i) => (i === index ? ([lng, lat] as [number, number]) : p))
      patchArea(areaId, { path })
    },
    [data.areas, patchArea],
  )
  const handleResizeCircle = useCallback(
    (areaId: string, radius: number) => patchArea(areaId, { radius }),
    [patchArea],
  )

  const handleDeleteSelected = useCallback(() => {
    if (!selected) return
    if (selected.kind === 'facility') {
      commit({ ...data, facilities: data.facilities.filter((f) => f.id !== selected.id) })
    } else if (selected.kind === 'area') {
      commit({ ...data, areas: data.areas.filter((a) => a.id !== selected.id) })
    } else {
      commit({ ...data, lines: data.lines.filter((l) => l.id !== selected.id) })
    }
    setSelected(null)
  }, [selected, data, commit])

  // ── 管理模式门禁 ───────────────────────────────────────
  const requestManage = useCallback(() => {
    if (manageMode) {
      setManageMode(false)
      return
    }
    setPwdInput('')
    setPwdError('')
    setPwdOpen(true)
  }, [manageMode])

  const submitPassword = useCallback(() => {
    if (pwdInput === MANAGE_PASSWORD) {
      setManageMode(true)
      setPwdOpen(false)
      setPwdInput('')
    } else {
      setPwdError('口令不正确')
    }
  }, [pwdInput])

  // ── 导入导出 ───────────────────────────────────────────
  const handleExport = useCallback(
    (format: 'json' | 'geojson') => {
      const payload = format === 'json' ? data : toGeoJSON(data)
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `golf-course.${format === 'json' ? 'json' : 'geojson'}`
      a.click()
      URL.revokeObjectURL(url)
    },
    [data],
  )

  const runImport = useCallback(
    (text: string, mode: ImportMode) => {
      setImportError(null)
      setImportInfo(null)
      try {
        const parsed = parseImportText(text)
        const next = applyImport(data, parsed.payload, mode)
        commit(next)
        setImportInfo(
          `导入成功（${parsed.format === 'golf' ? '应用 JSON' : 'GeoJSON'}）：设施 ${parsed.counts.facilities}、区域 ${parsed.counts.areas}、码数线 ${parsed.counts.lines}`,
        )
        setImportText('')
      } catch (e) {
        setImportError(e instanceof Error ? e.message : '导入失败')
      }
    },
    [data, commit],
  )

  // ── 瓦片预缓存 ─────────────────────────────────────────
  const handlePrecache = useCallback(async () => {
    const map = mapRef.current
    if (!map) {
      setPrecacheHint('地图尚未就绪')
      return
    }
    const b = map.getBounds()
    setPrecacheHint('准备缓存…')
    try {
      const n = await precacheTiles(
        provider,
        { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() },
        map.getZoom(),
        (done, total) => setPrecacheHint(`缓存中 ${done}/${total}`),
      )
      setPrecacheHint(`已缓存 ${n} 张瓦片，可离线查看`)
    } catch {
      setPrecacheHint('缓存失败（可能离线或跨域受限）')
    }
    setTimeout(() => setPrecacheHint(null), 4000)
  }, [provider])

  // ── GPS ────────────────────────────────────────────────
  const handleLocate = useCallback(() => {
    if (gpsActive) {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
      setGpsActive(false)
      setUserLocation(null)
      setNavTarget(null)
      return
    }
    if (!navigator.geolocation) {
      setGpsError('当前设备不支持定位')
      return
    }
    setGpsError(null)
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        // 浏览器返回 WGS-84，统一转成 GCJ-02 后再进入业务数据
        const [lng, lat] = wgs84ToGcj02(pos.coords.longitude, pos.coords.latitude)
        setUserLocation({ lng, lat, accuracy: pos.coords.accuracy ?? 20 })
      },
      (err) => setGpsError(err.message || '定位失败'),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
    )
    watchIdRef.current = id
    setGpsActive(true)
  }, [gpsActive])

  /** GPS 到导航目标的实时距离 */
  const navDistance = useMemo(() => {
    if (!userLocation || !navTarget) return null
    return distanceMeters([userLocation.lng, userLocation.lat], [navTarget.lng, navTarget.lat])
  }, [userLocation, navTarget])

  // ── 搜索 ───────────────────────────────────────────────
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const out: { kind: SelectedRef['kind']; id: string; label: string; lng: number; lat: number }[] = []
    for (const f of data.facilities) {
      const label = facilityTitle(f)
      const haystack = `${label} ${FACILITY_TYPES[f.type]?.label ?? ''} ${f.hole ?? ''} ${f.note ?? ''}`.toLowerCase()
      if (haystack.includes(q)) out.push({ kind: 'facility', id: f.id, label, lng: f.lng, lat: f.lat })
    }
    for (const a of data.areas) {
      const label = a.name || AREA_TYPES[a.type].label
      const haystack = `${label} ${AREA_TYPES[a.type].label} ${a.hole ?? ''}`.toLowerCase()
      if (haystack.includes(q)) {
        const p = a.kind === 'circle' ? a.center : a.path?.[0]
        if (p) out.push({ kind: 'area', id: a.id, label, lng: p[0], lat: p[1] })
      }
    }
    return out.slice(0, 30)
  }, [query, data.facilities, data.areas])

  const flyToTarget = useCallback((lng: number, lat: number, zoom?: number) => {
    setFlyTo({ lng, lat, zoom, key: Date.now() })
  }, [])

  const selectedFacility = selected?.kind === 'facility' ? data.facilities.find((f) => f.id === selected.id) : undefined
  const selectedArea = selected?.kind === 'area' ? data.areas.find((a) => a.id === selected.id) : undefined
  const selectedLine = selected?.kind === 'line' ? data.lines.find((l) => l.id === selected.id) : undefined

  const sidebarProps = {
    data,
    online,
    unit,
    onUnitChange: setUnit,
    viewMode,
    onViewModeChange: (m: ViewMode) => {
      setViewMode(m)
      if (m === 'all') setActiveHole(null)
    },
    activeHole,
    onActiveHoleChange: setActiveHole,
    layerPrefs,
    onLayerChange: (patch: Partial<LayerPrefs>) => setLayerPrefs((p) => ({ ...p, ...patch })),
    manageMode,
    onToggleManage: requestManage,
    selected,
    onSelect: (sel: SelectedRef) => {
      setSelected(sel)
      const f = data.facilities.find((x) => x.id === sel.id)
      if (f) flyToTarget(f.lng, f.lat)
      setMobileOpen(false)
    },
    onImport: () => setImportOpen(true),
    onExport: () => handleExport('json'),
    onPrecache: handlePrecache,
    precacheHint,
    onLocate: handleLocate,
    gpsActive,
    navigateTargetName: navTarget?.label ?? null,
    onStopNavigate: () => setNavTarget(null),
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-white/50 text-sm">
        正在加载球场数据…
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 flex">
      {/* 桌面侧边栏 */}
      <aside className="hidden md:block w-[340px] shrink-0 border-r border-white/10 bg-slate-900/50">
        <Sidebar {...sidebarProps} />
      </aside>

      {/* 移动端抽屉 */}
      {mobileOpen && (
        <div className="md:hidden absolute inset-0 z-[1200] flex">
          <div className="w-[86%] max-w-[340px] h-full bg-slate-900 border-r border-white/10">
            <Sidebar {...sidebarProps} onClose={() => setMobileOpen(false)} />
          </div>
          <div className="flex-1 bg-black/50" onClick={() => setMobileOpen(false)} />
        </div>
      )}

      {/* 地图区 */}
      <div className="flex-1 relative min-w-0">
        <MapCanvas
          data={data}
          basemapId={layerPrefs.basemap}
          visibleFacilityTypes={visibleFacilityTypes}
          visibleHoles={visibleHoles}
          visibleAreaTypes={visibleAreaTypes}
          showLines={layerPrefs.showDistanceLines}
          manageMode={manageMode}
          unit={unit}
          drawMode={drawMode}
          tempPoints={tempPoints}
          selected={selected}
          userLocation={userLocation}
          flyTo={flyTo}
          onMapClick={handleMapClick}
          onSelect={(kind, id) => setSelected({ kind, id })}
          onMoveFacility={handleMoveFacility}
          onMoveArea={handleMoveArea}
          onMoveVertex={handleMoveVertex}
          onResizeCircle={handleResizeCircle}
          onReady={(map) => {
            mapRef.current = map
          }}
        />

        {/* 顶部：菜单 + 搜索 */}
        <div className="absolute top-3 left-3 right-3 z-[600] flex gap-2 pointer-events-none">
          <button
            onClick={() => setMobileOpen(true)}
            className="md:hidden pointer-events-auto w-10 h-10 rounded-lg bg-slate-900/90 border border-white/15 text-white/70 flex items-center justify-center"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="pointer-events-auto relative flex-1 max-w-[320px]">
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900/90 border border-white/15">
              <Search className="w-4 h-4 text-white/40 shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索洞号 / 设施 / 区域"
                className="flex-1 min-w-0 bg-transparent text-white text-xs outline-none placeholder:text-white/30"
              />
              {query && (
                <button onClick={() => setQuery('')} className="text-white/40 hover:text-white">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            {searchResults.length > 0 && (
              <div className="absolute mt-1 w-full max-h-64 overflow-y-auto rounded-lg bg-slate-900/95 border border-white/15 py-1">
                {searchResults.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => {
                      setSelected({ kind: r.kind, id: r.id })
                      flyToTarget(r.lng, r.lat, 17)
                      setQuery('')
                    }}
                    className="w-full px-2.5 py-1.5 text-left text-xs text-white/75 hover:bg-white/10 truncate"
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 绘制工具栏（管理模式显示完整，浏览模式只给测距） */}
        <div className="absolute top-16 right-3 z-[600] flex flex-col gap-1.5 items-end">
          {manageMode && (
            <>
              <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-900/90 border border-white/15">
                <select
                  value={newFacilityType}
                  onChange={(e) => setNewFacilityType(e.target.value as FacilityPoint['type'])}
                  className="px-1.5 py-1 rounded bg-white/10 text-white text-xs outline-none"
                >
                  {Object.entries(FACILITY_TYPES).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
                </select>
                {newFacilityType === 'tee' && (
                  <select
                    value={newFacilitySubtype}
                    onChange={(e) => setNewFacilitySubtype(e.target.value)}
                    className="px-1.5 py-1 rounded bg-white/10 text-white text-xs outline-none"
                  >
                    {(FACILITY_TYPES.tee.subtypes ?? []).map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  onClick={() => {
                    setDrawMode(drawMode === 'marker' ? 'none' : 'marker')
                    setTempPoints([])
                  }}
                  className={`flex items-center gap-1 px-2 py-1.5 rounded text-xs ${
                    drawMode === 'marker' ? 'bg-blue-500 text-white' : 'bg-white/10 text-white/70'
                  }`}
                >
                  <Plus className="w-3.5 h-3.5" /> 点图添加
                </button>
              </div>

              <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-900/90 border border-white/15">
                <select
                  value={newAreaType}
                  onChange={(e) => setNewAreaType(e.target.value as AreaShape['type'])}
                  className="px-1.5 py-1 rounded bg-white/10 text-white text-xs outline-none"
                >
                  {Object.entries(AREA_TYPES).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    setDrawMode(drawMode === 'polygon' ? 'none' : 'polygon')
                    setTempPoints([])
                  }}
                  className={`flex items-center gap-1 px-2 py-1.5 rounded text-xs ${
                    drawMode === 'polygon' ? 'bg-blue-500 text-white' : 'bg-white/10 text-white/70'
                  }`}
                >
                  <Square className="w-3.5 h-3.5" /> 画多边形
                </button>
                <button
                  onClick={() => {
                    setDrawMode(drawMode === 'circle' ? 'none' : 'circle')
                    setTempPoints([])
                  }}
                  className={`flex items-center gap-1 px-2 py-1.5 rounded text-xs ${
                    drawMode === 'circle' ? 'bg-blue-500 text-white' : 'bg-white/10 text-white/70'
                  }`}
                >
                  <Circle className="w-3.5 h-3.5" /> 画圆
                </button>
              </div>
            </>
          )}

          <button
            onClick={() => {
              setDrawMode(drawMode === 'measure' ? 'none' : 'measure')
              setTempPoints([])
            }}
            className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs border ${
              drawMode === 'measure'
                ? 'bg-red-500/80 text-white border-transparent'
                : 'bg-slate-900/90 text-white/70 border-white/15'
            }`}
          >
            <Ruler className="w-3.5 h-3.5" /> 测距
          </button>

          {/* 多边形进行中：完成 / 取消 */}
          {drawMode === 'polygon' && tempPoints.length > 0 && (
            <div className="flex gap-1">
              <button
                onClick={finishPolygon}
                disabled={tempPoints.length < 3}
                className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs bg-emerald-500/85 text-white disabled:opacity-40"
              >
                <Check className="w-3.5 h-3.5" /> 完成({tempPoints.length})
              </button>
              <button
                onClick={() => setTempPoints([])}
                className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs bg-slate-900/90 text-white/70 border border-white/15"
              >
                <X className="w-3.5 h-3.5" /> 清除
              </button>
            </div>
          )}

          {/* 测距完成两点：可存为码数线（管理模式） */}
          {drawMode === 'measure' && tempPoints.length === 2 && (
            <div className="flex gap-1">
              {manageMode && (
                <button
                  onClick={saveMeasureAsLine}
                  className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs bg-emerald-500/85 text-white"
                >
                  <Check className="w-3.5 h-3.5" /> 存为码数线
                </button>
              )}
              <button
                onClick={() => setTempPoints([])}
                className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs bg-slate-900/90 text-white/70 border border-white/15"
              >
                <X className="w-3.5 h-3.5" /> 清除
              </button>
            </div>
          )}
        </div>

        {/* 导航距离读数 */}
        {navDistance !== null && (
          <div className="absolute bottom-3 right-3 z-[600] px-3 py-2 rounded-lg bg-slate-900/90 border border-white/15 text-xs text-white">
            <div className="text-white/50">距 {navTarget?.label}</div>
            <div className="text-lg font-semibold text-blue-300">{formatDistance(navDistance, unit)}</div>
            {userLocation && (
              <div className="text-[11px] text-white/40">定位精度 ±{Math.round(userLocation.accuracy)} 米</div>
            )}
          </div>
        )}

        {/* GPS 提示 */}
        {gpsError && (
          <div className="absolute bottom-3 right-3 z-[600] px-3 py-2 rounded-lg bg-red-500/25 text-red-200 text-xs">
            {gpsError}
          </div>
        )}

        {/* 要素信息卡 */}
        {selected && (selectedFacility || selectedArea || selectedLine) && (
          <FeatureCard
            kind={selected.kind}
            facility={selectedFacility}
            area={selectedArea}
            line={selectedLine}
            data={data}
            unit={unit}
            manageMode={manageMode}
            onPatchFacility={patchFacility}
            onPatchArea={patchArea}
            onPatchLine={patchLine}
            onDelete={handleDeleteSelected}
            onClose={() => setSelected(null)}
            onNavigate={(lng, lat, label) => {
              setNavTarget({ lng, lat, label })
              if (!gpsActive) handleLocate()
            }}
          />
        )}
      </div>

      {/* 口令弹窗 */}
      {pwdOpen && (
        <div className="absolute inset-0 z-[1500] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-xs rounded-xl bg-slate-900 border border-white/15 p-4">
            <h3 className="text-white text-sm font-medium mb-2">进入管理模式</h3>
            <p className="text-xs text-white/40 mb-3">可添加/编辑/删除标记与区域</p>
            <input
              type="password"
              value={pwdInput}
              onChange={(e) => setPwdInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitPassword()}
              placeholder="请输入口令"
              className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/15 text-white text-sm outline-none focus:border-white/40"
            />
            {pwdError && <p className="mt-1.5 text-xs text-red-400">{pwdError}</p>}
            <div className="flex gap-2 mt-3">
              <button
                onClick={submitPassword}
                className="flex-1 px-3 py-2 rounded-lg text-xs bg-blue-500/85 text-white"
              >
                确认
              </button>
              <button
                onClick={() => setPwdOpen(false)}
                className="flex-1 px-3 py-2 rounded-lg text-xs bg-white/5 text-white/60 border border-white/10"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 导入弹窗（文件 + 粘贴二合一） */}
      {importOpen && (
        <div className="absolute inset-0 z-[1500] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-lg rounded-xl bg-slate-900 border border-white/15 p-4">
            <h3 className="text-white text-sm font-medium mb-2">导入球场数据</h3>
            <p className="text-xs text-white/40 mb-3">
              支持本应用导出的 JSON 或标准 GeoJSON；坐标按 GCJ-02 处理
            </p>
            <div className="flex gap-2 mb-2">
              <label className="px-2.5 py-1.5 rounded-lg text-xs bg-white/10 text-white/70 cursor-pointer hover:bg-white/15">
                选择文件
                <input
                  type="file"
                  accept=".json,.geojson,application/json"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    const text = await file.text()
                    setImportText(text)
                    e.target.value = ''
                  }}
                />
              </label>
              <div className="flex gap-1">
                <button
                  onClick={() => setImportMode('merge')}
                  className={`px-2.5 py-1.5 rounded-lg text-xs ${
                    importMode === 'merge' ? 'bg-blue-500/85 text-white' : 'bg-white/5 text-white/60'
                  }`}
                >
                  合并（按 ID）
                </button>
                <button
                  onClick={() => setImportMode('replace')}
                  className={`px-2.5 py-1.5 rounded-lg text-xs ${
                    importMode === 'replace' ? 'bg-blue-500/85 text-white' : 'bg-white/5 text-white/60'
                  }`}
                >
                  覆盖全部
                </button>
              </div>
            </div>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder='也可以直接把 JSON / GeoJSON 粘贴到这里'
              className="w-full h-40 rounded-lg bg-black/30 border border-white/15 text-white text-xs px-3 py-2 outline-none focus:border-white/40 font-mono resize-y"
            />
            {importError && <p className="mt-1.5 text-xs text-red-400">{importError}</p>}
            {importInfo && <p className="mt-1.5 text-xs text-emerald-400">{importInfo}</p>}
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => runImport(importText, importMode)}
                disabled={!importText.trim()}
                className="flex-1 px-3 py-2 rounded-lg text-xs bg-emerald-500/85 text-white disabled:opacity-40"
              >
                开始导入
              </button>
              <button
                onClick={() => {
                  setImportOpen(false)
                  setImportText('')
                  setImportError(null)
                  setImportInfo(null)
                }}
                className="px-3 py-2 rounded-lg text-xs bg-white/5 text-white/60 border border-white/10"
              >
                关闭
              </button>
            </div>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => handleExport('geojson')}
                className="text-[11px] text-white/40 hover:text-white/70 underline"
              >
                导出 GeoJSON
              </button>
              <button
                onClick={() => handleExport('json')}
                className="text-[11px] text-white/40 hover:text-white/70 underline"
              >
                导出应用 JSON
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
