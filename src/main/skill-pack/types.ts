/**
 * SkillPack — 应用技能包类型定义
 *
 * 技能包 = 特定应用的专属操控知识（能力清单 + 操作提示 + 快捷键 + 验证要点），
 * 注入 visual-agent 决策链路，让玄枢操控特定应用时更精准、更像"用熟了的人"。
 * 玄枢越用越熟：一个应用被成功操控多次后，可把套路固化为技能包。
 */

/** 单个能力定义 */
export interface SkillPackAction {
  /** 能力 ID，如 'wps.create_presentation' */
  id: string
  /** 能力名称，如 '新建演示文稿' */
  name: string
  /** 能力描述（用于意图匹配与展示） */
  description: string
  /** 触发关键词（意图匹配用，含中英文变体） */
  keywords: string[]
  /** 专属操作提示：注入决策链路的"用熟了的人才知道"的知识 */
  hints: string[]
  /** 常用快捷键（可选） */
  shortcuts?: string[]
  /** 验证提示：操作完成后如何确认成功 */
  verifyHint?: string
}

/** 应用技能包定义 */
export interface SkillPack {
  /** 技能包 ID，如 'wps.office' */
  id: string
  /** 应用名称 */
  app: string
  /** 窗口/进程匹配关键词 */
  appMatch: string[]
  /** 技能包版本 */
  version: string
  /** 能力清单 */
  actions: SkillPackAction[]
}

/** 意图匹配结果 */
export interface SkillMatchResult {
  pack: SkillPack
  action: SkillPackAction
  /** 匹配得分 0-100 */
  score: number
  /** 命中关键词 */
  matchedKeyword: string
}

/** 执行参数（可扩展） */
export interface SkillExecuteParams {
  /** 附加上下文（如文本内容、文件路径） */
  extra?: Record<string, string>
}
