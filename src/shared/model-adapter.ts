/**
 * 模型适配层（Model Adapter）共享类型定义 —— 施工蓝本 §4
 *
 * 供主进程（src/main/agent/model-adapter.ts）与渲染进程（豆包 UI）共用。
 * 类型仅声明数据结构，不包含任何运行时逻辑。
 *
 * 契约名：ModelCapability / ToolCall / ToolResult（与豆包脑电波对齐，不得二义）
 * 铁律：三路降级（原生FC / JSON协议 / ReAct文本）归一封进 ToolCall 结构。
 *
 * @module shared/model-adapter
 */

/** 模型档次：本地 9B 小模型 or 云端万亿大模型 */
export type ModelTier = 'local' | 'cloud'

/** 模型规模档（用于 token 吝啬协议、窗口预算、工具面收窄决策） */
export type ModelScale = 'small' | 'medium' | 'large' | 'giant'

/** 成本提示 */
export type ModelCostHint = 'free' | 'cheap' | 'pricey'

/** 实际触发的降级层级 */
export type DegradeTier = 'native' | 'json' | 'react'

/** 模型能力描述（§4.1）—— 能力探测结果，纯数据，可被用户覆盖 */
export interface ModelCapability {
  modelId: string
  tier: ModelTier
  scale: ModelScale
  maxContextTokens: number
  /** 原生 function calling（标准 tools + tool_choice） */
  nativeTools: boolean
  /** 并行工具调用（一次返回 N 个 tool_call） */
  parallelTools: boolean
  /** 思考型模型（输出 reasoning_content，需抽 final_content 不污染正文） */
  reasoning: boolean
  /** 结构化输出（jsonMode） */
  jsonMode: boolean
  /** 视觉输入 */
  vision: boolean
  /** 流式输出 */
  stream: boolean
  costHint: ModelCostHint
  /** 是否已真实探测（false = 使用保守默认值，需 UI 标注「未探测」） */
  probed: boolean
  /** 探测数据来源（registry / provider / manual-override / conservative-default），用于审计 */
  source: string
  /** 云端接入修复：模型是否已在真实 /models 响应中验证存在（未验证为 false，杜绝假显示） */
  modelVerified?: boolean
  /** 云端接入修复：模型名校验时的规范建议（如 deepseek-v4-pro → deepseek-chat） */
  canonicalModelId?: string
}

/** 统一工具调用契约（§4.6）—— 三路降级归一的最终结构 */
export interface ModelAdapterToolCall {
  toolName: string
  args: Record<string, unknown>
  callId: string
}

/** 统一工具结果契约（§4.6）—— 内核执行后回注模型 */
export interface ModelAdapterToolResult {
  callId: string
  ok: boolean
  data?: unknown
  text?: string
  error?: string
  /** 是否因超长被截断（工具结果压缩回注 §4.7） */
  truncated?: boolean
}

/** 对话消息（标准 chat 结构，供原生 FC / providers 使用） */
export interface ModelAdapterMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** 工具消息时对应工具名 */
  name?: string
}

/** 一次模型推理的结果：要么产出正文，要么产出工具调用（或并行多个） */
export interface ModelAdapterCompletion {
  /** 正文内容（无工具调用时为用户可见回复；有工具调用时为空或为思考占位） */
  content: string
  /** 归一化后的工具调用列表（可 0..N 个，云端并行） */
  toolCalls: ModelAdapterToolCall[]
  /** 本次实际命中的降级层级（用于审计/UI 展示） */
  degradeTier: DegradeTier
  /** 思考段（reasoning 型模型抽离出的 final_content 之前的思考）—— 不污染正文 */
  reasoning?: string
}