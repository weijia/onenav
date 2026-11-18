// 示例球场数据加载、校验与归一化。格式贴近 iGolf 2D 矢量。
import { bboxOf } from '../geo/geometry.js';

export const FEATURE_TYPES = [
  'fairway', 'green', 'tee', 'rough', 'bunker', 'water', 'tree', 'cartPath', 'outOfBounds',
];

function isPoint(v) {
  return (Array.isArray(v) && v.length >= 2 && v.every((n) => typeof n === 'number'))
    || (v && typeof v === 'object' && typeof v.lat === 'number' && typeof v.lng === 'number');
}

function isPolygon(v) {
  return Array.isArray(v) && v.length >= 3 && v.every(isPoint);
}

function isLine(v) {
  return Array.isArray(v) && v.length >= 2 && v.every(isPoint);
}

function closePolygon(polygon) {
  if (!isPolygon(polygon)) return polygon;
  const first = polygon[0];
  const last = polygon[polygon.length - 1];
  const same = Array.isArray(first) && Array.isArray(last)
    ? first[0] === last[0] && first[1] === last[1]
    : first.lat === last.lat && first.lng === last.lng;
  return same ? polygon : [...polygon, first];
}

export function validateCourse(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: [{ path: '$', message: '数据不是对象' }], course: null };
  }
  if (!raw.id) errors.push({ path: '$.id', message: '缺少球场 id' });
  if (!raw.name) errors.push({ path: '$.name', message: '缺少球场名称' });
  const region = String(raw.region || '').toUpperCase();
  if (region !== 'CN' && region !== 'OVERSEAS' && region !== 'OVerseas'.toUpperCase()) {
    errors.push({ path: '$.region', message: 'region 必须为 CN 或 OVERSEAS' });
  }
  const cs = String(raw.coordinateSystem || '').toUpperCase();
  if (cs !== 'WGS-84' && cs !== 'GCJ-02') {
    errors.push({ path: '$.coordinateSystem', message: 'coordinateSystem 必须为 WGS-84 或 GCJ-02' });
  }
  if (!Array.isArray(raw.holes) || raw.holes.length === 0) {
    errors.push({ path: '$.holes', message: 'holes 不能为空数组' });
  } else {
    raw.holes.forEach((hole, hi) => {
      const base = `$.holes[${hi}]`;
      if (!Number.isInteger(hole.number)) errors.push({ path: `${base}.number`, message: '洞号必须为整数' });
      if (!isPoint(hole.tee)) errors.push({ path: `${base}.tee`, message: 'tee 必须为坐标点' });
      if (!isPoint(hole.green)) errors.push({ path: `${base}.green`, message: 'green 必须为坐标点' });
      if (!isLine(hole.centerLine)) errors.push({ path: `${base}.centerLine`, message: 'centerLine 至少需 2 个坐标点' });
      if (!Array.isArray(hole.features)) {
        errors.push({ path: `${base}.features`, message: 'features 必须为数组' });
      } else {
        hole.features.forEach((f, fi) => {
          const fp = `${base}.features[${fi}]`;
          if (!FEATURE_TYPES.includes(f.type)) {
            errors.push({ path: `${fp}.type`, message: `未知要素类型 ${f.type}` });
          }
          if (f.polygon && !isPolygon(f.polygon)) errors.push({ path: `${fp}.polygon`, message: '多边形至少需要 3 个点' });
          if (f.line && !isLine(f.line)) errors.push({ path: `${fp}.line`, message: '线段至少需要 2 个点' });
          if (f.point && !isPoint(f.point)) errors.push({ path: `${fp}.point`, message: '点坐标非法' });
        });
      }
    });
  }
  if (raw.bounds) {
    const b = raw.bounds;
    if (!(b.south < b.north)) errors.push({ path: '$.bounds', message: 'south 必须小于 north' });
    if (!(b.west < b.east)) errors.push({ path: '$.bounds', message: 'west 必须小于 east' });
  }
  return { ok: errors.length === 0, errors, course: errors.length === 0 ? raw : null };
}

export function normalizeCourse(raw) {
  const course = JSON.parse(JSON.stringify(raw));
  course.region = String(course.region).toUpperCase();
  course.coordinateSystem = String(course.coordinateSystem).toUpperCase();
  course.holes.forEach((hole) => {
    if (hole.features) {
      hole.features.forEach((f) => {
        if (f.polygon) f.polygon = closePolygon(f.polygon);
      });
    }
  });
  if (!course.bounds) {
    const all = course.holes.flatMap((h) => [h.tee, h.green, ...(h.centerLine || []),
      ...(h.features || []).flatMap((f) => [f.polygon, f.line, f.point].filter(Boolean))]);
    const box = bboxOf(all);
    if (box) course.bounds = box;
  }
  return course;
}

export function loadCourse(raw) {
  const result = validateCourse(raw);
  if (!result.ok) return result;
  return { ok: true, errors: [], course: normalizeCourse(result.course) };
}

export function getHole(course, number) {
  return course.holes.find((h) => h.number === Number(number)) || null;
}

export function getAllFeatures(course, holeNumbers = null) {
  const holes = holeNumbers
    ? course.holes.filter((h) => holeNumbers.includes(h.number))
    : course.holes;
  const features = holes.flatMap((h) => h.features || []);
  holes.forEach((h) => {
    features.push({ type: 'green', polygon: null, point: h.green });
    features.push({ type: 'tee', polygon: null, point: h.tee });
  });
  return features;
}

export function courseOrigin(course) {
  const b = course.bounds;
  return { lat: (b.south + b.north) / 2, lng: (b.west + b.east) / 2 };
}
