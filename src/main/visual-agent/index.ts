/**
 * 玄枢AI — 电脑操控引擎 v2.0
 * 
 * 五层架构:
 *   ScreenObserver (截图) 
 *     ↓
 *   ElementRecognizer v2.0 (视觉模型识别)  
 *     ↓
 *   VisualReasoningEngine (主模型决策)
 *     ↓
 *   InteractionExecutor (执行操作)
 *     ↓
 *   StateTracker (验证 + 重试)
 */

import { ipcMain, BrowserWindow, dialog } from 'electron'
import { screenObserver } from './screen-observer'
export { screenObserver } from './screen-observer'
import { elementRecognizer, Element, ScreenContext } from './element-recognizer'
import { visualReasoningEngine } from './visual-reasoning'
import { interactionExecutor } from './interaction-executor'
import { stateTracker } from './state-tracker'
import { commonKnowledge } from './common-knowledge'
import { logger } from '../../shared/logger'
import { notifyControlStart, notifyControlFinish } from '../control-state'

export type TaskStatus = 'done' | 'failed' | 'in_progress'

export interface VisualStep {
  id: string
  action: string
  target: string
  status: 'running' | 'completed' | 'error'
  beforeScreenshot?: string
  afterScreenshot?: string
  duration: number
  result?: any
  verificationResult?: boolean
  failReason?: string
}

export interface VisualTask {
  id: string
  intent: string
  maxSteps?: number
}

export interface VisualResult {
  success: boolean
  steps: VisualStep[]
  error: string | null
  summary: string
}

class VisualAgentV2 {
  // @ts-expect-error TS6133 - currentTask reserved for future use
  private currentTask: VisualTask | null = null
  private cancelled = false

