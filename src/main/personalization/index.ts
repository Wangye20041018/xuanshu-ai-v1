import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { logger } from '../../shared/logger'

interface UserPreference {
  id: string
  category: 'conversation' | 'operation' | 'interface' | 'voice'
  key: string
  value: any
  confidence: number
  lastUpdated: number
}

interface UserHabit {
  frequentTasks: Array<{ task: string; count: number; lastUsed: number }>
  frequentCommands: Array<{ command: string; count: number; lastUsed: number }>
  conversationStyle: 'formal' | 'casual' | 'humorous' | 'concise'
  responseLength: 'short' | 'medium' | 'long'
  preferredTimeSlots: Array<{ start: number; end: number; count: number }>
}

interface Persona {
  name: string
  avatar: string
  description: string
  personality: {
    friendly: number
    professional: number
    humorous: number
    patient: number
  }
  greeting: string
  farewell: string
}

class Personalization {
  private preferences: Map<string, UserPreference> = new Map()
  private habits: UserHabit
  private personas: Map<string, Persona> = new Map()
  private currentPersonaId: string = 'default'
  private dataDir: string | null = null
  private learningEnabled: boolean = true
  private analysisInterval: ReturnType<typeof setInterval> | null = null
  private initialized: boolean = false

  constructor() {
    this.habits = this.initHabits()
    // 延迟初始化，等待 app ready
  }

  initialize(): void {
    if (this.initialized) return
    this.dataDir = join(app.getPath('userData'), 'personalization')
    mkdirSync(this.dataDir, { recursive: true })
    this.loadData()
    this.registerDefaultPersonas()
    this.startLearning()
    this.initialized = true
  }

  private getDataDir(): string {
    if (!this.dataDir) {
      this.initialize()
    }
    return this.dataDir!
  }

  private initHabits(): UserHabit {
    return {
      frequentTasks: [],
      frequentCommands: [],
      conversationStyle: 'casual',
      responseLength: 'medium',
      preferredTimeSlots: []
    }
  }

  private loadData(): void {
    const dataDir = this.getDataDir()
    const prefsFile = join(dataDir, 'preferences.json')
    if (existsSync(prefsFile)) {
      try {
        const data = JSON.parse(readFileSync(prefsFile, 'utf-8'))
        data.forEach((pref: UserPreference) => {
          this.preferences.set(pref.id, pref)
        })
      } catch (e) { logger.error('[Personalization] 加载偏好文件失败:', e) }
    }

    const habitsFile = join(dataDir, 'habits.json')
    if (existsSync(habitsFile)) {
      try {
        this.habits = { ...this.habits, ...JSON.parse(readFileSync(habitsFile, 'utf-8')) }
      } catch (e) { logger.error('[Personalization] 加载习惯文件失败:', e) }
    }
  }

  private saveData(): void {
    const dataDir = this.getDataDir()
    const prefsFile = join(dataDir, 'preferences.json')
    writeFileSync(prefsFile, JSON.stringify(Array.from(this.preferences.values()), null, 2))

    const habitsFile = join(dataDir, 'habits.json')
    writeFileSync(habitsFile, JSON.stringify(this.habits, null, 2))
  }

  private registerDefaultPersonas(): void {
    const defaultPersonas: Persona[] = [
      {
        name: '玄枢小助手',
        avatar: 'assistant_default',
        description: '默认助手形象，友好热情',
        personality: { friendly: 0.9, professional: 0.7, humorous: 0.6, patient: 0.9 },
        greeting: '你好！我是玄枢，很高兴为你服务',
        farewell: '再见！有什么需要随时叫我'
      },
      {
        name: '专业顾问',
        avatar: 'assistant_professional',
        description: '专业严谨的助手形象',
        personality: { friendly: 0.6, professional: 0.95, humorous: 0.3, patient: 0.8 },
        greeting: '您好，我是您的专业助手',
        farewell: '本次服务结束，祝您工作顺利'
      },
      {
        name: '幽默伙伴',
        avatar: 'assistant_humorous',
        description: '轻松幽默的助手形象',
        personality: { friendly: 0.95, professional: 0.5, humorous: 0.9, patient: 0.7 },
        greeting: '嘿！我是你的开心果助手',
        farewell: '哈哈，拜拜啦！记得想我哦'
      },
      {
        name: '高效助手',
        avatar: 'assistant_efficient',
        description: '简洁高效的助手形象',
        personality: { friendly: 0.7, professional: 0.85, humorous: 0.4, patient: 0.6 },
        greeting: '你好，请说',
        farewell: '完成'
      }
    ]

    defaultPersonas.forEach(p => {
      this.personas.set(p.name, p)
    })
  }

