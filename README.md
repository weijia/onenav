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

## 需求文档

### REQ-001: Web Share Target 分享收件箱（onenav-temp）

**状态**：待实现  
**优先级**：高

#### 背景
OneNav 已支持作为手机系统的 Web Share Target（PWA 分享目标）。用户在其他 App 中点击"分享"并选择 OneNav 后，URL 和标题会传入应用。当前流程需要用户手动确认保存，且仅保存到本地 PouchDB。需要扩展该功能，使其在 RemoteStorage 模式下能够将分享的链接自动同步到远程存储的临时目录，并在多端共享这些待处理的链接。

#### 需求描述

**1. 分享链接自动写入 `onenav-temp`**
- 当用户通过手机系统分享功能发送链接到 OneNav 时，应用接收到 `?url=` 和 `?title=` 参数
- 如果当前处于 **RemoteStorage 模式**（已配置 RemoteStorage 且连接正常），分享的链接应立即保存到 RemoteStorage 的 `onenav-temp/` 目录下
- 保存格式：每个链接为一个独立的 JSON 文件，文件名使用 URL 的哈希或时间戳，避免冲突
- 文件内容至少包含：`url`、`title`、`sharedAt`（分享时间戳）
- 如果 RemoteStorage 未配置或连接失败，降级保存到本地 PouchDB，并在连接恢复后自动同步

**2. 启动时自动加载 `onenav-temp`**
- 每次打开 OneNav 页面（包括 PWA 启动和浏览器刷新）时，自动检查 RemoteStorage 的 `onenav-temp/` 目录
- 如果目录中存在待处理的链接文件，读取并解析所有内容
- 将读取到的链接合并到主书签列表中（PouchDB），合并规则：
  - 如果 URL 已存在：**忽略**，不修改本地书签，保留用户已有的标签和点击统计
  - 如果 URL 不存在：创建新书签，默认标签为 `[]`（无标签），`clicks: 0`
- **`onenav-temp/` 中的文件不删除**，作为共享池供所有设备读取
- 合并结果通过 UI Toast 提示用户（如"从远程导入了 3 条新书签，已忽略 2 条已存在的"）

**3. 数据格式**

`onenav-temp/` 下的单条文件格式：
```json
{
  "url": "https://example.com/article",
  "title": "文章标题",
  "sharedAt": 1719993600000,
  "source": "share-target"
}
```

**4. 多端同步语义**
- 手机 A 分享链接 → 写入 RemoteStorage `onenav-temp/`
- 手机 B 打开 OneNav → 自动读取 `onenav-temp/` → 仅导入本地不存在的 URL
- 电脑端打开 OneNav → 同样读取 `onenav-temp/`，导入本地不存在的 URL
- 因此，`onenav-temp/` 充当一个"跨设备共享书签池"，任何设备打开时都能从中获取新链接，文件永久保留供多端共享

**5. 边界情况**
- `onenav-temp/` 目录不存在：自动创建
- 文件解析失败：跳过该文件，记录错误日志，不阻塞其他文件处理
- 网络中断时分享：先保存到本地 PouchDB 的临时队列（`cfg:pendingShares`），连接恢复后自动上传

---

## 许可证

MIT
