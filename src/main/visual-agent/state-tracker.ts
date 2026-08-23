/**
 * StateTracker — 操作状态机 + 85条规则加载 + 意图匹配
 */
import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import type { CommonKnowledgeRule } from './element-recognizer'
import type { Screenshot } from './screen-observer'
import { logger } from '../../shared/logger'

export type VisualStateStatus = 'idle' | 'observing' | 'recognizing' | 'reasoning' | 'planning' | 'executing' | 'verifying' | 'done' | 'retry' | 'error' | 'cancelled'

export interface VisualState {
  status: VisualStateStatus
  currentStep: number
  totalSteps: number
  lastObservation: Screenshot | null
  lastActionResult: string | null
}

export interface VisualTask {
  id: string
  intent: string
  target: string
  context: Record<string, any>
  maxSteps: number
  timeout: number
}

export interface VisualStep {
  id: string
  action: string
  target: string
  status: 'pending' | 'running' | 'completed' | 'error'
  beforeScreenshot: Screenshot | null
  afterScreenshot: Screenshot | null
  duration: number
}

export interface ActionPlan {
  steps: VisualStep[]
  estimatedTime: number
  fallbackSteps: VisualStep[]
}

export interface VisualResult {
  success: boolean
  steps: VisualStep[]
  error: string | null
  screenshot: Screenshot | null
}

export class StateTracker {
  private currentState: VisualState
  private history: VisualState[] = []
  private rules: CommonKnowledgeRule[] = []

  constructor() {
    this.currentState = {
      status: 'idle',
      currentStep: 0,
      totalSteps: 0,
      lastObservation: null,
      lastActionResult: null
    }
  }

  /**
   * 状态转移
   */
  transition(newStatus: VisualStateStatus, metadata?: Partial<VisualState>): void {
    this.history.push({ ...this.currentState })
    this.currentState = {
      ...this.currentState,
      ...metadata,
      status: newStatus
    }
  }

  getCurrentState(): VisualState {
    return { ...this.currentState }
  }

  getHistory(): VisualState[] {
    return [...this.history]
  }

  /**
   * 加载85条常识规则
   */
  loadCommonRules(): CommonKnowledgeRule[] {
    try {
      // 从 common-knowledge.json 加载
      let jsonPath: string
      if (existsSync(join(process.resourcesPath, 'knowledge', 'common-knowledge.json'))) {
        jsonPath = join(process.resourcesPath, 'knowledge', 'common-knowledge.json')
      } else {
        jsonPath = join(app.getAppPath(), 'out', 'main', 'visual-agent', 'common-knowledge', 'common-knowledge.json')
        if (!existsSync(jsonPath)) {
          jsonPath = join(__dirname, 'visual-agent', 'common-knowledge', 'common-knowledge.json')
        }
      }

      if (existsSync(jsonPath)) {
        const data = JSON.parse(readFileSync(jsonPath, 'utf-8'))
        if (data.categories) {
          const allRules: CommonKnowledgeRule[] = []
          for (const category of Object.values(data.categories) as any[]) {
            if (Array.isArray(category)) {
              allRules.push(...category)
            }
          }
          this.rules = allRules
          logger.debug(`[StateTracker] 加载了 ${this.rules.length} 条常识规则`)
          return this.rules
        }
      }
    } catch (e) {
      logger.error('[StateTracker] 加载规则失败:', e)
    }

    // 降级：使用内嵌规则
    this.loadEmbeddedRules()
    return this.rules
  }

