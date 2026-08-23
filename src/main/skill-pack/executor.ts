/**
 * SkillPackExecutor — 技能包执行器
 *
 * 职责：意图 → 技能包匹配 → 注入专属知识 → 交给 visual-agent 闭环执行。
 * 技能包不替代视觉操控闭环，而是给主模型决策"加料"：
 * 用熟了的人才知道的快捷键、菜单路径、易错点、验证要点。
 */
import { visualAgent } from '../visual-agent'
import { skillPackManager } from './index'
import { learnFromExecution } from './learn'
import type { SkillExecuteParams, SkillMatchResult } from './types'
import { logger } from '../../shared/logger'

/** 将技能包专属知识格式化为注入决策链路的提示块 */
function buildKnowledgeBlock(match: SkillMatchResult): string {
  const lines: string[] = []
  lines.push('【应用技能包·专属操作提示】')
  lines.push(`目标应用：${match.pack.app}`)
  lines.push(`当前能力：${match.action.name}`)
  lines.push('')
  for (const hint of match.action.hints) {
    lines.push(`- ${hint}`)
  }
  if (match.action.shortcuts && match.action.shortcuts.length > 0) {
    lines.push('')
    lines.push('快捷键：')
    for (const sc of match.action.shortcuts) {
      lines.push(`- ${sc}`)
    }
  }
  if (match.action.verifyHint) {
    lines.push('')
    lines.push(`操作完成后的验证要点：${match.action.verifyHint}`)
  }
  lines.push('')
  lines.push('提示：优先使用上述专属知识完成操作；若界面与提示不符，请按屏幕实际情况灵活处理。')
  return lines.join('\n')
}

/** 生成增强后的意图文本（原始意图 + 专属知识块） */
export function buildEnhancedIntent(intent: string, match: SkillMatchResult): string {
  return `${intent}\n\n${buildKnowledgeBlock(match)}`
}

/**
 * 执行操控意图：有技能包则注入专属知识，无则走通用视觉操控
 * 执行成功后自动沉淀技能包（P2 越用越熟）
 */
export async function executeSkillIntent(intent: string, params?: SkillExecuteParams): Promise<any> {
  const match = skillPackManager.match(intent)
  const taskId = `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  if (!match) {
    logger.debug('[SkillPack] 无匹配技能包，走通用视觉操控')
    const result = await visualAgent.executeTask({ id: taskId, intent, maxSteps: 50 })
    maybeLearn(intent, result)
    return result
  }

  logger.info(`[SkillPack] 命中技能包 ${match.pack.id}/${match.action.id}（score=${match.score}, kw=${match.matchedKeyword}）`)
  const enhancedIntent = buildEnhancedIntent(intent, match)

  // 附加参数（如文本内容/文件路径）拼入意图，供决策引用
  const extraText = params?.extra
    ? Object.entries(params.extra).map(([k, v]) => `${k}：${v}`).join('；')
    : ''
  const finalIntent = extraText ? `${enhancedIntent}\n\n【任务参数】${extraText}` : enhancedIntent

  const result = await visualAgent.executeTask({ id: taskId, intent: finalIntent, maxSteps: 50 })
  maybeLearn(intent, result)
  return result
}

/** 执行成功后自动沉淀技能包（异步不阻塞） */
function maybeLearn(intent: string, result: any): void {
  try {
    if (result && result.success && result.steps && result.steps.length > 0) {
      learnFromExecution(intent, result.steps, result.windowTitle || '', result.targetApp || '')
    }
  } catch (e) {
    logger.debug(`[SkillPack·学习] 自动沉淀跳过: ${e}`)
  }
}
