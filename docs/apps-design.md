# 内置小应用（Apps）设计文档

> 目标：在 OneNav 首页里新增一类"内置小应用"。每个应用是项目内的一个**独立 HTML 页面（MPA）**，在「常用」页缺省显示为一个书签卡片；用户可在设置中自定义隐藏某些应用，隐藏配置随账号跨设备同步；应用自身的数据（如记账记录）也随同步层跨设备同步。
>
> **核心动机**：不让首页一次性把全部小程序的代码都拉下来。因此每个应用是物理上独立的 HTML 文件，各自拥有独立 JS chunk，只有访问该应用页面时才下载它的代码；首页 `index.html` 只携带轻量清单元数据，不引入任何应用组件。

## 1. 背景与约束

- OneNav 是单页应用（React 18 + TS + Vite + Tailwind + shadcn/ui），**没有 React Router**，导航靠 `window.location.hash`：`onenav`=常用、`._all_`=全部、或某个 tag。
- 小应用采用**多页面（MPA）**形态，而非 SPA 内覆盖层：每个应用一个独立 `index.html` + 入口 `entry.tsx`，由 Vite 多入口构建出独立 chunk。
- 已有完整配置同步链路：`saveToAllSources` → `localStorage` + PouchDB(`cfg:app`) + WebDAV(`app_data/onenav/config.json`) + RemoteStorage（整库同步，autoMerge）。

## 2. 整体架构（MPA）

```
   轻量清单 manifest.ts   APP_MANIFEST: AppMeta[]   ← 仅元数据（id/name/icon/accent/description/entry），不含组件
        │ isAppVisible(meta, appConfig.apps)
        ▼
   常用视图 MainPage  ──► visibleApps ──► <AppCard>  ← 渲染为 <a href="apps/<id>/index.html">
        │ 点击卡片 = 跳转到独立 HTML 页面
        ▼
   apps/<id>/index.html  （物理上独立的 HTML 文件，base './' 相对路径）
        │ entry.tsx: createRoot → <AppHost component={XxxApp} .../>
        ▼
   AppHost（纯展示：返回栏 + 应用组件）  ← 组件只被该 entry import，主 bundle 不含它
        │ useAppData(appId, fallback)
        ▼
   saveAppData ──► PouchDB(app:<id>) · WebDAV(app_data/onenav/apps/<id>.json) · RemoteStorage(整库同步)

   隐藏配置：AppConfig.apps: Record<id,{hidden}> ──► saveToAllSources 复用现有同步链路
            加载时 unionAppsVisibility 跨来源并集合并，避免多端各自隐藏不同应用相互覆盖
```

### 为什么主页面不会"一次性加载所有程序"

- `manifest.ts` **只导出元数据**，不 `import` 任何应用页面组件。
- `MainPage`、`SettingsDialog` 只引用 `APP_MANIFEST`（元数据）→ 主 bundle 只含清单，不含 `BookkeepingApp` 等组件。
- 每个应用的页面组件**只被它自己的 `apps/<id>/entry.tsx` 引入** → 被 Rollup 拆到该应用专属 chunk（`dist/assets/app-<id>-*.js`）。
- 构建产物验证：`dist/index.html` 仅引用 `main-*.js`，且 `main-*.js` 中不含记账应用代码；记账代码只存在于 `dist/assets/app-bookkeeping-*.js`，并对应独立页面 `dist/apps/bookkeeping/index.html`。

## 3. 轻量清单（manifest.ts）

`src/components/apps/manifest.ts` 只放元数据，**刻意不含组件**，以保证主 bundle 不被应用代码污染：

```ts
export interface AppMeta {
  id: string          // 唯一 id，同时作为数据文档前缀 app:<id>
  name: string        // 显示名称
  icon: LucideIcon    // 图标（lucide 组件）
  accent: string      // 卡片渐变背景（tailwind from-/to- 类）
  description: string // 一句话描述
  entry: string       // 该应用独立页面的相对路径（相对于主 index.html），如 'apps/bookkeeping/index.html'
}

export const APP_MANIFEST: AppMeta[] = [ /* … */ ]

// 根据全局 apps 配置判断可见性（未配置=默认显示）
export function isAppVisible(meta: AppMeta, apps?: Record<string, { hidden: boolean }>): boolean
```

> 旧版曾把 `component` 也放进注册表（`registry.ts`），导致主 bundle 静态引入全部应用组件——该文件已删除，改为上面的轻量清单 + 各应用独立入口。

