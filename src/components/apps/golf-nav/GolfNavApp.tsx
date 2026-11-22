import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { FEATURE_TYPES, loadCourse } from '@/golf-nav-engine/data/course-schema.js'
import { normalizePoint } from '@/golf-nav-engine/data/coordinates.js'
import { buildGrid, worldToCell, cellToLatLng, snapToPassable } from '@/golf-nav-engine/geo/passability.js'
import { latLngDistance } from '@/golf-nav-engine/geo/geometry.js'
import { findPath } from '@/golf-nav-engine/nav/astar.js'
import { adviseShot } from '@/golf-nav-engine/nav/shot-advisor.js'
import { createAdapter, sdkReady } from '@/golf-nav-engine/map-adapters/index.js'
import { buildCourseGeometry, toBusinessPoint, FEATURE_LABELS, STYLE_COLORS } from '@/golf-nav-engine/map-adapters/geometry.js'
import { golfDataToCourse, useSharedGolfData } from '@/lib/golf-shared'
import rawSampleCourse from '@/golf-nav-engine/data/sample-course.json'
import GolfSyncPanel from './GolfSyncPanel'

type Provider = 'amap' | 'tencent' | 'canvas'
type Mode = 'route' | 'shot'
type Point = { lat: number; lng: number }

const PROVIDER_LABELS: Record<Provider, string> = {
  amap: '高德地图',
  tencent: '腾讯地图',
  canvas: '矢量示意图',
}

// geometry.js 导出的是字面量对象，TS 侧补索引签名以便按分类字符串取值
const LABELS = FEATURE_LABELS as Record<string, string>
const COLORS = STYLE_COLORS as Record<string, string>

const myMarker = (p: Point) => ({ id: 'me', styleId: 'me', position: toBusinessPoint(p) })

