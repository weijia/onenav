# 高尔夫球场数据格式对照（iGolf 公开资料 / onenav 本地格式）

> 资料访问日期：2026-11-20。
> 官方来源：<https://igolf.com/developers-igolf/>、<https://igolf.com/solutions/golf-course-data/>、<https://connectaccount.igolf.com/sign-in>。
>
> 本文只写三类内容：**iGolf 官方公开页面明确写出的能力**、**第三方可验证的非官方例子**（单独标注，不等同官方事实），以及**我们代码中的权威格式定义**。
> iGolf 的字段名、JSON 层级、端点和认证方式没有公开，本文一律标记为「待澄清」，不推测。

## 1. 结论

1. iGolf 官方开发者页**没有公开可下载的测试数据、示例 JSON 或字段级文档**。它只说明：成为合作伙伴后可取得 API、SDK、开发文档、示例 App、Postman 脚本；旧页写 30 天试用，较新的平台页写「签互相 NDA 后最长 45 天」，两处口径不同，以商务确认为准。非官方例子见第 9 节，其中没有球场障碍字段级响应样例。
2. iGolf 公开确认的 2D 矢量数据内容，覆盖我们避障引擎需要的绝大多数要素：球道、果岭、Tee 台、沙坑、水、球车道、树、球场边界、会所、每洞中心路径。
3. iGolf 公开确认的 GPS 数据还包含：果岭前/中/后点、最多 5 个 Tee 中心点、每洞最多 4 个障碍点（标记 front 或 carry）、可用时的海拔。
4. **不能据此写出 iGolf 的字段级 schema**。端点、认证、坐标顺序、坐标系、几何表达方式、障碍点是否区分类型、授权/离线存储条款，均为待澄清。
5. onenav 内部有两套格式：
   - **引擎 course-schema**：`src/golf-nav-engine/data/course-schema.js` 为权威定义；用于导航避障计算。
   - **共享 GolfData**：`src/components/apps/golf/types.ts` 为权威定义；用于两个高尔夫页面共享标注。
6. 现有文档情况：`golf-navigator/docs/DESIGN.md` 第 4 节已描述引擎 course-schema；onenav 此前没有独立的球场数据格式文档，本文补齐这一空缺。本文不修改任何代码。

## 2. iGolf 官方公开可确认的数据内容

以下为中文转述，只记录公开页面明确写出的内容。

| 数据产品 | 官方明确写出的内容 | 与避障的关系 |
| --- | --- | --- |
| 2D Golf Course Maps | 矢量地图，包含球道（fairways）、果岭（greens）、Tee 台（tee boxes）、沙坑（bunkers）、水（water）、球车道（cart paths）、树（trees）、球场边界（course boundary）、会所位置（clubhouse）、每洞中心路径（center path） | 直接对应我们的障碍几何与通行代价；中心路径对应 `centerLine` |
| Golf GPS Distance Data | 每洞果岭前/中/后点；最多 5 个 Tee 中心点；每洞最多 4 个障碍点，标记到 front 或 carry；可用时含海拔 | 可作落点风险评分输入；但我们尚不知道障碍点是否带类型 |
| Golf Scorecard & Tee Box Data | Tee 名称与颜色、男女 slope/rating、按 Tee 的码数、par、stroke index | 对应 `par` / `strokeIndex`，不直接参与避障 |
| 交付方式 | REST API，结构化 JSON；通过 iGolf Connect 交付 | 具体端点与响应结构待澄清 |
| 数据规模 | 40,000+ 球场，177 个国家 | 仅说明覆盖面 |

官方页面同时说明：数据是商业授权产品，通过合作伙伴计划或试用获取；示例库、Postman 脚本、文档在后台。公开页面未声明这些数据可自由再分发。

## 3. iGolf 待澄清项（未得出结论，不能写成需求）

- 端点 URL、请求方法、认证头、key 的申请方式与配额。
- 响应 JSON 的字段名、层级、数组命名。
- 坐标顺序是 `[lat, lng]` 还是 `[lng, lat]`，坐标系是 WGS-84 还是其他。
- 几何表达方式：树是点+半径还是多边形；球道是 polygon 还是 line；边界是轮廓线还是区域。
- 障碍点（hazard point）是否区分沙坑/水/界外，还是只有距离与 front/carry 标记。
- 每洞中心路径的点密度与是否按 Tee 分级。
- 许可证是否允许离线缓存、是否允许提交到代码仓库、是否允许跨设备同步。
- 30 天试用的申请条件、费用与商用限制。

