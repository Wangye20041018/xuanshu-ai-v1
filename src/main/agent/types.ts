/* ============================================================
 * Agent 统一框架 — 核心类型定义
 * 统一所有任务执行入口，通过模型管理器调用推理模型
 * ============================================================ */

import type { PermissionLevel, SideEffect } from '../../shared/agent-types'

// ---- 工具定义 ----
export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description: string
  enum?: string[]
  default?: unknown
  required?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  category: 'plugin' | 'operation' | 'search' | 'vision' | 'knowledge' | 'system'
  parameters: {
    type: 'object'
    properties: Record<string, ToolParameter>
    required: string[]
  }
  /** 危险工具标记：执行前需经人工确认（驱动鼠标键盘 / 系统级破坏性操作） */
  dangerous?: boolean
  /** 可选的人工确认回调：返回 false 表示用户拒绝，此时不应执行 execute */
  confirm?: (params: Record<string, unknown>) => Promise<boolean>
  /** 权限分级（§8）：read 自动 / act 会话确认 / danger 每次强制确认。缺省按 dangerous 推断 */
  permissionLevel?: PermissionLevel
  /** 副作用（§8）：none / mutate / irreversible。缺省按 permissionLevel 推断 */
  sideEffect?: SideEffect
  // 执行函数
  execute: (params: Record<string, unknown>) => Promise<ToolResult>
}

export interface ToolResult {
  success: boolean
  data?: unknown
  error?: string
  duration?: number
}

// ---- Agent 事件 ----
export type AgentEvent =
  | { type: 'thinking'; content: string; step: number }
  | { type: 'tool_call'; tool: string; params: Record<string, unknown>; step: number }
  | { type: 'tool_result'; tool: string; result: ToolResult; step: number }
  | { type: 'response'; content: string; isFinal: boolean }
  | { type: 'error'; message: string; code?: string }
  | { type: 'status'; message: string; progress?: number }

// ---- Agent 状态 ----
export type AgentState = 'idle' | 'thinking' | 'acting' | 'observing' | 'responding' | 'error' | 'done'

// ---- Agent 输入/输出 ----
export interface AgentInput {
  messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; name?: string }>
  modelId?: string
  personaId?: string
  maxSteps?: number
  timeout?: number
  stream?: boolean
  /** per-agent 工具子集（可选）：未提供时回落 AgentConfig.toolIds */
  toolIds?: string[]
  /** 记忆命名空间：记忆检索工具据此隔离（A-3 记忆真隔离） */
  namespace?: string
}

export interface AgentConfig {
  maxSteps: number
  timeout: number
  defaultModelId: string
  systemPrompt: string
  verbose: boolean
  /** per-agent 工具子集（可选）：未提供时使用全局工具集 */
  toolIds?: string[]
  /** 记忆命名空间：记忆检索工具据此隔离（A-3 记忆真隔离） */
  namespace?: string
}

// ---- IAgent 接口 ----
export interface IAgent {
  readonly id: string
  readonly state: AgentState
  readonly config: AgentConfig

  run(input: AgentInput): AsyncIterable<AgentEvent>
  cancel(): void
  reset(): void
  getState(): AgentState
  getStats(): AgentStats
}

export interface AgentStats {
  totalRuns: number
  totalSteps: number
  totalToolCalls: number
  averageLatency: number
  lastRunAt: number | null
}