  learnFromInteraction(data: {
    type: 'task' | 'command' | 'conversation'
    content: string
    timestamp?: number
  }): void {
    if (!this.learningEnabled) return

    const timestamp = data.timestamp || Date.now()
    const hour = new Date(timestamp).getHours()

    switch (data.type) {
      case 'task':
        this.learnTask(data.content, timestamp)
        break
      case 'command':
        this.learnCommand(data.content, timestamp)
        break
      case 'conversation':
        this.learnConversation(data.content, timestamp)
        break
    }

    const slot = this.habits.preferredTimeSlots.find(
      s => hour >= s.start && hour < s.end
    )
    if (slot) {
      slot.count++
    } else {
      this.habits.preferredTimeSlots.push({ start: hour, end: hour + 1, count: 1 })
    }

    this.saveData()
  }

  private learnTask(task: string, timestamp: number): void {
    const existing = this.habits.frequentTasks.find(t => t.task === task)
    if (existing) {
      existing.count++
      existing.lastUsed = timestamp
    } else {
      this.habits.frequentTasks.push({ task, count: 1, lastUsed: timestamp })
    }

    this.habits.frequentTasks.sort((a, b) => b.count - a.count)
    if (this.habits.frequentTasks.length > 50) {
      this.habits.frequentTasks = this.habits.frequentTasks.slice(0, 50)
    }
  }

  private learnCommand(command: string, timestamp: number): void {
    const existing = this.habits.frequentCommands.find(c => c.command === command)
    if (existing) {
      existing.count++
      existing.lastUsed = timestamp
    } else {
      this.habits.frequentCommands.push({ command, count: 1, lastUsed: timestamp })
    }

    this.habits.frequentCommands.sort((a, b) => b.count - a.count)
    if (this.habits.frequentCommands.length > 100) {
      this.habits.frequentCommands = this.habits.frequentCommands.slice(0, 100)
    }
  }

  // @ts-expect-error TS6133 - retained for record type consistency
  private learnConversation(content: string, timestamp: number): void {
    // 多特征加权判定对话风格，避免单个字符误判
    let casualScore = 0
    let formalScore = 0

    // 随意特征：感叹号、笑声、波浪线、口语化词汇、表情符号类
    const casualCount = (content.match(/[！!]/g) || []).length
    casualScore += Math.min(casualCount, 5) * 2

    const emojiCount = (content.match(/[～~^_^＞▽＜♪]/g) || []).length
    casualScore += Math.min(emojiCount, 5) * 3

    if (content.includes('哈哈') || content.includes('呵呵') || content.includes('嘿嘿') || content.includes('嘻嘻')) {
      casualScore += 8
    }

    const casualWords = ['嗯', '哦', '啊', '吧', '嘛', '呢', '呗', '好嘞', '行吧', 'ok', 'okk', '好的呀', '没问题']
    for (const w of casualWords) {
      if (content.includes(w)) casualScore += 2
    }

    if (/^[a-zA-Z\s!~^_^]+$/.test(content.trim()) && content.length < 30) {
      casualScore += 5
    }

    // 正式特征：敬语、专业词汇、长句结构
    if (content.includes('请') || content.includes('感谢') || content.includes('谢谢') || content.includes('麻烦')) {
      formalScore += 5
    }

    const formalWords = ['专业', '按照', '根据', '需要', '建议', '方案', '确认', '咨询', '请教', '报告', '分析', '汇报']
    for (const w of formalWords) {
      if (content.includes(w)) formalScore += 2
    }

    if (content.length > 100) formalScore += 3
    if (content.length > 200) formalScore += 3

    // 综合判定：差距足够大时切换，否则保留原有风格
    const diff = casualScore - formalScore
    if (diff > 10) {
      this.habits.conversationStyle = 'casual'
    } else if (diff < -10) {
      this.habits.conversationStyle = 'formal'
    }
    // 其余情况保留当前风格，不因微弱信号切换

    if (content.length > 200) {
      this.habits.responseLength = 'long'
    } else if (content.length > 50) {
      this.habits.responseLength = 'medium'
    } else {
      this.habits.responseLength = 'short'
    }
  }