## 4. 本地格式 A：导航引擎 course-schema

**权威定义**：`src/golf-nav-engine/data/course-schema.js`。
**内置样例**：`src/golf-nav-engine/data/sample-course.json`（18 洞，含 rough/fairway/green/cartPath 各 18、bunker 27、tree 36、outOfBounds 18、water 6）。

### 4.1 顶层字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 球场唯一标识 |
| `name` | string | 是 | 球场名称 |
| `region` | `CN` / `OVERSEAS` | 是 | 大小写不敏感，归一化后大写 |
| `coordinateSystem` | `WGS-84` / `GCJ-02` | 是 | 声明输入坐标所用坐标系 |
| `bounds` | `{ south, north, west, east }` | 否 | 缺失时由所有点计算；校验要求 `south < north` 且 `west < east` |
| `clubhouse` | 点 | 否 | 会所位置 |
| `holes` | 数组 | 是 | 不能为空 |

点可以是 `[lat, lng]` 数组，也可以是 `{ lat, lng }` 对象。引擎坐标统一按纬度在前处理。

### 4.2 每洞字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `number` | integer | 是 | 洞号 |
| `par` | number | 否 | 标准杆 |
| `tee` | 点 | 是 | 发球点 |
| `green` | 点 | 是 | 果岭点 |
| `centerLine` | 点数组 | 是 | 至少 2 个点 |
| `features` | 数组 | 是 | 几何要素；允许空数组 |

### 4.3 要素类型

合法 `type` 共 9 种：`fairway`、`green`、`tee`、`rough`、`bunker`、`water`、`tree`、`cartPath`、`outOfBounds`。

| 几何键 | 要求 | 常见用途 |
| --- | --- | --- |
| `polygon` | 至少 3 个点；归一化时自动闭合 | 球道、果岭、沙坑、水、OB |
| `line` | 至少 2 个点 | 球车道、中心路径 |
| `point` | 合法坐标点 | Tee、树；树可用 `radiusMeters` 表示冠幅 |

通行代价（`src/golf-nav-engine/geo/passability.js`）：`fairway`/`green`/`tee` = 1，`cartPath` = 0.6，`rough` = 2.5；`bunker`/`water`/`tree`/`outOfBounds` 为硬阻挡。

### 4.4 最小合法示例

```json
{
  "id": "course-01",
  "name": "示例球场",
  "region": "CN",
  "coordinateSystem": "WGS-84",
  "bounds": { "south": 40.0, "north": 40.01, "west": 116.0, "east": 116.01 },
  "holes": [
    {
      "number": 1,
      "par": 4,
      "tee": [40.002, 116.001],
      "green": [40.008, 116.009],
      "centerLine": [[40.002, 116.001], [40.008, 116.009]],
      "features": [
        { "type": "fairway", "polygon": [[40.001, 116.0], [40.009, 116.0], [40.009, 116.01], [40.001, 116.01]] },
        { "type": "bunker", "polygon": [[40.004, 116.003], [40.0045, 116.003], [40.0045, 116.0035]] },
        { "type": "tree", "point": [40.005, 116.006], "radiusMeters": 6 }
      ]
    }
  ]
}
```

### 4.5 文档与代码的已知差异

`golf-navigator/docs/DESIGN.md` 第 4.3/5.2 节写有「校验时归一化」「补全缺省 rough」。当前 onenav 内的 `course-schema.js` 会归一化大小写、闭合多边形、补 `bounds`，但**不会自动补全 `rough`**。以代码为准。

## 5. 本地格式 B：共享 GolfData

**权威定义**：`src/components/apps/golf/types.ts`。
**存储位置**：独立 PouchDB 库 `onenav-golf`，两个高尔夫页面通过 `useSharedGolfData()` 共享。

### 5.1 顶层字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `courseName` | string | 球场名称 |
| `center` | `[lng, lat]` | 地图中心，GCJ-02 |
| `zoom` | number | 地图缩放级别 |
| `holes` | `Hole[]` | 洞信息：`number`、`par`、`strokeIndex`、可选 `note` |
| `facilities` | `FacilityPoint[]` | 设施点 |
| `areas` | `AreaShape[]` | 多边形/圆形区域 |
| `lines` | `DistanceLine[]` | 码数线/测距线 |

### 5.2 坐标系约定

