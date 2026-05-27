# PouchDB 本地数据缓存设计

## 概述

使用 PouchDB 作为本地 IndexedDB 封装层，缓存所有从 WebDAV/RemoteStorage 同步的数据和本地产生的数据。启动时优先从 PouchDB 加载（离线可用），同时从远程拉取最新数据更新。

**核心设计原则：每条数据独立文档**，而非单条大文档，以获得更好的同步性能和冲突处理。

## 数据库

- 数据库名：`onenav`
- 适配器：`pouchdb-browser`（底层使用 IndexedDB）
- 单数据库，通过 `doc.type` 和文档 ID 前缀区分类型

## 文档 ID 前缀规范

| 前缀 | 用途 | 示例 |
|------|------|------|
| `bm:` | 书签 (bookmark) | `bm:https://example.com` |
| `clk:` | 点击统计 (click) | `clk:https://example.com` |
| `cfg:` | 配置 (config) | `cfg:app`, `cfg:webdav` |
| `meta:` | 元数据 | `meta:sync` |

## 文档类型

### 1. 书签 (`type: "bookmark"`)

**每条书签一个独立文档**，URL 作为文档 ID。

```typescript
{
  _id: "bm:https://example.com",
  type: "bookmark",
  url: "https://example.com",
  title: "Example",
  tags: ["onenav"],
  description?: string,
  icon?: string,
  clicks: number,
  lastClickedAt?: number,
  createdAt: number,
  updatedAt: number,
  deleted?: boolean  // 软删除标记
}
```

**设计理由**：
- 细粒度同步：修改一条书签只同步该文档
- 冲突处理简单：不同书签不会冲突
- 查询高效：`allDocs({startkey: 'bm:', endkey: 'bm:\uffff'})`

### 2. 点击统计 (`type: "click-stat"`)

**每条 URL 一个独立文档**。

```typescript
{
  _id: "clk:https://example.com",
  type: "click-stat",
  url: "https://example.com",
  count: number,
  lastClickedAt: number,
  clickHistory?: Array<{ timestamp: number, tag?: string }>
}
```

### 3. 应用配置 (`type: "app-config"`)

单条文档存储应用级配置。

```typescript
{
  _id: "cfg:app",
  type: "app-config",
  tags: Array<{ name: string, displayName: string, order: number }>,
  display: {
    showFavicons: boolean,
    cardStyle: 'compact' | 'comfortable',
    showDescriptions: boolean
  },
  pinnedBookmarks: string[],
  updatedAt: number
}
```

### 4. WebDAV 配置 (`type: "webdav-config"`)

```typescript
{
  _id: "cfg:webdav",
  type: "webdav-config",
  url: string,
  username: string,
  password: string,
  bookmarkPath?: string
}
```

### 5. 同步元数据 (`type: "sync-meta"`)

```typescript
{
  _id: "meta:sync",
  type: "sync-meta",
  lastSyncAt: number,
  deviceId: string
}
```

## API 设计

### 书签操作

```typescript
// 保存单条书签
saveBookmark(bookmark: Omit<BookmarkDoc, '_id' | 'type'>): Promise<void>

// 批量保存书签
saveBookmarks(bookmarks: Array<Omit<BookmarkDoc, '_id' | 'type'>>): Promise<void>

// 获取单条书签
getBookmark(url: string): Promise<BookmarkDoc | null>

// 获取所有书签（自动过滤已删除）
getAllBookmarks(): Promise<BookmarkDoc[]>

// 软删除书签
deleteBookmark(url: string): Promise<void>
```

### 点击统计操作

```typescript
// 记录一次点击
recordClickToPouch(url: string, tag?: string): Promise<void>

// 获取所有点击统计
getClickStats(): Promise<Record<string, { count: number, lastClickedAt: number }>>
```

## 数据流

### 写入流程

```
用户操作 / 远程同步
  → 更新内存状态
  → 写入 PouchDB（逐条文档 put）
  → 写入 localStorage（兼容降级）
  → 异步同步到 RemoteStorage/WebDAV
```

### 读取流程（应用启动）

```
启动
  → 读取 PouchDB（优先，离线可用）
    → 使用 allDocs 查询所有 bm: 前缀文档
  → 如果 PouchDB 有数据 → 立即渲染 UI
  → 同时从 RemoteStorage/WebDAV 拉取最新数据
  → 更新 PouchDB + localStorage + UI
```

### 与 RemoteStorage 同步

```
首次连接 RemoteStorage
  → 检查 RemoteStorage 是否有数据
    → 有：使用 SyncEngine.pull() 加载到 PouchDB
    → 无：使用 SyncEngine.sync() 推送本地数据

后续同步
  → 使用 universal-sync-v2 的 SyncEngine
  → 自动处理双向同步和冲突
```

## 与旧设计的对比

| 方面 | 旧设计（单文档） | 新设计（多文档） |
|------|----------------|----------------|
| 存储方式 | `data:bookmarks` 一个文档存所有书签 | 每条书签 `bm:<url>` 独立文档 |
| 同步粒度 | 修改一条书签要同步整个数据集 | 只同步修改的文档 |
| 冲突处理 | 多设备同时修改容易冲突 | 不同书签独立，冲突概率低 |
| 查询方式 | 直接读取整个文档 | 使用 allDocs 范围查询 |
| 存储限制 | 单文档大小受限 | 分散存储，理论上无上限 |

## 设计决策

1. **URL 作为文档 ID**：天然唯一，便于直接查询和更新
2. **软删除**：使用 `deleted: true` 标记，而非物理删除，便于同步恢复
3. **保留 localStorage**：作为降级方案，PouchDB 不可用时仍可工作
4. **RemoteStorage/WebDAV 仍是权威数据源**：PouchDB 是本地缓存
5. **使用 universal-sync-v2**：专业处理 PouchDB 与文件系统的双向同步
