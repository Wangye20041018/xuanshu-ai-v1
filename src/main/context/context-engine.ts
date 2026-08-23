/**
 * context-engine.ts — 情境引擎 ContextEngine v1.0（情境感知层核心）
 *
 * 职责：
 * - 三层推理：信号层(感官事件) → 特征层(瞬时状态) → 情境层(语义情境)
 * - 情境 = 带置信度与时效的"信念"：事件持续喂入增强/衰减，超时自动降级
 * - 冲突仲裁：多感官矛盾时时间窗内多票表决 + 保守默认
 * - 四级状态机：瞬时事件 / 短期状态 / 中期会话 / 长期画像
 * - 主动性礼仪：打扰成本 = 情境严重度 × 置信度 × 用户当前负担 → 渐进式提醒通道
 * - 长期画像：作息规律/健康习惯/效率曲线（数字健康周报数据源）
 */

import { stateInference, StateSnapshot } from './state-inference'
import { SensoryChannel } from './sensory-bus'
import { systemSignals } from './system-signals'
import { createLogger } from '../../shared/logger'
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'

const logger = createLogger('ContextEngine')

/* ============================================================
 * 类型定义
 * ============================================================ */

export type ContextKey =
  | 'focused'        // 专注工作
  | 'fatigued'       // 疲惫
  | 'idle_away'      // 离开/待机
  | 'entertaining'   // 娱乐/看视频
  | 'deep_night'     // 深夜
  | 'visitor'        // 有访客/他人靠近
  | 'meeting'        // 会议/演讲
  | 'stressed'       // 压力/情绪低落
  | 'healthy'        // 健康状态良好（日常）

export type ContextTier = 'instant' | 'short' | 'session' | 'longterm'

export interface ContextBelief {
  key: ContextKey
  tier: ContextTier
  confidence: number
  severity: number        // 0-1 严重度（用于打扰成本）
  updatedAt: number
  sources: SensoryChannel[]
}

export interface ContextSnapshot {
  [key: string]: ContextBelief
}

/** 主动性档位 */
export type ProactivityLevel = 'quiet' | 'balanced' | 'active'

/** 提醒通道（渐进式） */
export type NotifyChannel = 'silent' | 'orb' | 'voice' | 'toast' | 'interrupt'

export interface AttentionDecision {
  context: ContextKey
  confidence: number
  cost: number             // 打扰成本 0-1
  channel: NotifyChannel
  message: string
  actionable: boolean
}

/** 长期画像（每日滚动） */
export interface LongTermProfile {
  day: string
  focusMinutes: number
  idleMinutes: number
  lateNightMinutes: number
  fatigueHits: number
  postureHits: number
  sittingLongHits: number
  videoMinutes: number
}

/** 数字健康周报（M4 深化：洞察而非监控） */
export interface WeeklyReport {
  days: Array<{
    day: string
    focusMinutes: number
    idleMinutes: number
    lateNightMinutes: number
    fatigueHits: number
    postureHits: number
    sittingLongHits: number
    videoMinutes: number
  }>
  totals: {
    focusMinutes: number
    idleMinutes: number
    lateNightMinutes: number
    fatigueHits: number
    postureHits: number
    sittingLongHits: number
    videoMinutes: number
  }
  avgFocusPerDay: number
  avgIdlePerDay: number
  insights: string[]
  suggestions: string[]
}

/* ============================================================
 * 情境引擎
 * ============================================================ */

const CONTEXT_DEFS: Record<ContextKey, { tier: ContextTier; severity: number; decayMs: number }> = {
  focused:      { tier: 'short',    severity: 0.1, decayMs: 60_000 },
  fatigued:     { tier: 'short',    severity: 0.6, decayMs: 5 * 60_000 },
  idle_away:    { tier: 'short',    severity: 0.2, decayMs: 5 * 60_000 },
  entertaining: { tier: 'session',  severity: 0.1, decayMs: 10 * 60_000 },
  deep_night:   { tier: 'session',  severity: 0.5, decayMs: 12 * 60_000 },
  visitor:      { tier: 'instant',  severity: 0.7, decayMs: 30_000 },
  meeting:      { tier: 'session',  severity: 0.3, decayMs: 30 * 60_000 },
  stressed:     { tier: 'short',    severity: 0.8, decayMs: 10 * 60_000 },
  healthy:      { tier: 'longterm', severity: 0.0, decayMs: 60 * 60_000 },
}