  private startLearning(): void {
    this.analysisInterval = setInterval(() => {
      this.analyzeAndAdapt()
    }, 60000)
  }

  private analyzeAndAdapt(): void {
    if (this.habits.frequentTasks.length > 0) {
      const topTask = this.habits.frequentTasks[0]
      const confidence = Math.min(topTask.count / 10, 1)
      this.setPreference('operation', 'suggested_task', topTask.task, confidence)
    }
  }

  setPreference(category: UserPreference['category'], key: string, value: any, confidence: number = 1): void {
    const id = `${category}:${key}`
    this.preferences.set(id, {
      id,
      category,
      key,
      value,
      confidence,
      lastUpdated: Date.now()
    })
    this.saveData()
  }

  getPreference(category: UserPreference['category'], key: string): UserPreference | undefined {
    return this.preferences.get(`${category}:${key}`)
  }

  getPreferenceByCategory(category: UserPreference['category']): UserPreference[] {
    return Array.from(this.preferences.values()).filter(p => p.category === category)
  }

  getHabits(): UserHabit {
    return { ...this.habits }
  }

  getSuggestedTasks(limit: number = 5): string[] {
    const now = Date.now()
    const recentTasks = this.habits.frequentTasks
      .filter(t => now - t.lastUsed < 30 * 24 * 60 * 60 * 1000)
      .slice(0, limit)
    return recentTasks.map(t => t.task)
  }

  getSuggestedCommands(limit: number = 10): string[] {
    const now = Date.now()
    const recentCommands = this.habits.frequentCommands
      .filter(c => now - c.lastUsed < 7 * 24 * 60 * 60 * 1000)
      .slice(0, limit)
    return recentCommands.map(c => c.command)
  }

  getPersonas(): Persona[] {
    return Array.from(this.personas.values())
  }

  getPersona(name: string): Persona | undefined {
    return this.personas.get(name)
  }

  setCurrentPersona(name: string): boolean {
    if (this.personas.has(name)) {
      this.currentPersonaId = name
      const dataDir = this.getDataDir()
      const settingsFile = join(dataDir, 'current-persona.json')
      writeFileSync(settingsFile, JSON.stringify({ currentPersonaId: name }))
      return true
    }
    return false
  }

  getCurrentPersona(): Persona | undefined {
    return this.personas.get(this.currentPersonaId)
  }

  addCustomPersona(persona: Persona): boolean {
    if (this.personas.has(persona.name)) {
      return false
    }
    this.personas.set(persona.name, persona)
    return true
  }

  updatePersona(name: string, updates: Partial<Persona>): boolean {
    const persona = this.personas.get(name)
    if (!persona) return false

    this.personas.set(name, { ...persona, ...updates })
    return true
  }

  getAdaptationHints(): {
    conversationStyle: string
    responseLength: string
    suggestedTasks: string[]
    preferredTime: string
  } {
    const hour = new Date().getHours()
    let timeHint = '白天'
    if (hour >= 22 || hour < 6) timeHint = '深夜'
    else if (hour >= 18) timeHint = '傍晚'
    else if (hour >= 12) timeHint = '下午'
    else if (hour >= 6) timeHint = '早晨'

    return {
      conversationStyle: this.habits.conversationStyle,
      responseLength: this.habits.responseLength,
      suggestedTasks: this.getSuggestedTasks(3),
      preferredTime: timeHint
    }
  }

