/**
 * 高尔夫球场地图 —— 侧边栏
 *
 * 自上而下：球场标题 → 在线状态 → 视图模式 → 洞号切换 → 当前洞信息 → 图层控制 → 设施/区域列表 → 工具区。
 * 移动端由父组件把它包进抽屉（Drawer），本组件只负责内容。
 *
 * 图层状态由父组件持有并持久化到 localStorage（见 GolfApp），本组件只负责发出变更。
 */

import { useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  CloudDownload,
  Download,
  Layers,
  Lock,
  MapPin,
  Navigation,
  Ruler,
  Unlock,
  Upload,
  Wifi,
  WifiOff,
} from 'lucide-react'
import {
  AREA_TYPES,
  AREA_TYPE_KEYS,
  BASEMAP_PROVIDERS,
  FACILITY_TYPES,
  FACILITY_TYPE_KEYS,
  facilityTitle,
  type AreaShape,
  type FacilityPoint,
  type GolfData,
  type LayerPrefs,
} from './types'
import { distanceMeters, formatDistance, type DistanceUnit } from './geo'
import type { SelectedRef } from './MapCanvas'

export type ViewMode = 'hole' | 'all'

export interface SidebarProps {
  data: GolfData
  online: boolean
  unit: DistanceUnit
  onUnitChange: (u: DistanceUnit) => void
  viewMode: ViewMode
  onViewModeChange: (m: ViewMode) => void
  activeHole: number | null
  onActiveHoleChange: (n: number | null) => void
  layerPrefs: LayerPrefs
  onLayerChange: (patch: Partial<LayerPrefs>) => void
  manageMode: boolean
  onToggleManage: () => void
  selected: SelectedRef | null
  onSelect: (sel: SelectedRef) => void
  onImport: () => void
  onExport: () => void
  onPrecache: () => void
  precacheHint: string | null
  onLocate: () => void
  gpsActive: boolean
  /** 导航中的目标名称 */
  navigateTargetName: string | null
  onStopNavigate: () => void
  onClose?: () => void
}

/** 可折叠分区 */
function Section({
  title,
  icon,
  children,
  defaultOpen = false,
}: {
  title: string
  icon?: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-white/10">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-white/70 hover:text-white hover:bg-white/5"
      >
        {icon}
        <span className="text-sm font-medium flex-1">{title}</span>
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
      </button>
      {open && <div className="px-3 pb-3 space-y-2">{children}</div>}
    </div>
  )
}

/** 通用勾选行 */
function CheckRow({
  label,
  color,
  checked,
  onChange,
}: {
  label: string
  color?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex items-center gap-2 py-1 cursor-pointer min-h-[28px]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 rounded accent-blue-500"
      />
      {color && <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: color }} />}
      <span className="text-sm text-white/70">{label}</span>
    </label>
  )
}

