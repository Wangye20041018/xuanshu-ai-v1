/**
 * SkillPackLearner — 技能包自动沉淀模块
 *
 * 玄枢越用越熟：每次视觉操控成功执行后，从中提取操作模式，
 * 自动生成学习型技能包，持久化到本地。
 * 多次针对同一应用的操作会自动合并，完善技能包知识。
 */
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import type { SkillPack } from './types'
import { skillPackManager } from './index'
import { logger } from '../../shared/logger'
import { addMemorySync } from '../ipc/memory.ipc'
import { vectorStore } from '../rag/vector-store'
import { getEmbedding, splitText } from '../rag/embedding'

interface LearnedSkillPackMeta {
  /** 学习型技能包 ID，如 'learned.wps.001' */
  id: string
  /** 目标应用名 */
  app: string
  /** 应用匹配关键词（从窗口标题/意图提取） */
  appMatch: string[]
  /** 能力数量 */
  actionCount: number
  /** 学习次数（合并次数） */
  learnCount: number
  /** 首次学习时间 */
  createdAt: string
  /** 最近学习时间 */
  updatedAt: string
  /** 是否启用 */
  enabled: boolean
}

const LEARNED_DIR = 'skill-packs/learned'

function getLearnedDir(): string {
  const dir = join(app.getPath('userData'), LEARNED_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function getMetaPath(): string {
  return join(getLearnedDir(), 'meta.json')
}

function loadMeta(): LearnedSkillPackMeta[] {
  try {
    const p = getMetaPath()
    if (!existsSync(p)) return []
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch { return [] }
}

function saveMeta(meta: LearnedSkillPackMeta[]): void {
  writeFileSync(getMetaPath(), JSON.stringify(meta, null, 2), 'utf-8')
}

function getPackPath(id: string): string {
  return join(getLearnedDir(), `${id}.json`)
}

/**
 * 从意图文本中提取应用关键词（去停用词、取有意义的词干）
 */
function extractAppKeywords(intent: string, windowTitle: string): string[] {
  const tokens = new Set<string>()
  // 从窗口标题提取
  if (windowTitle) {
    const parts = windowTitle.split(/[-\s—–_|]+/)
    parts.forEach(p => { if (p.length >= 2 && p.length <= 20) tokens.add(p.trim()) })
  }
  // 从意图提取常见应用名
  const appKeywords = ['WPS', 'wps', 'WPP', 'wpp', 'Word', 'word', 'Excel', 'excel',
    'PPT', 'ppt', '微信', 'WeChat', 'wechat', '浏览器', 'chrome', 'Chrome',
    'edge', 'Edge', 'Firefox', 'firefox', 'QQ', 'qq', '钉钉', '飞书', '企业微信']
  for (const kw of appKeywords) {
    if (intent.includes(kw)) tokens.add(kw)
  }
  return Array.from(tokens).slice(0, 5)
}

/**
 * 从 VisualStep 序列提取 hints
 */
function extractHintsFromSteps(steps: any[]): string[] {
  const hints: string[] = []
  for (const s of steps) {
    if (s.action && s.target) {
      hints.push(`执行操作：${s.action} 于 ${s.target}`)
    }
  }
  return hints
}

/**
 * 从意图文本提取关键词作为 match 词
 */
function extractKeywords(intent: string): string[] {
  const words = intent.split(/[\s,，。、；：；！？!?]+/)
  return words.filter(w => w.length >= 2).slice(0, 8)
}

/**
 * 学习：根据执行成功的 intent + steps 自动生成/合并技能包
 */
export function learnFromExecution(
  intent: string,
  steps: any[],
  windowTitle: string,
  appName?: string
): { packId: string; isNew: boolean } | null {
  if (!steps || steps.length === 0) return null
  const appKeywords = extractAppKeywords(intent, windowTitle)
  const app = appName || appKeywords[0] || '未知应用'
  const intents = extractKeywords(intent)
  const hints = extractHintsFromSteps(steps)

  // 加载已有元数据，查找同应用的已有技能包
  const meta = loadMeta()
  const existing = meta.find(m => {
    const match = m.appMatch.some(k => appKeywords.includes(k) || app.includes(k))
    return match && m.enabled
  })

  if (existing) {
    // 合并：追加 hints 和关键词
    try {
      const p = getPackPath(existing.id)
      if (existsSync(p)) {
        const pack: SkillPack = JSON.parse(readFileSync(p, 'utf-8'))
        // 追加 hints 到已有动作
        for (const action of pack.actions) {
          const newHints = hints.filter(h => !action.hints.includes(h))
          if (newHints.length > 0) action.hints.push(...newHints)
          // 追加关键词
          const newKws = intents.filter(k => !action.keywords.includes(k))
          if (newKws.length > 0) action.keywords.push(...newKws)
        }
        // 新增动作（如果意图明显不同）
        if (!pack.actions.some(a => a.keywords.some(k => intents.includes(k)))) {
          pack.actions.push({
            id: `${pack.id}.learned.${Date.now()}`,
            name: `从操作学习: ${intent.slice(0, 30)}`,
            description: `自动学习：${intent}`,
            keywords: intents,
            hints: hints,
          })
        }
        writeFileSync(p, JSON.stringify(pack, null, 2), 'utf-8')
        existing.learnCount++
        existing.updatedAt = new Date().toISOString()
        existing.actionCount = pack.actions.length
        saveMeta(meta)
        // 重新注册到内存管理器
        registerLearnedPack(pack)
        logger.info(`[SkillPack·学习] 合并技能包: ${existing.id}（第${existing.learnCount}次学习）`)
        persistExperienceMemory(intent, steps, app, existing.id)
        return { packId: existing.id, isNew: false }
      }
    } catch (e) {
      logger.warn(`[SkillPack·学习] 合并失败: ${e}，将新建`)
    }
  }

  // 新建技能包
  const packId = `learned.${app.replace(/[^a-zA-Z0-9_\u4e00-\u9fff]/g, '')}.${Date.now().toString(36)}`
  const actionId = `${packId}.act.001`
  const pack: SkillPack = {
    id: packId,
    app,
    appMatch: appKeywords.length > 0 ? appKeywords : [app],
    version: '1.0.0-learned',
    actions: [{
      id: actionId,
      name: `从操作学习: ${intent.slice(0, 30)}`,
      description: `自动学习自意图：${intent}`,
      keywords: intents,
      hints: hints,
    }],
  }

  writeFileSync(getPackPath(packId), JSON.stringify(pack, null, 2), 'utf-8')
  const newMeta: LearnedSkillPackMeta = {
    id: packId,
    app,
    appMatch: pack.appMatch,
    actionCount: 1,
    learnCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    enabled: true,
  }
  meta.push(newMeta)
  saveMeta(meta)
  registerLearnedPack(pack)
  logger.info(`[SkillPack·学习] 新建技能包: ${packId}（${app}）`)
  persistExperienceMemory(intent, steps, app, packId)
  return { packId, isNew: true }
}

function registerLearnedPack(pack: SkillPack): void {
  try {
    skillPackManager.register(pack)
  } catch {
    // 已存在则跳过
  }
}

/**
 * #25 经验分支：学习成功后同步沉淀 experience 记忆
 * 1) 写 memories.db（type=experience，主记忆库，记忆页可查）
 * 2) 异步写向量库（type=experience，供 RAG search-memory 检索参与上下文注入）
 * 走外置记忆，不碰模型权重，零坍缩风险；向量写入失败不影响主记忆落地。
 */
export function persistExperienceMemory(
  intent: string,
  steps: any[],
  app: string,
  packId: string
): void {
  if (!intent || !steps || steps.length === 0) return
  try {
    const stepSummary = steps
      .map((s: any) => `${s.action || '操作'}@${s.target || s.window || '当前窗口'}`)
      .slice(0, 12)
      .join('；')
    const content = `在「${app}」中学会了执行「${intent.slice(0, 120)}」：${stepSummary}`
    const mem = addMemorySync({
      content,
      type: 'experience',
      tags: ['经验学习', app, packId].filter(Boolean),
    })
    logger.info(`[SkillPack·学习] 已沉淀经验记忆: ${mem.id} (${app})`)
    // 向量库异步写入（embedding 较慢，不阻塞学习主流程）
    void (async () => {
      try {
        const { embedding } = await getEmbedding(content)
        const chunks = splitText(content)
        for (const chunk of chunks) {
          vectorStore.add(
            `experience-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
            chunk,
            embedding,
            { type: 'experience', tags: ['经验学习', app, packId], timestamp: Date.now(), memoryId: mem.id }
          )
        }
        logger.info(`[SkillPack·学习] 经验记忆已写入向量库 (${app})`)
      } catch (e) {
        logger.warn(`[SkillPack·学习] 经验向量写入失败（不影响主记忆）: ${e}`)
      }
    })()
  } catch (e) {
    logger.warn(`[SkillPack·学习] 经验记忆沉淀失败: ${e}`)
  }
}

/**
 * 加载所有已持久化的学习型技能包到内存管理器
 */
export function loadAllLearnedPacks(): void {
  const dir = getLearnedDir()
  if (!existsSync(dir)) return
  const meta = loadMeta()
  for (const m of meta) {
    if (!m.enabled) continue
    const p = getPackPath(m.id)
    if (!existsSync(p)) continue
    try {
      const pack: SkillPack = JSON.parse(readFileSync(p, 'utf-8'))
      registerLearnedPack(pack)
    } catch (e) {
      logger.warn(`[SkillPack·学习] 加载失败: ${m.id} - ${e}`)
    }
  }
  logger.info(`[SkillPack·学习] 已加载 ${meta.filter(m => m.enabled).length} 个学习型技能包`)
}

/**
 * 获取所有学习型技能包的元数据
 */
export function getLearnedPacksMeta(): LearnedSkillPackMeta[] {
  return loadMeta()
}

/**
 * 删除学习型技能包
 */
export function removeLearnedPack(packId: string): boolean {
  const meta = loadMeta()
  const idx = meta.findIndex(m => m.id === packId)
  if (idx === -1) return false
  const p = getPackPath(packId)
  try {
    if (existsSync(p)) unlinkSync(p)
    meta.splice(idx, 1)
    saveMeta(meta)
    logger.info(`[SkillPack·学习] 已删除技能包: ${packId}`)
    return true
  } catch (e) {
    logger.warn(`[SkillPack·学习] 删除失败: ${packId} - ${e}`)
    return false
  }
}

/**
 * 设置学习型技能包启用/禁用
 */
export function setLearnedPackEnabled(packId: string, enabled: boolean): boolean {
  const meta = loadMeta()
  const m = meta.find(m => m.id === packId)
  if (!m) return false
  m.enabled = enabled
  m.updatedAt = new Date().toISOString()
  saveMeta(meta)
  // 重新加载到内存
  const p = getPackPath(packId)
  if (existsSync(p) && enabled) {
    try {
      const pack: SkillPack = JSON.parse(readFileSync(p, 'utf-8'))
      registerLearnedPack(pack)
    } catch {}
  }
  logger.info(`[SkillPack·学习] 技能包 ${packId} 已${enabled ? '启用' : '禁用'}`)
  return true
}