  /**
   * 内嵌降级规则
   */
  private loadEmbeddedRules(): void {
    this.rules = [
      { id: 1, category: 'windowStructure', title: '最大化窗口', description: '', keywords: ['最大化', '全屏'], elementTypes: ['BUTTON'], actionSequence: ['press_keys:Alt+Space', 'press_keys:X'], fallbackSequence: [] },
      { id: 3, category: 'windowStructure', title: '关闭窗口', description: '', keywords: ['关闭', '退出'], elementTypes: ['BUTTON'], actionSequence: ['press_keys:Alt+F4'], fallbackSequence: [] },
      { id: 6, category: 'standardControls', title: '点击确定', description: '', keywords: ['确定', 'ok'], elementTypes: ['BUTTON'], actionSequence: ['press_keys:Enter'], fallbackSequence: [] },
      { id: 7, category: 'standardControls', title: '点击取消', description: '', keywords: ['取消', 'cancel'], elementTypes: ['BUTTON'], actionSequence: ['press_keys:Escape'], fallbackSequence: [] },
      { id: 9, category: 'standardControls', title: '输入文本', description: '', keywords: ['输入', '填写'], elementTypes: ['TEXT_BOX'], actionSequence: ['find_textbox', 'click_textbox', 'type_text'], fallbackSequence: ['clipboard_paste'] },
      { id: 21, category: 'shortcuts', title: '复制', description: '', keywords: ['复制', 'copy'], elementTypes: [], actionSequence: ['press_keys:Ctrl+C'], fallbackSequence: [] },
      { id: 22, category: 'shortcuts', title: '粘贴', description: '', keywords: ['粘贴', 'paste'], elementTypes: [], actionSequence: ['press_keys:Ctrl+V'], fallbackSequence: [] },
      { id: 24, category: 'shortcuts', title: '全选', description: '', keywords: ['全选'], elementTypes: [], actionSequence: ['press_keys:Ctrl+A'], fallbackSequence: [] },
      { id: 25, category: 'shortcuts', title: '撤销', description: '', keywords: ['撤销', 'undo'], elementTypes: [], actionSequence: ['press_keys:Ctrl+Z'], fallbackSequence: [] },
      { id: 27, category: 'shortcuts', title: '保存', description: '', keywords: ['保存', 'save'], elementTypes: [], actionSequence: ['press_keys:Ctrl+S'], fallbackSequence: [] },
      { id: 28, category: 'shortcuts', title: '新建', description: '', keywords: ['新建', 'new'], elementTypes: [], actionSequence: ['press_keys:Ctrl+N'], fallbackSequence: [] },
      { id: 29, category: 'shortcuts', title: '打开', description: '', keywords: ['打开', 'open'], elementTypes: [], actionSequence: ['press_keys:Ctrl+O'], fallbackSequence: [] },
      { id: 31, category: 'shortcuts', title: '查找', description: '', keywords: ['查找', 'find'], elementTypes: ['TEXT_BOX'], actionSequence: ['press_keys:Ctrl+F', 'type_text'], fallbackSequence: [] },
      { id: 35, category: 'shortcuts', title: '运行', description: '', keywords: ['运行', 'run'], elementTypes: ['TEXT_BOX'], actionSequence: ['press_keys:Win+R', 'type_text'], fallbackSequence: [] },
      { id: 36, category: 'shortcuts', title: '资源管理器', description: '', keywords: ['文件管理', 'explorer'], elementTypes: [], actionSequence: ['press_keys:Win+E'], fallbackSequence: [] },
      { id: 37, category: 'shortcuts', title: '设置', description: '', keywords: ['设置', 'settings'], elementTypes: [], actionSequence: ['press_keys:Win+I'], fallbackSequence: [] },
      { id: 38, category: 'shortcuts', title: '桌面', description: '', keywords: ['桌面', 'desktop'], elementTypes: [], actionSequence: ['press_keys:Win+D'], fallbackSequence: [] },
      { id: 39, category: 'fileOperations', title: '创建文件夹', description: '', keywords: ['创建文件夹', '新建文件夹'], elementTypes: [], actionSequence: ['press_keys:Ctrl+Shift+N'], fallbackSequence: [] },
      { id: 40, category: 'fileOperations', title: '重命名', description: '', keywords: ['重命名', 'rename'], elementTypes: ['TEXT_BOX'], actionSequence: ['press_keys:F2', 'type_text', 'press_keys:Enter'], fallbackSequence: [] },
      { id: 41, category: 'fileOperations', title: '删除文件', description: '', keywords: ['删除', 'delete'], elementTypes: [], actionSequence: ['press_keys:Delete'], fallbackSequence: [] }
    ]
  }

  /**
   * 根据用户意图匹配常识规则
   */
  matchIntent(intent: string): { rule: CommonKnowledgeRule | null; confidence: number; matchedKeywords: string[] } {
    if (this.rules.length === 0) {
      this.loadCommonRules()
    }

    const intentLower = intent.toLowerCase()
    let bestMatch: { rule: CommonKnowledgeRule; confidence: number; matchedKeywords: string[] } | null = null

    for (const rule of this.rules) {
      const matchedKeywords: string[] = []
      let score = 0

      for (const keyword of rule.keywords) {
        if (intentLower.includes(keyword.toLowerCase())) {
          matchedKeywords.push(keyword)
          // 越长的关键词匹配越有价值
          score += keyword.length * 2
        }
      }

      // 也检查标题匹配
      if (intentLower.includes(rule.title.toLowerCase())) {
        score += 20
        matchedKeywords.push(rule.title)
      }

      if (score > 0 && (!bestMatch || score > bestMatch.confidence)) {
        // 标准化置信度到 0-1
        const confidence = Math.min(1.0, score / 100)
        bestMatch = { rule, confidence, matchedKeywords }
      }
    }

    if (bestMatch) {
      return bestMatch
    }

    return { rule: null, confidence: 0, matchedKeywords: [] }
  }

  /**
   * 基于匹配的规则生成操作计划
   */
  generateActionPlan(rule: CommonKnowledgeRule, task: VisualTask): ActionPlan {
    const steps: VisualStep[] = rule.actionSequence.map((action, index) => ({
      id: `step-${task.id}-${index}`,
      action,
      target: task.target,
      status: 'pending' as const,
      beforeScreenshot: null,
      afterScreenshot: null,
      duration: 0
    }))

    const fallbackSteps: VisualStep[] = rule.fallbackSequence.map((action, index) => ({
      id: `fallback-${task.id}-${index}`,
      action,
      target: task.target,
      status: 'pending' as const,
      beforeScreenshot: null,
      afterScreenshot: null,
      duration: 0
    }))

    return {
      steps,
      estimatedTime: steps.length * 2000,
      fallbackSteps
    }
  }
}

export const stateTracker = new StateTracker()
