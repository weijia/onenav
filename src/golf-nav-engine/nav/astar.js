// A* 路径规划：8 邻域，禁止斜穿障碍角点，代价含地形权重。
import { cellIndex, costAt, isBlocked } from '../geo/passability.js';

class MinHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    if (a.length === 0) return null;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1; const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

function octile(dx, dy) {
  const ax = Math.abs(dx); const ay = Math.abs(dy);
  return Math.max(ax, ay) + (Math.SQRT2 - 1) * Math.min(ax, ay);
}

function smooth(points) {
  if (points.length <= 2) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = out[out.length - 1]; const b = points[i]; const c = points[i + 1];
    const cross = (b.col - a.col) * (c.row - b.row) - (b.row - a.row) * (c.col - b.col);
    if (cross !== 0) out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}

export function findPath(grid, start, goal, options = {}) {
  const mode = options.mode || 'walk';
  const maxExpand = options.maxExpand || 800000;
  if (isBlocked(grid, start.col, start.row) || isBlocked(grid, goal.col, goal.row)) {
    return { found: false, points: [], totalCost: Infinity, distanceMeters: 0, expanded: 0 };
  }
  const size = grid.width * grid.height;
  const gScore = new Float64Array(size).fill(Infinity);
  const gDist = new Float64Array(size).fill(Infinity);
  const cameFrom = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);
  const startIdx = cellIndex(grid, start.col, start.row);
  const goalIdx = cellIndex(grid, goal.col, goal.row);
  const minCost = 0.6;
  const heap = new MinHeap();
  gScore[startIdx] = 0;
  gDist[startIdx] = 0;
  heap.push({ idx: startIdx, col: start.col, row: start.row, f: octile(goal.col - start.col, goal.row - start.row) * minCost });
  let expanded = 0;

  while (heap.size > 0) {
    const current = heap.pop();
    if (closed[current.idx]) continue;
    closed[current.idx] = 1;
    expanded += 1;
    if (current.idx === goalIdx) {
      const points = [];
      let idx = goalIdx;
      while (idx !== -1) {
        points.push({ col: idx % grid.width, row: Math.floor(idx / grid.width) });
        idx = cameFrom[idx];
      }
      points.reverse();
      const simplified = options.smooth === false ? points : smooth(points);
      return {
        found: true,
        points: simplified,
        totalCost: gScore[goalIdx],
        distanceMeters: gDist[goalIdx],
        expanded,
      };
    }
    if (expanded > maxExpand) break;

    for (const [dx, dy, step] of DIRS) {
      const nc = current.col + dx; const nr = current.row + dy;
      if (isBlocked(grid, nc, nr)) continue;
      if (dx !== 0 && dy !== 0
        && (isBlocked(grid, current.col + dx, current.row) || isBlocked(grid, current.col, current.row + dy))) continue;
      const nIdx = cellIndex(grid, nc, nr);
      if (closed[nIdx]) continue;
      const terrain = costAt(grid, nc, nr, mode);
      if (!Number.isFinite(terrain)) continue;
      const tentative = gScore[current.idx] + step * terrain;
      if (tentative < gScore[nIdx]) {
        gScore[nIdx] = tentative;
        gDist[nIdx] = gDist[current.idx] + step * grid.resolution;
        cameFrom[nIdx] = current.idx;
        heap.push({ idx: nIdx, col: nc, row: nr, f: tentative + octile(goal.col - nc, goal.row - nr) * minCost });
      }
    }
  }
  return { found: false, points: [], totalCost: Infinity, distanceMeters: 0, expanded };
}
