/**
 * 高尔夫球场地图 —— 要素信息卡
 *
 * 点击地图上的标记/区域/码数线后，在地图上方浮出这张卡片（非全屏遮罩，不挡地图）。
 * - 浏览模式：只读展示（含到果岭中心距离）
 * - 管理模式：可编辑名称/类型/子类型/所属洞/备注，可删除
 */

import { Trash2, Navigation, X } from 'lucide-react'
import {
  AREA_TYPES,
  AREA_TYPE_KEYS,
  FACILITY_TYPES,
  FACILITY_TYPE_KEYS,
  facilityTitle,
  type AreaShape,
  type DistanceLine,
  type FacilityPoint,
  type GolfData,
} from './types'
import { distanceMeters, formatDistance, type DistanceUnit } from './geo'

export interface FeatureCardProps {
  kind: 'facility' | 'area' | 'line'
  facility?: FacilityPoint
  area?: AreaShape
  line?: DistanceLine
  data: GolfData
  unit: DistanceUnit
  manageMode: boolean
  onPatchFacility: (id: string, patch: Partial<FacilityPoint>) => void
  onPatchArea: (id: string, patch: Partial<AreaShape>) => void
  onPatchLine: (id: string, patch: Partial<DistanceLine>) => void
  onDelete: () => void
  onClose: () => void
  onNavigate: (lng: number, lat: number, label: string) => void
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] text-white/40">{label}</span>
      {children}
    </label>
  )
}

const inputCls =
  'w-full mt-0.5 px-2 py-1.5 rounded-lg bg-black/30 border border-white/15 text-white text-xs outline-none focus:border-white/40'