可见性语义采用**拒绝清单（visibility-map）**：`AppConfig.apps[id].hidden === true` 才隐藏；不配置或 `hidden:false` 都显示。这保证"新增应用缺省显示在常用页"。

## 4. 常用页缺省显示

在 `MainPage` 渲染书签区时，搜索框下方、标签列表上方插入一个"应用"分组（仅在 `!searchQuery` 且 `visibleApps.length > 0` 时显示）。`AppCard` 渲染为 `<a href={app.entry}>`，点击即跳转到该应用的独立 HTML 页面（而非 SPA 内覆盖层）：

```tsx
{visibleApps.length > 0 && !searchQuery.trim() && (
  <div className="mb-7">
    <p className="…">应用</p>
    <div className="flex flex-wrap gap-4 justify-center">
      {visibleApps.map(a => <AppCard key={a.id} app={a} … />)}  {/* AppCard 内部是 <a href={a.entry}> */}
    </div>
  </div>
)}
```

侧边栏、"全部"、"标签"视图**不**显示应用入口（按之前确认的范围）。

## 5. 独立页面（MPA，真·单独 HTML 文件）

- 每个应用在仓库 `apps/<id>/` 下拥有独立 `index.html` 与 `entry.tsx`。
- `vite.config.ts` 自动发现 `apps/*/index.html` 并注册为多入口（`build.rollupOptions.input`），新增应用**无需手动改 vite 配置**。
- 应用入口自挂 React、引入 `AppHost` + 自身组件 + 轻量清单元数据，并自带深色背景：
  ```tsx
  // apps/bookkeeping/entry.tsx
  createRoot(root).render(<AppHost name=… description=… accent=… icon=… component={BookkeepingApp} onBack={goBack} />)
  ```
- 返回逻辑：`onBack` 优先 `history.back()`（从首页点链接进来时即退回首页），无历史则跳 `../../index.html`（相对路径，兼容子目录部署）。
- 因为是物理独立页面：**浏览器后退键只退出应用、刷新停留在应用页、可作为独立链接收藏/部署**——这些问题在旧版 SPA 覆盖层里都无法满足。
- 不引入 react-router；应用页与首页通过真实 URL（`apps/<id>/index.html`）区分。

## 6. 隐藏配置 + 跨设备同步（重点）

- 配置落点：`AppConfig.apps?: Record<string, AppVisibility>`，`AppVisibility = { hidden: boolean }`。
- 写入：设置页"应用"标签页每个应用一个开关 → `updateApps({ [id]: { hidden } })` → `handleSave → onConfigSave → saveToAllSources`，**完全复用现有四端同步**（localStorage / PouchDB / WebDAV / RemoteStorage），零额外同步代码。
- 加载并集兜底：由于配置是单文档 last-write-wins，两台设备各自隐藏不同应用时后写方会覆盖前写方。为此在 `loadAllSources` 累积 `mergedApps`，对本地 / WebDAV / RS 三处来源的 `apps` 做并集合并——**任一来源里 `hidden:true` 都保留**：
  ```ts
  export function unionAppsVisibility(base?, incoming?): Record<string, AppVisibility> {
    const out = { ...(base || {}) }
    for (const [id, v] of Object.entries(incoming || {})) {
      if (v?.hidden) out[id] = { hidden: true }
    }
    return out
  }
  ```

## 7. 应用自身数据同步（useAppData）

`src/lib/app-data.ts` 提供应用数据的存取与同步，让有状态的应用（如记账）也能多端同步：

- 存储：PouchDB 文档 `app:<appId>`（RemoteStorage 整库同步自动覆盖）；WebDAV 额外落盘 `app_data/onenav/apps/<appId>.json`，加载时本地 PouchDB 优先、缺失回退 WebDAV 并写回本地缓存。
- 保存：`saveAppData` 写 PouchDB → 写 WebDAV → 触发 RemoteStorage 同步。
- Hook：`useAppData<T>(appId, fallback)` 返回 `{ data, loading, save }`，组件内直接读写即可。

无状态应用（如计算器、时间戳转换）不需要调用 `useAppData`。

## 8. 已落地示例：记账

`src/components/apps/BookkeepingApp.tsx` 演示完整链路：收支记录的增删与汇总。其独立入口位于 `apps/bookkeeping/`（`index.html` + `entry.tsx`），清单首项 `id:'bookkeeping'`，`accent: from-emerald-500 to-teal-600`，图标 `Wallet`。

