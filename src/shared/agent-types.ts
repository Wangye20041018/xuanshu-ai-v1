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
  /* ---- 智能体阵列（第三批）扩展字段（可选，向后兼容） ---- */
  /** 角色身份一句话（如「产品经理」） */
  role?: string
  /** 技能描述列表（如 ['需求分析', 'PRD 编写']） */
  skills?: string[]
  /** 协作协议：擅长如何与其它智能体协作（如「接收架构设计后输出前端实现」） */
  collaboration?: string
  /** 是否为预置智能体（预置库种子） */
  preset?: boolean
}

/* ============================================================
 * 智能体阵列：团队模板（第三批）
 * ============================================================ */

/** 团队模板步骤：按角色（personaId/名称）引用预置智能体，运行期解析到实际 agent */
export interface TeamTemplateStep {
  id: string
  /** 目标角色名（与预置智能体 name/personaId 匹配），如 '产品经理' */
  role: string
  /** 该步指令模板（{goal} 会被替换为用户目标） */
  instruction: string
  /** 前置步骤 id（接力关系，空 = 与其它无依赖步骤并行） */
  dependsOn: string[]
}

/** 团队模板：常用角色组合一键成团 */
export interface TeamTemplate {
  id: string
  name: string
  icon?: string
  description: string
  /** 流水线说明（用于运行视图展示，如 "产品经理 → 架构师 → 前后端并行 → 测试"） */
  pipeline: string
  steps: TeamTemplateStep[]
}

/* ============================================================
 * 手势意图引擎（第四批）
 * ============================================================ */

/** 意图候选：五路信号融合后输出的最高分意图 */
export interface IntentCandidate {
  ts: number
  /** 意图名（如 pause_media / toggle_presentation / open_quick_panel） */
  intent: string
  /** 目标对象描述（如「前台视频窗口」/「当前 PPT」），可为空 */
  target?: string
  /** 综合置信度 0-1 */
  confidence: number
  /** 命中的信号来源（gesture/gaze/voice/screen/context） */
  source: string[]
  /** 触发的原始手势/事件（展示用） */
  trigger?: string
  /** 建议动作描述 */
  action?: string
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

/* ============================================================
 * 任务执行事件（供豆包 UI 消费 · 任务书 03 · A-4）
 * ============================================================ */

/** 任务步骤事件：`xuanshu:task-step` 通道 payload */
export interface TaskStepEvent {
  stepId: string
  /** 步骤标题/说明 */
  title: string
  /** 状态：pending / running / done / failed */
  status: 'pending' | 'running' | 'done' | 'failed'
  /** 补充详情（如错误信息、输出摘要） */
  detail?: string
  /** 事件时间戳 */
  ts: number
}

/** 工具调用事件：`xuanshu:tool-call` 通道 payload */
export interface ToolCallEvent {
  /** 工具名，如 web_search / open_software / query_app_status */
  tool: string
  /** 参数摘要（脱敏/截断后的展示用摘要） */
  argsSummary: string
  /** 状态：start / done / error */
  status: 'start' | 'done' | 'error'
  /** 结果预览（截断） */
  resultPreview?: string
  /** 事件时间戳 */
  ts: number
}

/* ============================================================
 * 智能体重构 · AgentManifest 与安全分级（施工蓝本 §5 / §8）
 * ============================================================ */

/** 工具权限分级（§8）：read 自动 / act 会话确认 / danger 每次强制确认 */
export type PermissionLevel = 'read' | 'act' | 'danger'

/** 工具副作用（§8）：none 无副作用 / mutate 可变 / irreversible 不可逆 */
export type SideEffect = 'none' | 'mutate' | 'irreversible'

/** 智能体默认模型档（§5）：本地 9B 够用 / 云端万亿全开 */
export type AgentDefaultModelTier = 'local' | 'cloud'

/**
 * AgentManifest — 智能体清单（§5，纯数据可热加载，数量定死 20 个）。
 * 每个智能体 = 角色壳 + 工具集 + 边界 + 默认模型档 + 启用状态。
 * 供主进程种子落盘，豆包 UI 直接消费本结构展示列表/卡片/明细。
 */
export interface AgentManifest {
  /** 稳定 id（如 'agent-system-commander'） */
  id: string
  /** 显示名（中文） */
  name: string
  /** 一句话使命 */
  mission: string
  /** 角色身份 */
  role: string
  /** 技能描述列表 */
  skills: string[]
  /** 协作协议（如何与其它智能体/外部 AI 协作） */
  collaboration: string
  /** 引用 toolRegistry 工具名（子集，本地模式默认最小集） */
  toolIds: string[]
  /** 边界（明确不可做，红线硬约束） */
  boundaries: string[]
  /** 默认模型档 */
  defaultModelTier: AgentDefaultModelTier
  /** 启用状态（本地模式默认最小工具集，云端全开） */
  enabled: boolean
  tags: string[]
  icon?: string
  color?: string
}
