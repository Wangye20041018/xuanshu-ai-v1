/**
 * VisualReasoningEngine — 主模型视觉推理引擎 v2.0
 * 专门优化用于屏幕理解 + 电脑操控任务
 * 增强：结构化输出、动作规划、错误自愈、上下文记忆
 */
import { cpuInferenceEngine } from './cpu-engine'
import { logger } from '../../shared/logger'

interface ScreenObservation {
  description: string
  applicationName: string | null
  windowTitle: string | null
  dialogOpen: boolean
  loading: boolean
  errorMessage: string | null
  elements: Array<{ type: string; label: string; bbox: { x: number; y: number; w: number; h: number }; confidence: number }>
}

interface VisualTaskContext {
  intent: string
  target: string
  history: Array<{ action: string; result: string; timestamp: number }>
  attempts: number
  maxAttempts: number
}

interface ActionDecision {
  action: 'click' | 'type' | 'scroll' | 'drag' | 'press_keys' | 'wait' | 'screenshot' | 'right_click' | 'double_click' | 'ask_user' | 'done' | 'retry'
  target?: { x: number; y: number; label: string; type: string }
  text?: string
  keys?: string
  duration?: number
  reason: string
  confidence: number
  fallback?: ActionDecision
}

const COMPUTER_CONTROL_SYSTEM_PROMPT = `你是玄枢AI的视觉操控大脑。你正在通过截图观察用户的电脑屏幕，并需要像真人一样操控电脑完成任务。

## 核心能力
1. **屏幕理解**：从截图描述中理解当前屏幕状态（打开什么软件、有什么按钮、弹窗了什么）
2. **动作决策**：决定下一步应该点击哪里、输入什么、按什么键
3. **错误处理**：操作失败后自动分析原因并换策略重试
4. **任务记忆**：记住已完成步骤，规划后续步骤

## 输出格式（必须是纯JSON）
{
  "thinking": "简短分析当前屏幕状态和下一步计划",
  "action": "click|type|scroll|drag|press_keys|wait|screenshot|right_click|double_click|done|retry",
  "target": {"x": 坐标, "y": 坐标, "label": "元素描述", "type": "元素类型"}  // click/right_click/double_click时必填
  "text": "要输入的文字",  // type时必填
  "keys": "组合键如Ctrl+V",  // press_keys时必填
  "duration": 等待毫秒数,  // wait时必填
  "reason": "为什么这样决定的简短理由",
  "confidence": 0.0-1.0
}

## 操控策略
- 优先用键盘快捷键（比鼠标点击更快更可靠）
- 遇到弹窗先尝试关闭（Escape键或点击×），不要被会员/广告弹窗困住
- 如果某个方法失败2次，立刻换备用方案
- 不确定时，先截图确认状态再操作
- 操作后等待500ms-2s让UI响应，不要连续疯狂点击

## 软件知识
- WPS/Office：Ctrl+N新建 Ctrl+S保存 Ctrl+M新幻灯片 Alt+F4关闭
- 微信：Ctrl+F搜索 Ctrl+V粘贴 Ctrl+Enter发送
- 浏览器：Ctrl+T新标签 Ctrl+W关闭标签 Ctrl+L地址栏 Ctrl+F页面查找 F5刷新
- 通用：Win键打开开始菜单 Win+E资源管理器 Win+D桌面 Alt+Tab切换窗口 Escape关闭弹窗

现在开始执行任务。`

interface GenerateParams {
  temperature?: number
  maxTokens?: number
  topP?: number
}

export class VisualReasoningEngine {
  private taskContexts: Map<string, VisualTaskContext> = new Map()

  /**
   * 分析屏幕截图并决定下一步操作
   */
  async decideNextAction(
    taskId: string,
    screenObservation: ScreenObservation,
    taskIntent: string,
    options?: GenerateParams
  ): Promise<ActionDecision> {
    const ctx = this.getOrCreateContext(taskId, taskIntent)

    // 检查错误状态
    if (screenObservation.errorMessage) {
      logger.debug(`[VisualReasoning] 检测到错误: ${screenObservation.errorMessage}`)
      return this.handleErrorState(ctx, screenObservation)
    }

    // 检查弹窗
    if (screenObservation.dialogOpen) {
      logger.debug('[VisualReasoning] 检测到弹窗，优先关闭')
      return {
        action: 'press_keys',
        keys: 'Escape',
        reason: '检测到弹窗/对话框，优先尝试关闭',
        confidence: 0.85,
        fallback: {
          action: 'click',
          target: { x: 0, y: 0, label: '关闭按钮×', type: 'BUTTON' },
          reason: 'Escape无效，尝试点击关闭按钮',
          confidence: 0.6,
        },
      }
    }

    // 检查加载状态
    if (screenObservation.loading) {
      return {
        action: 'wait',
        duration: 2000,
        reason: '屏幕正在加载中，等待完成',
        confidence: 0.9,
      }
    }

    // 构建请求提示词
    const prompt = this.buildDecisionPrompt(screenObservation, ctx, taskIntent)
    const response = await this.invokeModel(prompt, options)
    const decision = this.parseDecision(response)

    // 记录历史
    ctx.history.push({
      action: decision.action,
      result: decision.reason,
      timestamp: Date.now(),
    })
    ctx.attempts++

    return decision
  }

