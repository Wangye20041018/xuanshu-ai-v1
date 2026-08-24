/**
 * 智能体操作系统（Agent OS）共享类型定义
 *
 * 供主进程（src/main/agent/*）与渲染进程（Agents 页 / agentStore / orchestrator）
 * 共用。类型仅声明数据结构，不包含任何运行时逻辑。
 *
 * @module shared/agent-types
 */

/** 记忆配置：独立命名空间，隔离到 vectorStore 分区 */
export interface AgentMemoryConfig {
  enabled: boolean
  /** 命名空间，形如 'agent:<agentId>'，检索时按 namespace 过滤 */
  namespace: string
  /** 默认召回条数 */
  maxRecall: number
}

/** 模型配置（可空，默认回落全局 defaultModelId） */
export interface AgentModelConfig {
  modelId?: string
  temperature?: number
  /** ReAct 最大步数，默认 15 */
  maxSteps?: number
}

/** 人设微调：动态创建时的 AI 微调（覆盖/追加 prompt） */
export interface AgentPersonaOverride {
  name?: string
  /** 追加到人设 prompt 之后 */
  systemPromptSuffix?: string
}

/** 智能体定义（落盘为 userData/agents/<id>.json） */
export interface AgentDefinition {
  /** 'agt-' + 时间戳 + 随机段 */
  id: string
  name: string
  description: string
  icon?: string
  color?: string
  /** 引用静态人设（personaLoader，canonical 源 resources/personas） */
  personaId: string
  personaOverride?: AgentPersonaOverride
  /** 引用 toolRegistry 工具名（子集） */
  toolIds: string[]
  memoryConfig: AgentMemoryConfig
  modelConfig: AgentModelConfig
  tags: string[]
  createdAt: number
  updatedAt: number
}

/* ============================================================
 * 控制白名单（三级闸门第 ① 级）
 * ============================================================ */

/** 授权范围：'tool' 单个工具 | 'category' 整类 */
export type WhitelistScope = 'tool' | 'category'

/** 单条白名单记录 */
export interface WhitelistEntry {
  /** 如 'click_at' / 'type_text' / 'registry_write' */
  toolName: string
  grantedAt: number
  scope: WhitelistScope
  /** scope='category' 时的工具分类 */
  category?: string
}

/** userData/permissions/control-whitelist.json 顶层结构 */
export interface ControlWhitelistFile {
  version: 1
  entries: WhitelistEntry[]
}

/* ============================================================
 * 控制状态三态（驱动发光特效）
 * ============================================================ */

export type ControlPhase = 'thinking' | 'acting' | 'done'

/* ============================================================
 * 群协作（Swarm）类型
 * ============================================================ */

export type SwarmStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface SwarmStep {
  id: string
  /** 派发到的智能体 */
  agentId: string
  /** 该步指令 */
  instruction: string
  /** 前置步骤 id（接力关系） */
  dependsOn: string[]
}

export type SwarmMode = 'auto' | 'manual'
export type SwarmStatus = 'planning' | 'running' | 'paused' | 'done' | 'failed'

export interface SwarmTask {
  id: string
  goal: string
  steps: SwarmStep[]
  mode: SwarmMode
  status: SwarmStatus
  createdAt: number
}

export interface SwarmStepResult {
  stepId: string
  agentId: string
  output: string
  status: SwarmStepStatus
}

export interface SwarmResult {
  taskId: string
  steps: SwarmStepResult[]
  summary: string
}

/* ============================================================
 * 智能体运行（agent:run）相关
 * ============================================================ */

/** 运行事件类型（与 main/agent/types.ts 的 AgentEvent 对应，供渲染层消费） */
export type AgentRunEventType =
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'response'
  | 'error'
  | 'status'

export interface AgentRunEvent {
  type: AgentRunEventType
  content?: string
  message?: string
  tool?: string
  params?: Record<string, unknown>
  result?: { success: boolean; data?: unknown; error?: string }
  step?: number
  isFinal?: boolean
  progress?: number
  code?: string
}

/** 运行智能体的入参 */
export interface AgentRunRequest {
  agentId: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
}

/** 智能体创建请求（自然语言 → AI 模板填空 → 预览） */
export interface AgentCreateRequest {
  requirement: string
}

/** 智能体创建预览（confirmed 由用户在渲染层置 true 后回传） */
export interface AgentCreatePreview {
  definition: AgentDefinition
  /** 是否已确认（未确认前不落盘） */
  confirmed: boolean
  /** 生成来源说明 */
  sourcePersonaName?: string
  warning?: string
}