共享层持久化坐标**一律为 GCJ-02**，数组顺序为 `[lng, lat]`。导航引擎内部使用 WGS-84。`golfDataToCourse()` 会把共享坐标转成引擎坐标（`[lat, lng]`），并声明输出的 `coordinateSystem` 为 `WGS-84`。

因此：**把 WGS-84 的外部数据导入 GolfData 前，必须先转成 GCJ-02**；否则会被转换链再转一次，产生偏移。

### 5.3 设施与区域类型

`facilities[].type`：`tee`、`green`、`bunker`、`fairway`、`rest`、`restroom`、`cartpath`、`water`、`distance`。
`areas[].type`：`water`、`bunker`、`rough`、`ob`、`woods`、`closed`。
`areas[].kind`：`polygon`（配 `path`）/ `circle`（配 `center`、`radius`）。

### 5.4 与引擎格式的关键差异

- GolfData **没有 `centerLine` 字段**。`golfDataToCourse()` 生成的中心线固定为 `tee → green` 两点连线。
- GolfData **没有粗草区以外的面状球道/果岭类型**：区域类型中没有 `fairway` / `green`，球道只能用 `facilities` 的点表示，属于有损表达。
- 只转换同时具备 `tee` 和 `green` 设施的洞；缺任一项的洞不进入导航。
- 球车道需要至少 2 个 `cartpath` 设施点才生成 line。
- 码数线是测量辅助，不进入导航几何。

## 6. iGolf 公开内容 → 本地格式映射建议

这是**适配建议**，不是 iGolf 的字段规定。拿到官方样例后需按真实字段修正。

| iGolf 公开内容 | 引擎 course-schema | 共享 GolfData | 说明 |
| --- | --- | --- | --- |
| 球道 fairways | `feature.type = "fairway"` + `polygon` | 无等价区域类型；只能用 `facilities` 的 `fairway` 点近似 | 要保留多边形应走引擎格式 |
| 果岭 greens | `feature.type = "green"` + `polygon`；洞级 `green` 点 | `facilities` 的 `green` 点 | 果岭前/中/后点公开确认存在，但字段名未知 |
| Tee 台 tee boxes | 洞级 `tee` 点；可选 `feature.type = "tee"` | `facilities` 的 `tee` 点 + `subtype` 分级 | 多 Tee 分级需人工选定一个作为导航起点 |
| 沙坑 bunkers | `feature.type = "bunker"` + `polygon` | `areas.type = "bunker"` + `polygon` | 可直接对应 |
| 水 water | `feature.type = "water"` + `polygon` | `areas.type = "water"` + `polygon` | 可直接对应 |
| 球车道 cart paths | `feature.type = "cartPath"` + `line` | 多个 `facilities.type = "cartpath"` 点 | 共享格式没有多段线字段 |
| 树 trees | `feature.type = "tree"` + `point` / `radiusMeters` | `areas.type = "woods"` + `circle` | 前提：iGolf 数据确实提供树半径 |
| 球场边界 course boundary | 用于计算 `bounds`；若语义为界外则用 `outOfBounds` | 仅当确认是界外区时才用 `areas.type = "ob"` | 边界轮廓不等于界外区域，不能直接等同 |
| 每洞中心路径 center path | `hole.centerLine` | **无字段** | 走共享格式会丢失 |
| 会所 clubhouse | 顶层 `clubhouse` | 无字段 | 不参与避障 |
| par / stroke index | `hole.par`；`strokeIndex` 引擎未使用 | `hole.par` / `hole.strokeIndex` | 记分信息 |
| 障碍点 hazard points(front/carry) | 无直接字段 | 无直接字段 | 需确认障碍类型后才可扩展为落点风险输入 |

## 7. 使用路径（操作结论）

1. **只验证导航避障**：直接用 `src/golf-nav-engine/data/sample-course.json`，无需 iGolf。该样例已是合法 course-schema，包含全部关键障碍类型。
2. **使用真实 iGolf 数据（路径 A，两页共享）**：申请 trial → 取得文档/key/Postman → 调 2D 地图端点 → 转成 GolfData JSON → 在球场地图页「导入 JSON」。优点是两个页面共享、可在地图页查看编辑；缺点是丢失 center path，tree/cart path/boundary 有损映射，且必须先做 WGS-84→GCJ-02 转换。
3. **使用真实 iGolf 数据（路径 B，导航保真）**：转成 course-schema JSON（结构见第 4 节），直接交给引擎加载。优点是保留多边形和 center path；缺点是球场地图页看不到、也不参与共享库同步。
4. iGolf 数据为商业授权，试用数据不得提交到仓库或公开分享；是否允许离线缓存与跨设备同步，待澄清。