  /**
   * 人工确认门：视觉代理将驱动鼠标/键盘多步操作，必须先经用户确认。
   * 防止 prompt-injection 让 LLM 静默操作电脑。
   */
  private async confirmExecute(task: VisualTask): Promise<boolean> {
    try {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      if (!win || win.isDestroyed()) return false
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        title: '电脑控制确认',
        message: '玄枢即将执行视觉自动化任务',
        detail: `任务：${task.intent}\n该任务会模拟鼠标点击与键盘输入，直接作用于您的电脑。如非本人发起，请点击取消。`,
        buttons: ['允许', '取消'],
        defaultId: 1,
        cancelId: 1,
      })
      return response === 0
    } catch {
      return false
    }
  }

  /**
   * 单步控制确认门：裸通道（visual:click/type/press-keys 等）直接驱动鼠标键盘，
   * 同样需要人工确认。委托给模块级 confirmSingleAction。
   */
  async confirmSingleAction(label: string, detail: string): Promise<boolean> {
    return confirmSingleAction(label, detail)
  }

  async executeTask(task: VisualTask): Promise<VisualResult> {
    // SECURITY: 多步自动操作需人工确认后方可执行
    if (!(await this.confirmExecute(task))) {
      return { success: false, steps: [], error: '用户已取消操作', summary: '' }
    }
    notifyControlStart(`视觉代理：${task.intent}`)
    try {
      return await this.executeTaskInner(task)
    } finally {
      notifyControlFinish()
    }
  }

  private async executeTaskInner(task: VisualTask): Promise<VisualResult> {
    this.currentTask = task
    this.cancelled = false
    const allSteps: VisualStep[] = []
    const maxSteps = task.maxSteps || 50

    try {
      // 1. 先用主模型拆解任务为步骤
      const plan = await visualReasoningEngine.planTask(task.intent)
      logger.debug(`[VisualAgent] AI分步计划: ${plan.length} 步`)

      // 2. 加载常识规则
      const rules = commonKnowledge.getRelevantRules(task.intent)
      logger.debug(`[VisualAgent] 加载 ${rules.length} 条相关常识规则`)

      let stepCount = 0
      while (stepCount < maxSteps && !this.cancelled) {
        stepCount++
        
        // 2a. 观察屏幕
        stateTracker.transition('observing')
        const screenshot = await screenObserver.captureFullScreen()
        stateTracker.transition('observing', { lastObservation: screenshot })

        // 2b. 识别元素（v11：UIA 控件树 → OCR 文字提取 → 2B 视觉模型 三级回退）
        stateTracker.transition('recognizing')
        let elements: Element[] = []
        let context: ScreenContext = {
          description: '', applicationName: null, windowTitle: null,
          dialogOpen: false, loading: false, errorMessage: null, suggestions: [],
        }
        const rec = await elementRecognizer.recognizeScreen(screenshot.base64, task.intent)
        elements = rec.elements
        context = rec.context
        if (rec.source === 'uia') {
          logger.debug(`[VisualAgent] UIA 控件树命中 ${elements.length} 个控件（零显存）`)
        } else if (rec.source === 'ocr') {
          logger.debug(`[VisualAgent] OCR 文字提取命中 ${elements.length} 处文字（零显存）`)
        } else {
          logger.debug(`[VisualAgent] 视觉模型兜底识别 ${elements.length} 个元素`)
        }

        // 2c. 主模型决策
        stateTracker.transition('reasoning')
        const decision = await visualReasoningEngine.decideNextAction(
          {
            taskId: task.id,
            description: context.description,
            applicationName: context.applicationName,
            windowTitle: context.windowTitle,
            dialogOpen: context.dialogOpen,
            loading: context.loading,
            errorMessage: context.errorMessage,
            taskIntent: task.intent,
            elements: elements.map(e => ({
              type: e.type, label: e.label,
              bbox: { x: e.bbox.x, y: e.bbox.y, w: e.bbox.w, h: e.bbox.h },
              confidence: e.confidence,
            })),
          },
          task.intent
        )

        if (decision.action === 'done') {
          stateTracker.transition('done')
          const summary = await visualReasoningEngine.summarizeResult(allSteps, task.intent)
          return { success: true, steps: allSteps, error: null, summary }
        }

        // 2d. 执行操作
        stateTracker.transition('executing')
        const beforeShot = await screenObserver.captureFullScreen()
        const step: VisualStep = {
          id: `step-${stepCount}`,
          action: decision.action,
          target: `${decision.target?.label || decision.keys || decision.text || ''}`,
          status: 'running',
          beforeScreenshot: beforeShot as any,
          afterScreenshot: null as any,
          duration: 0,
        }
        
        const startTime = Date.now()
        try {
          const execResult = await interactionExecutor.execute(decision)
          step.result = execResult
          
          // 2e. 验证
          const afterShot = await screenObserver.captureFullScreen()
          step.afterScreenshot = afterShot as any
          
          stateTracker.transition('verifying')
          const verification = await visualReasoningEngine.verifyAction(
            decision as any, beforeShot.base64, afterShot.base64, task.intent
          )
          
          step.verificationResult = verification.success
          
          if (verification.success) {
            step.status = 'completed'
          } else {
            // 失败 → 尝试重试
            step.status = 'error'
            step.failReason = verification.reason
            
            if (decision.fallback) {
              logger.debug(`[VisualAgent] 主方案失败，尝试回退方案: ${decision.fallback.action}`)
              const fallbackStep: VisualStep = {
                id: `step-${stepCount}-fallback`,
                action: decision.fallback.action,
                target: `${decision.fallback.target?.label || decision.fallback.keys || ''}`,
                status: 'running',
                duration: 0,
              }
              const fbStart = Date.now()
              try {
                await interactionExecutor.execute(decision.fallback)
                fallbackStep.status = 'completed'
              } catch (fbErr) {
                fallbackStep.status = 'error'
                fallbackStep.failReason = String(fbErr)
              }
              fallbackStep.duration = Date.now() - fbStart
              allSteps.push(fallbackStep)
            }
          }
        } catch (execError: any) {
          step.status = 'error'
          step.failReason = execError.message
        }
        
        step.duration = Date.now() - startTime
        allSteps.push(step)
      }

      // 超时完成
      const partialSummary = await visualReasoningEngine.summarizeResult(allSteps, task.intent)
      return { success: false, steps: allSteps, error: '达到最大步骤限制', summary: partialSummary }
      
    } catch (error: any) {
      stateTracker.transition('error', { lastActionResult: error.message })
      return { success: false, steps: allSteps, error: error.message, summary: '执行过程中出现错误' }
    } finally {
      this.currentTask = null
      this.cancelled = false
    }
  }

  cancel(): void {
    this.cancelled = true
    stateTracker.transition('cancelled')
  }
}

export const visualAgent = new VisualAgentV2()

/**
 * 单步控制确认门（模块级，供类内外复用）。
 * 裸通道直接驱动鼠标键盘，需人工确认，防止注入式静默控制。
 */
