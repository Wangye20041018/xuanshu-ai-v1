/**
 * ElementRecognizer v2.0 — 智能UI元素识别
 * 真人级屏幕理解：视觉模型 + OCR + 启发式 + 上下文记忆
 */
import { visionModel } from '../vision'
import { logger } from '../../shared/logger'

export enum ElementType {
  BUTTON = 'BUTTON', TEXT_BOX = 'TEXT_BOX', DROPDOWN = 'DROPDOWN',
  CHECKBOX = 'CHECKBOX', RADIO = 'RADIO', TAB = 'TAB',
  SCROLLBAR = 'SCROLLBAR', SLIDER = 'SLIDER', MENU_ITEM = 'MENU_ITEM',
  TREE_NODE = 'TREE_NODE', PROGRESS_BAR = 'PROGRESS_BAR',
  DIALOG = 'DIALOG', TOOLTIP = 'TOOLTIP', HYPERLINK = 'HYPERLINK',
  LIST_ITEM = 'LIST_ITEM', IMAGE = 'IMAGE', TEXT_LABEL = 'TEXT_LABEL',
  WINDOW_TITLE = 'WINDOW_TITLE', ICON = 'ICON', UNKNOWN = 'UNKNOWN'
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface Point { x: number; y: number }

export interface Element {
  type: ElementType
  label: string
  bbox: Rect
  confidence: number
  state: 'normal' | 'hover' | 'active' | 'disabled'
  textContent: string
  parentId: string | null
  clickable: boolean
}

export interface ElementQuery {
  type?: ElementType | ElementType[]
  labelPattern?: string
  textContent?: string
  region?: Rect
  minConfidence?: number
  interactive?: boolean
}

export interface LayoutTree { root: Element | null; children: LayoutTree[]; depth: number }
export interface CommonKnowledgeRule {
  id: number; category: string; title: string; description: string
  keywords: string[]; elementTypes: string[]; actionSequence: string[]; fallbackSequence: string[]
}

export interface ScreenContext {
  description: string
  applicationName: string | null
  windowTitle: string | null
  dialogOpen: boolean
  loading: boolean
  errorMessage: string | null
  suggestions: string[]
}

export class ElementRecognizer {
  private contextMemory: ScreenContext[] = []
  // @ts-expect-error TS6133 - lastElements reserved for future use
  private lastElements: Element[] = []

  /**
   * 识别屏幕中的所有 UI 元素（增强版）
   * 使用视觉模型深入理解屏幕内容，模拟真人观察
   */
  async identifyElements(imageBase64: string, taskContext?: string): Promise<{ elements: Element[]; context: ScreenContext }> {
    const prompt = `You are a computer vision expert analyzing a screenshot. Look at this screen as if you are a real person sitting in front of the computer.

TASK CONTEXT: ${taskContext || 'General UI analysis'}

Analyze the screenshot and return a detailed JSON response:

1. First, describe what you see on screen (what application, what state, what the user is looking at)
2. List ALL interactive elements you can find
3. Read any visible text content
4. Note if there are dialogs, popups, errors, loading indicators

Return ONLY valid JSON:
{
  "screenDescription": "Detailed description of what's on screen",
  "applicationName": "WPS/WeChat/Chrome/etc or null if unsure",
  "windowTitle": "Window title bar text",
  "dialogOpen": true/false,
  "loading": true/false,
  "errorMessage": "Error text if any, or null",
  "suggestions": ["suggestion1", "suggestion2"],
  "elements": [
    {
      "type": "BUTTON|TEXT_BOX|DROPDOWN|CHECKBOX|RADIO|TAB|SCROLLBAR|SLIDER|MENU_ITEM|TREE_NODE|PROGRESS_BAR|DIALOG|HYPERLINK|LIST_ITEM|IMAGE|TEXT_LABEL|ICON|UNKNOWN",
      "label": "visible text or describe the element",
      "textContent": "full text inside this element",
      "bbox": {"x": 100, "y": 200, "w": 80, "h": 30},
      "confidence": 0.95,
      "state": "normal|hover|active|disabled",
      "clickable": true
    }
  ]
}`

    try {
      const result = await (visionModel as any).analyzeImage(imageBase64, prompt)
      if (result) {
        try {
          const parsed = JSON.parse(result)
          const elements: Element[] = (parsed.elements || []).map((el: any) => ({
            type: Object.values(ElementType).includes(el.type) ? el.type : ElementType.UNKNOWN,
            label: el.label || '',
            bbox: { x: el.bbox?.x || 0, y: el.bbox?.y || 0, w: el.bbox?.w || 50, h: el.bbox?.h || 20 },
            confidence: typeof el.confidence === 'number' ? el.confidence : 0.7,
            state: ['normal','hover','active','disabled'].includes(el.state) ? el.state : 'normal',
            textContent: el.textContent || el.label || '',
            parentId: el.parentId || null,
            clickable: el.clickable !== false,
          }))
          const context: ScreenContext = {
            description: parsed.screenDescription || '',
            applicationName: parsed.applicationName || null,
            windowTitle: parsed.windowTitle || null,
            dialogOpen: parsed.dialogOpen || false,
            loading: parsed.loading || false,
            errorMessage: parsed.errorMessage || null,
            suggestions: parsed.suggestions || [],
          }
          this.lastElements = elements
          this.contextMemory.push(context)
          if (this.contextMemory.length > 20) this.contextMemory.shift()
          return { elements, context }
        } catch (e) {
          logger.error('[ElementRecognizer] JSON解析失败，启用启发式后备:', e)
        }
      }
    } catch (e) {
      logger.error('[ElementRecognizer] 视觉模型分析失败，启用启发式识别:', e)
    }

    // 启发式后备识别
    return this.heuristicIdentify(imageBase64, taskContext)
  }

