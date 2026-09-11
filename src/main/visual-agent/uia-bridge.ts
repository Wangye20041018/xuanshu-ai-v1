/**
 * UIA 桥接层（v10.2，P1-3）
 *
 * 把 UIA 定位结果接入 visual-agent 的 element-recognizer.Element 结构，
 * 实现「标准控件 → UIA 优先；自定义 → 视觉回退」的判断。
 *
 * 设计（架构 §4.4）：
 *   - executeTask 在 elementRecognizer.identifyElements 之前先走 UIA；
 *   - UIA 命中则跳过视觉识别（零显存），直接拿坐标；
 *   - UIA 未命中（返回 null）则回退视觉识别分支。
 */

import { uiaLocator } from '../uia'
import { POWERSHELL_EXE } from '../utils/powershell'
import { interactionExecutor } from './interaction-executor'
import { Element, ElementType } from './element-recognizer'

export interface UIALocateResult {
  hit: boolean
  element?: Element
  x?: number
  y?: number
}

/**
 * 扫描控件树脚本（v11 · 大修第一批）
 * 通过 Windows UI Automation 遍历当前屏幕所有可交互控件，
 * 输出 JSON 数组（name 非空且属交互控件类型），供「UIA 控件树」第一级使用。
 */
const SCAN_PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$interactive = @('ControlType.Button','ControlType.Edit','ControlType.ComboBox','ControlType.CheckBox','ControlType.RadioButton','ControlType.Hyperlink','ControlType.ListItem','ControlType.MenuItem','ControlType.TreeItem','ControlType.Slider','ControlType.TabItem','ControlType.Custom','ControlType.DataItem')
$stack = New-Object System.Collections.Generic.Stack[object]
$stack.Push($root)
$count = 0
$max = 8000
$outList = New-Object System.Collections.ArrayList
while ($stack.Count -gt 0 -and $count -lt $max -and $outList.Count -lt 120) {
  $el = $stack.Pop()
  $count++
  $ct = $el.Current.ControlType.ProgrammaticName
  $name = $el.Current.Name
  if ($name -and $interactive -contains $ct) {
    $r = $el.Current.BoundingRectangle
    if ($r.Width -gt 1 -and $r.Height -gt 1) {
      $null = $outList.Add([ordered]@{
        name = $name
        automationId = $el.Current.AutomationId
        controlType = $ct
        x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height
      })
    }
  }
  $child = $walker.GetFirstChild($el)
  while ($child -ne $null) {
    $stack.Push($child)
    $child = $walker.GetNextSibling($child)
  }
}
Write-Output ($outList | ConvertTo-Json -Compress -Depth 3)
`

/** 将 UIA 的 controlType ProgrammaticName 映射到 element-recognizer.ElementType */
function mapControlType(programmaticName: string): ElementType {
  const t = (programmaticName || '').replace('ControlType.', '').toUpperCase()
  const map: Record<string, ElementType> = {
    BUTTON: ElementType.BUTTON,
    EDIT: ElementType.TEXT_BOX,
    TEXT: ElementType.TEXT_LABEL,
    COMBOBOX: ElementType.DROPDOWN,
    CHECKBOX: ElementType.CHECKBOX,
    RADIOBUTTON: ElementType.RADIO,
    HYPERLINK: ElementType.HYPERLINK,
    LISTITEM: ElementType.LIST_ITEM,
    MENUITEM: ElementType.MENU_ITEM,
    TREEITEM: ElementType.TREE_NODE,
    SLIDER: ElementType.SLIDER,
    TABITEM: ElementType.TAB,
    WINDOW: ElementType.WINDOW_TITLE,
    IMAGE: ElementType.IMAGE,
    DOCUMENT: ElementType.TEXT_LABEL,
    PANE: ElementType.UNKNOWN,
    CUSTOM: ElementType.UNKNOWN,
  }
  return map[t] || ElementType.UNKNOWN
}

/**
 * 通过 UIA 扫描整棵控件树，返回可交互控件（第一级：UIA 控件树）
 * 失败/无命中返回空数组（交由 OCR / 视觉回退）
 */
export async function scanViaUIA(): Promise<Element[]> {
  try {
    if (process.platform !== 'win32') return []
    const { execFile } = require('child_process')
    const out = await new Promise<string>((resolve) => {
      execFile(
        POWERSHELL_EXE,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCAN_PS_SCRIPT],
        { maxBuffer: 8 * 1024 * 1024, timeout: 20000, windowsHide: true },
        (err: Error | null, stdout: string) => resolve(err ? '' : stdout || ''),
      )
    })
    const line = (out || '').trim().split('\n').filter(l => l.trim().startsWith('[')).pop()
    if (!line) return []
    const parsed = JSON.parse(line)
    if (!Array.isArray(parsed)) return []
    return parsed.map((c: any) => ({
      type: mapControlType(c.controlType || ''),
      label: c.name || '',
      bbox: { x: c.x || 0, y: c.y || 0, w: c.width || 0, h: c.height || 0 },
      confidence: 0.92,
      state: 'normal' as const,
      textContent: c.name || '',
      parentId: null,
      clickable: true,
    })).filter((el: Element) => el.label.length > 0 && el.bbox.w > 1 && el.bbox.h > 1)
  } catch {
    return []
  }
}

/**
 * 通过 UIA 定位目标文本对应的标准控件
 */
export async function locateViaUIA(targetText: string): Promise<UIALocateResult> {
  try {
    if (!targetText) return { hit: false }
    const ctrl = await uiaLocator.findControlByText(targetText)
    if (!ctrl) return { hit: false }

    const cx = ctrl.x + ctrl.width / 2
    const cy = ctrl.y + ctrl.height / 2
    const element: Element = {
      type: mapControlType(ctrl.controlType),
      label: ctrl.name || targetText,
      bbox: { x: ctrl.x, y: ctrl.y, w: ctrl.width, h: ctrl.height },
      confidence: 0.95,
      state: 'normal',
      textContent: ctrl.name || '',
      parentId: null,
      clickable: true,
    }
    return { hit: true, element, x: cx, y: cy }
  } catch {
    return { hit: false }
  }
}

/**
 * 通过 UIA 定位并直接点击目标文本对应的标准控件
 * @returns 是否成功点击
 */
export async function clickViaUIA(targetText: string): Promise<boolean> {
  const r = await locateViaUIA(targetText)
  if (!r.hit || r.x === undefined || r.y === undefined) return false
  try {
    await interactionExecutor.clickAt(r.x, r.y)
    return true
  } catch {
    return false
  }
}
