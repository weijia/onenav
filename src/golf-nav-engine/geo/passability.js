// 通行性建模：把球场矢量要素栅格化为可通行/不可通行与地形代价。
import { toLocalMeters, localToLatLng } from '../data/coordinates.js';

const BASE_COST = {
  rough: 2.5,
  fairway: 1,
  green: 1,
  tee: 1,
  cartPath: 0.6,
};
const APPLY_ORDER = ['rough', 'fairway', 'green', 'tee', 'cartPath', 'bunker', 'water', 'tree', 'outOfBounds', 'rest'];
// 默认阻挡集合：真障碍 + 休息区（人不穿过休息区），供找路/击球决策使用。
const BLOCKING = new Set(['bunker', 'water', 'tree', 'outOfBounds', 'rest']);
// 障碍类型 → 数字编码（供 TypedArray 存储），以及反查表。
// 编码覆盖全部要素类型：避障漫游可以把整片标注区域（长草区/球道/果岭/发球台）都当障碍。
const BLOCK_CODE = {
  bunker: 1, water: 2, tree: 3, outOfBounds: 4,
  rough: 5, fairway: 6, green: 7, tee: 8, cartPath: 9, rest: 10,
};
const CODE_BLOCK = {
  1: 'bunker', 2: 'water', 3: 'tree', 4: 'outOfBounds',
  5: 'rough', 6: 'fairway', 7: 'green', 8: 'tee', 9: 'cartPath', 10: 'rest',
};

function mPoint(value, origin) {
  if (Array.isArray(value)) return toLocalMeters(value[0], value[1], origin);
  return toLocalMeters(value.lat, value.lng, origin);
}

function inPolygonLocal(p, polygon) {
  if (!polygon || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]; const b = polygon[j];
    if (((a.y > p.y) !== (b.y > p.y))
      && p.x < ((b.x - a.x) * (p.y - a.y)) / ((b.y - a.y) || 1e-12) + a.x) inside = !inside;
  }
  return inside;
}

function distToSegmentLocal(p, a, b) {
  const dx = b.x - a.x; const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function bboxOfLocal(points) {
  return {
    minX: Math.min(...points.map((p) => p.x)),
    maxX: Math.max(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxY: Math.max(...points.map((p) => p.y)),
  };
}

export function buildGrid(course, options = {}) {
  const resolution = Number(options.resolutionMeters) > 0 ? Number(options.resolutionMeters) : 2;
  const origin = options.origin || {
    lat: (course.bounds.south + course.bounds.north) / 2,
    lng: (course.bounds.west + course.bounds.east) / 2,
  };
  const bounds = options.bounds || course.bounds;
  const sw = toLocalMeters(bounds.south, bounds.west, origin);
  const ne = toLocalMeters(bounds.north, bounds.east, origin);
  const padding = 12;
  const minX = Math.floor((sw.x - padding) / resolution) * resolution;
  const minY = Math.floor((sw.y - padding) / resolution) * resolution;
  const maxX = Math.ceil((ne.x + padding) / resolution) * resolution;
  const maxY = Math.ceil((ne.y + padding) / resolution) * resolution;
  let width = Math.ceil((maxX - minX) / resolution) + 1;
  let height = Math.ceil((maxY - minY) / resolution) + 1;
  // 防止异常 bounds 造成内存暴涨
  const MAX_CELLS = 2500000;
  if (width * height > MAX_CELLS) {
    const scale = Math.sqrt((width * height) / MAX_CELLS);
    return buildGrid(course, { ...options, resolutionMeters: resolution * scale });
  }
  // 哪些要素类型算不可通行。默认只算真障碍；漫游可通过 blockingTypes 传入
  // 「所有标注区域」的类型，让球道/果岭/长草区等面上要素也能挡住脚步。
  const blocking = Array.isArray(options.blockingTypes) && options.blockingTypes.length
    ? new Set(options.blockingTypes)
    : BLOCKING;
  const size = width * height;
  const blocked = new Uint8Array(size);
  // 记录每个受阻格被哪类障碍占据（数字编码），供「可走方向 + 受阻原因」提示使用。
  const blockerCode = new Uint8Array(size);
  const cost = new Float32Array(size).fill(1);
  const grid = { origin, resolution, minX, minY, width, height, blocked, cost, blockerCode };

  const holes = options.holeNumbers
    ? course.holes.filter((h) => options.holeNumbers.includes(h.number))
    : course.holes;
  const features = holes.flatMap((h) => h.features || []);

  APPLY_ORDER.forEach((type) => {
    features.filter((f) => f.type === type).forEach((f) => {
      let polygon = null; let line = null; let circle = null;
      if (f.polygon) polygon = f.polygon.map((p) => mPoint(p, origin));
      if (f.line) line = f.line.map((p) => mPoint(p, origin));
      if (f.point) circle = { ...mPoint(f.point, origin), radius: f.radiusMeters || 0 };
      if (!polygon && !line && !circle) return;

      const candidates = [];
      if (polygon) candidates.push(bboxOfLocal(polygon));
      if (line) candidates.push(bboxOfLocal(line));
      if (circle) candidates.push({ minX: circle.x - circle.radius, maxX: circle.x + circle.radius,
        minY: circle.y - circle.radius, maxY: circle.y + circle.radius });
      const area = {
        minX: Math.min(...candidates.map((b) => b.minX)),
        maxX: Math.max(...candidates.map((b) => b.maxX)),
        minY: Math.min(...candidates.map((b) => b.minY)),
        maxY: Math.max(...candidates.map((b) => b.maxY)),
      };
      const c0 = Math.max(0, Math.floor((area.minX - minX) / resolution));
      const c1 = Math.min(width - 1, Math.ceil((area.maxX - minX) / resolution));
      const r0 = Math.max(0, Math.floor((area.minY - minY) / resolution));
      const r1 = Math.min(height - 1, Math.ceil((area.maxY - minY) / resolution));
      for (let row = r0; row <= r1; row += 1) {
        for (let col = c0; col <= c1; col += 1) {
          const p = { x: minX + (col + 0.5) * resolution, y: minY + (row + 0.5) * resolution };
          let hit = false;
          if (polygon && inPolygonLocal(p, polygon)) hit = true;
          if (!hit && line) {
            for (let i = 0; i < line.length - 1 && !hit; i += 1) {
              if (distToSegmentLocal(p, line[i], line[i + 1]) <= 1.5) hit = true;
            }
          }
          if (!hit && circle) hit = Math.hypot(p.x - circle.x, p.y - circle.y) <= circle.radius;
          if (!hit) continue;
          const idx = row * width + col;
          if (blocking.has(type)) { blocked[idx] = 1; blockerCode[idx] = BLOCK_CODE[type] || 0; }
          else if (BASE_COST[type]) cost[idx] = BASE_COST[type];
        }
      }
    });
  });

  // 障碍膨胀一格，避免路径贴边穿越；膨胀格继承障碍类型以便给出受阻原因
  const snapshot = blocked.slice();
  const snapshotCode = blockerCode.slice();
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const idx = row * width + col;
      if (!snapshot[idx]) continue;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const rr = row + dy; const cc = col + dx;
          if (rr >= 0 && rr < height && cc >= 0 && cc < width) {
            const nIdx = rr * width + cc;
            blocked[nIdx] = 1;
            if (!blockerCode[nIdx] && snapshotCode[idx]) blockerCode[nIdx] = snapshotCode[idx];
          }
        }
      }
    }
  }
  return grid;
}

