# PouchDB 本地数据缓存设计

## 概述

使用 PouchDB 作为本地 IndexedDB 封装层，缓存所有从 WebDAV 同步的数据和本地产生的数据。启动时优先从 PouchDB 加载（离线可用），同时从 WebDAV 拉取最新数据更新。

## 数据库

- 数据库名：`onenav`
- 适配器：`pouchdb-browser`（底层使用 IndexedDB）
- 单数据库，通过 `doc.type` 区分文档类型

## 文档类型

| type | _id | 说明 | 权威数据源 |
|------|-----|------|-----------|
| `webdav-config` | `config:webdav` | WebDAV 连接配置 | localStorage（用户输入） |
| `app-config` | `config:app` | 应用配置 | WebDAV `config.json` |
| `bookmarks` | `data:bookmarks` | 完整书签数据 | WebDAV `bookmarks.json` |
| `click-stats` | `stats:clicks` | 点击统计 | 本地产生，同步到 WebDAV |
| `pinned` | `config:pinned` | 固定书签列表 | 本地产生，同步到 WebDAV |

## 文档结构

### 1. WebDAV 配置 (`config:webdav`)

```typescript
{
  _id: "config:webdav",
  type: "webdav-config",
  url: string,
  username: string,
  password: string,
  updatedAt: number
}
```

### 2. 应用配置 (`config:app`)

```typescript
{
  _id: "config:app",
  type: "app-config",
  version: number,
  tags: TagConfig[],
  bookmarkPath: string,
  display: DisplayConfig,
  background: BackgroundConfig,
  widgets: WidgetsConfig,
  pinnedBookmarks?: string[],
  updatedAt: number
}
```

### 3. 书签数据 (`data:bookmarks`)

```typescript
{
  _id: "data:bookmarks",
  type: "bookmarks",
  data: Record<string, BookmarkEntry>,
  meta: {
    databaseVersion: number,
    extensionVersion?: string,
    created: number,
    updated: number
  },
  updatedAt: number
}
```

### 4. 点击统计 (`stats:clicks`)

```typescript
{
  _id: "stats:clicks",
  type: "click-stats",
  version: number,
  records: Record<string, {
    url: string,
    title: string,
    count: number,
    lastClicked: number
  }>,
  updatedAt: number
}
```

### 5. 固定书签 (`config:pinned`)

```typescript
{
  _id: "config:pinned",
  type: "pinned",
  urls: string[],
  updatedAt: number
}
```

## 数据流

### 写入流程（任何数据变更）

```
用户操作 / WebDAV 同步
  → 更新内存状态
  → 写入 PouchDB（put，upsert）
  → 写入 localStorage（兼容降级）
  → 异步写入 WebDAV（如果可连接）
```

### 读取流程（应用启动）

```
启动
  → 读取 PouchDB（优先，离线可用）
  → 如果 PouchDB 有数据 → 立即渲染 UI
  → 同时从 WebDAV 拉取最新数据
  → 更新 PouchDB + localStorage + UI
```

### 各数据类型的更新时机

| 数据 | 触发更新的操作 |
|------|--------------|
| `webdav-config` | 用户在设置中输入 WebDAV 配置 |
| `app-config` | 从 WebDAV 拉取配置、用户修改设置 |
| `bookmarks` | 从 WebDAV 拉取书签、用户刷新 |
| `click-stats` | 用户点击书签、从 WebDAV 合并统计 |
| `pinned` | 用户固定/取消固定书签 |

## 设计决策

1. **单文档存储**：每种类型一个文档，避免大量 `_id`，简化查询
2. **`updatedAt` 字段**：用于冲突解决，取时间戳最新的
3. **PouchDB 作为一级缓存**：比 localStorage 更可靠（IndexedDB 支持更大存储）
4. **保留 localStorage**：作为降级方案，PouchDB 不可用时仍可工作
5. **WebDAV 仍是权威数据源**：PouchDB 是本地缓存，WebDAV 是最终真相
