# OneNav

浏览器首页 - 从 WebDAV 或 RemoteStorage 读取 utags 书签，按标签分组以图标网格展示。

## 功能

- **多存储后端支持**：WebDAV、RemoteStorage、PouchDB（本地 IndexedDB）
- **图标网格布局**（参考 open-nav 风格）
- **时间显示 + 搜索栏**
- **背景设置**（渐变/图片/纯色）
- **固定书签**：可将常用书签置顶显示
- **点击统计**：记录访问频率，支持"常用"标签
- **多设备同步**：通过 RemoteStorage 或 WebDAV 同步数据

## 存储模式

### 1. WebDAV 模式
配置 WebDAV 连接后，数据存储在 WebDAV 服务器：
- 配置：`app_data/onenav/config.json`
- 书签：`app_data/onenav/bookmarks.json`
- 点击统计：`app_data/onenav/click_stats.json`

### 2. RemoteStorage 模式
使用 [RemoteStorage](https://remotestorage.io/) 协议同步：
- 支持任意兼容 RemoteStorage 的服务器
- 数据存储在 `storage/` 文件夹下
- 使用 [universal-sync-v2](https://github.com/weijia/universal-sync-v2) 进行 PouchDB ↔ 文件系统同步

### 3. PouchDB 模式（本地）
无远程存储时，数据保存在浏览器 IndexedDB：
- 数据库名：`_pouch_onenav`
- 自动检测数据库损坏并恢复

## 数据结构

### PouchDB 文档类型

| 文档 ID | 类型 | 内容 |
|---------|------|------|
| `cfg:app` | `app-config` | 标签配置、显示设置、固定书签 |
| `cfg:pinned` | `pinned` | 固定书签 URL 列表 |
| `cfg:webdav` | `webdav-config` | WebDAV 连接配置 |
| `bm:{url}` | `bookmark` | 单条书签数据 |
| `stats:clicks` | `click-stats` | 点击统计 |

### 书签文档格式

```typescript
{
  _id: 'bm:https://example.com',
  type: 'bookmark',
  url: 'https://example.com',
  title: 'Example',
  tags: ['tag1', 'tag2'],
  description: 'Description',
  icon: 'icon-url',
  clicks: 10,
  lastClickedAt: 1234567890,
  createdAt: 1234567890,
  updatedAt: 1234567890,
  deleted: false
}
```

### 配置文档格式

```typescript
{
  _id: 'cfg:app',
  type: 'app-config',
  tags: [
    { id: 'tag1', name: 'tag1', displayName: '标签1', icon: 'icon', order: 0 }
  ],
  display: {
    showFavicons: true,
    cardStyle: 'comfortable', // 'compact' | 'comfortable'
    showDescriptions: true
  },
  pinnedBookmarks: ['https://example.com'],
  updatedAt: 1234567890
}
```

## 同步机制

### universal-sync-v2

RemoteStorage 同步基于 [zen-fs](https://github.com/zen-fs) 实现：

1. **PouchDB → 文件系统**：将书签、配置等文档序列化为 JSON 文件
2. **文件系统 → PouchDB**：读取 JSON 文件并更新 PouchDB
3. **冲突处理**：自动合并，优先保留较新的数据

文件映射：
- `storage/config.json` → `cfg:app`
- `storage/pinned.json` → `cfg:pinned`
- `storage/bookmarks/{encoded_url}.json` → `bm:{url}`
- `storage/stats/clicks.json` → `stats:clicks`

## 开发

```bash
npm install
npm run dev
```

## 构建

```bash
npm run build
```

## 相关项目

- [universal-sync-v2](https://github.com/weijia/universal-sync-v2) - PouchDB 文件系统同步引擎
- [utags](https://github.com/weijia/utags) - 书签标签管理扩展

## 许可证

MIT
