/**
 * 自我改造（Self-Modify）共享类型定义
 *
 * 供主进程（src/main/self-modify）与渲染进程（SelfModify 页 / store）共用。
 * 类型仅声明数据结构，不包含任何运行时逻辑。
 *
 * @module shared/self-modify-types
 */

/** 改动级别：L0 只读 · L1 低风险 · L2 中风险 · L3 高风险（架构级，默认禁止写入） */
export type ModifyLevel = 'L0' | 'L1' | 'L2' | 'L3'

/** 单文件改动：mode 区分整体覆盖与增量补丁（MVP 统一按整体内容写入） */
export interface SelfModifyFileChange {
  /** 相对仓库根目录的路径，使用正斜杠，如 `src/renderer/pages/Home/index.tsx` */
  path: string
  /** 目标文件的完整新内容 */
  content: string
  /** 改动方式：overwrite 覆盖 / patch 补丁（MVP 下 patch 语义与 overwrite 一致） */
  mode: 'patch' | 'overwrite'
}

/** 一次改造请求的变更集 */
export interface ChangeSet {
  files: SelfModifyFileChange[]
  /** 改动摘要（写入审计日志） */
  summary: string
}

/** 单文件 diff 行（DiffViewer 直接消费） */
export interface DiffLine {
  type: 'context' | 'add' | 'del'
  text: string
}

/** 单文件 diff 结果 */
export interface FileDiff {
  path: string
  additions: number
  deletions: number
  lines: DiffLine[]
}

/** 预览 diff 结果 */
export interface DiffResult {
  filesAffected: string[]
  additions: number
  deletions: number
  /** 文本形式的 diff（用于日志 / 导出） */
  diffText: string
  /** 结构化 diff（DiffViewer 高亮展示） */
  files: FileDiff[]
  estimatedRisk: ModifyLevel
}

/** 一次成功的 git 快照 */
export interface Snapshot {
  hash: string
  createdAt: number
  files: string[]
  summary: string
}

/** 能力等级说明 */
export interface LevelInfo {
  level: ModifyLevel
  description: string
  /** 是否允许写入（L3 恒为 false） */
  writable: boolean
}

/** get-capabilities 返回 */
export interface SelfModifyCapabilities {
  writeEnabled: boolean
  repoRoot: string
  whitelist: string[]
  blacklist: string[]
  levels: LevelInfo[]
  limits: {
    maxFilesPerChange: number
    maxLinesPerChange: number
  }
}

/** 白名单文件清单项 */
export interface FileListEntry {
  path: string
  size: number
  level: ModifyLevel
}

/** read-file 返回 */
export interface FileReadResult {
  path: string
  content: string
  truncated: boolean
  totalLines: number
  level: ModifyLevel
}

/** 生效方式：reload 渲染层刷新 / relaunch 主进程重启 / hot 配置人设热加载 / none 无需 */
export type SelfModifyEffect = 'reload' | 'relaunch' | 'hot' | 'none'

/** apply 返回 */
export interface ApplyResult {
  success: boolean
  snapshotHash?: string
  filesWritten: string[]
  effect: SelfModifyEffect
  error?: string
}

/** rollback 返回 */
export interface RollbackResult {
  success: boolean
  restoredFiles?: string[]
  effect: SelfModifyEffect
  error?: string
}

/** generate 返回（走本地模型，尽力生成 plan + changeSet） */
export interface GenerateResult {
  success: boolean
  plan: string
  changeSet?: ChangeSet
  error?: string
}

/** progress 广播载荷 */
export interface SelfModifyProgress {
  phase: 'snapshot' | 'write' | 'verify' | 'rollback' | 'done'
  message: string
  file?: string
}
