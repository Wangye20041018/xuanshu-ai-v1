/* ============================================================
 * ReAct 循环控制器
 * 思考 (Reason) → 行动 (Act) → 观察 (Observe) → 循环
 * 推理模型通过 modelManager.generateResponse() 调用
 * ============================================================ */

import { IAgent, AgentInput, AgentEvent, AgentState, AgentConfig, AgentStats, ToolDefinition, ToolResult } from './types'
import { toolRegistry } from './tool-registry'
import { modelAdapter } from './model-adapter'
import type { ModelAdapterMessage } from '../../shared/model-adapter'
import type { PermissionLevel, SideEffect } from '../../shared/agent-types'
import { getStore } from '../ipc/config.ipc'
import { logger } from '../../shared/logger'

/** 危险工具一键冻结开关（§14）：写入后 gatePermission 对所有 danger 级工具一律拒绝 */
const DANGER_FREEZE_KEY = 'dangerToolsFrozen'

export class ReActAgent implements IAgent {
  readonly id: string
  private _state: AgentState = 'idle'
  private _config: AgentConfig
  private abortController: AbortController | null = null
  /** 会话内已确认的 act 级工具（§14：act 会话确认一次缓存） */
  private sessionConfirmedTools: Set<string> = new Set()
  private stats: AgentStats = {
    totalRuns: 0,
    totalSteps: 0,
    totalToolCalls: 0,
    averageLatency: 0,
    lastRunAt: null,
  }

  constructor(config: Partial<AgentConfig> = {}) {
    this.id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this._config = {
      maxSteps: config.maxSteps ?? 15,
      timeout: config.timeout ?? 120000,
      defaultModelId: config.defaultModelId ?? 'default',
      systemPrompt: config.systemPrompt ?? '',
      verbose: config.verbose ?? false,
      toolIds: config.toolIds,
      namespace: config.namespace,
    }
  }

  get state(): AgentState { return this._state }
  get config(): AgentConfig { return this._config }

  async *run(input: AgentInput): AsyncIterable<AgentEvent> {
    this._state = 'thinking'
    this.abortController = new AbortController()
    const startTime = Date.now()
    const maxSteps = input.maxSteps ?? this._config.maxSteps
    const toolIds = input.toolIds ?? this._config.toolIds
    const tools = toolRegistry.getFunctionCallingTools(toolIds)

    // 构建初始上下文
    const context = this.buildContext(input)

    this.stats.totalRuns++
    this.stats.lastRunAt = Date.now()

    // ReAct 循环 —— 模型调用统一走 ModelAdapter（三阶降级：原生FC / JSON协议 / ReAct文本）
    for (let step = 0; step < maxSteps; step++) {
      if (this.abortController.signal.aborted) {
        yield { type: 'response', content: '', isFinal: true }
        this._state = 'done'
        return
      }

      this._state = 'thinking'
      yield { type: 'status', message: `思考中... (步骤 ${step + 1}/${maxSteps})`, progress: step / maxSteps }

      try {
        // ① 模型推理：上下文 → 统一消息 → ModelAdapter 三阶降级
        const messages: ModelAdapterMessage[] = context.map((m) => ({
          role: m.role as ModelAdapterMessage['role'],
          content: m.content,
          name: m.name,
        }))

        const completion = await modelAdapter.complete(messages, { tools })

        yield { type: 'thinking', content: completion.content || '准备调用工具', step: step + 1 }

        // ② 无工具调用 → 直接返回最终回复
        if (completion.toolCalls.length === 0) {
          this._state = 'responding'
          yield { type: 'response', content: completion.content, isFinal: true }
          this._state = 'done'
          this.updateStats(startTime, step)
          return
        }

        // ③ 执行工具（云端可并行多个，逐个触发真实动作闭环）
        for (const tc of completion.toolCalls) {
          this._state = 'acting'
          yield { type: 'tool_call', tool: tc.toolName, params: tc.args, step: step + 1 }
          this.stats.totalToolCalls++

          // 工具子集闸：per-agent 未授权工具直接拒绝（纵深防御，模型本不该看到）
          if (!this.isToolAllowed(tc.toolName)) {
            const denied: ToolResult = { success: false, error: `工具 ${tc.toolName} 未授权给该智能体` }
            yield { type: 'tool_result', tool: tc.toolName, result: denied, step: step + 1 }
            context.push({
              role: 'tool',
              content: JSON.stringify(denied),
              name: tc.toolName,
            })
            continue
          }

          const tool = toolRegistry.get(tc.toolName)
          // A-3 记忆真隔离：知识类工具透传当前智能体 namespace，检索限定在各自命名空间
          const namespace = this._config.namespace || input.namespace
          const toolParams: Record<string, unknown> = { ...tc.args }
          if (namespace && tool?.category === 'knowledge') {
            toolParams.namespace = namespace
          }
          // 权限闸门（§14）：read 自动 / act 会话确认 / danger 每次强制确认 + 一键冻结
          // 拒绝则产出失败结果并继续循环，不抛未捕获异常
          let result: ToolResult
          if (!tool) {
            result = { success: false, error: `工具 ${tc.toolName} 不存在` }
          } else if (!(await this.gatePermission(tool, toolParams))) {
            result = { success: false, error: '用户已拒绝执行该操作' }
          } else {
            result = await toolRegistry.execute(tc.toolName, toolParams)
          }

          // ④ 观察结果
          this._state = 'observing'
          yield { type: 'tool_result', tool: tc.toolName, result, step: step + 1 }

          // 将结果追加到上下文
          context.push({
            role: 'tool',
            content: JSON.stringify(result),
            name: tc.toolName,
          })

          if (!result.success) {
            context.push({
              role: 'system',
              content: `工具 ${tc.toolName} 执行失败: ${result.error}。请尝试其他方法或告知用户问题。`,
            })
          }
        }
      } catch (err) {
        logger.error(`[Agent] ReAct 循环 step ${step} 错误:`, err)
        yield { type: 'error', message: String(err), code: 'REACT_LOOP_ERROR' }
        this._state = 'error'
        return
      }
    }

    // 达到最大步数
    this._state = 'responding'
    yield { type: 'status', message: '达到最大步数限制，正在生成最终回复...' }

    // 最终回复（也走 ModelAdapter，纯文本、无工具）
    try {
      context.push({
        role: 'system',
        content: '已达到最大步骤限制，请基于已获取的信息生成最终回复。',
      })
      const finalMessages: ModelAdapterMessage[] = context.map((m) => ({
        role: m.role as ModelAdapterMessage['role'],
        content: m.content,
        name: m.name,
      }))
      const finalCompletion = await modelAdapter.complete(finalMessages)
      yield { type: 'response', content: finalCompletion.content, isFinal: true }
    } catch {
      yield { type: 'response', content: '抱歉，任务执行超时。请尝试简化需求或增加步骤限制。', isFinal: true }
    }

    this._state = 'done'
    this.updateStats(startTime, maxSteps)
  }

