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
import { interactionExecutor } from './interaction-executor'
import { Element, ElementType } from './element-recognizer'

export interface UIALocateResult {
  hit: boolean
  element?: Element
  x?: number
  y?: number
}

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