const CONTEXT_MESSAGES: Record<ContextKey, string> = {
  focused:      '',
  fatigued:     '老板，您看起来有些疲惫，休息两分钟喝口水吧',
  idle_away:    '',
  entertaining: '',
  deep_night:   '夜深了，注意休息，别熬太晚',
  visitor:      '好像有人靠近屏幕，注意隐私',
  meeting:      '',
  stressed:     '感觉您今天心情不太好，需要聊聊吗',
  healthy:      '',
}

const MAPPING: Array<{ context: ContextKey; from: string; weight: number }> = [
  { context: 'focused',      from: 'focus',          weight: 1.0 },
  { context: 'fatigued',     from: 'fatigue',        weight: 1.0 },
  { context: 'fatigued',     from: 'sleepy',         weight: 0.8 },
  { context: 'fatigued',     from: 'posture_bad',    weight: 0.3 },
  { context: 'idle_away',    from: 'absent',         weight: 1.0 },
  { context: 'entertaining', from: 'video_watching', weight: 1.0 },
  { context: 'deep_night',   from: 'late_night',     weight: 1.0 },
  { context: 'visitor',      from: 'peeping',        weight: 1.0 },
  { context: 'meeting',      from: 'speaking',       weight: 0.9 },
  { context: 'stressed',     from: 'emotion_down',   weight: 1.0 },
  { context: 'stressed',     from: 'fatigue',        weight: 0.2 },
  { context: 'healthy',      from: 'present',        weight: 0.1 },
]

export class ContextEngine {
  private contexts: Record<ContextKey, ContextBelief> = {} as Record<ContextKey, ContextBelief>
  private profile: LongTermProfile
  /** 历史画像归档（按 day 索引，M4 周报数据源） */
  private history: Map<string, LongTermProfile> = new Map()
  private historyFile: string
  private proactivity: ProactivityLevel = 'balanced'
  private lastAttentionAt: Record<ContextKey, number> = {} as Record<ContextKey, number>
  private attentionCallback: ((d: AttentionDecision) => void) | null = null
  private decayTimer: ReturnType<typeof setInterval> | null = null
  private dayRolloverAt: number = 0

  constructor() {
    const keys = Object.keys(CONTEXT_DEFS) as ContextKey[]
    for (const key of keys) {
      this.contexts[key] = {
        key, tier: CONTEXT_DEFS[key].tier,
        confidence: 0, severity: CONTEXT_DEFS[key].severity,
        updatedAt: 0, sources: [],
      }
    }
    // M4 长期画像：历史归档落盘于 userData，跨会话保留
    this.historyFile = join(app.getPath('userData'), 'profile-history.json')
    this.loadProfileHistory()
    this.profile = this.newProfile()
    this.dayRolloverAt = this.nextDayRollover()
  }

  /** 启动：订阅状态推理快照 + 衰减时钟 + 系统信号源 */
  start(onAttention?: (d: AttentionDecision) => void): void {
    this.attentionCallback = onAttention ?? null
    this.decayTimer = setInterval(() => this.tick(), 1500)
    systemSignals.start()
    logger.info('[ContextEngine] 已启动（含系统信号源）')
  }

  stop(): void {
    if (this.decayTimer) { clearInterval(this.decayTimer); this.decayTimer = null }
    systemSignals.stop()
    this.attentionCallback = null
    logger.info('[ContextEngine] 已停止')
  }

  setProactivity(level: ProactivityLevel): void {
    this.proactivity = level
    logger.info(`[ContextEngine] 主动性档位: ${level}`)
  }

  getProactivity(): ProactivityLevel {
    return this.proactivity
  }

  getSnapshot(): ContextSnapshot {
    return { ...this.contexts }
  }

  getProfile(): LongTermProfile {
    return { ...this.profile }
  }

  /* ==================== 周期融合（三层推理核心） ==================== */

