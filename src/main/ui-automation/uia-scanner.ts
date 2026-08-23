/**
 * UIA 扫描器 — 主力交互通路的核心感知层
 *
 * 核心理念：UIA 是主力通路（结构化遍历控件树，精确知道元素的 Name/Type/AutomationId，毫秒级响应）。
 *           扫描器提供结构化感知能力，供 UIA 执行器使用。
 *
 * 封装 PowerShell UIA 调用，提供结构化 UI 树扫描、快速存在性判断、属性快照、自绘控件预判。
 */

import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { createLogger } from '../utils/logging'
import { POWERSHELL_EXE } from '../utils/powershell'

const logger = createLogger('UIA:Scanner')

// ============================================================
// 类型定义
// ============================================================

export interface BoundingRect {
  x: number
  y: number
  w: number
  h: number
}

export interface UIAElement {
  name: string
  controlType: string
  automationId: string
  className: string
  boundingRect: BoundingRect
  isEnabled: boolean
  isVisible: boolean
  children: UIAElement[]
}

export interface ElementSearchResult {
  found: boolean
  name: string
  controlType: string
  automationId: string
  className: string
  boundingRect: BoundingRect
  isEnabled: boolean
  error?: string
}

export interface FocusedElement {
  name: string
  controlType: string
  automationId: string
  className: string
  boundingRect: BoundingRect
  isEnabled: boolean
  isFocused: boolean
  error?: string
}

export interface WaitResult {
  found: boolean
  name?: string
  controlType?: string
  automationId?: string
  className?: string
  boundingRect?: BoundingRect
  isEnabled?: boolean
  timeoutMs?: number
  error?: string
}

export interface ElementConditions {
  name?: string
  controlType?: string
  automationId?: string
}

export interface ScanOptions {
  /** 扫描最大深度，默认 10 */
  maxDepth?: number
  /** PowerShell 调用超时（毫秒），默认 15000 */
  timeout?: number
}

// ============================================================
// PowerShell 引擎
// ============================================================

const SCRIPT_PATH = join(__dirname, 'uia-ps.ps1')
const DEFAULT_TIMEOUT = 15000

let powershellAvailable: boolean | null = null

function isPowerShellAvailable(): boolean {
  if (powershellAvailable !== null) return powershellAvailable
  try {
    if (!existsSync(SCRIPT_PATH)) {
      logger.warn(`PowerShell script not found: ${SCRIPT_PATH}`)
      powershellAvailable = false
      return false
    }
    execFileSync(POWERSHELL_EXE, ['-Command', 'Write-Host "ok"'], {
      timeout: 3000,
      encoding: 'utf-8'
    })
    powershellAvailable = true
    logger.info('PowerShell is available')
    return true
  } catch {
    logger.warn('PowerShell is not available — UIA features will be degraded')
    powershellAvailable = false
    return false
  }
}

function invokePowerShell(command: string, params: Record<string, unknown> = {}, timeout: number = DEFAULT_TIMEOUT): string {
  if (!isPowerShellAvailable()) {
    throw new Error('PowerShell is not available — UIA operations cannot be executed')
  }

  const paramsJson = JSON.stringify(params)
  const escapedParams = paramsJson.replace(/"/g, '`"')

  const psArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', `"${SCRIPT_PATH}"`,
    command,
    `"${escapedParams}"`
  ]

  const startTime = Date.now()
  logger.info(`UIA PS invoke: ${command} params=${paramsJson.substring(0, 200)}`)

  try {
    const stdout = execFileSync(POWERSHELL_EXE, psArgs, {
      timeout,
      encoding: 'utf-8',
      maxBuffer: 20 * 1024 * 1024, // 20MB for large trees
      windowsHide: true
    })

    const elapsed = Date.now() - startTime
    logger.info(`UIA PS done: ${command} (${elapsed}ms)`)

    return stdout.trim()
  } catch (err: any) {
    const elapsed = Date.now() - startTime
    if (err.killed) {
      logger.error(`UIA PS timeout: ${command} (${elapsed}ms)`)
      throw new Error(`PowerShell call timed out after ${timeout}ms`)
    }
    logger.error(`UIA PS error: ${command} — ${err.message}`)
    throw err
  }
}

function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    // 尝试从输出中提取 JSON（去除可能的警告/提示行）
    const lines = raw.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return JSON.parse(trimmed) as T
      }
    }
    throw new Error(`Failed to parse PowerShell output as JSON: ${raw.substring(0, 200)}`)
  }
}

// ============================================================
// UIA Scanner
// ============================================================

export class UIAScanner {
  /**
   * 扫描窗口的完整 UI 控件树
   * @param windowTitle - 窗口标题（不传则使用当前活动窗口）
   * @param options - 扫描选项
   */
  static scanWindow(windowTitle?: string, options?: ScanOptions): UIAElement {
    const title = windowTitle || ''
    const raw = invokePowerShell('GetTree', { windowTitle: title }, options?.timeout || DEFAULT_TIMEOUT)
    const parsed = parseJson<UIAElement & { error?: string }>(raw)

    if (parsed.error) {
      throw new Error(`UIA scan failed: ${parsed.error}`)
    }

    return parsed
  }

