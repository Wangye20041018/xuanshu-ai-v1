/**
 * UIA 执行器 — 主力交互通路
 *
 * 核心理念：UIA 是主力通路（结构化遍历控件树，精确知道元素的 Name/Type/AutomationId，毫秒级响应）。
 *           视觉负责兜底（UIA 找不到自绘控件时顶上）和质检（操作后截图验证真实渲染效果是否达标）。
 *
 * 操作流程：
 *   用户指令 → UIA 扫描找元素 → 找到？→ UIA 执行（主力通路）
 *     → 没找到？→ VisionFallback 视觉定位 → 坐标操作（视觉兜底）
 *     → 操作完成 → VisionQualityInspector 视觉质检
 *
 * 安全保障：操作前确认元素存在且 enabled
 */

import { execFileSync } from 'child_process'
import { join } from 'path'
import { createLogger } from '../utils/logging'
import { POWERSHELL_EXE } from '../utils/powershell'
import { UIAScanner, ElementConditions, ElementSearchResult } from './uia-scanner'

const logger = createLogger('UIA:Executor')

// ============================================================
// 类型定义
// ============================================================

/** 操作结果 — 所有方法返回此类型，method 字段标明使用的通路 */
export interface OperationResult {
  success: boolean
  /** 操作通路：uia（主力）| vision-fallback（视觉兜底）| failed（失败） */
  method?: 'uia' | 'vision-fallback' | 'failed'
  error?: string
  details?: string
}

/** 带 fallback 的操作结果 — executeWithFallback 专属 */
export interface FallbackOperationResult {
  success: boolean
  /** 实际使用的通路 */
  method: 'uia' | 'vision-fallback' | 'failed'
  result: OperationResult | null
  error?: string
}

export interface TargetSpec {
  name?: string
  controlType?: string
  automationId?: string
}

// ============================================================
// PowerShell 执行引擎
// ============================================================

const SCRIPT_PATH = join(__dirname, 'uia-ps.ps1')
const DEFAULT_TIMEOUT = 15000

function invokePowerShell(command: string, params: Record<string, unknown> = {}): string {
  const paramsJson = JSON.stringify(params).replace(/"/g, '`"')

  const psArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', `"${SCRIPT_PATH}"`,
    command,
    `"${paramsJson}"`
  ]

  logger.info(`UIA exec: ${command} ${paramsJson.substring(0, 200)}`)

  const stdout = execFileSync(POWERSHELL_EXE, psArgs, {
    timeout: DEFAULT_TIMEOUT,
    encoding: 'utf-8',
    maxBuffer: 5 * 1024 * 1024,
    windowsHide: true
  })

  return stdout.trim()
}

function parseResult(raw: string): { success: boolean; error?: string; action?: string; method?: string } {
  try {
    return JSON.parse(raw)
  } catch {
    const lines = raw.split('\n')
    for (const line of lines) {
      const t = line.trim()
      if (t.startsWith('{')) return JSON.parse(t)
    }
    return { success: false, error: `Cannot parse result: ${raw.substring(0, 200)}` }
  }
}

function toConditions(target: TargetSpec): ElementConditions {
  return {
    name: target.name,
    controlType: target.controlType,
    automationId: target.automationId
  }
}

// ============================================================
// 安全确认
// ============================================================

function validateElement(target: TargetSpec, windowTitle?: string): ElementSearchResult {
  const result = UIAScanner.findElement(toConditions(target), windowTitle)

  if (!result.found) {
    throw new Error(`Element not found: ${JSON.stringify(target)}`)
  }
  if (!result.isEnabled) {
    throw new Error(`Element is disabled: ${JSON.stringify(target)}`)
  }

  return result
}

// ============================================================
// UIA Executor
// ============================================================

export class UIAExecutor {
  /**
   * 点击元素
   * 支持 InvokePattern，降级到鼠标坐标点击
   */
  static click(target: TargetSpec, windowTitle?: string): OperationResult {
    try {
      const el = validateElement(target, windowTitle)
      logger.info(`Click: ${el.name} (${el.controlType}) at (${el.boundingRect.x}, ${el.boundingRect.y})`)

      const raw = invokePowerShell('Invoke', {
        windowTitle: windowTitle || '',
        name: target.name || '',
        controlType: target.controlType || '',
        automationId: target.automationId || '',
        action: 'click'
      })

      const result = parseResult(raw)

      if (!result.success) {
        return { success: false, error: result.error || 'Click failed' }
      }

      logger.info(`Click succeeded: ${el.name}`)
      return { success: true, method: 'uia', details: `Clicked ${el.name}` }
    } catch (err: any) {
      logger.error(`Click failed: ${err.message}`)
      return { success: false, method: 'failed', error: err.message }
    }
  }