  setLearningEnabled(enabled: boolean): void {
    this.learningEnabled = enabled
  }

  isLearningEnabled(): boolean {
    return this.learningEnabled
  }

  resetLearningData(): void {
    this.preferences.clear()
    this.habits = this.initHabits()
    this.saveData()
  }

  exportData(): string {
    return JSON.stringify({
      preferences: Array.from(this.preferences.values()),
      habits: this.habits,
      currentPersonaId: this.currentPersonaId,
      customPersonas: Array.from(this.personas.values()).filter(p => !['玄枢小助手', '专业顾问', '幽默伙伴', '高效助手'].includes(p.name))
    }, null, 2)
  }

  importData(jsonData: string): boolean {
    try {
      const data = JSON.parse(jsonData)
      if (data.preferences) {
        this.preferences.clear()
        data.preferences.forEach((p: UserPreference) => {
          this.preferences.set(p.id, p)
        })
      }
      if (data.habits) this.habits = { ...this.habits, ...data.habits }
      if (data.currentPersonaId) this.currentPersonaId = data.currentPersonaId
      this.saveData()
      return true
    } catch (e) {
      logger.error('[Personalization] 导入数据失败:', e)
      return false
    }
  }

  shutdown(): void {
    if (this.analysisInterval) {
      clearInterval(this.analysisInterval)
    }
    this.saveData()
  }
}

export const personalization = new Personalization()

export function setupPersonalizationHandlers(): void {
  const { ipcMain } = require('electron')

  ipcMain.handle('personalization:learn', (_event: any, data: { type: string; content: string; timestamp?: number }) => {
    personalization.learnFromInteraction({ ...data, type: data.type as 'task' | 'command' | 'conversation' })
    return { success: true }
  })

  ipcMain.handle('personalization:get-preference', (_event: any, category: string, key: string) => {
    return personalization.getPreference(category as UserPreference['category'], key)
  })

  ipcMain.handle('personalization:set-preference', (_event: any, category: string, key: string, value: any, confidence?: number) => {
    personalization.setPreference(category as UserPreference['category'], key, value, confidence)
    return { success: true }
  })

  ipcMain.handle('personalization:get-habits', () => {
    return personalization.getHabits()
  })

  ipcMain.handle('personalization:get-suggested-tasks', (_event: any, limit?: number) => {
    return personalization.getSuggestedTasks(limit)
  })

  ipcMain.handle('personalization:get-suggested-commands', (_event: any, limit?: number) => {
    return personalization.getSuggestedCommands(limit)
  })

  ipcMain.handle('personalization:get-personas', () => {
    return personalization.getPersonas()
  })

  ipcMain.handle('personalization:get-persona', (_event: any, name: string) => {
    return personalization.getPersona(name)
  })

  ipcMain.handle('personalization:set-persona', (_event: any, name: string) => {
    return { success: personalization.setCurrentPersona(name) }
  })

  ipcMain.handle('personalization:get-current-persona', () => {
    return personalization.getCurrentPersona()
  })

  ipcMain.handle('personalization:add-persona', (_event: any, persona: Persona) => {
    return { success: personalization.addCustomPersona(persona) }
  })

  ipcMain.handle('personalization:update-persona', (_event: any, name: string, updates: Partial<Persona>) => {
    return { success: personalization.updatePersona(name, updates) }
  })

  ipcMain.handle('personalization:get-hints', () => {
    return personalization.getAdaptationHints()
  })

  ipcMain.handle('personalization:set-learning', (_event: any, enabled: boolean) => {
    personalization.setLearningEnabled(enabled)
    return { enabled: personalization.isLearningEnabled() }
  })

  ipcMain.handle('personalization:reset', () => {
    personalization.resetLearningData()
    return { success: true }
  })

  ipcMain.handle('personalization:export', () => {
    return personalization.exportData()
  })

  ipcMain.handle('personalization:import', (_event: any, jsonData: string) => {
    return { success: personalization.importData(jsonData) }
  })
}
