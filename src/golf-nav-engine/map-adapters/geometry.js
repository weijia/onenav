// 地图适配层共享几何：样式常量、点归一化、圆域、由球场数据构建统一几何。
// 所有几何点一律为业务坐标 WGS-84 的 {lat, lng}；转显示坐标由各适配器负责。
import { normalizePoint } from '../data/coordinates.js';

export const STYLE_COLORS = {
  fairway: 'rgba(168, 214, 145, 0.65)',
  green: 'rgba(110, 190, 120, 0.9)',
  tee: 'rgba(255, 255, 255, 0.85)',
  rough: 'rgba(210, 222, 190, 0.45)',
  bunker: 'rgba(232, 205, 150, 0.95)',
  water: 'rgba(120, 180, 230, 0.9)',
  tree: 'rgba(60, 130, 70, 0.9)',
  outOfBounds: 'rgba(200, 90, 90, 0.28)',
  cartPath: 'rgba(255, 255, 255, 0.9)',
};

export const FEATURE_LABELS = {
  fairway: '球道',
  green: '果岭',
  tee: '发球台',
  rough: '长草区',
  bunker: '沙坑',
  water: '水障碍',
  tree: '树木',
  cartPath: '球车道',
  outOfBounds: '界外区',
  center: '球道中心线',
};

export const LINE_STYLES = {
  center: { color: '#5a5a5a', width: 2, opacity: 0.6 },
  cart: { color: '#ffffff', width: 3, opacity: 1 },
  route: { color: '#185fa5', width: 6, opacity: 1 },
};

export const MARKER_COLORS = {
  me: '#378add',
  target: '#d85a30',
  landing: '#1d9e75',
};

export function toBusinessPoint(point) {
  const { lat, lng } = normalizePoint(point);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`非法坐标点：${JSON.stringify(point)}`);
  }
  return { lat, lng };
}

// 圆形树冠：返回 12 个业务坐标点
export function circlePaths(center, radiusMeters) {
  const c = toBusinessPoint(center);
  const result = [];
  for (let i = 0; i < 12; i += 1) {
    const angle = (i / 12) * Math.PI * 2;
    const dLat = (radiusMeters * Math.sin(angle)) / 111320;
    const dLng = (radiusMeters * Math.cos(angle)) / (111320 * Math.cos((c.lat * Math.PI) / 180));
    result.push({ lat: c.lat + dLat, lng: c.lng + dLng });
  }
  return result;
}

// 由球场数据构建与 SDK 无关的统一几何（业务坐标）
export function buildCourseGeometry(course) {
  const polygons = [];
  const lines = [];
  course.holes.forEach((hole) => {
    (hole.features || []).forEach((f, i) => {
      const id = `h${hole.number}-f${i}`;
      const meta = { featureType: f.type, hole: hole.number, featureIndex: i };
      if (f.polygon && STYLE_COLORS[f.type] && f.type !== 'tree') {
        polygons.push({ ...meta, id, styleId: f.type, paths: f.polygon.map(toBusinessPoint) });
      }
      if (f.line && f.type === 'cartPath') {
        lines.push({ ...meta, id, styleId: 'cart', paths: f.line.map(toBusinessPoint) });
      }
      if (f.point && f.type === 'tree') {
        polygons.push({ ...meta, id, styleId: 'tree', paths: circlePaths(f.point, f.radiusMeters || 6) });
      }
    });
    lines.push({
      id: `h${hole.number}-center`,
      featureType: 'center',
      hole: hole.number,
      featureIndex: -1,
      styleId: 'center',
      paths: hole.centerLine.map(toBusinessPoint),
    });
  });
  return { polygons, lines };
}

// CSS rgba/rgb 字符串拆成 Leaflet 可用的 color + opacity
export function parseColor(css) {
  const m = /rgba?\(([^)]+)\)/.exec(String(css));
  if (!m) return { color: css, opacity: 1 };
  const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
  const color = `rgb(${parts[0]},${parts[1]},${parts[2]})`;
  return { color, opacity: parts.length > 3 ? parts[3] : 1 };
}
