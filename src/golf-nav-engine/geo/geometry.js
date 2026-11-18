// 基础几何运算：点为二者之一 {lat,lng} 或 [lat,lng]；多边形为坐标数组。
export function asLatLng(value) {
  if (Array.isArray(value)) return { lat: value[0], lng: value[1] };
  return { lat: value.lat, lng: value.lng };
}

export function pointInPolygon(point, polygon) {
  const p = asLatLng(point);
  if (!polygon || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = asLatLng(polygon[i]);
    const b = asLatLng(polygon[j]);
    const xi = a.lng; const yi = a.lat;
    const xj = b.lng; const yj = b.lat;
    const intersect = (yi > p.lat) !== (yj > p.lat)
      && p.lng < ((xj - xi) * (p.lat - yi)) / ((yj - yi) || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function distancePointToSegment(point, a, b) {
  const p = asLatLng(point);
  const s = asLatLng(a);
  const e = asLatLng(b);
  const dx = e.lng - s.lng;
  const dy = e.lat - s.lat;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-15) return Math.hypot(p.lng - s.lng, p.lat - s.lat);
  let t = ((p.lng - s.lng) * dx + (p.lat - s.lat) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.lng - (s.lng + t * dx), p.lat - (s.lat + t * dy));
}

export function distanceToLine(point, line) {
  if (!line || line.length < 2) return Infinity;
  let min = Infinity;
  for (let i = 0; i < line.length - 1; i += 1) {
    min = Math.min(min, distancePointToSegment(point, line[i], line[i + 1]));
  }
  return min;
}

export function distanceToPolygon(point, polygon) {
  if (!polygon || polygon.length === 0) return Infinity;
  if (pointInPolygon(point, polygon)) return 0;
  let min = Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    min = Math.min(min, distancePointToSegment(point, polygon[i], polygon[(i + 1) % polygon.length]));
  }
  return min;
}

// feature 支持 polygon / line / point(+radius)
export function distanceToFeature(point, feature) {
  if (feature.polygon) return distanceToPolygon(point, feature.polygon);
  if (feature.line) return distanceToLine(point, feature.line);
  if (feature.point) {
    const p = asLatLng(point);
    const c = asLatLng(feature.point);
    const d = Math.hypot(p.lng - c.lng, p.lat - c.lat);
    return Math.max(0, d - (feature.radiusMeters || 0) / 111320);
  }
  return Infinity;
}

export function bboxOf(geometry) {
  const points = [];
  const collect = (v) => {
    if (Array.isArray(v) && typeof v[0] === 'number') points.push(asLatLng(v));
    else if (v && typeof v === 'object' && typeof v.lat === 'number') points.push(asLatLng(v));
    else if (Array.isArray(v)) v.forEach(collect);
  };
  collect(geometry);
  if (points.length === 0) return null;
  return {
    south: Math.min(...points.map((p) => p.lat)),
    north: Math.max(...points.map((p) => p.lat)),
    west: Math.min(...points.map((p) => p.lng)),
    east: Math.max(...points.map((p) => p.lng)),
  };
}

export function latLngDistance(a, b) {
  const p = asLatLng(a); const q = asLatLng(b);
  return Math.hypot(
    (q.lat - p.lat) * 111320,
    (q.lng - p.lng) * 111320 * Math.cos(((p.lat + q.lat) / 2) * Math.PI / 180),
  );
}