  private tick(): void {
    const snap: StateSnapshot = stateInference.getSnapshot()
    const now = Date.now()

    // 处理日期翻转（长期画像滚动）
    if (now > this.dayRolloverAt) {
      this.rolloverProfile()
    }

    // 特征层 → 情境层：按映射加权融合
    const acc: Record<ContextKey, { sum: number; sources: SensoryChannel[]; updatedAt: number }> = {} as never
    for (const key of Object.keys(this.contexts) as ContextKey[]) {
      acc[key] = { sum: 0, sources: [], updatedAt: this.contexts[key].updatedAt }
    }

    for (const m of MAPPING) {
      const belief = snap[m.from]
      if (!belief || belief.confidence <= 0) continue
      const entry = acc[m.context]
      entry.sum += belief.confidence * m.weight
      entry.updatedAt = Math.max(entry.updatedAt, belief.updatedAt)
      for (const s of belief.sources) if (!entry.sources.includes(s)) entry.sources.push(s)
    }

    // 互斥仲裁：专注 与 娱乐/离开/访客 冲突时保守取低
    const focusing = acc['focused'].sum
    if (focusing > 0.4) {
      acc['entertaining'].sum *= 0.4
      acc['idle_away'].sum *= 0.3
    }
    if (acc['visitor'].sum > 0.6) {
      // 访客置信度高时压过专注（防窥优先）
      acc['focused'].sum *= 0.3
    }

    // 更新情境信念（置信度 + 时效）
    for (const key of Object.keys(this.contexts) as ContextKey[]) {
      const entry = acc[key]
      const def = CONTEXT_DEFS[key]
      const belief = this.contexts[key]
      if (entry.sum <= 0) {
        // 无证据：按衰减处理（在 decayAll 中）
        continue
      }
      const prev = belief.confidence
      belief.confidence = Math.min(1, prev * 0.6 + entry.sum * 0.4)
      belief.updatedAt = entry.updatedAt || now
      belief.sources = entry.sources
      belief.severity = def.severity
    }

    this.decayStale(now)
    this.updateProfile(snap)
    this.maybeAttention(now)
  }

  /** 超时自动降级（情境=带时效的信念） */
  private decayStale(now: number): void {
    for (const key of Object.keys(this.contexts) as ContextKey[]) {
      const belief = this.contexts[key]
      if (belief.confidence <= 0) continue
      const def = CONTEXT_DEFS[key]
      const elapsed = now - belief.updatedAt
      if (elapsed > def.decayMs) {
        belief.confidence = Math.max(0, belief.confidence - 0.08)
        if (belief.confidence <= 0.01) { belief.confidence = 0; belief.sources = [] }
      }
    }
  }

  /* ==================== 长期画像 ==================== */

  private newProfile(): LongTermProfile {
    const d = new Date()
    return {
      day: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      focusMinutes: 0, idleMinutes: 0, lateNightMinutes: 0,
      fatigueHits: 0, postureHits: 0, sittingLongHits: 0, videoMinutes: 0,
    }
  }

  private nextDayRollover(): number {
    const d = new Date()
    d.setHours(24, 0, 0, 0)
    return d.getTime()
  }

