/**
 * 智能模型调度系统 — 类型定义
 *
 * 调度器核心概念：
 * - TaskType：任务类型（由 classifier 从用户请求识别）
 * - ModelProfile：模型画像（速度/质量/上下文能力/适用任务/启用开关/优先级）
 * - ScheduleDecision：一次调度决策（选了哪个模型、为什么、置信度）
 * - ScheduleRecord：调度记录（历史请求 → 模型 → 原因 → 耗时/速度）
 *
 * @module scheduler/types
 */

/** 任务类型：调度器据此挑选最合适的模型 */
export type SchedulerTaskType =
  | 'chat'        // 日常对话（快速响应优先）
  | 'deep'        // 深度推理 / 复杂问题（质量优先）
  | 'code'        // 代码生成 / 编程任务
  | 'longctx'     // 长上下文 / 文档分析
  | 'quick'       // 简单快捷问答（最低开销）

export const TASK_TYPE_LABELS: Record<SchedulerTaskType, string> = {
  chat: '日常对话',
  deep: '深度推理',
  code: '代码编程',
  longctx: '长上下文',
  quick: '快捷问答',
}

/** 模型画像：每个已注册文本模型的调度属性（速度 0-10，质量 0-10） */
export interface ModelProfile {
  /** 对应 model-registry 中的模型 id */
  id: string
  /** 显示名称 */
  name: string
  /** 速度评分（0-10，越高越快） */
  speed: number
  /** 质量评分（0-10，越高质量越好） */
  quality: number
  /** 上下文能力（约多少 token） */
  contextCap: number
  /** 定位说明（用于 UI 展示） */
  role: string
  /** 是否参与调度（用户可关闭） */
  enabled: boolean
  /** 优先级（数字越小越优先尝试） */
  priority: number
  /** 最适用的任务类型（可多个） */
  suitedFor: SchedulerTaskType[]
  /** 该模型失败时的回退候选模型 id（可空） */
  fallback?: string
}

/** 任务识别结果（决策透明可见） */
export interface TaskClassifyResult {
  taskType: SchedulerTaskType
  /** 置信度 0-1 */
  confidence: number
  /** 命中的证据（关键词/结构/长度/语义），供 UI 展示"为什么这么判定" */
  evidence: string[]
  /** 是否强制锁定（如明确包含代码/文件类型关键词时不受长度影响） */
  locked: boolean
}

/** 一次完整的调度决策 */
export interface ScheduleDecision {
  /** 识别出的任务类型 */
  taskType: SchedulerTaskType
  classify: TaskClassifyResult
  /** 最终选中的模型 id */
  modelId: string
  modelName: string
  /** 决策理由（人类可读，UI 直接展示） */
  reason: string
  /** 候选模型链（按优先级） */
  candidates: string[]
  /** 期望运行位置 */
  targetDevice: 'gpu' | 'cpu'
  /** 分层层数 */
  gpuLayers: number
  /** 上下文大小 */
  contextSize: number
  ts: number
  /** 本次调度是否计划走云端补救（本地无可用模型/能力不足） */
  cloudFallback?: boolean
  /** 云端 Provider id（cloudFallback 时有效） */
  cloudProviderId?: string
  /** 是否需要换载常驻模型（目标模型 ≠ 常驻主力且需 GPU） */
  needsSwap?: boolean
  /** 常驻主力模型 id（换载场景展示用） */
  residentModelId?: string
}

/** 调度执行过程中的一次尝试 */
export interface ScheduleAttempt {
  modelId: string
  modelName: string
  gpuLayers: number
  device: 'gpu' | 'cpu'
  status: 'starting' | 'running' | 'failed'
  elapsedMs: number
  error?: string
  tokensPerSec?: number
  content?: string
}

/** 调度记录（持久化到 electron-store） */
export interface ScheduleRecord {
  id: string
  ts: number
  /** 触发调度的请求摘要（前 120 字符） */
  request: string
  taskType: SchedulerTaskType
  classifyConfidence: number
  evidence: string[]
  modelId: string
  modelName: string
  reason: string
  device: 'gpu' | 'cpu'
  gpuLayers: number
  /** 实际耗时 ms */
  elapsedMs: number
  /** 生成速度 token/s */
  tokensPerSec: number
  status: 'success' | 'fallback' | 'failed'
  /** 回退链（如 [qwopus-18b, qwen3.5-9b]） */
  fallbackChain: string[]
  /** 输出内容预览（可选，便于 UI 展示） */
  contentPreview?: string
  /** 是否实际走了云端补救 */
  usedCloud?: boolean
  /** 云端 Provider id（usedCloud 时有效） */
  cloudProviderId?: string
  /** 是否发生常驻模型换载 */
  usedSwap?: boolean
}

/** 云端补救配置（复杂任务本地能力不足时升级云端） */
export interface SchedulerCloudConfig {
  /** 是否启用云端补救 */
  enabled: boolean
  /** 云端 Provider id（对应 config.providers 中注册的 API Provider） */
  providerId: string
  /** 云端模型 id（如 deepseek-v4-pro） */
  modelId: string
  /** 仅复杂任务升级云端（推理/数学/代码/长文档/超长文本） */
  complexOnly: boolean
  /** 判定"超长文本"的字符数阈值（超过则视为复杂任务） */
  complexThreshold: number
  /** 单次云端调用的 token 预算上限（超出则本任务不升云端） */
  tokenBudget: number
}

/** 显卡单模型常驻换载配置（6GB 显存一次只能常驻一个模型） */
export interface SchedulerResidentConfig {
  /** 常驻主力模型 id（日常默认常驻，另一 9B 待命按需换载） */
  residentModelId: string
  /** 是否启用按需换载（复杂任务换载另一模型） */
  swapEnabled: boolean
  /** 任务完成后是否切回常驻主力（释放显存） */
  restoreAfterTask: boolean
  /** 换载启动超时（ms），超时则回退 */
  swapTimeoutMs: number
}

/** 调度器配置 */
export interface SchedulerConfig {
  /** 是否启用智能调度（关闭时走默认主模型） */
  enabled: boolean
  /** 调度记录最大保留条数 */
  historyLimit: number
  /** 当前调度策略版本 */
  version: number
  /** 云端补救配置 */
  cloud?: SchedulerCloudConfig
  /** 单模型常驻换载配置 */
  resident?: SchedulerResidentConfig
}