export default function Sidebar(props: SidebarProps) {
  const {
    data,
    online,
    unit,
    onUnitChange,
    viewMode,
    onViewModeChange,
    activeHole,
    onActiveHoleChange,
    layerPrefs,
    onLayerChange,
    manageMode,
    onToggleManage,
    selected,
    onSelect,
    onImport,
    onExport,
    onPrecache,
    precacheHint,
    onLocate,
    gpsActive,
    navigateTargetName,
    onStopNavigate,
    onClose,
  } = props

  /** 当前洞的 Tee → Green 码数（按 Tee 分级分组） */
  const holeInfo = useMemo(() => {
    if (activeHole === null) return null
    const hole = data.holes.find((h) => h.number === activeHole)
    if (!hole) return null
    const green = data.facilities.find((f) => f.hole === activeHole && f.type === 'green')
    const tees = data.facilities.filter((f) => f.hole === activeHole && f.type === 'tee')
    const teeDistances = tees
      .map((t) => ({
        id: t.id,
        label: facilityTitle(t),
        meters: green ? distanceMeters([t.lng, t.lat], [green.lng, green.lat]) : null,
      }))
      .sort((a, b) => (b.meters ?? 0) - (a.meters ?? 0))
    return { hole, green, teeDistances }
  }, [activeHole, data.holes, data.facilities])

  /** 列表：当前洞（或全场）的设施与区域 */
  const listItems = useMemo(() => {
    const facilities = data.facilities.filter(
      (f) => activeHole === null || f.hole === activeHole || f.hole === undefined,
    )
    const areas = data.areas.filter(
      (a) => activeHole === null || a.hole === activeHole || a.hole === undefined,
    )
    return { facilities, areas }
  }, [data.facilities, data.areas, activeHole])

  const toggleAllFacilityTypes = (v: boolean) => {
    const next: Record<string, boolean> = {}
    for (const k of FACILITY_TYPE_KEYS) next[k] = v
    onLayerChange({ facilityTypes: next })
  }
  const toggleAllHoles = (v: boolean) => {
    const next: Record<string, boolean> = {}
    for (const h of data.holes) next[String(h.number)] = v
    onLayerChange({ holes: next })
  }
  const toggleAllAreaTypes = (v: boolean) => {
    const next: Record<string, boolean> = {}
    for (const k of AREA_TYPE_KEYS) next[k] = v
    onLayerChange({ areaTypes: next })
  }

  return (
    <div className="flex flex-col h-full text-white">
      {/* 标题 + 在线状态 */}
      <div className="px-3 py-3 border-b border-white/10">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <h2 className="text-white/90 font-medium truncate">{data.courseName}</h2>
            <div className="flex items-center gap-1.5 mt-1 text-xs">
              {online ? (
                <>
                  <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-400">在线</span>
                </>
              ) : (
                <>
                  <WifiOff className="w-3.5 h-3.5 text-amber-400" />
                  <span className="text-amber-400">离线（只读本地缓存）</span>
                </>
              )}
            </div>
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="shrink-0 px-2 py-1 rounded text-white/50 hover:text-white hover:bg-white/10 text-xs"
            >
              收起
            </button>
          )}
        </div>
      </div>

      {/* 视图模式 + 单位 */}
      <div className="px-3 py-2.5 border-b border-white/10 space-y-2">
        <div className="flex gap-1">
          <button
            onClick={() => onViewModeChange('hole')}
            className={`flex-1 px-2 py-1.5 rounded-lg text-xs ${
              viewMode === 'hole' ? 'bg-blue-500/80 text-white' : 'bg-white/5 text-white/60 hover:bg-white/10'
            }`}
          >
            单洞视图
          </button>
          <button
            onClick={() => onViewModeChange('all')}
            className={`flex-1 px-2 py-1.5 rounded-lg text-xs ${
              viewMode === 'all' ? 'bg-blue-500/80 text-white' : 'bg-white/5 text-white/60 hover:bg-white/10'
            }`}
          >
            全场总览
          </button>
        </div>
        <div className="flex items-center gap-2">
          <Ruler className="w-3.5 h-3.5 text-white/40" />
          <div className="flex gap-1 flex-1">
            <button
              onClick={() => onUnitChange('yard')}
              className={`flex-1 px-2 py-1 rounded text-xs ${
                unit === 'yard' ? 'bg-white/20 text-white' : 'bg-white/5 text-white/50 hover:bg-white/10'
              }`}
            >
              码
            </button>
            <button
              onClick={() => onUnitChange('meter')}
              className={`flex-1 px-2 py-1 rounded text-xs ${
                unit === 'meter' ? 'bg-white/20 text-white' : 'bg-white/5 text-white/50 hover:bg-white/10'
              }`}
            >
              米
            </button>
          </div>
        </div>
      </div>

      {/* 洞号切换 */}
      <div className="px-3 py-2.5 border-b border-white/10">
        <div className="grid grid-cols-6 gap-1">
          {data.holes.map((h) => (
            <button
              key={h.number}
              onClick={() => {
                onActiveHoleChange(h.number)
                onViewModeChange('hole')
              }}
              className={`h-9 rounded text-xs font-medium ${
                activeHole === h.number && viewMode === 'hole'
                  ? 'bg-blue-500 text-white'
                  : 'bg-white/5 text-white/60 hover:bg-white/10'
              }`}
            >
              {h.number}
            </button>
          ))}
        </div>
        {viewMode === 'hole' && activeHole !== null && (
          <button
            onClick={() => onViewModeChange('all')}
            className="mt-2 w-full px-2 py-1 rounded text-xs bg-white/5 text-white/50 hover:bg-white/10"
          >
            返回全场
          </button>
        )}
      </div>

      {/* 当前洞信息卡 */}
      {holeInfo && (
        <div className="px-3 py-2.5 border-b border-white/10">
          <div className="rounded-lg bg-white/5 p-2.5">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-white/90 font-medium">第 {holeInfo.hole.number} 洞</span>
              <span className="px-1.5 py-0.5 rounded bg-white/10 text-xs text-white/60">
                Par {holeInfo.hole.par}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-white/10 text-xs text-white/60">
                SI {holeInfo.hole.strokeIndex}
              </span>
            </div>
            {holeInfo.teeDistances.length > 0 ? (
              <div className="space-y-1">
                {holeInfo.teeDistances.map((t) => (
                  <div key={t.id} className="flex justify-between text-xs">
                    <span className="text-white/60">{t.label}</span>
                    <span className="text-white/80">
                      {t.meters === null ? '—' : formatDistance(t.meters, unit)}
                    </span>
                  </div>
                ))}
                <div className="text-[11px] text-white/35 pt-0.5">↑ 各 Tee 到果岭距离</div>
              </div>
            ) : (
              <p className="text-xs text-white/40">该洞还没有 Tee / 果岭标记</p>
            )}
          </div>
        </div>
      )}

      {/* 图层控制 */}
      <div className="flex-1 overflow-y-auto">
        <Section title="图层控制" icon={<Layers className="w-4 h-4" />} defaultOpen>
          {/* 底图 */}
          <div>
            <p className="text-xs text-white/40 mb-1">底图</p>
            <div className="grid grid-cols-2 gap-1">
              {BASEMAP_PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => onLayerChange({ basemap: p.id })}
                  className={`px-2 py-1.5 rounded text-xs ${
                    layerPrefs.basemap === p.id
                      ? 'bg-blue-500/80 text-white'
                      : 'bg-white/5 text-white/60 hover:bg-white/10'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* 设施类型 */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-white/40">设施类型</p>
              <div className="flex gap-1">
                <button
                  onClick={() => toggleAllFacilityTypes(true)}
                  className="text-[11px] px-1.5 py-0.5 rounded bg-white/5 text-white/50 hover:bg-white/10"
                >
                  全选
                </button>
                <button
                  onClick={() => toggleAllFacilityTypes(false)}
                  className="text-[11px] px-1.5 py-0.5 rounded bg-white/5 text-white/50 hover:bg-white/10"
                >
                  全不选
                </button>
              </div>
            </div>
            {FACILITY_TYPE_KEYS.map((k) => (
              <CheckRow
                key={k}
                label={FACILITY_TYPES[k].label}
                color={FACILITY_TYPES[k].color}
                checked={layerPrefs.facilityTypes[k] !== false}
                onChange={(v) =>
                  onLayerChange({ facilityTypes: { ...layerPrefs.facilityTypes, [k]: v } })
                }
              />
            ))}
          </div>

          {/* 洞号 */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-white/40">洞号</p>
              <div className="flex gap-1">
                <button
                  onClick={() => toggleAllHoles(true)}
                  className="text-[11px] px-1.5 py-0.5 rounded bg-white/5 text-white/50 hover:bg-white/10"
                >
                  全选
                </button>
                <button
                  onClick={() => toggleAllHoles(false)}
                  className="text-[11px] px-1.5 py-0.5 rounded bg-white/5 text-white/50 hover:bg-white/10"
                >
                  全不选
                </button>
              </div>
            </div>
            <div className="grid grid-cols-6 gap-1">
              {data.holes.map((h) => {
                const on = layerPrefs.holes[String(h.number)] !== false
                return (
                  <button
                    key={h.number}
                    onClick={() =>
                      onLayerChange({ holes: { ...layerPrefs.holes, [String(h.number)]: !on } })
                    }
                    className={`h-8 rounded text-xs ${
                      on ? 'bg-emerald-500/70 text-white' : 'bg-white/5 text-white/35'
                    }`}
                  >
                    {h.number}
                  </button>
                )
              })}
            </div>
          </div>

          {/* 区域类型 */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-white/40">区域类型</p>
              <div className="flex gap-1">
                <button
                  onClick={() => toggleAllAreaTypes(true)}
                  className="text-[11px] px-1.5 py-0.5 rounded bg-white/5 text-white/50 hover:bg-white/10"
                >
                  全选
                </button>
                <button
                  onClick={() => toggleAllAreaTypes(false)}
                  className="text-[11px] px-1.5 py-0.5 rounded bg-white/5 text-white/50 hover:bg-white/10"
                >
                  全不选
                </button>
              </div>
            </div>
            {AREA_TYPE_KEYS.map((k) => (
              <CheckRow
                key={k}
                label={AREA_TYPES[k].label}
                color={AREA_TYPES[k].fillColor}
                checked={layerPrefs.areaTypes[k] !== false}
                onChange={(v) => onLayerChange({ areaTypes: { ...layerPrefs.areaTypes, [k]: v } })}
              />
            ))}
          </div>

          {/* 码数线 */}
          <CheckRow
            label="码数线"
            color="#f97316"
            checked={layerPrefs.showDistanceLines}
            onChange={(v) => onLayerChange({ showDistanceLines: v })}
          />
        </Section>

        {/* 设施列表 */}
        <Section title={`设施（${listItems.facilities.length}）`} icon={<MapPin className="w-4 h-4" />}>
          {listItems.facilities.length === 0 ? (
            <p className="text-xs text-white/35">暂无设施标记</p>
          ) : (
            <div className="space-y-1">
              {listItems.facilities.map((f: FacilityPoint) => (
                <button
                  key={f.id}
                  onClick={() => onSelect({ kind: 'facility', id: f.id })}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs ${
                    selected?.id === f.id ? 'bg-blue-500/30' : 'hover:bg-white/10'
                  }`}
                >
                  <span
                    className="w-2.5 h-2.5 rounded-sm shrink-0"
                    style={{ background: FACILITY_TYPES[f.type]?.color }}
                  />
                  <span className="truncate flex-1 text-white/75">{facilityTitle(f)}</span>
                  {f.hole !== undefined && (
                    <span className="text-white/35 shrink-0">#{f.hole}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </Section>

        {/* 区域列表 */}
        <Section title={`区域（${listItems.areas.length}）`} icon={<Layers className="w-4 h-4" />}>
          {listItems.areas.length === 0 ? (
            <p className="text-xs text-white/35">暂无区域</p>
          ) : (
            <div className="space-y-1">
              {listItems.areas.map((a: AreaShape) => (
                <button
                  key={a.id}
                  onClick={() => onSelect({ kind: 'area', id: a.id })}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs ${
                    selected?.id === a.id ? 'bg-blue-500/30' : 'hover:bg-white/10'
                  }`}
                >
                  <span
                    className="w-2.5 h-2.5 rounded-sm shrink-0"
                    style={{ background: AREA_TYPES[a.type]?.fillColor }}
                  />
                  <span className="truncate flex-1 text-white/75">{a.name || AREA_TYPES[a.type].label}</span>
                  {a.hole !== undefined && <span className="text-white/35 shrink-0">#{a.hole}</span>}
                </button>
              ))}
            </div>
          )}
        </Section>
      </div>

      {/* GPS / 导航状态 */}
      <div className="px-3 py-2 border-t border-white/10 space-y-1.5">
        <button
          onClick={onLocate}
          className={`w-full flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-xs ${
            gpsActive ? 'bg-emerald-500/25 text-emerald-300' : 'bg-white/5 text-white/60 hover:bg-white/10'
          }`}
        >
          <Navigation className="w-3.5 h-3.5" />
          {gpsActive ? 'GPS 已开启' : '开启 GPS 定位'}
        </button>
        {navigateTargetName && (
          <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-blue-500/15 text-xs">
            <Navigation className="w-3.5 h-3.5 text-blue-300 shrink-0" />
            <span className="truncate flex-1 text-blue-200">导航中：{navigateTargetName}</span>
            <button onClick={onStopNavigate} className="text-white/50 hover:text-white shrink-0">
              结束
            </button>
          </div>
        )}
      </div>

      {/* 底部工具区 */}
      <div className="px-3 py-2.5 border-t border-white/10 space-y-2">
        <button
          onClick={onToggleManage}
          className={`w-full flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-xs ${
            manageMode ? 'bg-amber-500/80 text-white' : 'bg-white/5 text-white/60 hover:bg-white/10'
          }`}
        >
          {manageMode ? <Unlock className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
          {manageMode ? '退出管理模式' : '进入管理模式'}
        </button>

        <div className="grid grid-cols-3 gap-1">
          <button
            onClick={onImport}
            className="flex items-center justify-center gap-1 px-2 py-2 rounded-lg text-xs bg-white/5 text-white/60 hover:bg-white/10"
          >
            <Upload className="w-3.5 h-3.5" /> 导入
          </button>
          <button
            onClick={onExport}
            className="flex items-center justify-center gap-1 px-2 py-2 rounded-lg text-xs bg-white/5 text-white/60 hover:bg-white/10"
          >
            <Download className="w-3.5 h-3.5" /> 导出
          </button>
          <button
            onClick={onPrecache}
            className="flex items-center justify-center gap-1 px-2 py-2 rounded-lg text-xs bg-white/5 text-white/60 hover:bg-white/10"
          >
            <CloudDownload className="w-3.5 h-3.5" /> 缓存
          </button>
        </div>
        {precacheHint && <p className="text-[11px] text-white/40 text-center">{precacheHint}</p>}
      </div>
    </div>
  )
}
