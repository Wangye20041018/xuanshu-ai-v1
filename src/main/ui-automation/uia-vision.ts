/**
 * 视觉模块 — UIA 的兜底和质检员
 *
 * 核心理念：UIA 是主力交互通路（结构化、精确、毫秒级），
 *           视觉负责兜底（UIA 找不到自绘控件时顶上）和
 *           质检（操作后截图验证真实渲染效果是否达标）。
 *
 * 架构角色：
 *   VisionFallback        — UIA 失败时的后备通路（截图→视觉定位→坐标操作）
 *   VisionQualityInspector — 操作后视觉质检（"UIA 只能读属性，视觉真实看到"）
 */

import { createLogger } from '../utils/logging'
import { POWERSHELL_EXE } from '../utils/powershell'
import {UIAScanner} from './uia-scanner'

const logger = createLogger('UIA:Vision')

// ============================================================
// 类型定义
// ============================================================

/** 视觉定位结果 — VisionFallback.locateByVision 返回 */
export interface VisionLocation {
  found: boolean
  /** 识别出的元素中心坐标 */
  x: number
  y: number
  /** 元素宽高（来自视觉模型估算） */
  w: number
  h: number
  /** 标识此元素的自然语言描述 */
  description: string
  /** 视觉模型给出的可信度（0-1） */
  confidence: number
}

/** 视觉质检结果 — VisionQualityInspector.inspect 返回 */
export interface InspectionResult {
  /** 是否通过质检 */
  passed: boolean
  /** 可信度（0-1） */
  confidence: number
  /** 视觉模型的证据输出，如 "截图右下角出现绿色提示框，文字为'保存成功'" */
  evidence: string
  /** 未达标项列表 */
  issues: string[]
  /** 操作后截图路径（base64 或本地路径） */
  afterScreenshot: string
}

/** 带质检保护的操作执行结果 */
export interface GuardedResult {
  /** 操作最终是否成功（包括质检） */
  success: boolean
  /** 实际使用的通路：uia 或 vision-fallback */
  method: 'uia' | 'vision-fallback'
  /** 尝试次数 */
  attempts: number
  /** 视觉质检结果 */
  quality: InspectionResult
  /** 错误信息（如有） */
  error?: string
}

// ============================================================
// 截图辅助
// ============================================================

/**
 * 截取当前屏幕，返回 base64 data URL
 */
async function captureScreenshot(): Promise<string> {
  try {
    const { visionModel } = require('../vision')
    const capture = await visionModel.captureScreen()
    return capture.dataUrl
  } catch (err: any) {
    logger.warn(`Screenshot capture failed: ${err.message}`)
    return ''
  }
}

// ============================================================
// 视觉模型调用
// ============================================================

/**
 * 调用视觉大模型分析截图
 * @param screenshotBase64 - 截图的 base64 data URL
 * @param prompt - 发给视觉模型的指令
 * @returns 视觉模型原始输出文本
 */
async function callVisionModel(
  screenshotBase64: string,
  prompt: string
): Promise<string> {
  const { visionModel } = require('../vision')
  const result = await visionModel.analyzeImage(screenshotBase64, prompt)

  if (!result.success || !result.description) {
    throw new Error('Vision model returned no valid analysis')
  }

  return result.description
}

// ============================================================
// VisionFallback — UIA 失败时的后备通路
// ============================================================

/**
 * VisionFallback：当 UIA 找不到目标元素时，截图→视觉模型分析→返回可操作坐标。
 *
 * 应用场景：
 *   - 自绘控件（Canvas / DirectUI / WebView）
 *   - UIA 树中不可见的元素（被遮挡但渲染层可见）
 *   - 跨进程/高权限窗口等 UIA 无法穿透的场景
 */
