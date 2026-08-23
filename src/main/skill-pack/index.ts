/**
 * SkillPackManager — 应用技能包管理器
 *
 * 技能包 = 特定应用的专属操控知识库。管理器负责：
 *  - 技能包注册（内建 + 未来可扩展外部加载）
 *  - 意图匹配（关键词打分，命中应用关键词加权）
 *  - IPC 暴露：列出 / 匹配 / 执行
 *
 * 设计哲学：玄枢越用越熟。每次成功操控一个应用，都可沉淀为新技能包；
 * 高频应用（WPS/浏览器/微信）由内建技能包先行覆盖。
 */
import { ipcMain } from 'electron'
import type { SkillPack, SkillMatchResult, SkillExecuteParams } from './types'
import { wpsSkillPack } from './packs/wps'
import { browserSkillPack } from './packs/browser'
import { wechatSkillPack } from './packs/wechat'
import { systemSkillPack } from './packs/system'
import { executeSkillIntent } from './executor'
import { loadAllLearnedPacks, getLearnedPacksMeta, removeLearnedPack, setLearnedPackEnabled } from './learn'
import { logger } from '../../shared/logger'

/** 最低匹配得分阈值（低于则不视为命中，走通用操控） */
const MIN_MATCH_SCORE = 20

class SkillPackManager {
  private packs: Map<string, SkillPack> = new Map()

  register(pack: SkillPack): void {
    this.packs.set(pack.id, pack)
    logger.debug(`[SkillPack] 注册技能包: ${pack.id}（${pack.app}，${pack.actions.length} 项能力）`)
  }

  list(): SkillPack[] {
    return Array.from(this.packs.values())
  }

  getAction(packId: string, actionId: string): SkillPack['actions'][number] | null {
    const pack = this.packs.get(packId)
    if (!pack) return null
    return pack.actions.find(a => a.id === actionId) || null
  }

  /**
   * 意图匹配：遍历所有技能包能力的关键词，取最高分。
   * 评分规则：关键词长度 *5（最长覆盖意图的关键词得分高）；
   * 意图同时命中应用名（appMatch）再 +30，避免"发文件"被浏览器/微信同时误中。
   */
  match(intent: string): SkillMatchResult | null {
    const text = intent || ''
    if (!text) return null

    let best: SkillMatchResult | null = null
    for (const pack of this.packs.values()) {
      const appHit = pack.appMatch.some(m => text.includes(m))
      for (const action of pack.actions) {
        for (const kw of action.keywords) {
          if (!text.includes(kw)) continue
          let score = Math.min(kw.length * 5, 60)
          if (appHit) score += 30
          if (!best || score > best.score) {
            best = { pack, action, score, matchedKeyword: kw }
          }
        }
      }
    }
    return best && best.score >= MIN_MATCH_SCORE ? best : null
  }
}

export const skillPackManager = new SkillPackManager()

/**
 * 注册 IPC 通道（在 ipc.register.ts 的 setupAllIpcHandlers 中调用）
 */
export function setupSkillPackHandlers(): void {
  try {
    // 注册内建技能包
    skillPackManager.register(wpsSkillPack)
    skillPackManager.register(browserSkillPack)
    skillPackManager.register(wechatSkillPack)
    skillPackManager.register(systemSkillPack)
  } catch (e) {
    logger.warn(`[SkillPack] 内建技能包注册失败: ${e}`)
  }

  // 列出全部技能包（渲染层展示用）
  ipcMain.handle('skill-pack:list', () => {
    return skillPackManager.list().map(p => ({
      id: p.id,
      app: p.app,
      version: p.version,
      actions: p.actions.map(a => ({
        id: a.id,
        name: a.name,
        description: a.description,
      })),
    }))
  })

  // 意图匹配（渲染层预览/调试用）
  ipcMain.handle('skill-pack:match', (_e, intent: string) => {
    const match = skillPackManager.match(intent || '')
    if (!match) return null
    return {
      packId: match.pack.id,
      app: match.pack.app,
      actionId: match.action.id,
      name: match.action.name,
      score: match.score,
      matchedKeyword: match.matchedKeyword,
    }
  })

  // 执行操控意图（注入技能包知识后走 visual-agent 闭环）
  ipcMain.handle('skill-pack:execute', async (_e, intent: string, params?: SkillExecuteParams) => {
    try {
      return await executeSkillIntent(intent || '', params)
    } catch (e: any) {
      logger.error(`[SkillPack] 执行失败: ${e}`)
      return { success: false, steps: [], error: String(e), summary: '' }
    }
  })

  // 列出所有学习型技能包（自动沉淀）
  ipcMain.handle('skill-pack:learned-list', () => {
    return getLearnedPacksMeta()
  })

  // 删除学习型技能包
  ipcMain.handle('skill-pack:learned-remove', (_e, packId: string) => {
    return { success: removeLearnedPack(packId) }
  })

  // 启用/禁用学习型技能包
  ipcMain.handle('skill-pack:learned-set-enabled', (_e, packId: string, enabled: boolean) => {
    return { success: setLearnedPackEnabled(packId, enabled) }
  })
}

// 启动时加载已持久化的学习型技能包
export function loadLearnedSkillPacks(): void {
  try {
    loadAllLearnedPacks()
  } catch (e) {
    logger.warn(`[SkillPack] 加载学习型技能包失败: ${e}`)
  }
}
