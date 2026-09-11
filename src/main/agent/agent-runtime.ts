/**
 * Agent 运行时 — 凭 agentId 拉起完整 ReAct 循环
 *
 * 封装「人设 + 工具子集 + 独立记忆命名空间」四要素：
 *   ① agentStore.get(agentId) 读定义
 *   ② personaLoader.getPersona(personaId) 取 system_prompt + personaOverride 拼接
 *   ③ toolRegistry 按 toolIds 过滤工具子集
 *   ④ 独立记忆：memoryConfig.namespace 注入 system prompt
 *   ⑤ new ReActAgent({ systemPrompt, toolIds, maxSteps }) 运行并逐事件回传
 *
 * @module main/agent/agent-runtime
 */

import type {
  AgentDefinition,
  AgentRunEvent,
} from '../../shared/agent-types'
import { ReActAgent } from './react-loop'
import { agentStore } from './agent-store'
import { logger } from '../../shared/logger'
import type { AgentEvent } from './types'
import { personaLoader } from '../persona-loader'

/** 运行中的 agent 句柄（供 agent:stop 取消） */
const runningAgents = new Map<string, ReActAgent>()

export interface AgentRunContext {
  agentId: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
}

export function isAgentRunning(agentId: string): boolean {
  return runningAgents.has(agentId)
}

/** 取消指定智能体的运行 */
export function stopAgent(agentId: string): void {
  const agent = runningAgents.get(agentId)
  if (agent) {
    try {
      agent.cancel()
    } catch (e) {
      logger.warn(`[AgentRuntime] 取消 ${agentId} 失败: ${e instanceof Error ? e.message : String(e)}`)
    }
    runningAgents.delete(agentId)
  }
}

/** 取消所有运行中的智能体（紧急暂停时调用） */
export function stopAllAgents(): void {
  for (const id of Array.from(runningAgents.keys())) {
    stopAgent(id)
  }
}

/** 组装 system prompt：人设 + 微调 + 记忆命名空间 */
async function buildSystemPrompt(def: AgentDefinition): Promise<string> {
  let base = ''
  try {
    // 延迟加载，避免启动期循环依赖
    const persona = personaLoader.getPersona(def.personaId)
    base = persona?.system_prompt || persona?.description || ''
  } catch (e) {
    logger.warn(`[AgentRuntime] 加载人设 ${def.personaId} 失败: ${e instanceof Error ? e.message : String(e)}`)
  }

  if (!base) {
    base = `你是智能体「${def.name}」。${def.description || ''}`.trim()
  }

  // 人设微调（动态创建时 AI 追加的 prompt）
  if (def.personaOverride?.systemPromptSuffix) {
    base += `\n\n${def.personaOverride.systemPromptSuffix}`
  }

  // 独立记忆命名空间（注入为上下文标记，供后续检索按 namespace 过滤）
  if (def.memoryConfig?.enabled) {
    base += `\n\n## 记忆\n- 记忆命名空间: ${def.memoryConfig.namespace}\n- 每次召回条数上限: ${def.memoryConfig.maxRecall}`
  }

  // 工作方式提示（与 ReActAgent 默认 prompt 保持一致的工具调用约定）
  base += `\n\n## 工作方式
1. 分析用户意图，确定是否需要调用工具
2. 如需调用工具，使用以下格式：
\`\`\`tool
{"name": "工具名", "params": {"参数": "值"}}
\`\`\`
3. 观察工具返回结果，决定下一步操作
4. 完成任务后，直接回复用户，不要包含工具调用代码`

  return base
}

/** 将主进程 AgentEvent 映射为渲染层消费的 AgentRunEvent */
function mapEvent(ev: AgentEvent): AgentRunEvent {
  switch (ev.type) {
    case 'thinking':
      return { type: 'thinking', content: ev.content, step: ev.step }
    case 'tool_call':
      return { type: 'tool_call', tool: ev.tool, params: ev.params, step: ev.step }
    case 'tool_result':
      return {
        type: 'tool_result',
        tool: ev.tool,
        step: ev.step,
        result: { success: ev.result.success, data: ev.result.data, error: ev.result.error },
      }
    case 'response':
      return { type: 'response', content: ev.content, isFinal: ev.isFinal }
    case 'error':
      return { type: 'error', message: ev.message, code: ev.code }
    case 'status':
      return { type: 'status', message: ev.message, progress: ev.progress }
    default:
      return { type: 'status', message: '未知事件' }
  }
}

/**
 * 运行智能体，逐事件通过 onEvent 回调回传。
 * 返回 void；错误经 onEvent({type:'error'}) 传递（不抛未捕获异常）。
 */
export async function runAgent(
  ctx: AgentRunContext,
  onEvent: (ev: AgentRunEvent) => void,
): Promise<void> {
  const def = agentStore.get(ctx.agentId)
  if (!def) {
    onEvent({ type: 'error', message: '智能体不存在', code: 'AGENT_NOT_FOUND' })
    return
  }
  if (runningAgents.has(ctx.agentId)) {
    onEvent({ type: 'error', message: '该智能体正在运行中', code: 'AGENT_BUSY' })
    return
  }

  const systemPrompt = await buildSystemPrompt(def)
  const maxSteps = def.modelConfig?.maxSteps ?? 15
  const agent = new ReActAgent({
    systemPrompt,
    toolIds: def.toolIds,
    maxSteps,
    defaultModelId: def.modelConfig?.modelId ?? 'default',
    // A-3 记忆真隔离：注入智能体命名空间，检索类工具据此过滤
    namespace: def.memoryConfig?.enabled ? def.memoryConfig.namespace : undefined,
  })

  runningAgents.set(ctx.agentId, agent)
  try {
    const input = {
      messages: ctx.messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      maxSteps,
      modelId: def.modelConfig?.modelId,
    }
    for await (const ev of agent.run(input)) {
      onEvent(mapEvent(ev))
    }
  } catch (e) {
    logger.error(`[AgentRuntime] 运行 ${ctx.agentId} 异常: ${e instanceof Error ? e.message : String(e)}`)
    onEvent({ type: 'error', message: e instanceof Error ? e.message : String(e), code: 'AGENT_RUNTIME_ERROR' })
  } finally {
    runningAgents.delete(ctx.agentId)
  }
}