export default function GolfNavApp() {
  const { data: sharedData, loading: sharedLoading } = useSharedGolfData()
  // 共享数据（球场地图标注）优先；尚无 tee/green 标注时回退内置示例球场。
  const course = useMemo(() => {
    const converted = golfDataToCourse(sharedData)
    const result = loadCourse(converted)
    if (result.ok && result.course.holes.length > 0) return result.course
    return loadCourse(rawSampleCourse as any).course
  }, [sharedData])
  const usingShared = useMemo(
    () => golfDataToCourse(sharedData).holes.length > 0,
    [sharedData],
  )
  const mapEl = useRef<HTMLDivElement>(null)
  const adapterRef = useRef<any>(null)
  const courseGeom = useMemo(() => buildCourseGeometry(course), [course])

  const [provider, setProvider] = useState<Provider>('amap')
  const [mode, setMode] = useState<Mode>('route')
  const [syncOpen, setSyncOpen] = useState(false)
  const [hole, setHole] = useState(1)
  const [target, setTarget] = useState<'tee' | 'green'>('green')
  const [position, setPosition] = useState<Point | null>(null)
  const [result, setResult] = useState('点击「定位」或地图设置当前位置，再生成路线。')
  const [notice, setNotice] = useState('')
  const [visibleTypes, setVisibleTypes] = useState<Record<string, boolean>>(
    () => Object.fromEntries(FEATURE_TYPES.map((t: string) => [t, true])) as Record<string, boolean>,
  )
  const [selected, setSelected] = useState<any>(null)
  const selectedRef = useRef<string | null>(null)
  const routeRef = useRef<any[] | null>(null)
  const positionRef = useRef<Point | null>(null)

  // 统一绘制「我的位置」：me 标记始终在最前，extras 用于叠加击球建议的候选点
  const syncMyPosition = useCallback((p: Point | null, extras: any[] = []) => {
    positionRef.current = p
    const a = adapterRef.current
    if (a) a.setMarkers(p ? [myMarker(p), ...extras] : extras)
  }, [])

  // 按分类过滤后的几何；中心线属于辅助线，始终显示
  const displayGeom = useMemo(() => ({
    polygons: courseGeom.polygons.filter((p: any) => visibleTypes[p.featureType] !== false),
    lines: courseGeom.lines.filter((l: any) => l.styleId === 'center' || visibleTypes[l.featureType] !== false),
  }), [courseGeom, visibleTypes])

  // 按分类分组的标注列表（仅当前洞，排除中心线辅助线）。
  // 名称来自球场地图真实标注（经 golfDataToCourse → buildCourseGeometry 透传），无名称时按类型+序号兜底。
  const featureGroups = useMemo(() => {
    const geoms: any[] = [
      ...courseGeom.polygons.map((g: any) => ({ ...g, geomKind: 'polygon' })),
      ...courseGeom.lines
        .filter((l: any) => l.styleId !== 'center')
        .map((l: any) => ({ ...l, geomKind: 'line' })),
    ].filter((g: any) => g.hole === hole && visibleTypes[g.featureType || g.styleId] !== false)
    const map = new Map<string, any[]>()
    for (const g of geoms) {
      const key = g.featureType || g.styleId || 'other'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(g)
    }
    return map
  }, [courseGeom, hole, visibleTypes])

  const currentHole = useMemo(
    () => course.holes.find((h: any) => h.number === hole) || course.holes[0],
    [course, hole],
  )

  const center = useMemo<Point>(() => {
    const b = course.bounds
    return { lat: (b.south + b.north) / 2, lng: (b.west + b.east) / 2 }
  }, [course])

  const centerOn = useCallback((p: Point) => {
    const a = adapterRef.current
    if (!a || !a.map || !a.toDisplayPoint) return
    try {
      const display = a.toDisplayPoint(p)
      if (provider === 'amap') a.map.setView(display, 16)
      else if (provider === 'tencent') a.map.setCenter(display)
    } catch { /* ignore */ }
  }, [provider])

  // 从「标注列表」点击一条：构造与地图点击一致的 hit，复用同一套高亮链路；并把地图定位到该标注。
  const selectFromList = useCallback((g: any) => {
    const hit = {
      id: g.id,
      featureType: g.featureType,
      hole: g.hole,
      featureIndex: g.featureIndex,
      styleId: g.styleId,
      name: g.name,
      sourceId: g.sourceId,
      kind: g.geomKind,
    }
    setSelected(hit)
    selectedRef.current = g.id
    if (adapterRef.current) adapterRef.current.setSelection(g.id)
    // 取几何顶点的中心作为定位点，避免飞到某个角落
    if (g.paths && g.paths.length) {
      const lat = g.paths.reduce((s: number, p: any) => s + p.lat, 0) / g.paths.length
      const lng = g.paths.reduce((s: number, p: any) => s + p.lng, 0) / g.paths.length
      centerOn({ lat, lng })
    }
  }, [centerOn])

  const initMap = useCallback((p: Provider) => {
    if (!mapEl.current) return
    try {
      if (adapterRef.current) adapterRef.current.destroy()
      if (!sdkReady(p, { TMap: (window as any).TMap, L })) {
        setNotice(`${PROVIDER_LABELS[p]}加载失败，已切换为矢量示意图。`)
        p = 'canvas'
      }
      const adapter = createAdapter(p, { region: course.region, L, course, canvas: mapEl.current })
      adapter.create(mapEl.current, center, 16)
      adapterRef.current = adapter
      adapter.setPolygons(displayGeom.polygons)
      adapter.setLines([
        ...displayGeom.lines,
        ...(routeRef.current ? [{ id: 'route', styleId: 'route', paths: routeRef.current.map(toBusinessPoint) }] : []),
      ])
      adapter.onClick((pt: Point) => {
        setPosition(pt)
        syncMyPosition(pt)
        setSelected(null)
        selectedRef.current = null
        setResult('已手动设置位置。')
      })
      adapter.onFeatureClick((hit: any) => {
        setSelected(hit)
        selectedRef.current = hit.id
        adapter.setSelection(hit.id)
      })
      if (selectedRef.current) adapter.setSelection(selectedRef.current)
      if (positionRef.current) adapter.setMarkers([myMarker(positionRef.current)])
      setProvider(p)
      setNotice('')
    } catch (e: any) {
      setNotice(`地图初始化失败：${e.message}`)
    }
  }, [course, center, displayGeom, syncMyPosition])

  // 分类筛选/切洞后的图层同步，保留已有路线与选中高亮
  const applyLines = useCallback(() => {
    const a = adapterRef.current
    if (!a) return
    a.setLines([
      ...displayGeom.lines,
      ...(routeRef.current ? [{ id: 'route', styleId: 'route', paths: routeRef.current.map(toBusinessPoint) }] : []),
    ])
    if (selectedRef.current) a.setSelection(selectedRef.current)
  }, [displayGeom])

  useEffect(() => {
    const a = adapterRef.current
    if (!a) return
    a.course = course
    a.setPolygons(displayGeom.polygons)
    applyLines()
  }, [course, displayGeom, applyLines])

  useEffect(() => {
    initMap('amap')
    return () => { try { adapterRef.current && adapterRef.current.destroy() } catch { /* ignore */ } }
  }, [])

  const locate = () => {
    const apply = (p: Point, msg: string, doCenter = false) => {
      setPosition(p)
      syncMyPosition(p)
      setResult(msg)
      if (doCenter) centerOn(p)
    }
    if (!navigator.geolocation) {
      apply(normalizePoint(currentHole.tee), '浏览器不支持定位，已使用本洞发球台作为模拟位置。')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        apply(p, `定位成功（精度约 ${Math.round(pos.coords.accuracy)} 米）。`, true)
      },
      () => {
        apply(normalizePoint(currentHole.tee), '定位不可用，已使用本洞发球台作为模拟位置；可点击地图手动设置。')
      },
      { enableHighAccuracy: true, timeout: 8000 },
    )
  }

  const ensureGrid = () => {
    const parts = [
      currentHole.tee, currentHole.green, ...currentHole.centerLine,
      ...(currentHole.features || []).flatMap((f: any) => [f.polygon, f.line, f.point].filter(Boolean)),
    ]
    const lats = parts.flatMap((p: any) => Array.isArray(p) ? [p[0]] : [])
    const lngs = parts.flatMap((p: any) => Array.isArray(p) ? [p[1]] : [])
    const bounds = lats.length
      ? { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lngs), east: Math.max(...lngs) }
      : course.bounds
    return buildGrid(course, { resolutionMeters: 2, holeNumbers: [hole], bounds })
  }

  const cellFor = (p: Point) => {
    const g = ensureGrid()
    const c = worldToCell(g, p)
    return snapToPassable(g, c.col, c.row) || c
  }

  const calculateRoute = () => {
    if (!position) { setResult('请先定位或点击地图设置位置。'); return }
    const goal = target === 'tee' ? currentHole.tee : currentHole.green
    const r = findPath(ensureGrid(), cellFor(position), cellFor(goal as Point), { mode: 'walk' })
    if (!r.found) { setResult('当前位置到目标无可行路线。'); return }
    const pts = r.points.map((c: any) => cellToLatLng(ensureGrid(), c.col, c.row))
    routeRef.current = pts
    applyLines()
    syncMyPosition(position)
    let dist = 0
    for (let i = 1; i < pts.length; i++) dist += latLngDistance(pts[i - 1], pts[i])
    setResult(`路线已生成\n目标：${target === 'tee' ? '发球台' : '果岭'}\n折线距离约 ${dist.toFixed(0)} 米\n路线点数 ${pts.length}`)
  }

  const calculateShot = () => {
    if (!position) { setResult('请先定位或点击地图设置位置。'); return }
    const r = adviseShot(ensureGrid(), position, currentHole.green)
    if (!r.ok || !r.recommended) { setResult(r.reason || '无法生成建议'); return }
    syncMyPosition(position, [
      { id: 'green', styleId: 'target', position: toBusinessPoint(currentHole.green) },
      ...r.candidates.slice(0, 6).map((c: any, i: number) => ({ id: `land${i}`, styleId: 'landing', position: toBusinessPoint(c.latLng) })),
    ])
    setResult(`${r.recommended.kind}\n推荐落点风险分 ${r.recommended.risk}（越低越安全）\n${r.disclaimer || ''}`)
  }

  const changeHole = (n: number) => {
    setHole(n)
    const h = course.holes.find((x: any) => x.number === n) || course.holes[0]
    routeRef.current = null
    setSelected(null)
    selectedRef.current = null
    const a = adapterRef.current
    if (a) { applyLines(); a.setSelection(null) }
    syncMyPosition(position)
    const tee = normalizePoint(h.tee); const green = normalizePoint(h.green)
    centerOn({ lat: (tee.lat + green.lat) / 2, lng: (tee.lng + green.lng) / 2 })
    setResult(`已切换到第 ${n} 洞。`)
  }

  return (
    <div className="flex flex-col gap-3 p-4 h-full">
      <div className="flex flex-wrap items-center gap-2">
        <select value={provider} onChange={(e) => initMap(e.target.value as Provider)} className="rounded bg-white/10 px-2 py-1">
          {(Object.keys(PROVIDER_LABELS) as Provider[]).map((p) => <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>)}
        </select>
        <select value={hole} onChange={(e) => changeHole(Number(e.target.value))} className="rounded bg-white/10 px-2 py-1">
          {course.holes.map((h: any) => <option key={h.number} value={h.number}>第 {h.number} 洞 · Par {h.par}</option>)}
        </select>
        <button onClick={locate} className="rounded bg-white/10 px-3 py-1">定位</button>
        <div className="flex rounded overflow-hidden">
          <button onClick={() => setMode('route')} className={`px-3 py-1 ${mode === 'route' ? 'bg-emerald-600' : 'bg-white/10'}`}>场内找路</button>
          <button onClick={() => setMode('shot')} className={`px-3 py-1 ${mode === 'shot' ? 'bg-emerald-600' : 'bg-white/10'}`}>击球决策</button>
        </div>
      </div>

      {notice && <div className="rounded bg-amber-900/40 px-3 py-2 text-sm">{notice}</div>}
      <p className="text-xs opacity-70">
        数据源：{usingShared ? '球场地图共享标注（独立库 golf）' : '内置示例球场（共享数据尚无 tee/green 标注）'}
        {sharedLoading ? ' · 加载中…' : ''}
      </p>

      <div className="flex flex-col md:flex-row gap-3 flex-1 min-h-0">
        <div className="w-full md:w-64 shrink-0 flex flex-col gap-3">
          <div className="rounded-lg bg-white/5 p-3">
            <h3 className="font-medium mb-2">状态</h3>
            <p className="text-sm whitespace-pre-line leading-relaxed">{result}</p>
          </div>
          {selected && (
            <div className="rounded-lg bg-sky-950/40 p-3 ring-1 ring-sky-500/40">
              <h3 className="font-medium mb-1">选中标注</h3>
              <p className="text-sm">{selected.name || LABELS[selected.featureType] || selected.featureType}</p>
              <p className="text-sm opacity-80">类型：{LABELS[selected.featureType] || selected.featureType}</p>
              <p className="text-sm opacity-80">第 {selected.hole} 洞 · {(selected.kind || selected.geomKind) === 'polygon' ? '面状区域' : '线状要素'}</p>
              <button
                onClick={() => {
                  setSelected(null)
                  selectedRef.current = null
                  if (adapterRef.current) adapterRef.current.setSelection(null)
                }}
                className="mt-2 rounded bg-white/10 px-2 py-1 text-xs"
              >清除选中</button>
            </div>
          )}
          <div className="rounded-lg bg-white/5 p-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-medium">标注分类</h3>
              <button
                onClick={() => setVisibleTypes(Object.fromEntries(FEATURE_TYPES.map((t: string) => [t, true])) as Record<string, boolean>)}
                className="text-xs opacity-70 hover:opacity-100"
              >全部显示</button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {FEATURE_TYPES.map((type: string) => {
                const on = visibleTypes[type] !== false
                const color = COLORS[type] || 'rgba(148,163,184,0.8)'
                return (
                  <button
                    key={type}
                    onClick={() => {
                      const next = !visibleTypes[type]
                      setVisibleTypes((prev) => ({ ...prev, [type]: next }))
                      if (!next && selected && selected.featureType === type) {
                        setSelected(null)
                        selectedRef.current = null
                        if (adapterRef.current) adapterRef.current.setSelection(null)
                      }
                    }}
                    title={on ? `隐藏${LABELS[type] || type}` : `显示${LABELS[type] || type}`}
                    className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition ${on ? 'bg-white/15 ring-1 ring-sky-400/50' : 'bg-white/5 opacity-40'}`}
                  >
                    <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: color }} />
                    {LABELS[type] || type}
                  </button>
                )
              })}
            </div>
            <p className="mt-2 text-xs opacity-60">点击标注可高亮并查看类型；点击空白处设置当前位置。</p>
          </div>
          <div className="rounded-lg bg-white/5 p-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-medium">标注列表</h3>
              <span className="text-xs opacity-60">第 {hole} 洞</span>
            </div>
            {featureGroups.size === 0 ? (
              <p className="text-xs opacity-60">当前洞暂无标注（或全部已隐藏）。</p>
            ) : (
              <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
                {Array.from(featureGroups.keys())
                  .sort((a, b) => {
                    const ia = FEATURE_TYPES.indexOf(a)
                    const ib = FEATURE_TYPES.indexOf(b)
                    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
                  })
                  .map((type) => {
                  const items = featureGroups.get(type)!
                  const color = COLORS[type] || 'rgba(148,163,184,0.8)'
                  return (
                    <div key={type}>
                      <div className="flex items-center gap-1.5 text-xs opacity-80 mb-1">
                        <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: color }} />
                        {LABELS[type] || type}
                        <span className="opacity-60">({items.length})</span>
                      </div>
                      <div className="flex flex-col gap-1">
                        {items.map((g: any, i: number) => {
                          const active = selected && selected.id === g.id
                          return (
                            <button
                              key={g.id}
                              onClick={() => selectFromList(g)}
                              className={`w-full text-left rounded px-2 py-1 text-xs transition truncate ${active ? 'bg-sky-500/30 ring-1 ring-sky-400' : 'bg-white/5 hover:bg-white/10'}`}
                              title={g.name || `${LABELS[type] || type} ${i + 1}`}
                            >
                              {g.name || `${LABELS[type] || type} ${i + 1}`}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          {mode === 'route' && (
            <div className="rounded-lg bg-white/5 p-3">
              <h3 className="font-medium mb-2">目标</h3>
              <label className="block text-sm"><input type="radio" name="gtarget" checked={target === 'green'} onChange={() => setTarget('green')} /> 果岭</label>
              <label className="block text-sm"><input type="radio" name="gtarget" checked={target === 'tee'} onChange={() => setTarget('tee')} /> 发球台</label>
              <button onClick={calculateRoute} className="mt-2 w-full rounded bg-emerald-600 px-3 py-1">计算路线</button>
            </div>
          )}
          {mode === 'shot' && (
            <div className="rounded-lg bg-white/5 p-3">
              <h3 className="font-medium mb-2">击球建议</h3>
              <button onClick={calculateShot} className="w-full rounded bg-emerald-600 px-3 py-1">生成建议</button>
            </div>
          )}
        </div>
        {/* 地图区：外层 relative 提供定位上下文；地图本身 overflow-hidden，浮层挂外层避免被裁切 */}
        <div className="relative flex-1 min-w-0 min-h-[420px]">
          {/* 数据同步组入口（appId: golf）——与球场地图页保持一致的右上角范式 */}
          <button
            onClick={() => setSyncOpen((v) => !v)}
            className="absolute top-3 right-3 z-[650] px-3 py-1.5 rounded-lg bg-slate-900/90 border border-white/15 text-white/80 text-xs shadow"
            title="数据同步组设置"
          >
            同步组
          </button>
          {/* 面板常驻挂载、只切显隐：连接由 config-ui 在挂载时发起，条件渲染会导致「不点开就永不连接」 */}
          <div
            className={`absolute top-14 right-3 z-[650] w-96 max-w-[calc(100%-1.5rem)] rounded-lg bg-slate-900/95 border border-white/15 text-white shadow-lg ${syncOpen ? '' : 'hidden'}`}
          >
            <GolfSyncPanel />
          </div>
          <div ref={mapEl} className="absolute inset-0 rounded-lg overflow-hidden bg-slate-200" />
        </div>
      </div>
    </div>
  )
}
