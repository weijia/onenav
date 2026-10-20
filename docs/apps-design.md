# 内置小应用（Apps）设计文档

> 目标：在 OneNav 首页里新增一类"内置小应用"。每个应用是项目内的一个独立页面，在「常用」页缺省显示为一个书签卡片；用户可在设置中自定义隐藏某些应用，隐藏配置随账号跨设备同步；应用自身的数据（如记账记录）也随同步层跨设备同步。

## 1. 背景与约束

- OneNav 是单页应用（React 18 + TS + Vite + Tailwind + shadcn/ui），**没有 React Router**，导航靠 `window.location.hash`：`onenav`=常用、`._all_`=全部、或某个 tag。
- 已有完整配置同步链路：`saveToAllSources` → `localStorage` + PouchDB(`cfg:app`) + WebDAV(`app_data/onenav/config.json`) + RemoteStorage（整库同步，autoMerge）。
- 书签瓦片由 `BookmarkGrid → BookmarkItem` 渲染；应用入口复用同一视觉风格，但**点击不跳外链**，而是打开同站全屏页面。

## 2. 整体架构

```
                  ┌─────────────────────────────┐
   注册表 registry │  APP_REGISTRY: AppDefinition[] │ 代码内清单，新增应用=加一项
                  └───────────────┬─────────────┘
                                  │ isAppVisible(app, appConfig.apps)
                                  ▼
   常用视图(MainPage)  ──► visibleApps ──► <AppCard> 卡片（书签区顶部"应用"分组）
                                  │ 点击 AppCard
                                  ▼
                          setActiveApp(id) ──► <AppHost> 全屏覆盖（顶部"← 返回"）
                                  │ React 直接挂载（非懒加载，注册表体量小）
                                  ▼
                          app.component（如 BookkeepingApp）
                                  │ useAppData(appId, fallback)
                                  ▼
          saveAppData ──► PouchDB(app:<id>) · WebDAV(app_data/onenav/apps/<id>.json) · RemoteStorage(整库同步)

   隐藏配置：AppConfig.apps: Record<id, {hidden}> ──► saveToAllSources 复用现有同步链路
            加载时 unionAppsVisibility 跨来源并集合并，避免多端各自隐藏不同应用相互覆盖
```

## 3. 应用注册表（registry.ts）

`src/components/apps/registry.ts` 定义应用清单。新增应用 = 在此追加一项并实现页面组件，无需改动其它文件。

```ts
export interface AppDefinition {
  id: string                 // 唯一 id，同时作为数据文档前缀 app:<id>
  name: string               // 显示名称
  icon: LucideIcon           // 图标（lucide 组件）
  accent: string             // 卡片渐变背景（tailwind from-/to- 类）
  description: string        // 一句话描述
  component: ComponentType   // 独立页面组件
  defaultHidden?: boolean    // 默认是否隐藏，缺省 false（即默认显示）
}

export const APP_REGISTRY: AppDefinition[] = [ /* … */ ]

// 根据全局 apps 配置判断可见性（未配置=默认显示）
export function isAppVisible(app, apps?): boolean
```

可见性语义采用**拒绝清单（visibility-map）**：`AppConfig.apps[id].hidden === true` 才隐藏；不配置或 `hidden:false` 都显示。这保证"新增应用缺省显示在常用页"——只要不写进 `apps[id].hidden`，用户就能看到。

## 4. 常用页缺省显示

在 `MainPage` 渲染书签区时，搜索框下方、标签列表上方插入一个"应用"分组（仅在 `!searchQuery` 且 `visibleApps.length > 0` 时显示）：

```tsx
{visibleApps.length > 0 && !searchQuery.trim() && (
  <div className="mb-7">
    <p className="…">应用</p>
    <div className="flex flex-wrap gap-4 justify-center">
      {visibleApps.map(a => <AppCard key={a.id} app={a} … onClick={setActiveApp} />)}
    </div>
  </div>
)}
```

`AppCard` 外观与书签卡片一致（同一套 `iconSize / borderRadius / nameSize`），点击回调 `setActiveApp(id)` 打开应用，而非 `window.open`。侧边栏、"全部"、"标签"视图**不**显示应用入口（按之前确认的范围）。

## 5. 独立页面与路由

- 不引入 react-router。复用 hash：`activeApp` 为 `null` 时显示书签区；非 `null` 时渲染 `<AppHost appId={activeApp} onBack={() => setActiveApp(null)} />` 全屏覆盖层（带"← 返回书签"）。
- `handleTagSelect` 切换 tag 时会 `setActiveApp(null)`，避免从应用页跳 tag 时残留。
- 应用页面组件由注册表直接挂载（`AppHost` 内 `def.component`），注册表体量小，未做 `React.lazy` 代码分割（如需按需加载可后续改 `React.lazy(() => import(...))`）。