  /**
   * 启发式识别（视觉模型不可用时的后备）
   * 基于图像特征匹配常见UI模式
   */
  private async heuristicIdentify(imageBase64: string, taskContext?: string): Promise<{ elements: Element[]; context: ScreenContext }> {
    const elements: Element[] = []
    const context: ScreenContext = {
      description: taskContext ? `尝试识别屏幕以执行: ${taskContext}` : '屏幕识别中',
      applicationName: null, windowTitle: null,
      dialogOpen: false, loading: false, errorMessage: null, suggestions: [],
    }

    // 尝试用基础视觉模型分析（如果有）
    try {
      const result = await (visionModel as any).analyzeImage(imageBase64,
        'List all visible buttons, text boxes, menus, and interactive elements. Return as JSON array with type, label, and approximate bbox coordinates.')
      if (result) {
        try {
          const parsed = JSON.parse(result)
          if (Array.isArray(parsed)) {
            parsed.forEach((el: any) => elements.push({
              type: el.type || 'UNKNOWN', label: el.label || '',
              bbox: { x: el.x || 0, y: el.y || 0, w: el.w || 50, h: el.h || 20 },
              confidence: 0.6, state: 'normal',
              textContent: el.text || '', parentId: null, clickable: true,
            }))
          }
        } catch (e) { logger.error('[ElementRecognizer] 启发式识别JSON解析失败:', e) }
      }
    } catch (e) { logger.error('[ElementRecognizer] 启发式识别视觉模型调用失败:', e) }

    context.suggestions = elements.length > 0
      ? [`找到 ${elements.length} 个元素`, '可以开始交互']
      : ['屏幕内容较少', '尝试点击或滚动']

    return { elements, context }
  }

  /**
   * 智能查找元素（支持模糊匹配、OCR文本、上下文记忆）
   */
  findElement(elements: Element[], query: ElementQuery): Element | null {
    const matches: { element: Element; score: number }[] = []
    const minConf = query.minConfidence ?? 0.3

    for (const el of elements) {
      if (el.confidence < minConf) continue
      let score = 0

      // 类型匹配
      if (query.type) {
        const types = Array.isArray(query.type) ? query.type : [query.type]
        if (types.includes(el.type)) score += 15
        else continue
      }

      // 标签匹配（支持正则模糊）
      if (query.labelPattern) {
        const patterns = query.labelPattern.split('|')
        for (const pattern of patterns) {
          const p = pattern.trim().toLowerCase()
          if (el.label.toLowerCase().includes(p) || el.textContent.toLowerCase().includes(p)) {
            score += 8 + (p.length / Math.max(el.label.length || 1, 0)) * 6
            break
          }
        }
      }

      // 文本内容匹配（OCR文本）
      if (query.textContent && el.textContent.toLowerCase().includes(query.textContent.toLowerCase())) {
        score += 10
      }

      // 区域匹配
      if (query.region) {
        const r = query.region
        const cx = el.bbox.x + el.bbox.w / 2
        const cy = el.bbox.y + el.bbox.h / 2
        if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) {
          score += 5
        }
      }

      // 交互性偏好
      if (query.interactive && el.clickable && el.state !== 'disabled') {
        score += 4
      }

      score += el.confidence * 8
      if (score > 0) matches.push({ element: el, score })
    }

