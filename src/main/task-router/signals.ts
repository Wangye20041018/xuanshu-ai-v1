/**
 * task-router 信号与类型定义（v10.2）
 *
 * 路由中枢接收"用户意图信号" → 分类 → 选档（快/质/视觉）→ 调用 model-manager 换载。
 * 本文件为纯类型模块，零运行时依赖。
 */

/** 路由档位：fast=对话态(Qwen3.5-9B)，vision=视觉态 */
export type Tier = 'fast' | 'vision'

/** 意图分类结果 */
export type IntentClass =
  | 'chat'        // 普通闲聊
  | 'code'        // 代码相关
  | 'reasoning'   // 复杂推理/分析
  | 'math'        // 数学计算
  | 'longdoc'     // 长文档
  | 'image'       // 图片/截图
  | 'voice'       // 语音闲聊
  | 'unknown'

/**
 * 归一化后的路由信号（五类输入统一归一到此结构）
 * - text: 文本指令语义
 * - hasImage: 是否含图片/截图
 * - fileType: 上传文件扩展名（如 .py / .xlsx）
 * - triggerWindow: 触发窗口来源（语音球/代码编辑器/文件浏览器/聊天）
 * - audioText: 语音识别出的文本（用于区分语音闲聊 vs 语音含复杂任务）
 * - personaId: 当前人格 id（路由读取其 preferred_tier）
 */
export interface RouteSignal {
  text?: string
  hasImage?: boolean
  imageUrls?: string[]
  fileType?: string
  triggerWindow?: 'voice-ball' | 'code-editor' | 'file-explorer' | 'chat' | string
  audioText?: string
  personaId?: string
}

/** 路由决策结果（广播给渲染端用于状态灯 / toast） */
export interface TierResult {
  tier: Tier
  intent: IntentClass
  swapped: boolean
  fromModel: string | null
  toModel: string | null
  reason: string
}

/** GPU 显存状态（与 model-manager.GpuModelType 对齐） */
export type GpuState = 'main' | 'vision' | null
