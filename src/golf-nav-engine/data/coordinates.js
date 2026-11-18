// WGS-84 / GCJ-02 坐标换算，纯函数，无外部依赖。
const PI = Math.PI;
const A = 6378245.0;
const EE = 0.00669342162296594323;

export function outOfChina(lat, lng) {
  return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
  return ret;
}

export function wgs84ToGcj02(lat, lng) {
  if (outOfChina(lat, lng)) return [lat, lng];
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
  dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * PI);
  return [lat + dLat, lng + dLng];
}

export function gcj02ToWgs84(lat, lng) {
  if (outOfChina(lat, lng)) return [lat, lng];
  let wLat = lat;
  let wLng = lng;
  for (let i = 0; i < 8; i += 1) {
    const [gLat, gLng] = wgs84ToGcj02(wLat, wLng);
    const dLat = lat - gLat;
    const dLng = lng - gLng;
    wLat += dLat;
    wLng += dLng;
    if (Math.abs(dLat) < 1e-11 && Math.abs(dLng) < 1e-11) break;
  }
  return [wLat, wLng];
}

// 业务数据统一以 WGS-84 存储；渲染前按目标底图区域换算。
export function toDisplay(lat, lng, region, sourceSystem = 'WGS-84') {
  const target = String(region).toUpperCase() === 'CN' ? 'CN' : 'OVERSEAS';
  if (target === 'OVERSEAS') return [lat, lng];
  if (String(sourceSystem).toUpperCase() === 'GCJ-02') return [lat, lng];
  return wgs84ToGcj02(lat, lng);
}

// 把 [lat, lng] 数组、{lat, lng} 对象、类数组对象、带 getter 的点统一为 {lat, lng}。
// 类数组对象（如 {0: lat, 1: lng}）常由展开运算符误产生，必须在此兜住。
export function normalizePoint(point) {
  if (Array.isArray(point)) return { lat: Number(point[0]), lng: Number(point[1]) };
  if (point && typeof point === 'object') {
    let lat = typeof point.lat === 'function' ? point.lat() : point.lat;
    let lng = typeof point.lng === 'function' ? point.lng() : point.lng;
    if (lat === undefined && lng === undefined
      && typeof point[0] === 'number' && typeof point[1] === 'number') {
      lat = point[0];
      lng = point[1];
    }
    return { lat: Number(lat), lng: Number(lng) };
  }
  return { lat: NaN, lng: NaN };
}

// 显示坐标（底图坐标系）反解回业务坐标 WGS-84，供地图点击设点使用。
export function fromDisplay(lat, lng, region) {
  return String(region).toUpperCase() === 'CN' ? gcj02ToWgs84(lat, lng) : [lat, lng];
}

const LAT_METERS = 111320;

export function toLocalMeters(lat, lng, origin) {
  const latRad = (origin.lat * PI) / 180;
  return {
    x: (lng - origin.lng) * LAT_METERS * Math.cos(latRad),
    y: (lat - origin.lat) * LAT_METERS,
  };
}

export function localToLatLng(x, y, origin) {
  const latRad = (origin.lat * PI) / 180;
  return {
    lat: origin.lat + y / LAT_METERS,
    lng: origin.lng + x / (LAT_METERS * Math.cos(latRad)),
  };
}