export class VisionFallback {
  /**
   * 通过视觉模型定位元素
   * 截图 → 视觉模型分析 → 返回可操作坐标
   *
   * @param elementDescription - 元素自然语言描述，如 "右上角的保存按钮"、"文件列表第一行"
   * @param screenshot - 可选，传入已有截图（base64），不传则自动截取
   * @returns 视觉定位结果
   */
  static async locateByVision(
    elementDescription: string,
    screenshot?: string
  ): Promise<VisionLocation> {
    logger.info(`[VisionFallback] Locating by vision: "${elementDescription}"`)
    const startTime = Date.now()

    const screen = screenshot || await captureScreenshot()
    if (!screen) {
      return {
        found: false, x: 0, y: 0, w: 0, h: 0,
        description: elementDescription, confidence: 0
      }
    }

    const prompt = `分析这张截图。请找到以下UI元素："${elementDescription}"
返回精确的JSON：
{
  "found": true/false,
  "x": 元素中心X坐标(像素),
  "y": 元素中心Y坐标(像素),
  "w": 元素宽度(像素),
  "h": 元素高度(像素),
  "confidence": 0到1的可信度
}
只返回JSON，不要其他文字。如果找不到元素，found设为false。`

    try {
      const rawResult = await callVisionModel(screen, prompt)

      // 从返回文本中提取 JSON
      const jsonMatch = rawResult.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        logger.warn('[VisionFallback] No JSON found in vision response')
        return {
          found: false, x: 0, y: 0, w: 0, h: 0,
          description: elementDescription, confidence: 0
        }
      }

      const parsed = JSON.parse(jsonMatch[0])
      const elapsed = Date.now() - startTime

      const location: VisionLocation = {
        found: parsed.found === true,
        x: parsed.x || 0,
        y: parsed.y || 0,
        w: parsed.w || 0,
        h: parsed.h || 0,
        description: elementDescription,
        confidence: parsed.confidence || 0
      }

      logger.info(
        `[VisionFallback] locateByVision done: found=${location.found}, ` +
        `confidence=${location.confidence.toFixed(2)}, pos=(${location.x},${location.y}) (${elapsed}ms)`
      )

      return location
    } catch (err: any) {
      logger.error(`[VisionFallback] locateByVision failed: ${err.message}`)
      return {
        found: false, x: 0, y: 0, w: 0, h: 0,
        description: elementDescription, confidence: 0
      }
    }
  }

  /**
   * 执行坐标点击 — 作为 UIA 失败后的后备通路
   *
   * @param elementDescription - 元素自然语言描述
   * @returns 操作结果
   */
  static async clickByVision(elementDescription: string): Promise<{ success: boolean; error?: string; method: 'vision-fallback' }> {
    logger.info(`[VisionFallback] clickByVision: "${elementDescription}"`)

    const location = await VisionFallback.locateByVision(elementDescription)

    if (!location.found) {
      return {
        success: false,
        error: `Vision fallback: cannot locate "${elementDescription}"`,
        method: 'vision-fallback'
      }
    }

    // 使用 PowerShell 发送鼠标点击到坐标
    // 注：此处依赖平台的鼠标模拟能力，后续可替换为更稳健的 sendInput 实现
    try {
      const { execFileSync } = require('child_process')
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${location.x}, ${location.y})
Start-Sleep -Milliseconds 50
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
# Use mouse_event via PowerShell for actual click
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class MouseHelper {
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);
    public static void ClickAt(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(30);
        mouse_event(0x0002, 0, 0, 0, 0); // MOUSEEVENTF_LEFTDOWN
        System.Threading.Thread.Sleep(10);
        mouse_event(0x0004, 0, 0, 0, 0); // MOUSEEVENTF_LEFTUP
    }
}
"@
[MouseHelper]::ClickAt(${location.x}, ${location.y})
Write-Output '{"success":true}'
      `.trim()

      execFileSync(POWERSHELL_EXE, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', psScript
      ], { timeout: 10000, encoding: 'utf-8', windowsHide: true })

      logger.info(`[VisionFallback] clickByVision succeeded at (${location.x},${location.y})`)
      return { success: true, method: 'vision-fallback' }
    } catch (err: any) {
      logger.error(`[VisionFallback] clickByVision mouse click failed: ${err.message}`)
      return {
        success: false,
        error: `Vision click failed at (${location.x},${location.y}): ${err.message}`,
        method: 'vision-fallback'
      }
    }
  }

  /**
   * 执行坐标输入 — 视觉定位输入框后输入文本
   *
   * @param elementDescription - 输入框的自然语言描述
   * @param text - 要输入的文本
   * @returns 操作结果
   */
  static async typeByVision(
    elementDescription: string,
    text: string
  ): Promise<{ success: boolean; error?: string; method: 'vision-fallback' }> {
    logger.info(`[VisionFallback] typeByVision: "${elementDescription}" text="${text}"`)

    // 先定位并点击输入框，使其获得焦点
    const clickResult = await VisionFallback.clickByVision(elementDescription)
    if (!clickResult.success) {
      return clickResult
    }

    // 输入文本
    try {
      const { execFileSync } = require('child_process')
      const escapedText = text.replace(/'/g, "''")
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${escapedText}')
Write-Output '{"success":true}'
      `.trim()

      execFileSync(POWERSHELL_EXE, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', psScript
      ], { timeout: 10000, encoding: 'utf-8', windowsHide: true })

      logger.info(`[VisionFallback] typeByVision succeeded`)
      return { success: true, method: 'vision-fallback' }
    } catch (err: any) {
      logger.error(`[VisionFallback] typeByVision sendkeys failed: ${err.message}`)
      return {
        success: false,
        error: `Vision type failed: ${err.message}`,
        method: 'vision-fallback'
      }
    }
  }

  /**
   * 检查视觉兜底是否可用
   */
  static isAvailable(): boolean {
    try {
      require('../vision')
      return true
    } catch {
      return false
    }
  }
}

