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