> 记账的**数据与存储层**已修订为「统一 `type` 模型 + 每条记录独立 `bk:` 文档」，**不再使用** `useAppData('bookkeeping', { transactions: [] })` 单文档形态。详见 [`bookkeeping-data-model.md`](./bookkeeping-data-model.md)。

## 9. 如何新增一个小应用（扩展指南）

1. 在 `apps/<id>/` 下新建 `index.html`（`<script type="module" src="./entry.tsx">`）与 `entry.tsx`（默认导出页面组件，挂载 `<AppHost component={XxxApp} …/>`；如需本地数据用 `useAppData`）。
2. 在 `src/components/apps/manifest.ts` 的 `APP_MANIFEST` 追加一项（仅元数据：`id/name/icon/accent/description/entry`）。
3. **无需手动改 vite 配置**——`vite.config.ts` 已自动发现 `apps/*/index.html` 作为独立入口。
4. 无需改 MainPage / Settings / 路由——可见性与入口自动生效，默认显示在常用页。
5. 如需默认隐藏，在清单项加 `defaultHidden: true`（用户仍可在设置里打开）。

## 10. 改动文件清单（相对实现前）

| 文件 | 变更 |
| --- | --- |
| `src/types/index.ts` | 新增 `AppVisibility`、`AppConfig.apps?: Record<string, AppVisibility>` |
| `src/lib/config.ts` | 读写 `apps` 字段；默认配置 `apps: {}` |
| `src/lib/pouchdb.ts` | 新增 `saveAppDataToPouch` / `loadAppDataFromPouch`（文档前缀 `app:`） |
| `src/lib/app-data.ts` | 新增（应用数据存取 + `useAppData` Hook + 同步） |
| `src/components/apps/manifest.ts` | 新增（**轻量清单**：仅元数据 + `isAppVisible`，不含组件） |
| `src/components/apps/AppCard.tsx` | 渲染为 `<a href={app.entry}>`，点击跳转到独立页面 |
| `src/components/apps/AppHost.tsx` | 纯展示容器（接收 `name/description/accent/icon/component/onBack`） |
| `src/components/apps/BookkeepingApp.tsx` | 新增（示例应用） |
| `apps/bookkeeping/index.html` + `apps/bookkeeping/entry.tsx` | 新增（记账独立页面入口） |
| `src/components/MainPage.tsx` | 接入 `visibleApps`（来自清单）、`AppCard` 链接；移除旧 `activeApp` 覆盖层；`loadAllSources` 并集合并 `apps` |
| `src/components/SettingsDialog.tsx` | "应用"标签页改用 `APP_MANIFEST`（显隐开关） |
| `vite.config.ts` | 自动发现 `apps/*/index.html` 并注册为多入口（MPA） |
| ~~`src/components/apps/registry.ts`~~ | **已删除**（原含组件静态导入，会污染主 bundle） |

## 11. 验证状态

- `tsc -b`：通过（exit 0）。
- `vite build`：通过（exit 0；仅有与本次无关的旧 `INEFFECTIVE_DYNAMIC_IMPORT` 告警）。
- **主 bundle 不含应用代码**（已用构建产物验证）：`dist/index.html` 仅引用 `main-*.js`；`main-*.js` 中不含记账应用代码；记账代码只存在于独立 chunk `dist/assets/app-bookkeeping-*.js`，对应独立页面 `dist/apps/bookkeeping/index.html`。
- **已知细微权衡（PWA 预缓存）**：`vite-plugin-pwa` 的 `injectManifest` 会把所有构建产物（含 `apps/**`）预缓存，因此 Service Worker 在首页加载后会在**后台**把各应用 chunk 也下载下来（用于离线）。这不会阻塞/拖慢首页首屏，但与该应用 chunk 不会在首页主线程执行的事实并存。若希望连后台预取都避免，可在 PWA 配置加 `globIgnores: ['**/apps/**']`（代价是应用页不再离线可用），按需开启。
- 运行期验证建议：本地 `npm run dev`，确认常用页出现"记账"卡片 → 点击进入 `apps/bookkeeping/index.html`（地址栏变为该独立页面）→ 添加一笔 → 刷新仍停留在该应用页、数据仍在；设置"应用"里关掉记账 → 首页卡片消失；配置 WebDAV/RemoteStorage 后多设备检查隐藏配置与记账数据是否同步。