  cancel(): void {
    this.abortController?.abort()
    this._state = 'done'
  }

  reset(): void {
    this.abortController?.abort()
    this.abortController = null
    this._state = 'idle'
  }

  getState(): AgentState { return this._state }

  getStats(): AgentStats { return { ...this.stats } }

  private buildContext(input: AgentInput): Array<{ role: string; content: string; name?: string }> {
    const context: Array<{ role: string; content: string; name?: string }> = []

    // System prompt
    const systemPrompt = this._config.systemPrompt || this.getDefaultSystemPrompt()
    context.push({ role: 'system', content: systemPrompt })

    // 用户消息
    for (const msg of input.messages) {
      context.push(msg)
    }

    return context
  }

  private getDefaultSystemPrompt(): string {
    return `你是一个智能桌面助手，通过调用工具完成用户请求。工具清单与调用格式由运行时（模型适配层）自动注入，请严格遵循运行时给出的工具调用格式。完成任务后直接回复用户，不要透露内部工作细节。`
  }

  /** 解析工具有效权限分级（§8）：显式 permissionLevel 优先；缺省按 dangerous 推断 */
  private resolvePermissionLevel(tool: ToolDefinition): PermissionLevel {
    if (tool.permissionLevel) return tool.permissionLevel
    return tool.dangerous ? 'danger' : 'read'
  }

  /** 解析工具副作用（§8）：显式 sideEffect 优先；缺省按权限分级推断 */
  private resolveSideEffect(tool: ToolDefinition, level: PermissionLevel): SideEffect {
    if (tool.sideEffect) return tool.sideEffect
    if (level === 'danger') return 'irreversible'
    if (level === 'act') return 'mutate'
    return 'none'
  }

  /**
   * 权限闸门（§14）：
   *  - read：自动放行（无副作用只读）
   *  - act：会话内确认一次（缓存到 sessionConfirmedTools）
   *  - danger：每次强制确认；且受「一键冻结危险工具」开关全局拦截
   */
  private async gatePermission(tool: ToolDefinition, params: Record<string, unknown>): Promise<boolean> {
    const level = this.resolvePermissionLevel(tool)
    const sideEffect = this.resolveSideEffect(tool, level)
    // 不可逆副作用一律升级为 danger（每次强制确认），防止 act 分级被绕过
    const effectiveLevel: PermissionLevel = sideEffect === 'irreversible' ? 'danger' : level

    // 一键冻结：danger 级全局拒绝（§14 安全横切）
    if (effectiveLevel === 'danger' && this.isDangerFrozen()) {
      logger.warn(`[Agent] 危险工具已全局冻结，拒绝执行: ${tool.name}`)
      return false
    }

    if (effectiveLevel === 'read') return true
    if (effectiveLevel === 'act') {
      if (this.sessionConfirmedTools.has(tool.name)) return true
      const ok = await this.confirmTool(tool, params)
      if (ok) this.sessionConfirmedTools.add(tool.name)
      return ok
    }
    // danger：每次强制确认
    return this.confirmTool(tool, params)
  }

  /** 确认门：有独立 confirm 回调则调用；无则返回 true（依赖工具内部确认，如 visualAgent.confirmExecute） */
  private async confirmTool(tool: ToolDefinition, params: Record<string, unknown>): Promise<boolean> {
    if (!tool.confirm) return true
    try {
      return await tool.confirm(params)
    } catch {
      return false
    }
  }

  /** 读取「一键冻结危险工具」开关（§14），读取失败默认不冻结（不阻断正常功能） */
  private isDangerFrozen(): boolean {
    try {
      return getStore().get(DANGER_FREEZE_KEY) === true
    } catch {
      return false
    }
  }

  /** 工具子集闸：未配置 toolIds 时放行全部；配置后仅允许子集内工具 */
  private isToolAllowed(name: string): boolean {
    const toolIds = this._config.toolIds
    if (!toolIds || toolIds.length === 0) return true
    return toolIds.includes(name)
  }

  private updateStats(startTime: number, steps: number): void {
    const latency = Date.now() - startTime
    this.stats.totalSteps += steps
    this.stats.averageLatency =
      this.stats.totalRuns > 0
        ? (this.stats.averageLatency * (this.stats.totalRuns - 1) + latency) / this.stats.totalRuns
        : latency
  }
}