  /** 从 userData 加载历史画像归档 */
  private loadProfileHistory(): void {
    try {
      if (!existsSync(this.historyFile)) return
      const raw = JSON.parse(readFileSync(this.historyFile, 'utf-8'))
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (item && typeof item.day === 'string') {
            // 兼容旧版归档缺字段
            item.focusMinutes = item.focusMinutes ?? 0
            item.idleMinutes = item.idleMinutes ?? 0
            item.lateNightMinutes = item.lateNightMinutes ?? 0
            item.fatigueHits = item.fatigueHits ?? 0
            item.postureHits = item.postureHits ?? 0
            item.sittingLongHits = item.sittingLongHits ?? 0
            item.videoMinutes = item.videoMinutes ?? 0
            this.history.set(item.day, item)
          }
        }
        logger.info(`[ContextEngine] 已加载历史画像 ${this.history.size} 天`)
      }
    } catch (e: any) {
      logger.warn(`[ContextEngine] 加载历史画像失败: ${e.message}`)
    }
  }

  /** 保存历史画像归档（保留最近 14 天） */
  private saveProfileHistory(): void {
    try {
      const days = [...this.history.values()]
        .sort((a, b) => (a.day < b.day ? 1 : -1))
        .slice(0, 14)
      mkdirSync(dirname(this.historyFile), { recursive: true })
      writeFileSync(this.historyFile, JSON.stringify(days, null, 2), 'utf-8')
    } catch (e: any) {
      logger.warn(`[ContextEngine] 保存历史画像失败: ${e.message}`)
    }
  }

  private rolloverProfile(): void {
    // M4：当天画像归档到历史（若当天已有归档则合并最大值方向，防止同日多次滚动覆盖）
    const existing = this.history.get(this.profile.day)
    if (existing) {
      this.history.set(this.profile.day, {
        ...existing,
        focusMinutes: Math.max(existing.focusMinutes, this.profile.focusMinutes),
        idleMinutes: Math.max(existing.idleMinutes, this.profile.idleMinutes),
        lateNightMinutes: Math.max(existing.lateNightMinutes, this.profile.lateNightMinutes),
        fatigueHits: existing.fatigueHits + this.profile.fatigueHits,
        postureHits: existing.postureHits + this.profile.postureHits,
        sittingLongHits: existing.sittingLongHits + this.profile.sittingLongHits,
        videoMinutes: Math.max(existing.videoMinutes, this.profile.videoMinutes),
      })
    } else {
      this.history.set(this.profile.day, { ...this.profile })
    }
    this.saveProfileHistory()
    logger.info(`[ContextEngine] 长期画像日结归档: ${JSON.stringify(this.profile)}`)
    this.profile = this.newProfile()
    this.dayRolloverAt = this.nextDayRollover()
  }

  private updateProfile(snap: StateSnapshot): void {
    const p = this.profile
    if (this.contexts['focused'].confidence > 0.5) p.focusMinutes += 0.025
    if (this.contexts['idle_away'].confidence > 0.6) p.idleMinutes += 0.025
    if (this.contexts['deep_night'].confidence > 0.5) p.lateNightMinutes += 0.025
    if (this.contexts['entertaining'].confidence > 0.5) p.videoMinutes += 0.025
    if (snap['fatigue']?.confidence > 0.6) p.fatigueHits++
    if (snap['posture_bad']?.confidence > 0.6) p.postureHits++
    if (snap['sitting_long']?.confidence > 0.6) p.sittingLongHits++
  }

  /** M4 数字健康周报：聚合最近 7 天画像，生成洞察与建议（洞察而非监控） */
  getWeeklyReport(): WeeklyReport {
    const days: WeeklyReport['days'] = []
    const today = this.profile.day
    const keys = [...this.history.keys()]
    keys.push(today)
    const unique = [...new Set(keys)].sort()
    const last7 = unique.slice(-7)

    for (const day of last7) {
      const rec = day === today ? this.profile : this.history.get(day)
      if (!rec) continue
      days.push({
        day, focusMinutes: rec.focusMinutes, idleMinutes: rec.idleMinutes,
        lateNightMinutes: rec.lateNightMinutes, fatigueHits: rec.fatigueHits,
        postureHits: rec.postureHits, sittingLongHits: rec.sittingLongHits,
        videoMinutes: rec.videoMinutes,
      })
    }

    const sum = (fn: (d: WeeklyReport['days'][number]) => number) => days.reduce((a, d) => a + fn(d), 0)
    const totals = {
      focusMinutes: sum(d => d.focusMinutes),
      idleMinutes: sum(d => d.idleMinutes),
      lateNightMinutes: sum(d => d.lateNightMinutes),
      fatigueHits: sum(d => d.fatigueHits),
      postureHits: sum(d => d.postureHits),
      sittingLongHits: sum(d => d.sittingLongHits),
      videoMinutes: sum(d => d.videoMinutes),
    }
    const n = Math.max(1, days.length)
    const avgFocusPerDay = Math.round(totals.focusMinutes / n)
    const avgIdlePerDay = Math.round(totals.idleMinutes / n)

    const insights: string[] = []
    const suggestions: string[] = []

    if (totals.lateNightMinutes > 180) {
      insights.push(`本周深夜使用约 ${Math.round(totals.lateNightMinutes / 60)} 小时，作息偏晚`)
      suggestions.push('深夜模式已多次触发，建议设置睡前提醒，提前 30 分钟收尾')
    }
    if (totals.sittingLongHits > 15) {
      insights.push(`久坐提醒触发 ${totals.sittingLongHits} 次，久坐偏多`)
      suggestions.push('建议每小时起身活动 2 分钟，玄枢会继续盯梢提醒')
    }
    if (totals.fatigueHits > 12) {
      insights.push(`疲劳信号出现 ${totals.fatigueHits} 次，工作节奏偏紧`)
      suggestions.push('建议每隔 90 分钟安排一次短暂休息，喝口水看看远处')
    }
    if (avgFocusPerDay >= 240) {
      insights.push(`日均专注约 ${Math.round(avgFocusPerDay / 60)} 小时，效率在线`)
    } else if (avgFocusPerDay >= 120) {
      insights.push(`日均专注约 ${Math.round(avgFocusPerDay / 60)} 小时，节奏平稳`)
    } else {
      insights.push(`日均专注不足 2 小时，可能有大量时间在离开或娱乐`)
      suggestions.push('如果本周在赶工，可以试试番茄钟式的分段专注')
    }
    if (totals.videoMinutes > 360) {
      insights.push(`娱乐/看视频累计约 ${Math.round(totals.videoMinutes / 60)} 小时，占比偏高`)
      suggestions.push('娱乐时段玄枢会保持安静，如需监督可调高主动性档位')
    }
    if (totals.postureHits > 15) {
      insights.push(`坐姿不良提醒 ${totals.postureHits} 次，注意肩颈`)
      suggestions.push('可以调整屏幕高度与座椅，保持视线平视')
    }
    if (insights.length === 0) {
      insights.push('本周作息与专注节奏总体健康，继续保持')
    }

    return { days, totals, avgFocusPerDay, avgIdlePerDay, insights, suggestions }
  }

  /* ==================== 主动性礼仪 ==================== */

  private maybeAttention(now: number): void {
    if (!this.attentionCallback) return
    const levelWeight: Record<ProactivityLevel, number> = { quiet: 0.6, balanced: 0.45, active: 0.3 }

    for (const key of Object.keys(this.contexts) as ContextKey[]) {
      const belief = this.contexts[key]
      if (belief.confidence < levelWeight[this.proactivity]) continue
      if (!CONTEXT_MESSAGES[key]) continue
      if (now - (this.lastAttentionAt[key] ?? 0) < 30 * 60_000) continue // 同一情境 30 分钟内不重复打扰

      // 打扰成本 = 严重度 × 置信度 × 用户负担（当前专注时负担高，打扰通道降级）
      const burden = this.contexts['focused'].confidence > 0.5 ? 0.7 : 0.3
      const cost = belief.severity * belief.confidence * (0.5 + burden)
      const channel = this.pickChannel(cost, belief.severity)

      // 静默/低打扰通道不需要打断用户
      if (channel === 'silent' || channel === 'orb') continue

      this.lastAttentionAt[key] = now
      this.attentionCallback({
        context: key,
        confidence: belief.confidence,
        cost: Number(cost.toFixed(2)),
        channel,
        message: CONTEXT_MESSAGES[key],
        actionable: channel === 'toast' || channel === 'interrupt',
      })
    }
  }

  /** 渐进式提醒通道选择：先轻后重 */
  private pickChannel(cost: number, severity: number): NotifyChannel {
    if (cost < 0.15) return 'silent'
    if (cost < 0.35 || severity <= 0.3) return 'orb'
    if (cost < 0.55) return 'voice'
    if (cost < 0.8) return 'toast'
    return 'interrupt'
  }

  /** 供外部（粒子球/语音/弹窗）查询当前最值得表现的单一情境 */
  dominantContext(): { key: ContextKey; confidence: number } | null {
    let best: ContextKey | null = null
    let bestC = 0
    for (const key of Object.keys(this.contexts) as ContextKey[]) {
      const b = this.contexts[key]
      if (b.confidence > bestC) { bestC = b.confidence; best = key }
    }
    if (!best || bestC < 0.25) return null
    return { key: best, confidence: bestC }
  }
}

export const contextEngine = new ContextEngine()