  /**
   * 向输入框设置文本
   * 优先 ValuePattern.SetValue，回退 SendKeys
   */
  static typeText(target: TargetSpec, text: string, windowTitle?: string): OperationResult {
    try {
      const el = validateElement(target, windowTitle)
      logger.info(`TypeText: into "${el.name}" text="${text}"`)

      const raw = invokePowerShell('SetText', {
        windowTitle: windowTitle || '',
        name: target.name || '',
        controlType: target.controlType || '',
        text
      })

      const result = parseResult(raw)
      if (!result.success) {
        return { success: false, error: result.error || 'TypeText failed' }
      }

      logger.info(`TypeText succeeded (method=${result.method})`)
      return { success: true, method: 'uia', details: `Typed into ${el.name} via ${result.method}` }
    } catch (err: any) {
      logger.error(`TypeText failed: ${err.message}`)
      return { success: false, method: 'failed', error: err.message }
    }
  }

  /**
   * 选中列表项/下拉项
   */
  static selectItem(target: TargetSpec, windowTitle?: string): OperationResult {
    try {
      const el = validateElement(target, windowTitle)
      logger.info(`SelectItem: ${el.name} (${el.controlType})`)

      const raw = invokePowerShell('Invoke', {
        windowTitle: windowTitle || '',
        name: target.name || '',
        controlType: target.controlType || '',
        automationId: target.automationId || '',
        action: 'select'
      })

      const result = parseResult(raw)
      if (!result.success) {
        return { success: false, error: result.error || 'Select failed' }
      }

      logger.info(`SelectItem succeeded: ${el.name}`)
      return { success: true, method: 'uia', details: `Selected ${el.name}` }
    } catch (err: any) {
      logger.error(`SelectItem failed: ${err.message}`)
      return { success: false, method: 'failed', error: err.message }
    }
  }

  /**
   * 展开可折叠元素（TreeItem / MenuItem 等）
   */
  static expand(target: TargetSpec, windowTitle?: string): OperationResult {
    try {
      const el = validateElement(target, windowTitle)
      logger.info(`Expand: ${el.name} (${el.controlType})`)

      const raw = invokePowerShell('Invoke', {
        windowTitle: windowTitle || '',
        name: target.name || '',
        controlType: target.controlType || '',
        automationId: target.automationId || '',
        action: 'expand'
      })

      const result = parseResult(raw)
      if (!result.success) {
        return { success: false, error: result.error || 'Expand failed' }
      }

      logger.info(`Expand succeeded: ${el.name}`)
      return { success: true, method: 'uia', details: `Expanded ${el.name}` }
    } catch (err: any) {
      logger.error(`Expand failed: ${err.message}`)
      return { success: false, method: 'failed', error: err.message }
    }
  }

  /**
   * 滚动到目标元素
   */
  static scrollTo(target: TargetSpec, windowTitle?: string): OperationResult {
    try {
      const el = validateElement(target, windowTitle)
      logger.info(`ScrollTo: ${el.name}`)

      const raw = invokePowerShell('Invoke', {
        windowTitle: windowTitle || '',
        name: target.name || '',
        controlType: target.controlType || '',
        automationId: target.automationId || '',
        action: 'scrollIntoView'
      })

      const result = parseResult(raw)
      if (!result.success) {
        return { success: false, error: result.error || 'ScrollIntoView failed' }
      }

      logger.info(`ScrollTo succeeded: ${el.name}`)
      return { success: true, method: 'uia', details: `Scrolled to ${el.name}` }
    } catch (err: any) {
      logger.error(`ScrollTo failed: ${err.message}`)
      return { success: false, method: 'failed', error: err.message }
    }
  }