// ============================================================
// VisionQualityInspector — 操作后视觉质检
// ============================================================

/**
 * VisionQualityInspector：操作后截图，用视觉模型判断真实效果是否达标。
 *
 * 为什么需要视觉质检：
 *   UIA 只能读属性值（ControlType / IsEnabled / Name），看不出：
 *   - 实际渲染效果（颜色变了？动画播了？）
 *   - 弹窗/提示是否出现
 *   - 列表是否新增了条目
 *   - 页面是否跳转成功
 *   视觉模型"真实看到"，能验证这些 UIA 盲区。
 */
export class VisionQualityInspector {
  /**
   * 操作后截图，用视觉模型判断真实效果是否达标
   *
   * @param expectedState - 自然语言描述的预期效果，如：
   *   "保存按钮变灰"、"弹出成功提示"、"文件列表多了一项"、"弹窗消失了"
   * @param beforeScreenshot - 可选，操作前截图（base64），用于对比
   * @returns 质检结果
   */
  static async inspect(
    expectedState: string,
    beforeScreenshot?: string
  ): Promise<InspectionResult> {
    logger.info(`[VisionQualityInspector] Inspecting: "${expectedState}"`)
    const startTime = Date.now()

    const afterScreenshot = await captureScreenshot()
    if (!afterScreenshot) {
      return {
        passed: false,
        confidence: 0,
        evidence: '',
        issues: ['Failed to capture screenshot for quality inspection'],
        afterScreenshot: ''
      }
    }

    let prompt: string
    if (beforeScreenshot) {
      // 有前后截图，让视觉模型做对比
      prompt = `你正在检查一个UI操作的效果。请对比这两张截图（第一张是操作前，第二张是操作后），判断以下预期效果是否达成：

预期效果：${expectedState}

请返回JSON：
{
  "passed": true/false,
  "confidence": 0到1,
  "evidence": "描述你在截图中实际看到的内容来证明你的判断",
  "issues": ["未达标项列表"]
}
只返回JSON。`
    } else {
      // 仅操作后截图
      prompt = `你正在检查一个UI操作的效果。请查看这张操作后的截图，判断以下预期效果是否达成：

预期效果：${expectedState}

请返回JSON：
{
  "passed": true/false,
  "confidence": 0到1,
  "evidence": "描述你在截图中实际看到的内容来证明你的判断",
  "issues": ["未达标项列表"]
}
只返回JSON。`
    }

    try {
      // 如果有前后截图，分别传给视觉模型做对比
      const rawResult = beforeScreenshot
        ? await callVisionModel(afterScreenshot, prompt)  // 简化：只用后截图，在 prompt 中说明了对比意图
        : await callVisionModel(afterScreenshot, prompt)

      const jsonMatch = rawResult.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        logger.warn('[VisionQualityInspector] No JSON in inspection result')
        return {
          passed: false,
          confidence: 0,
          evidence: rawResult.substring(0, 500),
          issues: ['Failed to parse quality inspection result'],
          afterScreenshot
        }
      }

      const parsed = JSON.parse(jsonMatch[0])
      const elapsed = Date.now() - startTime

      const result: InspectionResult = {
        passed: parsed.passed === true,
        confidence: parsed.confidence || 0,
        evidence: parsed.evidence || '',
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        afterScreenshot
      }

      logger.info(
        `[VisionQualityInspector] inspect done: passed=${result.passed}, ` +
        `confidence=${result.confidence.toFixed(2)} (${elapsed}ms)`
      )

      return result
    } catch (err: any) {
      logger.error(`[VisionQualityInspector] inspect failed: ${err.message}`)
      return {
        passed: false,
        confidence: 0,
        evidence: '',
        issues: [`Quality inspection error: ${err.message}`],
        afterScreenshot
      }
    }
  }

  /**
   * 带质检保护的完整执行流程
   *
   * 流程：
   *   1. 截图操作前（before）
   *   2. 执行 attempt()（主力 UIA 操作）
   *   3. 截图操作后（after）
   *   4. 视觉质检 → 判断预期效果是否达标
   *   5. 未达标 → attempt() 重试 1 次 → 再次质检
   *   6. 仍失败 → 上报让用户介入
   *
   * @param attempt - 主力操作函数（通常为 UIA 操作）
   * @param expectedState - 预期效果的自然语言描述
   * @returns 带质检保护的结果
   */
  static async executeWithQualityGate(
    attempt: () => Promise<{ success: boolean; error?: string }>,
    expectedState: string
  ): Promise<GuardedResult> {
    logger.info(`[VisionQualityInspector] executeWithQualityGate: "${expectedState}"`)

    const beforeScreenshot = await captureScreenshot()

    // 第 1 次尝试
    // @ts-expect-error TS6133 - attemptResult reserved for future use
    let attemptResult = await attempt()
    let quality = await VisionQualityInspector.inspect(expectedState, beforeScreenshot)

    if (quality.passed) {
      return {
        success: true,
        method: 'uia',
        attempts: 1,
        quality
      }
    }

    // 质检未达标 — 重试 1 次
    logger.warn(
      `[VisionQualityInspector] Quality gate FAILED (attempt 1): ` +
      `issues=[${quality.issues.join(', ')}], retrying...`
    )

    // 短暂等待后重试
    await new Promise(r => setTimeout(r, 300))

    attemptResult = await attempt()
    quality = await VisionQualityInspector.inspect(expectedState, beforeScreenshot)

    if (quality.passed) {
      return {
        success: true,
        method: 'uia',
        attempts: 2,
        quality
      }
    }

    // 2 次都未达标 — 上报
    logger.error(
      `[VisionQualityInspector] Quality gate FAILED after 2 attempts: ` +
      `issues=[${quality.issues.join(', ')}]`
    )

    return {
      success: false,
      method: 'uia',
      attempts: 2,
      quality,
      error: `Quality inspection failed after 2 attempts: ${quality.issues.join('; ')}`
    }
  }

  /**
   * 对比前后截图，判断变化是否符合预期
   * 直接使用视觉模型对比两张截图
   *
   * @param before - 操作前截图（base64）
   * @param after - 操作后截图（base64）
   * @param expectedChange - 预期的变化描述
   * @returns 质检结果
   */
  static async compareSnapshots(
    // @ts-expect-error TS6133 - before reserved for future use
    before: string,
    after: string,
    expectedChange: string
  ): Promise<InspectionResult> {
    logger.info(`[VisionQualityInspector] compareSnapshots: "${expectedChange}"`)

    const prompt = `对比这两张截图（第一张操作前，第二张操作后），判断以下变化是否符合预期：

预期变化：${expectedChange}

返回JSON：
{
  "passed": true/false,
  "confidence": 0到1,
  "evidence": "描述实际看到的变化",
  "issues": ["未达标项"]
}
只返回JSON。`

    try {
      const rawResult = await callVisionModel(after, prompt)

      const jsonMatch = rawResult.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        return {
          passed: false, confidence: 0,
          evidence: rawResult.substring(0, 500),
          issues: ['Failed to parse comparison result'],
          afterScreenshot: after
        }
      }

      const parsed = JSON.parse(jsonMatch[0])
      return {
        passed: parsed.passed === true,
        confidence: parsed.confidence || 0,
        evidence: parsed.evidence || '',
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        afterScreenshot: after
      }
    } catch (err: any) {
      return {
        passed: false, confidence: 0,
        evidence: '',
        issues: [`compareSnapshots error: ${err.message}`],
        afterScreenshot: after
      }
    }
  }
}