export default function FeatureCard(props: FeatureCardProps) {
  const {
    kind,
    facility,
    area,
    line,
    data,
    unit,
    manageMode,
    onPatchFacility,
    onPatchArea,
    onPatchLine,
    onDelete,
    onClose,
    onNavigate,
  } = props

  /** 该要素的坐标（用于「导航到这里」） */
  const coord: [number, number] | null =
    facility
      ? [facility.lng, facility.lat]
      : area
        ? area.kind === 'circle'
          ? (area.center ?? null)
          : (area.path?.[0] ?? null)
        : line
          ? line.from
          : null

  /** 到同洞果岭中心的距离（仅设施点展示） */
  const toGreenMeters = (() => {
    if (!facility || facility.hole === undefined) return null
    const green = data.facilities.find((f) => f.hole === facility.hole && f.type === 'green')
    if (!green) return null
    if (facility.type === 'green') return null
    return distanceMeters([facility.lng, facility.lat], [green.lng, green.lat])
  })()

  const title = facility
    ? facilityTitle(facility)
    : area
      ? (area.name || AREA_TYPES[area.type].label)
      : line
        ? (line.label || '码数线')
        : ''

  return (
    <div className="absolute left-3 bottom-3 z-[500] w-[290px] max-w-[calc(100%-24px)] rounded-xl bg-slate-900/95 border border-white/15 shadow-xl backdrop-blur p-3">
      <div className="flex items-start gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <h3 className="text-white text-sm font-medium truncate">{title}</h3>
          <p className="text-[11px] text-white/40">
            {kind === 'facility'
              ? FACILITY_TYPES[facility!.type]?.label
              : kind === 'area'
                ? `${AREA_TYPES[area!.type].label} · ${area!.kind === 'circle' ? '圆形' : '多边形'}`
                : '码数线'}
            {facility?.hole !== undefined && ` · 第 ${facility.hole} 洞`}
            {area?.hole !== undefined && ` · 第 ${area.hole} 洞`}
          </p>
        </div>
        <button onClick={onClose} className="shrink-0 text-white/40 hover:text-white p-0.5">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 到果岭距离 */}
      {toGreenMeters !== null && (
        <div className="mb-2 px-2 py-1.5 rounded-lg bg-emerald-500/15 text-xs text-emerald-300">
          到本洞果岭中心：{formatDistance(toGreenMeters, unit)}
        </div>
      )}
      {line && (
        <div className="mb-2 px-2 py-1.5 rounded-lg bg-orange-500/15 text-xs text-orange-300">
          线段长度：{formatDistance(distanceMeters(line.from, line.to), unit)}
        </div>
      )}
      {area?.kind === 'circle' && area.radius !== undefined && (
        <div className="mb-2 px-2 py-1.5 rounded-lg bg-white/10 text-xs text-white/60">
          半径：{formatDistance(area.radius, unit)}
        </div>
      )}

      {/* 编辑区（管理模式） */}
      {manageMode ? (
        <div className="space-y-2">
          {facility && (
            <>
              <Field label="名称">
                <input
                  className={inputCls}
                  value={facility.name ?? ''}
                  onChange={(e) => onPatchFacility(facility.id, { name: e.target.value })}
                  placeholder="例如：1 号洞黑 Tee"
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="类型">
                  <select
                    className={inputCls}
                    value={facility.type}
                    onChange={(e) =>
                      onPatchFacility(facility.id, {
                        type: e.target.value as FacilityPoint['type'],
                        subtype: undefined,
                      })
                    }
                  >
                    {FACILITY_TYPE_KEYS.map((k) => (
                      <option key={k} value={k}>
                        {FACILITY_TYPES[k].label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="所属洞">
                  <select
                    className={inputCls}
                    value={facility.hole ?? ''}
                    onChange={(e) =>
                      onPatchFacility(facility.id, {
                        hole: e.target.value === '' ? undefined : Number(e.target.value),
                      })
                    }
                  >
                    <option value="">不限洞</option>
                    {data.holes.map((h) => (
                      <option key={h.number} value={h.number}>
                        第 {h.number} 洞
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              {/* 子类型：Tee 分级 / 沙坑分类 / 码数桩码值 */}
              {facility.type === 'tee' && (
                <Field label="Tee 分级">
                  <select
                    className={inputCls}
                    value={facility.subtype ?? 'white'}
                    onChange={(e) => onPatchFacility(facility.id, { subtype: e.target.value })}
                  >
                    {(FACILITY_TYPES.tee.subtypes ?? []).map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {facility.type === 'bunker' && (
                <Field label="沙坑分类">
                  <select
                    className={inputCls}
                    value={facility.subtype ?? 'fairway'}
                    onChange={(e) => onPatchFacility(facility.id, { subtype: e.target.value })}
                  >
                    {(FACILITY_TYPES.bunker.subtypes ?? []).map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {facility.type === 'distance' && (
                <Field label="码数（到果岭，码）">
                  <input
                    className={inputCls}
                    value={facility.subtype ?? ''}
                    onChange={(e) => onPatchFacility(facility.id, { subtype: e.target.value })}
                    placeholder="150"
                  />
                </Field>
              )}
              <Field label="备注">
                <input
                  className={inputCls}
                  value={facility.note ?? ''}
                  onChange={(e) => onPatchFacility(facility.id, { note: e.target.value })}
                />
              </Field>
            </>
          )}

          {area && (
            <>
              <Field label="名称">
                <input
                  className={inputCls}
                  value={area.name ?? ''}
                  onChange={(e) => onPatchArea(area.id, { name: e.target.value })}
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="区域类型">
                  <select
                    className={inputCls}
                    value={area.type}
                    onChange={(e) => onPatchArea(area.id, { type: e.target.value as AreaShape['type'] })}
                  >
                    {AREA_TYPE_KEYS.map((k) => (
                      <option key={k} value={k}>
                        {AREA_TYPES[k].label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="所属洞">
                  <select
                    className={inputCls}
                    value={area.hole ?? ''}
                    onChange={(e) =>
                      onPatchArea(area.id, {
                        hole: e.target.value === '' ? undefined : Number(e.target.value),
                      })
                    }
                  >
                    <option value="">不限洞</option>
                    {data.holes.map((h) => (
                      <option key={h.number} value={h.number}>
                        第 {h.number} 洞
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="备注">
                <input
                  className={inputCls}
                  value={area.note ?? ''}
                  onChange={(e) => onPatchArea(area.id, { note: e.target.value })}
                />
              </Field>
              {area.kind === 'polygon' && (
                <p className="text-[11px] text-white/35">拖拽地图上的白色圆点可调整形状顶点</p>
              )}
              {area.kind === 'circle' && (
                <p className="text-[11px] text-white/35">
                  拖白点移动圆心，拖红点调整半径
                </p>
              )}
            </>
          )}

          {line && (
            <>
              <Field label="标注文字">
                <input
                  className={inputCls}
                  value={line.label ?? ''}
                  onChange={(e) => onPatchLine(line.id, { label: e.target.value })}
                  placeholder="例如：150 码"
                />
              </Field>
              <Field label="所属洞">
                <select
                  className={inputCls}
                  value={line.hole ?? ''}
                  onChange={(e) =>
                    onPatchLine(line.id, {
                      hole: e.target.value === '' ? undefined : Number(e.target.value),
                    })
                  }
                >
                  <option value="">不限洞</option>
                  {data.holes.map((h) => (
                    <option key={h.number} value={h.number}>
                      第 {h.number} 洞
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}

          <button
            onClick={onDelete}
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs bg-red-500/25 text-red-300 hover:bg-red-500/35"
          >
            <Trash2 className="w-3.5 h-3.5" /> 删除
          </button>
        </div>
      ) : (
        /* 浏览模式：只读详情 */
        <div className="space-y-1">
          {facility?.note && <p className="text-xs text-white/60">备注：{facility.note}</p>}
          {area?.note && <p className="text-xs text-white/60">备注：{area.note}</p>}
          {!facility?.note && !area?.note && !line && (
            <p className="text-xs text-white/35">切换到管理模式可编辑</p>
          )}
        </div>
      )}

      {/* 导航到这里 */}
      {coord && (
        <button
          onClick={() => onNavigate(coord[0], coord[1], title)}
          className="mt-2 w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs bg-blue-500/25 text-blue-200 hover:bg-blue-500/35"
        >
          <Navigation className="w-3.5 h-3.5" /> 导航到这里
        </button>
      )}
    </div>
  )
}
