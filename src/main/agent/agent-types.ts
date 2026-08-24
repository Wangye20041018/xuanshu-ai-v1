/**
 * Agent 共享类型薄再导出
 *
 * 主进程统一从本文件（或直接 from shared/agent-types）消费智能体相关类型。
 * 保持与设计文档「src/main/agent/agent-types.ts 薄再导出」一致。
 *
 * @module main/agent/agent-types
 */

export type {
  AgentDefinition,
  AgentMemoryConfig,
  AgentModelConfig,
  AgentPersonaOverride,
  AgentCreatePreview,
  AgentCreateRequest,
  AgentRunEvent,
  AgentRunEventType,
  AgentRunRequest,
  ControlPhase,
  ControlWhitelistFile,
  SwarmMode,
  SwarmResult,
  SwarmStatus,
  SwarmStep,
  SwarmStepResult,
  SwarmStepStatus,
  SwarmTask,
  WhitelistEntry,
  WhitelistScope,
} from '../../shared/agent-types'