  /**
   * 带视觉 fallback 的执行 — UIA 主力通路失败后自动切换视觉兜底
   *
   * 流程：
   *   1. 尝试 UIA 执行（主力通路）
   *   2. 成功 → 返回 { method: 'uia', result }
   *   3. 失败 → 调用 VisionFallback.locateByVision(fallbackDescription)
   *   4. 视觉定位成功 → 坐标操作 → 返回 { method: 'vision-fallback', result }
   *   5. 视觉也失败 → 返回 { method: 'failed', error }
   *
   * @param target - UIA 目标元素描述
   * @param action - 操作动作描述（'click' | 'type'）
   * @param fallbackDescription - 视觉 fallback 的元素自然语言描述
   * @param text - 输入文本（仅 action='type' 时使用）
   * @param windowTitle - 窗口标题
   * @returns 带 method 标注的完整结果
   */
  static async executeWithFallback(
    target: TargetSpec,
    action: 'click' | 'type',
    fallbackDescription: string,
    text?: string,
    windowTitle?: string
  ): Promise<FallbackOperationResult> {
    logger.info(
      `[executeWithFallback] action=${action}, target=${JSON.stringify(target)}, ` +
      `fallbackDesc="${fallbackDescription}"`
    )

    // Step 1: 尝试 UIA 主力通路（带重试）
    let uiaResult: OperationResult
    try {
      uiaResult = await UIAExecutor.retryWithBackoff(
        async () => {
          if (action === 'click') {
            return UIAExecutor.click(target, windowTitle)
          } else {
            return UIAExecutor.typeText(target, text || '', windowTitle)
          }
        },
        2,   // 最多重试 2 次
        [200, 400]  // 退避间隔 200ms → 400ms
      )

      if (uiaResult.success) {
        logger.info('[executeWithFallback] UIA primary path succeeded')
        return {
          success: true,
          method: 'uia',
          result: uiaResult
        }
      }

      logger.warn(
        `[executeWithFallback] UIA primary path failed: ${uiaResult.error}, ` +
        `switching to vision fallback...`
      )
    } catch (err: any) {
      logger.warn(`[executeWithFallback] UIA threw: ${err.message}, falling back to vision`)
      uiaResult = { success: false, method: 'failed', error: err.message }
    }

    // Step 2: UIA 失败 → 视觉兜底
    try {
      const { VisionFallback } = require('./uia-vision')

      let visionResult: { success: boolean; error?: string; method: 'vision-fallback' }

      if (action === 'click') {
        visionResult = await VisionFallback.clickByVision(fallbackDescription)
      } else {
        visionResult = await VisionFallback.typeByVision(fallbackDescription, text || '')
      }

      if (visionResult.success) {
        logger.info('[executeWithFallback] Vision fallback succeeded')
        return {
          success: true,
          method: 'vision-fallback',
          result: {
            success: true,
            method: 'vision-fallback',
            details: `Vision fallback: ${action} on "${fallbackDescription}"`
          }
        }
      }

      // 视觉也失败
      logger.error(`[executeWithFallback] Vision fallback also failed: ${visionResult.error}`)
      return {
        success: false,
        method: 'failed',
        result: null,
        error: `Both UIA and vision fallback failed. UIA: ${uiaResult.error}; Vision: ${visionResult.error}`
      }

    } catch (err: any) {
      logger.error(`[executeWithFallback] Vision fallback error: ${err.message}`)
      return {
        success: false,
        method: 'failed',
        result: null,
        error: `UIA failed (${uiaResult.error}) and vision fallback unavailable: ${err.message}`
      }
    }
  }

  /**
   * 带指数退避的重试机制
   *
   * @param fn - 要重试的异步操作
   * @param maxRetries - 最大重试次数（不含首次尝试），默认 2
   * @param backoffMs - 退避间隔数组（毫秒），如 [200, 400]
   * @returns 操作结果
   */
  static async retryWithBackoff<T extends OperationResult>(
    fn: () => Promise<T>,
    maxRetries: number = 2,
    backoffMs: number[] = [200, 400]
  ): Promise<T> {
    let lastResult: T

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = backoffMs[attempt - 1] || backoffMs[backoffMs.length - 1]
        logger.info(`[retryWithBackoff] Attempt ${attempt + 1}/${maxRetries + 1}, waiting ${delay}ms...`)
        await new Promise(r => setTimeout(r, delay))
      }

      lastResult = await fn()

      if (lastResult.success) {
        if (attempt > 0) {
          logger.info(`[retryWithBackoff] Succeeded on attempt ${attempt + 1}`)
        }
        return lastResult
      }

      logger.warn(`[retryWithBackoff] Attempt ${attempt + 1} failed: ${lastResult.error}`)
    }

    return lastResult!
  }

  /**
   * 检查 UIA 能力是否可用
   */
  static isAvailable(): boolean {
    return UIAScanner.isAvailable()
  }
}
