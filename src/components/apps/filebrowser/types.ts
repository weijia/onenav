// 文件浏览器应用的数据类型。
// 数据来源：my-data 定义的 Directory-Structure Manifest（dir-struct-gen 生成），
// 存储于 RemoteStorage 的 app_data/folders/ 目录，每个清单文件对应一台主机。
// 格式规范见 my-data/docs/formats/dir-struct-manifest-format.md。

/** 任意原始清单 JSON（字段宽容，运行时再做类型收窄） */
export type RawManifest = Record<string, unknown>

/** 文件夹节点视图（已校验、已过滤 type:"file"） */
export interface FolderNodeView {
  /** 文件夹名称（盘符如 C:，或目录名） */
  name: string
  /** 固定为 'folder' */
  type: 'folder'
  /** 标签数组（可能为空），如 git / node / rust 等自动探测标签 */
  tags: string[]
  /** 子文件夹节点 */
  children: FolderNodeView[]
  /**
   * 驱动层节点（盘符）的稳定身份：来自磁盘根 .dir-struct-id，跨主机一致。
   * 用于深挖标记的命名空间与「同盘多主机去重」。子目录不携带，靠祖先驱动节点溯源。
   */
  volumeId?: string | null
  /**
   * 可选统计字段：该目录下所有文件（含其全部子孙目录）的总文件数，单位「个」。
   * 仅在 dir-struct-gen 开启「汇总文件数与大小」时随清单出现；缺失表示该目录未统计。
   */
  fileCount?: number
  /**
   * 可选统计字段：该目录下所有文件（含其全部子孙目录）的逻辑大小之和（字节）。
   * 与 fileCount 同时出现/省略；用于读取侧无需递归下钻即展示「目录有多大」。
   */
  totalSize?: number
  /**
   * 可选统计字段：同一范围内所有文件的「占用磁盘空间」之和（字节）。
   * 与 totalSize 常不相等（簇对齐 / 压缩 / 稀疏文件等）；取不到占用时由生成器按逻辑大小替代。
   */
  totalSizeOnDisk?: number
  /**
   * 数值只是下界（子树有读不到 / 超深度上限的部分）时为 true，读取侧应以「≥」展示。
   */
  sizePartial?: boolean
  /** 该目录由哪些主机（分片来源）确认过存在；多主机合并时取并集去重。仅分片层可能出现。 */
  sources?: string[]
  /** 磁盘上确实无子目录时为 true（读取侧据此省略展开按钮） */
  leaf?: boolean
  /**
   * 该目录自身在磁盘上的最后修改时间（filesystem mtime），毫秒级 Unix epoch（UTC）。
   * 与 updatedAt（生成器扫描确认时间）语义不同：mtime 是磁盘上该条目本身的修改时刻，不随扫描变化。
   * 由生成器为每个进清单的节点写入，不参与合并取舍（分片合并规则第 9 条），仅作展示。
   */
  mtime?: number
}

/** 单台主机的目录结构清单视图 */
export interface ManifestView {
  /** 计算机 ID（主机名），用于命名空间隔离多台机器 */
  source: string
  /** 生成时间（ISO 8601），可能缺失 */
  generatedAt: string | null
  /** 生成器标识，固定为 "fluentos-dir-struct-gen" */
  generator: string | null
  /** 根目录节点（即主机节点，name 通常等于 source） */
  root: FolderNodeView
  /** 递归统计的文件夹总数（不含根节点自身） */
  folderCount: number
  /** 解析过程中的告警（如跳过非法子节点等） */
  warnings: string[]
}
