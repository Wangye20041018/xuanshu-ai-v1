/**
 * context-fusion.ts — 情境融合（P3）
 *
 * 玄枢作为"电脑的魂"，主动感知当前前台应用并预加载对应技能包：
 * - 订阅感官总线 window 事件，识别前台应用
 * - 匹配技能包管理器，记录"当前窗口技能包上下文"
 * - 供上下文构建/决策链路查询，让玄枢"看人下菜碟"
 */
import { sensoryBus } from './sensory-bus'
import { skillPackManager } from '../skill-pack'
import { createLogger } from '../../shared/logger'

const logger = createLogger('ContextFusion')

interface FusionState {
  /** 当前前台窗口标题 */
  windowTitle: string
  /** 匹配到的技能包 ID（可能为空） */
  packId: string | null
  /** 技能包名称 */
  packApp: string | null
  /** 匹配时间 */
  matchedAt: number | null
}

class ContextFusion {
  private state: FusionState = {
    windowTitle: '',
    packId: null,
    packApp: null,
    matchedAt: null,
  }
  private unsub: (() => void) | null = null

  /** 启动情境融合（订阅窗口事件） */
  start(): void {
    if (this.unsub) return
    this.unsub = sensoryBus.subscribe((event) => {
      if (event.type !== 'window' || !event.payload?.app) return
      this.onWindowChange(String(event.payload.app))
    })
    logger.info('[ContextFusion] 情境融合已启动')
  }

  stop(): void {
    if (this.unsub) {
      this.unsub()
      this.unsub = null
    }
    logger.info('[ContextFusion] 情境融合已停止')
  }

  private onWindowChange(windowTitle: string): void {
    this.state.windowTitle = windowTitle

    // 匹配技能包：窗口标题命中应用关键词
    const packs = skillPackManager.list()
    let bestPack: string | null = null
    let bestApp: string | null = null
    for (const pack of packs) {
      if (pack.appMatch.some((kw) => windowTitle.includes(kw))) {
        bestPack = pack.id
        bestApp = pack.app
        break
      }
    }

    // 兜底：意图匹配（把窗口标题当意图试一把，常见应用名可命中）
    if (!bestPack) {
      const match = skillPackManager.match(windowTitle)
      if (match) {
        bestPack = match.pack.id
        bestApp = match.pack.app
      }
    }

    this.state.packId = bestPack
    this.state.packApp = bestApp
    this.state.matchedAt = Date.now()

    if (bestPack) {
      logger.debug(`[ContextFusion] 前台「${windowTitle}」→ 技能包 ${bestPack}（${bestApp}）`)
    }
  }

  /** 当前情境融合状态（渲染层/上下文构建用） */
  getState(): FusionState {
    return { ...this.state }
  }

  /** 当前窗口对应的技能包知识块（注入决策链路） */
  getCurrentPackContext(): string {
    const { packId, packApp, windowTitle } = this.state
    if (!packId || !packApp) return ''
    const pack = skillPackManager.list().find((p) => p.id === packId)
    if (!pack) return ''
    const actionNames = pack.actions.map((a) => `- ${a.name}`).slice(0, 10).join('\n')
    return [
      '【情境融合·当前应用技能包】',
      `当前前台应用：${packApp}`,
      `窗口：${windowTitle}`,
      '该应用已沉淀以下专属操控能力：',
      actionNames,
      '执行操控任务时，优先引用对应能力的快捷键/菜单路径与验证要点。',
    ].join('\n')
  }
}

export const contextFusion = new ContextFusion()
