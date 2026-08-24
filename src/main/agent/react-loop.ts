/* ============================================================
 * ReAct 循环控制器
 * 思考 (Reason) → 行动 (Act) → 观察 (Observe) → 循环
 * 推理模型通过 modelManager.generateResponse() 调用
 * ============================================================ */

import { IAgent, AgentInput, AgentEvent, AgentState, AgentConfig, AgentStats, ToolDefinition, ToolResult } from './types'
import { toolRegistry } from './tool-registry'
import { logger } from '../../shared/logger'

// 延迟导入，避免循环依赖
let modelManager: any = null
function getModelManager() {
  if (!modelManager) {
    try {
      modelManager = require('../model-manager').modelManager
    } catch {
      logger.warn('[Agent] modelManager 未就绪')
    }
  }
  return modelManager
}

export class ReActAgent implements IAgent {
  readonly id: string
  private _state: AgentState = 'idle'
  private _config: AgentConfig
  private abortController: AbortController | null = null
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

    // ReAct 循环
    for (let step = 0; step < maxSteps; step++) {
      if (this.abortController.signal.aborted) {
        yield { type: 'response', content: '', isFinal: true }
        this._state = 'done'
        return
      }

      this._state = 'thinking'
      yield { type: 'status', message: `思考中... (步骤 ${step + 1}/${maxSteps})`, progress: step / maxSteps }

      try {
        // ① 调用推理模型
        const mgr = getModelManager()
        if (!mgr) {
          yield { type: 'error', message: '模型管理器未就绪', code: 'MODEL_MANAGER_NOT_READY' }
          this._state = 'error'
          return
        }

        // 将上下文消息转换为 prompt 字符串
        const prompt = this.formatContextAsPrompt(context, tools)

        const response = await mgr.generateResponse(prompt, {
          temperature: 0.7,
          maxTokens: 2048,
        })

        const thought = typeof response === 'string' ? response : response.content || response.text || JSON.stringify(response)

        yield { type: 'thinking', content: thought, step: step + 1 }

        // ② 解析工具调用
        const toolCall = this.parseToolCall(thought)

        if (!toolCall) {
          // 没有工具调用，直接返回
          this._state = 'responding'
          yield { type: 'response', content: thought, isFinal: true }
          this._state = 'done'
          this.updateStats(startTime, step)
          return
        }

        // ③ 执行工具
        this._state = 'acting'
        yield { type: 'tool_call', tool: toolCall.name, params: toolCall.params, step: step + 1 }
        this.stats.totalToolCalls++

        // 工具子集闸：per-agent 未授权工具直接拒绝（纵深防御，模型本不该看到）
        if (!this.isToolAllowed(toolCall.name)) {
          yield {
            type: 'tool_result',
            tool: toolCall.name,
            result: { success: false, error: `工具 ${toolCall.name} 未授权给该智能体` },
            step: step + 1,
          }
          context.push({
            role: 'tool',
            content: JSON.stringify({ success: false, error: `工具 ${toolCall.name} 未授权给该智能体` }),
            name: toolCall.name,
          })
          continue
        }

        // 危险工具人工确认门：拒绝则产出失败结果并继续循环，不抛未捕获异常
        const tool = toolRegistry.get(toolCall.name)
        let result: ToolResult
        if (tool?.dangerous) {
          const confirmed = await this.confirmIfDangerous(tool, toolCall.params)
          result = confirmed
            ? await toolRegistry.execute(toolCall.name, toolCall.params)
            : { success: false, error: '用户已拒绝' }
        } else {
          result = await toolRegistry.execute(toolCall.name, toolCall.params)
        }

        // ④ 观察结果
        this._state = 'observing'
        yield { type: 'tool_result', tool: toolCall.name, result, step: step + 1 }

        // 将结果追加到上下文
        context.push({
          role: 'tool',
          content: JSON.stringify(result),
          name: toolCall.name,
        })

        if (!result.success) {
          context.push({
            role: 'system',
            content: `工具 ${toolCall.name} 执行失败: ${result.error}。请尝试其他方法或告知用户问题。`,
          })
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

    // 最终回复
    try {
      const mgr = getModelManager()
      if (mgr) {
        context.push({
          role: 'system',
          content: '已达到最大步骤限制，请基于已获取的信息生成最终回复。',
        })
        const finalPrompt = this.formatContextAsPrompt(context, null)
        const finalResponse = await mgr.generateResponse(finalPrompt, { temperature: 0.7, maxTokens: 2048 })
        const content = typeof finalResponse === 'string' ? finalResponse : finalResponse.content || ''
        yield { type: 'response', content, isFinal: true }
      }
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

  private formatContextAsPrompt(
    context: Array<{ role: string; content: string; name?: string }>,
    tools: ReturnType<typeof toolRegistry.getFunctionCallingTools> | null,
  ): string {
    const parts: string[] = []

    // 工具定义
    if (tools && tools.length > 0) {
      parts.push('## 可用工具')
      for (const t of tools) {
        parts.push(`- **${t.function.name}**: ${t.function.description}`)
        parts.push(`  参数: ${JSON.stringify(t.function.parameters)}`)
      }
      parts.push('')
    }

    // 对话历史
    for (const msg of context) {
      const roleLabel = msg.role === 'system' ? '系统' : msg.role === 'user' ? '用户' : msg.role === 'assistant' ? '助手' : msg.role === 'tool' ? `工具(${msg.name || 'unknown'})` : msg.role
      parts.push(`[${roleLabel}]: ${msg.content}`)
    }

    return parts.join('\n')
  }

  private getDefaultSystemPrompt(): string {
    const toolList = toolRegistry.getEnabled(this._config.toolIds)
      .map(t => `- **${t.name}**: ${t.description}`)
      .join('\n')

    return `你是一个智能桌面助手，可以通过调用工具来完成用户的请求。

## 可用工具
${toolList}

## 工作方式
1. 分析用户意图，确定是否需要调用工具
2. 如需调用工具，使用以下格式：
\`\`\`tool
{"name": "工具名", "params": {"参数": "值"}}
\`\`\`
3. 观察工具返回结果，决定下一步操作
4. 完成任务后，直接回复用户，不要包含工具调用代码

## 规则
- 每次只调用一个工具
- 工具调用失败时，尝试其他方法
- 不要透露内部工作细节给用户`
  }

  /** 危险工具确认门：有独立 confirm 回调则调用；无则返回 true（依赖工具内部确认，如 visualAgent.confirmExecute） */
  private async confirmIfDangerous(tool: ToolDefinition, params: Record<string, unknown>): Promise<boolean> {
    if (!tool.confirm) return true
    try {
      return await tool.confirm(params)
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

  private parseToolCall(text: string): { name: string; params: Record<string, unknown> } | null {
    // 尝试匹配 ```tool ... ``` 格式
    const toolMatch = text.match(/```tool\s*\n\s*(\{[\s\S]*?\})\s*\n\s*```/)
    if (toolMatch) {
      try {
        const parsed = JSON.parse(toolMatch[1])
        if (parsed.name && parsed.params) {
          return { name: parsed.name, params: parsed.params }
        }
      } catch { /* 忽略解析错误 */ }
    }

    // 尝试匹配 JSON 格式的工具调用
    const jsonMatch = text.match(/\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?"params"[\s\S]*?\}/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0])
        if (parsed.name && parsed.params) {
          return { name: parsed.name, params: parsed.params }
        }
      } catch { /* 忽略 */ }
    }

    return null
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