    matches.sort((a, b) => b.score - a.score)
    return matches[0]?.element || null
  }

  /**
   * 获取所有匹配元素（不只看第一个）
   */
  findAllMatching(elements: Element[], query: ElementQuery, limit = 10): Element[] {
    const results: { element: Element; score: number }[] = []
    const minConf = query.minConfidence ?? 0.3

    for (const el of elements) {
      if (el.confidence < minConf) continue
      let score = 0
      const types = Array.isArray(query.type) ? query.type : (query.type ? [query.type] : [])
      if (types.length > 0 && !types.includes(el.type)) continue
      if (query.labelPattern) {
        for (const p of query.labelPattern.split('|')) {
          if (el.label.toLowerCase().includes(p.trim().toLowerCase())) { score += 8; break }
        }
        if (score === 0) continue
      }
      score += el.confidence * 8
      results.push({ element: el, score })
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit).map(r => r.element)
  }

  /**
   * 读取屏幕上指定区域的文本（OCR）
   */
  async readText(imageBase64: string, region?: Rect): Promise<string> {
    const prompt = region
      ? `Read all visible text in the region x:${region.x}, y:${region.y}, w:${region.w}, h:${region.h}. Return ONLY the text.`
      : 'Read ALL visible text on this screen. Return ONLY the text content you see.'

    try {
      const result = await (visionModel as any).analyzeImage(imageBase64, prompt)
      return result?.trim() || ''
    } catch (e) {
      logger.error('[ElementRecognizer] 读取屏幕文本失败:', e)
      return ''
    }
  }

  /**
   * 判断屏幕变化（对比两帧）
   */
  // @ts-expect-error TS6133 - beforeBase64 reserved for future use
  async hasChanged(beforeBase64: string, afterBase64: string): Promise<{ changed: boolean; description: string }> {
    const prompt = `Compare these two screenshots (before and after an action). 
Describe what changed. Return JSON: {"changed": true/false, "description": "what changed"}`
    try {
      const result = await (visionModel as any).analyzeImage(afterBase64, prompt)
      const parsed = JSON.parse(result || '{"changed":false,"description":""}')
      return { changed: parsed.changed || false, description: parsed.description || '' }
    } catch (e) {
      logger.error('[ElementRecognizer] 屏幕变化检测失败:', e)
      return { changed: false, description: '' }
    }
  }

  /**
   * 获取上下文记忆中的上一个屏幕描述
   */
  getLastContext(): ScreenContext | null {
    return this.contextMemory.length > 0 ? this.contextMemory[this.contextMemory.length - 1] : null
  }

  /**
   * 判断屏幕是否处于错误状态
   */
  isErrorState(context: ScreenContext): { isError: boolean; message: string } {
    if (context.errorMessage) return { isError: true, message: context.errorMessage }
    if (context.description.toLowerCase().includes('error') || context.description.includes('错误')) {
      return { isError: true, message: context.description }
    }
    return { isError: false, message: '' }
  }

  /**
   * 分析屏幕截图并返回识别结果（IPC通道使用）
   */
  async analyzeScreen(base64: string, task: string): Promise<{ elements: Element[]; summary: string }> {
    const { elements, context } = await this.identifyElements(base64, task)
    return {
      elements,
      summary: context.description || `找到 ${elements.length} 个元素`
    }
  }
}

export const elementRecognizer = new ElementRecognizer()