## 8. 文档索引

- 本文：iGolf 公开数据内容 + onenav 两套本地格式 + 映射建议。
- `golf-navigator/docs/DESIGN.md` 第 4 节：引擎 course-schema 的设计说明（部分表述与当前代码有差异，见 4.5）。
- `src/golf-nav-engine/data/course-schema.js`：引擎格式的校验与归一化权威定义。
- `src/components/apps/golf/types.ts`：共享 GolfData 的字段与坐标系权威定义。
- `src/lib/golf-shared.ts`：GolfData → course-schema 的转换规则。

## 9. 非官方 / 开放替代例子（2026-11-20 补充）

以下均**不是 iGolf 官方授权数据或官方文档**，只作为协议参考或测试数据使用。

### 9.1 `igolf-sdk`：非官方 iGolf API SDK（最有价值的协议参考）

- npm： `igolf-sdk@2.0.1`，GitHub： `MAnand59/igolf-sdk`，MIT，2026-08-26 发布。作者个人项目，未获 iGolf 背书。
- 它公开的**请求协议**（来自 README 与测试）：
  - `POST /rest/action/<ActionCode>/<appKey>/<apiVersion>/<signVersion>/<signMethod>/<signature>/<timestamp>/JSON`
  - 签名串： `actionCode/appKey/apiVersion/signVersion/signMethod/timestamp/JSON`，HMAC-SHA256，密钥 `appSecret`，结果用 URL-safe Base64 无填充。
  - 时间戳格式： `YYMMDDHHmmss±HHmm`。
  - 响应外壳：成功 `{ Status: 1, ... }`，失败 `{ Status: 0, Message: "..." }`；SDK 包装为 `{ stat: true, data }` / `{ stat: false, data: string }`。
- 公开 action code 与参数示例： `CourseList`，参数 `referenceLatitude`、`referenceLongitude`、`radius`、`page`。
- 测试中的响应仅为 mock： `{ Status: 1, Courses: [{ Id: 42, Name: "Example Golf Club" }] }`。**没有球场地图、障碍、果岭/沙坑/水等多边形响应样例**。
- 结论：可用它理解签名与请求格式，但**不能从中得到 2D 矢量数据字段**；仍需自己的 appKey/appSecret/baseUrl。

### 9.2 Open Course / T'doff：开放数据标准（可直接用于我们的导航测试）

- 站点： <https://opensourcegolf.com/open-course.html>，CC BY 4.0，无 API key。
- 完整样例： <https://opensourcegolf.com/assets/San-Marcos-Golf-Course.json>。经实际下载解析：18 洞、4 组 tee、`green.front/middle/back`、`teeBoxes` 按 tee-set ID 索引、`sharedHazards` 7 个（全部 `bunker` 多边形）、`hazardShapes` 7 个、`hazardAssignments` 7 条。
- 障碍多边形字段： `id`、`type`、`coordinates: [{ lat, lon }]`、`isClosed`；按洞关联通过 `hazardAssignments.holeNumber` 或 `hazardShapes.holeNumber`。
- 局限：该样例**没有 centerLine、fairway、water、tree、cartPath**，障碍只有沙坑；不能单独覆盖完整避障场景，需与我们的 `sample-course.json` 互补。

### 9.3 OpenGolfAPI：开放的球场空间要素接口（备选）

- 仓库： <https://github.com/opengolfapi/api>，数据仓 `opengolfapi/data`（ODbL）；PyPI 包装 `lukhed-sports` 说明读端点免 key、1000 次/天/IP。
- `get_course_features(course_id, feature_type='green'|'bunker'|...)` 返回 `center: {lat,lng}` 与 `geometry: {type:'MultiPolygon', coordinates}`，并带 `source` / `license`。
- 免费层是粗粒度 OSM 多边形，适合做测试与覆盖验证，精度不应与 iGolf 商业数据等同。

### 9.4 非官方例子的可用边界

- 能用于：验证签名请求外壳、拿到可直接转换的真实球场障碍多边形、补充我们内置 18 洞样例的不足。
- 不能用于：推断 iGolf 2D 地图的字段名、坐标顺序、hazard 点是否带类型、授权条款。这些仍为第 3 节「待澄清」。