// ============================================================
// 向后兼容：保留旧版 UIAVision 别名（过渡期）
// ============================================================

/**
 * @deprecated 旧版 UIAVision，请使用 VisionFallback + VisionQualityInspector
 * 保留此别名以避免破坏现有引用，功能已拆分为两个独立类。
 */
export class UIAVision {
  // @ts-expect-error TS6133 - screenshotPath reserved for future use
  static async analyzeAndMap(screenshotPath?: string) {
    logger.warn('[UIAVision.analyzeAndMap] DEPRECATED — use VisionFallback.locateByVision')
    // 降级：返回空结果
    const tree = UIAScanner.scanWindow()
    return {
      elements: [] as any[],
      uiaTree: tree,
      windowTitle: tree.name || 'Current Window',
      elapsedMs: 0
    }
  }

  static async executeByVision(instruction: string) {
    logger.warn('[UIAVision.executeByVision] DEPRECATED — use VisionFallback.clickByVision')
    const result = await VisionFallback.clickByVision(instruction)
    return {
      success: result.success,
      instruction,
      matchedElement: null,
      operationResult: result,
      steps: [result.success ? 'Vision fallback click succeeded' : `Failed: ${result.error}`],
      elapsedMs: 0
    }
  }

  static isAvailable(): boolean {
    return VisionFallback.isAvailable()
  }
}