  /**
   * 分析任务是否已完成
   */
  async checkTaskCompletion(
    screenObservation: ScreenObservation,
    taskIntent: string,
    _options?: GenerateParams
  ): Promise<{ done: boolean; description: string; confidence: number }> {
    const prompt = `判断以下任务是否已完成。

任务目标: ${taskIntent}

当前屏幕状态:
- 描述: ${screenObservation.description}
- 应用: ${screenObservation.applicationName || '未知'}
- 弹窗: ${screenObservation.dialogOpen ? '是' : '否'}
- 错误: ${screenObservation.errorMessage || '无'}

返回JSON: {"done": true/false, "description": "简短说明", "confidence": 0.0-1.0}`

    const response = await this.invokeModel(prompt, { temperature: 0.3, maxTokens: 256 })
    try {
      const result = JSON.parse(response || '{}')
      return {
        done: result.done || false,
        description: result.description || '',
        confidence: result.confidence || 0.5,
      }
    } catch (e) {
      logger.error('[VisualReasoning] 解析任务完成检查结果失败:', e)
      return { done: false, description: response?.slice(0, 100) || '', confidence: 0.3 }
    }
  }

  /**
   * 分析操作失败原因并生成重试策略
   */
  async analyzeFailure(
    beforeScreen: ScreenObservation,
    afterScreen: ScreenObservation,
    attemptedAction: ActionDecision,
    _options?: GenerateParams
  ): Promise<ActionDecision> {
    const prompt = `分析操作失败原因并给出重试方案。

任务: ${beforeScreen.description}
尝试的操作: ${attemptedAction.action} (${attemptedAction.reason})
操作前状态: ${beforeScreen.description}
操作后状态: ${afterScreen.description}
变化: ${beforeScreen.description === afterScreen.description ? '无变化' : '有变化'}

分析失败原因并返回新的操作方案（JSON格式同前）。`

    const response = await this.invokeModel(prompt, { temperature: 0.5 })
    return this.parseDecision(response)
  }

  /**
   * 生成完整任务计划
   */
  async planTask(
    taskIntent: string,
    options?: GenerateParams
  ): Promise<Array<{ step: number; action: string; target: string; expectedResult: string }>> {
    const prompt = `为以下任务生成详细执行计划:

任务: ${taskIntent}

请列出具体操作步骤（每步包含操作类型、目标、预期结果），返回JSON数组:
[{"step": 1, "action": "操作描述", "target": "目标元素", "expectedResult": "预期结果"}, ...]`

    const response = await this.invokeModel(prompt, { ...options, maxTokens: 1024 })
    try {
      return JSON.parse(response || '[]')
    } catch (e) {
      logger.error('[VisualReasoning] 解析任务计划结果失败:', e)
      return [{ step: 1, action: '截图观察', target: '全屏', expectedResult: '了解当前状态' }]
    }
  }

  /**
   * 重置任务上下文
   */
  resetTask(taskId: string): void {
    this.taskContexts.delete(taskId)
  }

  private getOrCreateContext(taskId: string, intent: string): VisualTaskContext {
    if (!this.taskContexts.has(taskId)) {
      this.taskContexts.set(taskId, {
        intent,
        target: '',
        history: [],
        attempts: 0,
        maxAttempts: 50,
      })
    }
    return this.taskContexts.get(taskId)!
  }

  private handleErrorState(ctx: VisualTaskContext, screen: ScreenObservation): ActionDecision {
    if (ctx.attempts > 3) {
      // 连续错误超过3次，尝试完全不同的策略
      return {
        action: 'press_keys',
        keys: 'Alt+F4',
        reason: `连续${ctx.attempts}次失败，尝试关闭当前窗口重来`,
        confidence: 0.4,
      }
    }
    return {
      action: 'press_keys',
      keys: 'Escape',
      reason: `屏幕显示错误: ${screen.errorMessage}`,
      confidence: 0.7,
    }
  }

  private buildDecisionPrompt(
    screen: ScreenObservation,
    ctx: VisualTaskContext,
    taskIntent: string
  ): string {
    const elementsList = screen.elements
      .filter(e => e.confidence > 0.5)
      .slice(0, 15)
      .map(e => `  - ${e.type}: "${e.label}" @ (${e.bbox.x},${e.bbox.y}) ${e.bbox.w}x${e.bbox.h}`)
      .join('\n')

    const historyStr = ctx.history
      .slice(-5)
      .map(h => `  - ${h.action}: ${h.result}`)
      .join('\n')

    return `## 任务
${taskIntent}

## 当前屏幕
- 应用: ${screen.applicationName || '未知'}
- 描述: ${screen.description}
- 弹窗: ${screen.dialogOpen ? '有' : '无'}
- 加载中: ${screen.loading ? '是' : '否'}

## 屏幕元素
${elementsList || '未识别到明确元素'}

## 最近操作
${historyStr || '无历史操作'}

## 已尝试次数
${ctx.attempts} / ${ctx.maxAttempts}

请以JSON格式返回下一步操作决策。`
  }

