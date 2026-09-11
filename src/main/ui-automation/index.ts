/**
 * ui-automation 模块 — UIA 主力交互通路 + 视觉兜底/质检
 *
 * 核心理念：
 *   UIA 是主力交互通路（结构化、精确、毫秒级响应）
 *   视觉负责兜底（UIA 找不到自绘控件时顶上）
 *   视觉负责质检（操作后截图验证真实渲染效果是否达标）
 *
 * 操作流程：
 *   用户指令 → UIA 扫描找元素 → 找到？→ UIA 点击/输入（主力通路）
 *     → 没找到？→ 截图 → VisionFallback 视觉定位 → 坐标点击（视觉兜底）
 *     → 操作完成 → 截图 → VisionQualityInspector 验证效果是否达标（视觉质检）
 *
 * 统一出口 + IPC 注册
 */

import { ipcMain } from 'electron'
import { createLogger } from '../utils/logging'

const logger = createLogger('UIAutomation')

// ============================================================
// 导出所有类和类型
// ============================================================

export { UIAScanner } from './uia-scanner'
export { UIAExecutor } from './uia-executor'
export { VisionFallback, VisionQualityInspector } from './uia-vision'

export type {
  UIAElement,
  BoundingRect,
  ElementSearchResult,
  FocusedElement,
  WaitResult,
  ElementConditions,
  ScanOptions
} from './uia-scanner'

export type {
  OperationResult,
  FallbackOperationResult,
  TargetSpec
} from './uia-executor'

export type {
  VisionLocation,
  InspectionResult,
  GuardedResult,
} from './uia-vision'

// ============================================================
// IPC 注册
// ============================================================