export function cellIndex(grid, col, row) {
  return row * grid.width + col;
}

export function worldToCell(grid, point) {
  const ll = Array.isArray(point) ? { lat: point[0], lng: point[1] } : point;
  const local = ll.x !== undefined ? ll : toLocalMeters(ll.lat, ll.lng, grid.origin);
  return {
    col: Math.max(0, Math.min(grid.width - 1, Math.floor((local.x - grid.minX) / grid.resolution))),
    row: Math.max(0, Math.min(grid.height - 1, Math.floor((local.y - grid.minY) / grid.resolution))),
  };
}

export function cellToLatLng(grid, col, row) {
  return localToLatLng(grid.minX + (col + 0.5) * grid.resolution,
    grid.minY + (row + 0.5) * grid.resolution, grid.origin);
}

export function isBlocked(grid, col, row) {
  if (col < 0 || row < 0 || col >= grid.width || row >= grid.height) return true;
  return grid.blocked[cellIndex(grid, col, row)] === 1;
}

// 返回该格受阻的障碍类型（如 bunker/water/tree/outOfBounds），可通行或越界返回 null。
export function blockerTypeAt(grid, col, row) {
  if (col < 0 || row < 0 || col >= grid.width || row >= grid.height) return null;
  if (!grid.blockerCode) return null;
  return CODE_BLOCK[grid.blockerCode[cellIndex(grid, col, row)]] || null;
}

export function costAt(grid, col, row, mode = 'walk') {
  if (isBlocked(grid, col, row)) return Infinity;
  if (mode === 'cart') {
    // 球车模式预留：仅球车道可走（cartPath 代价 0.6，其它置高代价）
    const c = grid.cost[cellIndex(grid, col, row)];
    return c <= 0.6 ? 0.6 : Infinity;
  }
  return grid.cost[cellIndex(grid, col, row)];
}

export function snapToPassable(grid, col, row, maxRadius = 40) {
  if (!isBlocked(grid, col, row)) return { col, row, snapped: false };
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const c = col + dx; const r = row + dy;
        if (!isBlocked(grid, c, r)) return { col: c, row: r, snapped: true };
      }
    }
  }
  return null;
}
