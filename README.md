# OneNav

浏览器首页 - 从 WebDAV 读取 utags 书签，按标签分组以图标网格展示。

## 功能

- 从 WebDAV 读取 utags 书签数据，按配置的标签分组展示
- 图标网格布局（参考 open-nav 风格）
- 时间显示 + 搜索栏
- 背景设置（渐变/图片/纯色）
- 配置保存到 WebDAV `app_data/onenav/config.json`

## 配置

首次打开需配置 WebDAV 连接信息（URL、用户名、密码），配置后会自动从 WebDAV 加载书签数据。

## 数据格式

配置格式详见 [my-data 仓库](https://github.com/weijia/my-data) 的 `docs/formats/` 目录。

## 开发

```bash
npm install
npm run dev
```

## 构建

```bash
npm run build
```

## 许可证

MIT