## 6. 隐藏配置 + 跨设备同步（重点）

- 配置落点：`AppConfig.apps?: Record<string, AppVisibility>`，`AppVisibility = { hidden: boolean }`。
- 写入：设置页"应用"标签页每个应用一个开关 → `updateApps({ [id]: { hidden } })` → `handleSave → onConfigSave → saveToAllSources`，**完全复用现有四端同步**（localStorage / PouchDB / WebDAV / RemoteStorage），零额外同步代码。
- 加载并集兜底（之前确认的方案）：由于配置是单文档 last-write-wins，两台设备各自隐藏不同应用时后写方会覆盖前写方。为此在 `loadAllSources` 中累积 `mergedApps`，对本地 / WebDAV / RS 三处来源的 `apps` 做并集合并——**任一来源里 `hidden:true` 都保留**：

```ts
export function unionAppsVisibility(base?, incoming?): Record<string, AppVisibility> {
  const out = { ...(base || {}) }
  for (const [id, v] of Object.entries(incoming || {})) {
    if (v?.hidden) out[id] = { hidden: true }
  }
  return out
}
```

> 注意：文档级冲突（如两台设备同时改了 display 与 app 隐藏）仍由现有同步引擎的 autoMerge 处理；本并集仅保证"应用隐藏"这一子字段不被整体覆盖掉。

## 7. 应用自身数据同步（useAppData）

`src/lib/app-data.ts` 提供应用数据的存取与同步，让有状态的应用（如记账）也能多端同步：

- 存储：PouchDB 文档 `app:<appId>`（RemoteStorage 整库同步自动覆盖）；WebDAV 额外落盘 `app_data/onenav/apps/<appId>.json`，加载时本地 PouchDB 优先、缺失回退 WebDAV 并写回本地缓存。
- 保存：`saveAppData` 写 PouchDB → 写 WebDAV → 触发 `scheduleAutoSync`（RemoteStorage）。
- Hook：`useAppData<T>(appId, fallback)` 返回 `{ data, loading, save }`，组件内直接读写即可。

无状态应用（如计算器、时间戳转换）不需要调用 `useAppData`。

## 8. 已落地示例：记账

`src/components/apps/BookkeepingApp.tsx` 演示完整链路：收支记录的增删与汇总，数据经 `useAppData('bookkeeping', { transactions: [] })` 跨设备同步。注册表首项即记账，`accent: from-emerald-500 to-teal-600`，图标 `Wallet`。

## 9. 如何新增一个小应用（扩展指南）

1. 在 `src/components/apps/` 下新建 `<id>.tsx`，默认导出页面组件（使用 `useAppData` 读写数据，如需）。
2. 在 `src/components/apps/registry.ts` 的 `APP_REGISTRY` 追加一项（`id` 唯一，配 `name/icon/accent/description/component`）。
3. 无需改 MainPage / Settings / 路由——可见性与入口自动生效，默认显示在常用页。
4. 如需默认隐藏，在清单项加 `defaultHidden: true`（用户仍可在设置里打开）。

## 10. 改动文件清单（相对实现前）

| 文件 | 变更 |
| --- | --- |
| `src/types/index.ts` | 新增 `AppVisibility`、`AppConfig.apps?: Record<string, AppVisibility>` |
| `src/lib/config.ts` | 读写 `apps` 字段；默认配置 `apps: {}` |
| `src/lib/pouchdb.ts` | 新增 `saveAppDataToPouch` / `loadAppDataFromPouch`（文档前缀 `app:`） |
| `src/lib/app-data.ts` | 新增（应用数据存取 + `useAppData` Hook + 同步） |
| `src/components/apps/registry.ts` | 新增（应用清单 + `isAppVisible`） |
| `src/components/apps/AppCard.tsx` | 新增（书签区应用入口卡片） |
| `src/components/apps/AppHost.tsx` | 新增（应用全屏页容器 + 返回栏） |
| `src/components/apps/BookkeepingApp.tsx` | 新增（示例应用） |
| `src/components/MainPage.tsx` | 接入 `visibleApps` / `activeApp` / `AppHost` / `AppCard`；`loadAllSources` 并集合并 `apps` |
| `src/components/SettingsDialog.tsx` | 新增"应用"标签页（显隐开关） |

## 11. 验证状态

- `tsc -b`：通过（exit 0）。
- `vite build`：通过（exit 0；仅有与本次无关的旧 `INEFFECTIVE_DYNAMIC_IMPORT` 告警）。
- 运行期验证建议：本地 `npm run dev`，确认常用页出现"记账"卡片 → 点击进入全屏页 → 添加一笔 → 刷新仍在；设置"应用"里关掉记账 → 首页卡片消失；配置 WebDAV/RemoteStorage 后多设备检查隐藏配置与记账数据是否同步。