async function confirmSingleAction(label: string, detail: string): Promise<boolean> {
  try {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    if (!win || win.isDestroyed()) return false
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: '电脑控制确认',
      message: `玄枢即将执行「${label}」`,
      detail: `${detail}\n该操作会直接作用于您的电脑。如非本人发起，请点击取消。`,
      buttons: ['允许', '取消'],
      defaultId: 1,
      cancelId: 1,
    })
    return response === 0
  } catch {
    return false
  }
}

/**
 * 注册 IPC 通道（兼容旧版）
 * 保持对 src/main/index.ts 中 setupVisualAgentHandlers() 调用的兼容
 */
export function setupVisualAgentHandlers(): void {
  // 原有基础通道
  ipcMain.handle('visual:capture', async () => {
    try {
      return await screenObserver.captureFullScreen()
    } catch (e: any) {
      return { error: e.message }
    }
  })

  ipcMain.handle('visual:capture-window', async () => {
    try {
      return await screenObserver.captureActiveWindow()
    } catch (e: any) {
      return { error: e.message }
    }
  })

  ipcMain.handle('visual:analyze', async (_e, base64: string, task: string) => {
    try {
      return await elementRecognizer.analyzeScreen(base64, task)
    } catch (e: any) {
      return { elements: [], summary: String(e) }
    }
  })

  ipcMain.handle('visual:click', async (_e, x: number, y: number) => {
    if (!(await visualAgent.confirmSingleAction('点击', `坐标 (${x}, ${y})`))) return false
    notifyControlStart('视觉代理：点击')
    try {
      return await interactionExecutor.clickAt(x, y)
    } catch { return false } finally { notifyControlFinish() }
  })

  ipcMain.handle('visual:double-click', async (_e, x: number, y: number) => {
    if (!(await visualAgent.confirmSingleAction('双击', `坐标 (${x}, ${y})`))) return false
    notifyControlStart('视觉代理：双击')
    try {
      return await interactionExecutor.doubleClickAt(x, y)
    } catch { return false } finally { notifyControlFinish() }
  })

  ipcMain.handle('visual:right-click', async (_e, x: number, y: number) => {
    if (!(await visualAgent.confirmSingleAction('右键点击', `坐标 (${x}, ${y})`))) return false
    notifyControlStart('视觉代理：右键点击')
    try {
      return await interactionExecutor.rightClickAt(x, y)
    } catch { return false } finally { notifyControlFinish() }
  })

  ipcMain.handle('visual:type', async (_e, text: string) => {
    if (!(await visualAgent.confirmSingleAction('键盘输入', `文本：${text}`))) return false
    notifyControlStart('视觉代理：键盘输入')
    try {
      return await interactionExecutor.typeText(text)
    } catch { return false } finally { notifyControlFinish() }
  })

  ipcMain.handle('visual:press-keys', async (_e, keys: string) => {
    if (!(await visualAgent.confirmSingleAction('发送按键', `按键：${keys}`))) return false
    notifyControlStart('视觉代理：发送按键')
    try {
      return await interactionExecutor.pressKeys(keys)
    } catch { return false } finally { notifyControlFinish() }
  })

  ipcMain.handle('visual:drag', async (_e, fromX: number, fromY: number, toX: number, toY: number) => {
    if (!(await visualAgent.confirmSingleAction('拖拽', `(${fromX}, ${fromY}) → (${toX}, ${toY})`))) return false
    notifyControlStart('视觉代理：拖拽')
    try {
      return await interactionExecutor.drag({ x: fromX, y: fromY }, { x: toX, y: toY })
    } catch { return false } finally { notifyControlFinish() }
  })

  ipcMain.handle('visual:scroll', async (_e, x: number, y: number, delta: number) => {
    if (!(await visualAgent.confirmSingleAction('滚动', `坐标 (${x}, ${y}) 增量 ${delta}`))) return false
    notifyControlStart('视觉代理：滚动')
    try {
      return await interactionExecutor.scrollAt(x, y, delta)
    } catch { return false } finally { notifyControlFinish() }
  })

  ipcMain.handle('visual:get-state', () => {
    try {
      return stateTracker.getCurrentState()
    } catch { return { status: 'error' } }
  })

  ipcMain.handle('visual:cancel', () => {
    try {
      visualAgent.cancel()
      return true
    } catch { return false }
  })

  // 完整任务执行通道
  ipcMain.handle('visual:execute-task', async (_e, task: VisualTask) => {
    try {
      return await visualAgent.executeTask(task)
    } catch (e: any) {
      return { success: false, steps: [], error: String(e), summary: '' }
    }
  })
}