  private async invokeModel(prompt: string, options?: GenerateParams): Promise<string> {
    const fullPrompt = `${COMPUTER_CONTROL_SYSTEM_PROMPT}\n\n${prompt}`

    // 视觉模型运行位置（用户显式设置）：纯 CPU 时直接走 CpuInferenceEngine，跳过 SGLang/tandem GPU 路径
    let visionRunLocation: 'auto' | 'cpu' | 'gpu' | 'layered' = 'auto'
    try {
      const { modelRegistry } = await import('../model-registry')
      const visionModel = (modelRegistry.list?.() || []).find((m: any) => m.type === 'vision')
      visionRunLocation = (visionModel?.runLocation as any) || 'auto'
    } catch { /* registry 不可用时回退自动 */ }
    const forceCpuVision = visionRunLocation === 'cpu'
    logger.debug(`[VisualReasoning] 视觉推理运行位置: ${visionRunLocation}${forceCpuVision ? '（纯 CPU，直走 CpuInferenceEngine）' : ''}`)

    try {
      // GPU/分层/自动：优先尝试 SGLang (GPU)，再回退 tandem llama-server；纯 CPU 直走 CPU 引擎
      if (!forceCpuVision) {
        // 优先尝试 SGLang (GPU)
        try {
          const resp = await fetch('http://127.0.0.1:30000/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'default',
              messages: [{ role: 'user', content: fullPrompt }],
              temperature: options?.temperature ?? 0.7,
              max_tokens: options?.maxTokens ?? 1024,
              top_p: options?.topP ?? 0.9,
            }),
            signal: AbortSignal.timeout(60000),
          })
          if (resp.ok) {
            const data: any = await resp.json()
            return data.choices?.[0]?.message?.content || ''
          } else {
            const body = await resp.text().catch(() => '')
            logger.error(`[Visual] SGLang 返回 ${resp.status}: ${body.slice(0, 200)}`)
          }
        } catch (e) {
          logger.error('[VisualReasoning] SGLang模型调用失败:', e)
        }

        // 回退1：tandem 主模型（llama-server 8082，已在运行则零额外开销）
        try {
          const resp = await fetch('http://127.0.0.1:8082/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'default',
              messages: [{ role: 'user', content: fullPrompt }],
              temperature: options?.temperature ?? 0.7,
              max_tokens: options?.maxTokens ?? 1024,
              top_p: options?.topP ?? 0.9,
            }),
            signal: AbortSignal.timeout(60000),
          })
          if (resp.ok) {
            const data: any = await resp.json()
            const content = data.choices?.[0]?.message?.content || ''
            if (content) return content
          }
        } catch (e) {
          logger.error('[VisualReasoning] tandem主模型调用失败:', e)
        }
      }

      if (cpuInferenceEngine.model) {
        const cpuPromise = cpuInferenceEngine.generate(fullPrompt, {
          maxTokens: options?.maxTokens || 1024,
          temperature: options?.temperature ?? 0.7,
          topP: options?.topP,
        })
        return await Promise.race([
          cpuPromise,
          new Promise<null>((_, reject) =>
            setTimeout(() => reject(new Error('CPU 视觉推理超时（120秒）')), 120000)
          ),
        ]) as string
      }
    } catch (e: any) {
      logger.error('[VisualReasoning] 模型调用失败:', e.message)
    }

    // 终极回退：空动作=截图观察，携带诊断信息
    return JSON.stringify({ action: 'screenshot', reason: '等待模型就绪', confidence: 0.3, _diagnostic: '所有推理引擎不可用，使用安全回退' })
  }

  private parseDecision(response: string): ActionDecision {
    try {
      // 尝试提取JSON
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        return {
          action: ['click','type','scroll','drag','press_keys','wait','screenshot','right_click','double_click','done','retry'].includes(parsed.action)
            ? parsed.action : 'screenshot',
          target: parsed.target || undefined,
          text: parsed.text || undefined,
          keys: parsed.keys || undefined,
          duration: typeof parsed.duration === 'number' ? parsed.duration : undefined,
          reason: parsed.reason || parsed.thinking || '无说明',
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
          fallback: parsed.fallback || undefined,
        }
      }
    } catch (e) {
      logger.error('[VisualReasoning] 解析模型决策输出失败:', e)
    }

    return {
      action: 'screenshot',
      reason: '无法解析模型输出，截图重试',
      confidence: 0.3,
    }
  }
}

export const visualReasoningEngine = new VisualReasoningEngine()