export function setupUIAutomationIPC(): void {
  logger.info('Setting up UIAutomation IPC handlers...')

  // 安全导入辅助
  const safeImport = (name: string): boolean => {
    try {
      return true
    } catch (e: any) {
      logger.error(`Module not ready: ${name} — ${e.message}`)
      return false
    }
  }

  // ==========================================================
  // UIA 主力通路（保持原有 IPC）
  // ==========================================================

  // --- uia:scan ---
  ipcMain.handle('uia:scan', async (_event, windowTitle?: string) => {
    try {
      if (!safeImport('uia-scanner')) {
        return { error: 'UIA scanner module not available' }
      }
      const { UIAScanner } = require('./uia-scanner')
      const tree = UIAScanner.scanWindow(windowTitle)
      return { success: true, tree }
    } catch (err: any) {
      logger.error(`uia:scan failed: ${err.message}`)
      return { success: false, error: err.message }
    }
  })

  // --- uia:find ---
  ipcMain.handle('uia:find', async (
    _event,
    conditions: { name?: string; controlType?: string; automationId?: string },
    windowTitle?: string
  ) => {
    try {
      if (!safeImport('uia-scanner')) {
        return { error: 'UIA scanner module not available' }
      }
      const { UIAScanner } = require('./uia-scanner')
      const result = UIAScanner.findElement(conditions, windowTitle)
      return result
    } catch (err: any) {
      logger.error(`uia:find failed: ${err.message}`)
      return { found: false, error: err.message }
    }
  })

  // --- uia:click ---
  ipcMain.handle('uia:click', async (
    _event,
    target: { name?: string; controlType?: string; automationId?: string },
    windowTitle?: string
  ) => {
    try {
      if (!safeImport('uia-executor')) {
        return { success: false, error: 'UIA executor module not available' }
      }
      const { UIAExecutor } = require('./uia-executor')
      return UIAExecutor.click(target, windowTitle)
    } catch (err: any) {
      logger.error(`uia:click failed: ${err.message}`)
      return { success: false, error: err.message }
    }
  })

  // --- uia:type ---
  ipcMain.handle('uia:type', async (
    _event,
    target: { name?: string; controlType?: string; automationId?: string },
    text: string,
    windowTitle?: string
  ) => {
    try {
      if (!safeImport('uia-executor')) {
        return { success: false, error: 'UIA executor module not available' }
      }
      const { UIAExecutor } = require('./uia-executor')
      return UIAExecutor.typeText(target, text, windowTitle)
    } catch (err: any) {
      logger.error(`uia:type failed: ${err.message}`)
      return { success: false, error: err.message }
    }
  })

  // --- uia:wait-for ---
  ipcMain.handle('uia:wait-for', async (
    _event,
    conditions: { name?: string },
    timeoutMs?: number,
    windowTitle?: string
  ) => {
    try {
      if (!safeImport('uia-scanner')) {
        return { error: 'UIA scanner module not available' }
      }
      const { UIAScanner } = require('./uia-scanner')
      return UIAScanner.waitForElement(conditions, timeoutMs || 5000, windowTitle)
    } catch (err: any) {
      logger.error(`uia:wait-for failed: ${err.message}`)
      return { found: false, error: err.message }
    }
  })

  // --- uia:status ---
  ipcMain.handle('uia:status', () => {
    try {
      const { UIAScanner } = require('./uia-scanner')
      return { available: UIAScanner.isAvailable() }
    } catch {
      return { available: false, error: 'Module not loaded' }
    }
  })

  // ==========================================================
  // 视觉兜底 + 质检通路（新增 IPC）
  // ==========================================================

  // --- uia:vision-locate ---
  // 当 UIA 找不到元素时，视觉定位兜底
  ipcMain.handle('uia:vision-locate', async (
    _event,
    elementDescription: string,
    screenshot?: string
  ) => {
    try {
      if (!safeImport('uia-vision')) {
        return { found: false, error: 'Vision module not available' }
      }
      const { VisionFallback } = require('./uia-vision')
      return await VisionFallback.locateByVision(elementDescription, screenshot)
    } catch (err: any) {
      logger.error(`uia:vision-locate failed: ${err.message}`)
      return { found: false, error: err.message }
    }
  })

  // --- uia:quality-inspect ---
  // 操作后视觉质检（单独调用，不执行操作）
  ipcMain.handle('uia:quality-inspect', async (
    _event,
    expectedState: string,
    beforeScreenshot?: string
  ) => {
    try {
      if (!safeImport('uia-vision')) {
        return { passed: false, issues: ['Vision module not available'] }
      }
      const { VisionQualityInspector } = require('./uia-vision')
      return await VisionQualityInspector.inspect(expectedState, beforeScreenshot)
    } catch (err: any) {
      logger.error(`uia:quality-inspect failed: ${err.message}`)
      return { passed: false, issues: [err.message] }
    }
  })

  // --- uia:execute-guarded ---
  // 带质检保护的完整执行流程
  // UIA 执行 → 截图前 → attempt() → 截图后 → 视觉质检 → 未达标重试 → 报告
  ipcMain.handle('uia:execute-guarded', async (
    _event,
    params: {
      /** UIA 操作参数 */
      action: 'click' | 'type' | 'select' | 'expand' | 'scroll'
      /** 目标元素描述 */
      target: { name?: string; controlType?: string; automationId?: string }
      /** 输入文本（type 操作时必填） */
      text?: string
      /** 窗口标题 */
      windowTitle?: string
    },
    expectedState: string
  ) => {
    try {
      if (!safeImport('uia-vision') || !safeImport('uia-executor')) {
        return {
          success: false,
          error: 'Vision or executor module not available'
        }
      }

      const { VisionQualityInspector } = require('./uia-vision')
      const { UIAExecutor } = require('./uia-executor')

      // 构建主力操作函数
      const attempt = async (): Promise<{ success: boolean; error?: string }> => {
        let result: { success: boolean; error?: string }

        switch (params.action) {
          case 'click':
            result = UIAExecutor.click(params.target, params.windowTitle)
            break
          case 'type':
            result = UIAExecutor.typeText(params.target, params.text || '', params.windowTitle)
            break
          case 'select':
            result = UIAExecutor.selectItem(params.target, params.windowTitle)
            break
          case 'expand':
            result = UIAExecutor.expand(params.target, params.windowTitle)
            break
          case 'scroll':
            result = UIAExecutor.scrollTo(params.target, params.windowTitle)
            break
          default:
            return { success: false, error: `Unknown action: ${params.action}` }
        }

        return result
      }

      return await VisionQualityInspector.executeWithQualityGate(attempt, expectedState)
    } catch (err: any) {
      logger.error(`uia:execute-guarded failed: ${err.message}`)
      return { success: false, error: err.message }
    }
  })

  logger.info('UIAutomation IPC handlers registered')
}
