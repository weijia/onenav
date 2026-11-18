// 地图适配器注册表与工厂。切换底图只改 provider 参数，业务代码零改动。
import { TencentAdapter } from './tencent-adapter.js';
import { AmapAdapter } from './amap-adapter.js';
import { CanvasAdapter } from './canvas-adapter.js';

export const PROVIDERS = {
  tencent: { label: '腾讯地图 GL JS', Adapter: TencentAdapter, needsSdk: 'tmap' },
  amap: { label: '高德地图（Leaflet）', Adapter: AmapAdapter, needsSdk: 'leaflet' },
  canvas: { label: '矢量示意图（无底图）', Adapter: CanvasAdapter, needsSdk: null },
};

export function availableProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label }));
}

export function sdkReady(providerId, { TMap, L } = {}) {
  const need = PROVIDERS[providerId] && PROVIDERS[providerId].needsSdk;
  if (need === 'tmap') return !!TMap;
  if (need === 'leaflet') return !!L;
  return true;
}

// 创建适配器实例。canvas 需要 course/canvas，其余需要 region/(L)。
export function createAdapter(providerId, options) {
  const def = PROVIDERS[providerId];
  if (!def) throw new Error(`未知地图适配器：${providerId}`);
  if (providerId === 'canvas') {
    return new CanvasAdapter(options.course, options.canvas);
  }
  if (providerId === 'amap') {
    return new AmapAdapter(options.region, options.L);
  }
  return new TencentAdapter(options.region);
}