  /**
   * 查找单个 UI 元素
   */
  static findElement(conditions: ElementConditions, windowTitle?: string): ElementSearchResult {
    const raw = invokePowerShell('FindElement', {
      windowTitle: windowTitle || '',
      name: conditions.name || '',
      controlType: conditions.controlType || '',
      automationId: conditions.automationId || ''
    })
    return parseJson<ElementSearchResult>(raw)
  }

  /**
   * 查找所有匹配条件的 UI 元素
   * 通过递归扫描整棵树并过滤实现
   */
  static findElements(conditions: ElementConditions, windowTitle?: string): UIAElement[] {
    const tree = UIAScanner.scanWindow(windowTitle)

    const results: UIAElement[] = []

    function search(node: UIAElement) {
      let match = true
      if (conditions.name && node.name !== conditions.name) match = false
      if (conditions.controlType && node.controlType !== conditions.controlType) match = false
      if (conditions.automationId && node.automationId !== conditions.automationId) match = false
      if (match) results.push(node)

      for (const child of node.children) {
        search(child)
      }
    }

    search(tree)
    return results
  }

  /**
   * 获取当前焦点元素
   */
  static getFocusedElement(): FocusedElement {
    const raw = invokePowerShell('GetFocused')
    return parseJson<FocusedElement>(raw)
  }

  /**
   * 等待指定元素出现（轮询 200ms 间隔）
   * @param conditions - 搜索条件
   * @param timeoutMs - 超时时间（毫秒），默认 5000
   * @param windowTitle - 窗口标题
   */
  static waitForElement(
    conditions: ElementConditions,
    timeoutMs: number = 5000,
    windowTitle?: string
  ): WaitResult {
    const raw = invokePowerShell('WaitForElement', {
      windowTitle: windowTitle || '',
      name: conditions.name || '',
      timeoutMs
    })
    return parseJson<WaitResult>(raw)
  }

  /**
   * 快速判断元素是否存在（不做全量扫描，比 findElement 更轻量）
   *
   * UIA 主力通路中用此方法快速预判，避免每次都做完整 FindElement 的开销。
   *
   * @param conditions - 搜索条件
   * @param windowTitle - 窗口标题
   * @returns 是否存在
   */
  static hasElement(conditions: ElementConditions, windowTitle?: string): boolean {
    try {
      const result = UIAScanner.findElement(conditions, windowTitle)
      return result.found
    } catch {
      return false
    }
  }

  /**
   * 获取元素当前所有属性（用于质检前的属性快照）
   *
   * 在操作前拍下属性快照，操作后可对比判断属性级变化。
   * 注意：属性变化不等于视觉变化（UIA 看不出颜色/动画），视觉变化请用 VisionQualityInspector。
   *
   * @param conditions - 元素搜索条件
   * @param windowTitle - 窗口标题
   * @returns 元素所有属性的键值对，元素不存在时返回 null
   */
  static getElementProperties(
    conditions: ElementConditions,
    windowTitle?: string
  ): Record<string, unknown> | null {
    try {
      const raw = invokePowerShell('GetProperties', {
        windowTitle: windowTitle || '',
        name: conditions.name || '',
        controlType: conditions.controlType || '',
        automationId: conditions.automationId || ''
      })
      return parseJson<Record<string, unknown>>(raw)
    } catch {
      return null
    }
  }

  /**
   * 判断控件类型是否可能是自绘控件（Custom 渲染，UIA 可能无法精确交互）
   *
   * 用于预判是否需要视觉兜底。以下类型很可能绕过标准 UIA 控件：
   *   - Custom: 完全自绘
   *   - Image: 图片控件（无标准交互接口）
   *   - Pane: 容器面板（通常内部是自绘）
   *   - Group: 分组容器（可能包裹自绘内容）
   *
   * 返回 true 时，建议在操作前准备好 VisionFallback 描述。
   *
   * @param controlType - UIA 控件类型名称
   * @returns 是否可能是自绘控件
   */
  static isVisualElement(controlType: string): boolean {
    const visualTypes = new Set([
      'Custom',
      'Image',
      'Pane',
      'Group',
      'ToolBar',    // 工具栏通常是自绘
      'DataGrid',   // 数据表格常有自绘单元格
      'List',       // 列表可能包含自绘项
      'Tree',       // 树控件可能有自绘节点
      'Menu',       // 菜单可能是自绘
      'ToolTip'     // 提示框通常是自绘
    ])
    return visualTypes.has(controlType)
  }

  /**
   * 检查 UIA 能力是否可用
   */
  static isAvailable(): boolean {
    return isPowerShellAvailable()
  }

  /**
   * 从树中展平所有元素（不含递归 children）
   */
  static flattenTree(root: UIAElement): Omit<UIAElement, 'children'>[] {
    const result: Omit<UIAElement, 'children'>[] = []

    function walk(node: UIAElement) {
      const { children, ...rest } = node
      result.push(rest)
      for (const child of children) {
        walk(child)
      }
    }

    walk(root)
    return result
  }
}
