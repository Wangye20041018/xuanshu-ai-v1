/**
 * 群协作编排器 — 多智能体串行接力
 *
 * 新建 orchestrator（不复用 tandem-manager，其语义是「多模型联动」）。
 *  - plan(goal)：AI 任务分解 + 派发（生成 SwarmTask：steps + dependsOn DAG）
 *  - 解析失败 / 无合法 DAG → 降级 manual（展示任务清单待用户编排）
 *  - run(task)：拓扑排序 → 逐 step 派发 agent-runtime 串行执行 → 汇总
 *  - 单 step 失败 → 标记 failed，继续下一步（不整体崩）
 *
 * 本地小模型结构化输出不稳定 → tryParseSwarmTask 严格解析 + 失败降级。
 *
 * @module main/agent/orchestrator
 */

import { logger } from '../../shared/logger'
import { ipcMain } from 'electron'
import { agentStore } from './agent-store'
import { runAgent } from './agent-runtime'
import type {
  AgentRunEvent,
  SwarmResult,
  SwarmStep,
  SwarmStepResult,
  SwarmTask,
} from '../../shared/agent-types'

/** 生成 swarm id */
function swarmId(): string {
  return `swarm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function stepId(i: number): string {
  return `step-${Date.now().toString(36)}-${i}`
}

/** AI 输出的步骤结构 */
interface RawStep {
  agentId?: string
  instruction?: string
  dependsOn?: string[]
}

/** 从模型输出解析 SwarmTask；失败返回 undefined */
function tryParseSwarmTask(text: string, agents: Array<{ id: string; name: string }>): SwarmTask | undefined {
  if (!text) return undefined
  try {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    const json = text.slice(start, end + 1)
    const parsed = JSON.parse(json) as { goal?: string; steps?: RawStep[] }
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) return undefined

    const validIds = new Set(agents.map((a) => a.id))
    const steps: SwarmStep[] = parsed.steps
      .filter((s) => s && typeof s.instruction === 'string' && s.instruction.trim())
      .map((s, i) => ({
        id: stepId(i),
        agentId: s.agentId && validIds.has(s.agentId) ? s.agentId : agents[0]?.id || '',
        instruction: s.instruction!.trim(),
        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.filter((d) => typeof d === 'string') : [],
      }))

    if (steps.length === 0 || steps.some((s) => !s.agentId)) return undefined

    return {
      id: swarmId(),
      goal: parsed.goal || '群协作任务',
      steps,
      mode: 'auto',
      status: 'planning',
      createdAt: Date.now(),
    }
  } catch {
    return undefined
  }
}

/** 拓扑排序（Kahn）：返回按依赖顺序排列的 step id 列表；有环返回 null */
function topoSort(steps: SwarmStep[]): string[] | null {
  const ids = steps.map((s) => s.id)
  const idSet = new Set(ids)
  const indegree = new Map<string, number>()
  const out = new Map<string, string[]>()
  for (const s of steps) {
    indegree.set(s.id, 0)
    out.set(s.id, [])
  }
  for (const s of steps) {
    for (const dep of s.dependsOn) {
      if (!idSet.has(dep)) return null // 依赖不存在的 step
      indegree.set(s.id, (indegree.get(s.id) || 0) + 1)
      out.get(dep)!.push(s.id)
    }
  }
  const queue = Array.from(indegree.entries()).filter(([, d]) => d === 0).map(([id]) => id)
  const sorted: string[] = []
  while (queue.length > 0) {
    const cur = queue.shift()!
    sorted.push(cur)
    for (const next of out.get(cur)!) {
      indegree.set(next, (indegree.get(next) || 1) - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }
  return sorted.length === steps.length ? sorted : null
}

/** 构建编排 prompt（固定 schema） */
function buildPlanPrompt(goal: string, agents: Array<{ id: string; name: string; description: string }>): string {
  const agentLines = agents.map((a) => `- ${a.id}（${a.name}）：${a.description || '通用智能体'}`).join('\n')
  return `你是玄枢AI的群协作编排器。请把用户目标分解为多智能体串行接力步骤。

## 可用智能体
${agentLines}

## 输出要求
只输出严格 JSON（不要输出其他文字），格式如下：
{"goal":"目标","steps":[{"agentId":"智能体id","instruction":"该步指令","dependsOn":[]}]}

说明：dependsOn 是前置步骤序号（从 0 开始，用数字字符串数组，如 ["0"]），表示该步依赖哪些前序步骤的输出。首步 dependsOn 为空数组。

用户目标：${goal}`
}

/** 调模型生成编排（返回原始文本） */
async function generateOnce(prompt: string): Promise<string> {
  const { modelManager } = await import('../model-manager')
  const resp = await modelManager.generateResponse(prompt, { temperature: 0.4, maxTokens: 1024 })
  return typeof resp === 'string' ? resp : (resp as { content?: string })?.content || String(resp)
}

class Orchestrator {
  /**
   * 规划群协作任务（AI 分解 + 派发）。
   * 失败 → 返回 { success: false, error }，渲染层降级为手动编排。
   */
  async plan(goal: string): Promise<{ success: boolean; data?: SwarmTask; error?: string }> {
    const g = String(goal || '').trim()
    if (!g) return { success: false, error: '目标不能为空' }

    const agents = agentStore.list().map((a) => ({ id: a.id, name: a.name, description: a.description }))
    if (agents.length === 0) {
      return { success: false, error: '没有可用智能体，请先创建智能体' }
    }

    const prompt = buildPlanPrompt(g, agents)
    let task: SwarmTask | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await generateOnce(prompt)
        const candidate = tryParseSwarmTask(raw, agents)
        if (candidate) {
          // 校验 DAG 合法性（依赖存在 + 无环）
          const order = topoSort(candidate.steps)
          if (order) {
            // 归一化 dependsOn（AI 用序号，转成 step id）
            candidate.steps = candidate.steps.map((s, i) => ({
              ...s,
              dependsOn: s.dependsOn
                .map((d) => {
                  const idx = Number(d)
                  return Number.isInteger(idx) && idx >= 0 && idx < i ? candidate!.steps[idx].id : d
                })
                .filter((d) => candidate!.steps.some((x) => x.id === d)),
            }))
            task = candidate
            break
          }
        }
        logger.warn(`[Orchestrator] 第 ${attempt + 1} 次编排解析/DAG 校验失败`)
      } catch (e) {
        logger.warn(`[Orchestrator] 生成异常（第 ${attempt + 1} 次）: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    if (!task) {
      // 降级手动编排：返回带空 steps 的 manual 任务，渲染层展示智能体清单待用户编排
      const manualTask: SwarmTask = {
        id: swarmId(),
        goal: g,
        steps: [],
        mode: 'manual',
        status: 'planning',
        createdAt: Date.now(),
      }
      return { success: false, data: manualTask, error: '自动编排失败，已降级为手动编排' }
    }

    return { success: true, data: task }
  }

  /** 手动编排：直接接收用户组装好的 task（steps 由用户指定） */
  buildManualTask(goal: string, steps: SwarmStep[]): SwarmTask {
    return {
      id: swarmId(),
      goal: String(goal || ''),
      steps: steps || [],
      mode: 'manual',
      status: 'planning',
      createdAt: Date.now(),
    }
  }

  /**
   * 运行群协作任务（串行拓扑排序执行）。
   * 通过 onEvent 回传进度；最终返回 SwarmResult。
   */
  async run(
    task: SwarmTask,
    onEvent?: (ev: { type: string; stepId?: string; agentId?: string; message?: string; output?: string }) => void,
  ): Promise<SwarmResult> {
    const results: SwarmStepResult[] = []
    if (!task || task.steps.length === 0) {
      return { taskId: task?.id || '', steps: [], summary: '任务为空，无可执行步骤' }
    }

    const order = topoSort(task.steps)
    if (!order) {
      return { taskId: task.id, steps: [], summary: '任务依赖关系非法（存在循环或缺失依赖），无法执行' }
    }

    const stepMap = new Map(task.steps.map((s) => [s.id, s]))
    const outputs = new Map<string, string>()

    for (const sid of order) {
      const step = stepMap.get(sid)!
      onEvent?.({ type: 'step-start', stepId: step.id, agentId: step.agentId, message: step.instruction })
      try {
        // 拼接前置步骤输出作为上下文
        const contextParts: string[] = []
        for (const dep of step.dependsOn) {
          if (outputs.has(dep)) contextParts.push(`[前序步骤输出]\n${outputs.get(dep)}`)
        }
        const instruction = contextParts.length > 0
          ? `${step.instruction}\n\n${contextParts.join('\n\n')}`
          : step.instruction

        let finalOutput = ''
        await runAgent(
          { agentId: step.agentId, messages: [{ role: 'user', content: instruction }] },
          (ev: AgentRunEvent) => {
            if (ev.type === 'response' && ev.content) {
              finalOutput = ev.content
            }
            if (ev.type === 'error') {
              onEvent?.({ type: 'step-error', stepId: step.id, agentId: step.agentId, message: ev.message })
            }
          },
        )

        outputs.set(step.id, finalOutput || '（该步骤未返回内容）')
        results.push({ stepId: step.id, agentId: step.agentId, output: finalOutput, status: 'done' })
        onEvent?.({ type: 'step-done', stepId: step.id, agentId: step.agentId, output: finalOutput })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        results.push({ stepId: step.id, agentId: step.agentId, output: '', status: 'failed' })
        onEvent?.({ type: 'step-failed', stepId: step.id, agentId: step.agentId, message: msg })
      }
    }

    const summary = results
      .map((r) => `[${r.status === 'done' ? '✓' : '✗'} ${r.agentId}] ${r.output || '（失败/无输出）'}`)
      .join('\n\n')

    return { taskId: task.id, steps: results, summary }
  }
}

/** 全局单例 */
export const orchestrator = new Orchestrator()

/** 注册 swarm:* IPC handler */
export function setupSwarmHandlers(): void {
  ipcMain.handle('swarm:plan', async (_event, goal: string) => {
    return orchestrator.plan(String(goal || ''))
  })

  ipcMain.handle('swarm:run', async (event, task: SwarmTask) => {
    const sender = event.sender
    const send = (payload: unknown): void => {
      try {
        if (!sender.isDestroyed()) sender.send('swarm:event', payload)
      } catch {
        /* ignore */
      }
    }
    const result = await orchestrator.run(task, (ev) => send({ taskId: task?.id, ...ev }))
    return { success: true, data: result }
  })

  ipcMain.handle('swarm:status', async () => {
    return { success: true, data: { agents: agentStore.list().length, status: 'idle' } }
  })

  logger.debug('[Orchestrator] setupSwarmHandlers registered')
}
