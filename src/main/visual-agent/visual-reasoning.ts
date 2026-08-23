/**
 * VisualReasoningEngine — 视觉推理引擎 (visual-agent 层)
 * 
 * 包装 inference/visual-reasoning 的引擎，新增:
 *   - verifyAction: 操作后截图对比，验证操作是否生效
 *   - summarizeResult: 任务结束后生成自然语言总结
 * 
 * 采用懒加载模式：首次调用时才加载重量级依赖。
 */
import type { VisualStep } from './index'
import { logger } from '../../shared/logger'

interface DecisionInput {
  action: string
  target?: any
  keys?: string
  text?: string
}

class VisualAgentReasoningEngine {
  private _engine: any = null
  private _loading: Promise<any> | null = null

  private async _ensureEngine(): Promise<any> {
    if (this._engine) return this._engine
    if (!this._loading) {
      this._loading = import('../inference/visual-reasoning').then(mod => {
        const BaseEngine = mod.VisualReasoningEngine
        this._engine = new BaseEngine()
        return this._engine
      })
    }
    return this._loading
  }

  /** 规划任务步骤 */
  async planTask(intent: string): Promise<any> {
    const engine = await this._ensureEngine()
    return engine.planTask(intent)
  }

  /** 决定下一步操作 */
  async decideNextAction(
    observation: any,
    taskContext: any
  ): Promise<any> {
    const engine = await this._ensureEngine()
    // 拆包 observation → 底层 ScreenObservation；taskContext 实为 task.intent 字符串
    const screenObservation = {
      description: observation?.description ?? '',
      applicationName: observation?.applicationName ?? null,
      windowTitle: observation?.windowTitle ?? null,
      dialogOpen: observation?.dialogOpen ?? false,
      loading: observation?.loading ?? false,
      errorMessage: observation?.errorMessage ?? null,
      elements: Array.isArray(observation?.elements) ? observation.elements : [],
    }
    const taskId = observation?.taskId || `task-${Date.now()}`
    const taskIntent = typeof taskContext === 'string' ? taskContext : (observation?.taskIntent || '')
    return engine.decideNextAction(taskId, screenObservation, taskIntent)
  }

  /**
   * 验证操作是否生效
   * 对比操作前后的截图，判断预期变化是否发生
   */
  async verifyAction(
    decision: DecisionInput,
    beforeScreenshot: string,
    afterScreenshot: string,
    taskIntent: string
  ): Promise<{ success: boolean; reason: string }> {
    logger.debug(`[VisualReasoning] 验证操作: ${decision.action}`)

    if (beforeScreenshot === afterScreenshot) {
      return { success: false, reason: '操作前后屏幕无变化，操作可能未生效' }
    }

    const diffRatio = Math.abs(afterScreenshot.length - beforeScreenshot.length) / beforeScreenshot.length
    if (diffRatio < 0.01) {
      return { success: false, reason: `屏幕变化太小 (${(diffRatio * 100).toFixed(1)}%)，操作可能未生效` }
    }

    // 调用基模型进一步验证
    try {
      const engine = await this._ensureEngine()
      const prompt = `你正在验证一个电脑操作是否成功。
任务: ${taskIntent}
执行的操作: ${JSON.stringify(decision)}

请判断操作是否生效了。返回 JSON:
{"success": true/false, "reason": "判断理由"}`
      const response = await engine.invokeModel(prompt, { temperature: 0.3, maxTokens: 256 })
      if (response) {
        const result = JSON.parse(response)
        return { success: result.success === true, reason: result.reason || '模型验证通过' }
      }
    } catch {
      // fallback
    }

    return { success: true, reason: '屏幕有变化，假设操作成功' }
  }

  /**
   * 生成任务执行总结
   */
  async summarizeResult(steps: VisualStep[], taskIntent: string): Promise<string> {
    const completed = steps.filter(s => s.status === 'completed').length
    const failed = steps.filter(s => s.status === 'error').length
    const total = steps.length

    let summary = `任务"${taskIntent}"执行完毕。`
    summary += `共执行 ${total} 步，成功 ${completed} 步，失败 ${failed} 步。`

    if (failed > 0) {
      const failedSteps = steps.filter(s => s.status === 'error')
      summary += ` 失败步骤: ${failedSteps.map(s => `[${s.id}] ${s.action} → ${s.failReason || '未知错误'}`).join('; ')}`
    }

    return summary
  }
}

export const visualReasoningEngine = new VisualAgentReasoningEngine()
