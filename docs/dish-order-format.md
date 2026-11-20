# 点菜助手数据格式与存储设计

> 点菜助手是 OneNav 的内置小应用，用 **zen-fs-config 数据同步组**存储点菜记录。
> 支持手动新增、粘贴/文件导入，以及把「AI Agent 从照片识别出的 JSON」直接导入。
> 价格全部可选——识别不到就留空，程序不会编造。

## 1. 存储布局

数据组 appId 固定为 `dish-order`（见 `DishOrderSyncPanel.DISH_ORDER_APP_ID`），记录按月分片，避免单目录文件过多：

```
/orders/YYYY/MM/<id>.json
```

例：`/orders/2026/11/2026-11-19-a1b2c3d4.json`。

- 一条记录一个 JSON 文件；写入前逐级建目录（忽略 `EEXIST`）。
- 读取先 `group.flush()` 拉远端，再按所选月份（或全部月份）`readdir` + 逐文件 `readFile`；单文件解析失败跳过。
- 删除优先 `group.deleteFile()`（写墓碑、防同步复活），回退 `fs.promises.unlink`。
- 月份列表由 `/orders/YYYY/MM` 目录树枚举，倒序；列表页默认全部，可按月筛选。

## 2. 记录格式（存储 / 展示）

```json
{
  "id": "2026-11-19-a1b2c3d4",
  "date": "2026-11-19",
  "meal": "晚餐",
  "restaurant": "老地方家常菜",
  "people": 3,
  "items": [
    { "name": "宫保鸡丁", "qty": 1, "unit": "份", "price": 38, "note": "微辣", "tags": ["好吃", "回购"] },
    { "name": "米饭", "qty": 2, "unit": "碗", "price": 3 },
    { "name": "酸辣汤", "qty": 1, "unit": "份", "price": null }
  ],
  "total": 44,
  "note": "朋友聚餐",
  "source": "photo-agent",
  "createdAt": 1763500000000
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 去重键。AI 给定则清洗后加内容哈希后缀；缺失则由 `date + 内容` 生成稳定值（同一批重复导入可去重）。 |
| `date` | string | `YYYY-MM-DD`，必填且必须是真实日期（决定分片路径）。 |
| `meal` | string? | 餐次（早餐/午餐/晚餐/夜宵），自由文本。 |
| `restaurant` | string? | 店名。 |
| `people` | number? | 就餐人数。 |
| `items` | array | 菜品数组，至少 1 项，每项必须有 `name`。 |
| `items[].name` | string | 菜名，必填。 |
| `items[].qty` | number | 数量，缺省 1。 |
| `items[].unit` | string? | 单位（份/碗/盘/杯…）。 |
| `items[].price` | number? | 单价，识别不到为 `null`。 |
| `items[].note` | string? | 单菜备注（微辣、不要香菜…）。照片识别到就填；事后也可在应用内编辑。 |
| `items[].tags` | string[]? | 事后人工加的标记（好吃 / 回购 / 避雷 / 想吃…），自由文字、可自定义；AI 照片识别**不生成**此字段。导入时接受数组或逗号/顿号/空格分隔的字符串，去空去重，最多 12 个、单个最长 24 字。 |
| `total` | number? | 账单总额，识别不到为 `null`；展示时若为空则按有价菜品 `qty × price` 累加并标注。 |
| `note` | string? | 整单备注。 |
| `source` | enum? | `photo-agent`（照片 Agent）/ `manual`（手填）/ `import`（粘贴或文件导入）。 |
| `createdAt` | number | 入库时间戳。 |

## 3. 导入格式（宽松）

导入入口接受单条对象、对象数组，或逐行分隔的多个 JSON（AI 有时这样输出）。导入时归一化：

- `date` 缺失 → 用今天；格式非法 → 该条报错、跳过。
- `items` 必须是非空数组且每项有 `name`，否则该条报错。
- `price` / `total` 接受数字或带 `¥`、千分位的字符串；缺失/非法 → `null`（不编造）。
- `qty` 缺省 1；`id` 缺失时按内容生成稳定 id。
- 预览表格逐条展示「可导入 / 有误 / 有 N 项无价格」，确认后写入。
- 重复 id 处理：默认跳过，可选覆盖。

参考样例：`docs/dish-order-sample.json`。

## 3.1 单菜标记与笔记

记录卡片展开后，明细表每行右侧有「标记/笔记」按钮，点开在当前行下方展开编辑区：

- **标记**：自由文字标签，回车或点「添加」写入；也可点快捷建议（好吃 / 回购 / 避雷 / 想吃）；点已有标签上的 × 移除。
- **笔记**：单菜自由文本，如「这次偏咸，下次少放盐」。
- 保存时**只修改该道菜的 `tags` / `note`**，其余字段原样保留，覆盖写回原文件（`/orders/YYYY/MM/<id>.json`），不重新生成 id。
- 列表搜索覆盖店名、菜名、标记和笔记；卡片折叠态在有菜被标记时显示标签数量提示。

兼容性：老记录没有 `tags` 字段，读取时视为空数组，不影响展示与编辑。去重 id 的内容哈希故意**不包含** `tags` / `note`，所以加标记不会让文件路径漂移。

## 4. AI Agent 提示词（照片 → 导入 JSON）

应用内置「AI 提示词」面板，一键复制。提示词与格式定义、示例共用 `src/components/apps/dish-order/format.ts` 的 `AI_PROMPT` / `SAMPLE_ORDER`（单一来源，避免格式改了提示词没跟上）。核心约束：

1. 只输出 JSON，不要解释、不要 Markdown 代码块标记。
2. 看不清/没有的信息留空或 `null`，绝不猜测编造。
3. 一次就餐一个对象；多张单子输出对象数组。
4. 日期 `YYYY-MM-DD`；菜名原样保留；价格只填数字；`total` 没看到就填 `null`（不用菜品相加去猜）。
5. `source` 固定填 `photo-agent`。

用户流程：拍照 → 发给带图片识别的 AI Agent 并附提示词 → 复制输出的 JSON → 应用「导入」粘贴 → 预览 → 确认写入。

## 5. 相关代码

| 文件 | 职责 |
|---|---|
| `src/components/apps/dish-order/format.ts` | 类型、归一化/校验、分片路径、示例、AI 提示词 |
| `src/components/apps/dish-order/store.ts` | 数据组持有、flush、按月读取、写单条/批量、删除 |
| `src/components/apps/dish-order/DishOrderSyncPanel.tsx` | zen-fs-config-ui 同步组配置 |
| `src/components/apps/DishOrderApp.tsx` | 导入/预览/列表/手填/提示词界面 |
| `src/lib/fs-config-backends.ts` | 公共后端注册（RemoteStorage / Gitee）与 `resolveDataGroup` |
