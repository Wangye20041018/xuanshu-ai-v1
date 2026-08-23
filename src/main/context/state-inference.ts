/**
 * state-inference.ts — 状态推理引擎 StateInferenceEngine v1.0
 *
 * 职责：
 * - 订阅感官总线，融合多源信号推断用户状态（专注/疲劳/离开/访客等）
 * - 每个状态是带置信度的"信念"：事件持续喂入增强/衰减，超时自动降级
 * - 冲突仲裁：多感官矛盾时时间窗内多票表决 + 保守默认（宁可不触发不误触发）
 * - 输出 16 项功能矩阵对应的可观察状态，供情境引擎与决策层消费
 */

import { sensoryBus, SensoryEvent, SensoryChannel } from './sensory-bus'
import { createLogger } from '../../shared/logger'

const logger = createLogger('StateInference')

/* ============================================================
 * 类型定义
 * ============================================================ */

export type UserStateKey =
  // M v4 功能矩阵 16 项
  | 'focus'          // 专注中（无声反馈/注意力通知）
  | 'fatigue'        // 疲劳（疲劳提醒）
  | 'posture_bad'    // 坐姿不良（坐姿提醒）
  | 'screen_too_close' // 距离过近（护眼提醒）
  | 'breathing_slow' // 呼吸平缓（呼吸引导）
  | 'sitting_long'   // 久坐（久坐提醒）
  | 'peeping'        // 防窥（他人窥屏）
  | 'late_night'     // 深夜（深夜守护）
  | 'present'        // 人在场（人在感应）
  | 'absent'         // 人离开（防窥/暂停）
  | 'looking_at'     // 注视屏幕（注视回应）
  | 'distracted'     // 注意力分散（注意力通知）
  | 'emotion_down'   // 情绪低落（情绪陪伴）
  | 'speaking'       // 演讲中（演讲教练）
  | 'sleepy'         // 犯困（深夜守护强化）
  | 'video_watching' // 看视频/娱乐（不打扰）

export interface StateBelief {
  key: UserStateKey
  confidence: number       // 0-1 当前置信度
  updatedAt: number
  /** 触发通道，用于仲裁记录 */
  sources: SensoryChannel[]
  /** 连续确认帧/次数（去抖） */
  stableCount: number
}

export interface StateSnapshot {
  [key: string]: StateBelief
}

/* ============================================================
 * 状态推理引擎
 * ============================================================ */

interface FeatureWindow {
  lastInputAt: number
  lastWindowAt: number
  currentWindow: string | null
  idleSeconds: number
  audioPlaying: boolean
  lastGestureAt: number
  lastGesture: string
  lastFaceAt: number
  lastEmotion: string
  presenceConfirmed: boolean
  peepVotes: number
  peepWindowStart: number
  lookingAtScreen: boolean
  posture: string
  distanceScore: number
  inputRatePerMin: number
  recentInputEvents: number[]
}

const CONFIDENCE_STEP = 0.15      // 单次事件置信度增量
const DECAY_PER_MS = 0.0004       // 每毫秒衰减系数（2.5s 内衰减约 63%）
const LONG_IDLE_MS = 5 * 60 * 1000  // 5 分钟无输入视为离开倾向

const DEFAULT_STATES: UserStateKey[] = [
  'focus', 'fatigue', 'posture_bad', 'screen_too_close', 'breathing_slow',
  'sitting_long', 'peeping', 'late_night', 'present', 'absent',
  'looking_at', 'distracted', 'emotion_down', 'speaking', 'sleepy', 'video_watching',
]

export class StateInferenceEngine {
  private states: StateSnapshot = {}
  private win: FeatureWindow = {
    lastInputAt: Date.now(),
    lastWindowAt: Date.now(),
    currentWindow: null,
    idleSeconds: 0,
    audioPlaying: false,
    lastGestureAt: 0,
    lastGesture: 'idle',
    lastFaceAt: 0,
    lastEmotion: 'neutral',
    presenceConfirmed: false,
    peepVotes: 0,
    peepWindowStart: 0,
    lookingAtScreen: false,
    posture: 'unknown',
    distanceScore: 0.5,
    inputRatePerMin: 0,
    recentInputEvents: [],
  }
  private unsubscribe: (() => void) | null = null
  private decayTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    for (const key of DEFAULT_STATES) {
      this.states[key] = { key, confidence: 0, updatedAt: 0, sources: [], stableCount: 0 }
    }
    // 初始化环境信号
    this.applyEnvironment()
  }

  /** 启动：订阅感官总线 + 启动信念衰减时钟 */
  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = sensoryBus.subscribe((e) => this.onEvent(e))
    this.decayTimer = setInterval(() => this.decayAll(), 1000)
    logger.info('[StateInference] 已启动')
  }

  stop(): void {
    if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null }
    if (this.decayTimer) { clearInterval(this.decayTimer); this.decayTimer = null }
    logger.info('[StateInference] 已停止')
  }

  getSnapshot(): StateSnapshot {
    return { ...this.states }
  }

  getState(key: UserStateKey): StateBelief {
    return this.states[key]
  }

  /* ==================== 事件处理 ==================== */

  private onEvent(e: SensoryEvent): void {
    // 更新特征窗口
    this.updateFeatures(e)

    // 按事件类型驱动状态信念
    switch (e.type) {
      case 'input':       this.bump('present', e); this.bump('focus', e); this.resetBelief('absent'); this.resetBelief('distracted'); break
      case 'idle':        this.bump('absent', e, 0.08); this.bump('distracted', e, 0.06); break
      case 'presence':    this.handlePresence(e); break
      case 'gesture':     this.handleGesture(e); break
      case 'face':        this.handleFace(e); break
      case 'window':      this.handleWindow(e); break
      case 'audio_output': this.handleAudio(e); break
      case 'time':        this.handleTime(e); break
      case 'clipboard':   this.bump('focus', e, 0.08); this.bump('present', e, 0.1); break
      case 'notification': this.bump('distracted', e, 0.12); break
      case 'file_activity': this.bump('present', e, 0.08); break
      case 'network':     this.bump('present', e, 0.06); break
      case 'physio_data': this.handlePhysio(e); break
    }
  }

  /* ==================== 特征窗口更新 ==================== */

  private updateFeatures(e: SensoryEvent): void {
    const now = e.ts
    if (e.type === 'input') {
      this.win.lastInputAt = now
      this.win.recentInputEvents.push(now)
      // 保留最近 60s 的输入事件用于速率计算
      this.win.recentInputEvents = this.win.recentInputEvents.filter(t => now - t < 60_000)
      this.win.inputRatePerMin = this.win.recentInputEvents.length
    }
    if (e.type === 'window' && e.payload?.app) {
      this.win.currentWindow = String(e.payload.app)
      this.win.lastWindowAt = now
    }
    if (e.type === 'gesture' && e.payload?.gesture) {
      this.win.lastGesture = String(e.payload.gesture)
      this.win.lastGestureAt = now
    }
    if (e.type === 'face') {
      this.win.lastFaceAt = now
      if (e.payload?.emotion) this.win.lastEmotion = String(e.payload.emotion)
      if (e.payload?.looking !== undefined) this.win.lookingAtScreen = Boolean(e.payload.looking)
    }
    if (e.type === 'audio_output' && e.payload?.playing !== undefined) {
      this.win.audioPlaying = Boolean(e.payload.playing)
    }
    this.win.idleSeconds = (now - this.win.lastInputAt) / 1000
  }

  /* ==================== 各事件处理器 ==================== */

  private handlePresence(e: SensoryEvent): void {
    const present = e.payload?.present === true
    if (present) {
      this.win.presenceConfirmed = true
      this.bump('present', e, 0.3)
      this.resetBelief('absent')
    } else {
      // 人离开：视觉判定 + 长时间无输入 双票表决（冲突仲裁）
      const idleVote = this.win.idleSeconds > LONG_IDLE_MS / 1000
      if (idleVote) {
        this.bump('absent', e, 0.35)
        this.bump('peeping', e, 0.1) // 离开时屏幕暴露 → 防窥倾向
      } else {
        // 摄像头说离开但输入仍活跃 → 保守默认：不判定离开
        logger.debug('[StateInference] 仲裁: 视觉判离但输入活跃，保守保持在场')
      }
    }
  }

  private handleGesture(e: SensoryEvent): void {
    const gesture = String(e.payload?.gesture ?? 'idle')
    switch (gesture) {
      case 'thumbs_up': this.bump('focus', e, 0.1); break
      case 'nod': this.bump('focus', e, 0.08); break
      case 'shake_head': this.bump('distracted', e, 0.15); break
      case 'yawn': this.bump('fatigue', e, 0.3); this.bump('sleepy', e, 0.25); break
      case 'stretch': this.bump('fatigue', e, 0.2); this.bump('sitting_long', e, 0.2); break
      case 'wave': this.bump('present', e, 0.1); break
    }
  }

  private handleFace(e: SensoryEvent): void {
    const emotion = this.win.lastEmotion
    if (emotion === 'sad' || emotion === 'angry' || emotion === 'fear') {
      this.bump('emotion_down', e, 0.25)
    } else if (emotion === 'happy' || emotion === 'neutral') {
      this.resetBelief('emotion_down')
    }
    if (this.win.lookingAtScreen) {
      this.bump('looking_at', e, 0.2)
    } else {
      this.bump('distracted', e, 0.1)
    }
  }

  private handleWindow(e: SensoryEvent): void {
    const app = this.win.currentWindow ?? ''
    const lower = app.toLowerCase()
    // 娱乐类应用 → 视频/娱乐情境
    if (/bilibili|youtube|netflix|potplayer|youku|iqiyi|tencent video|wegame|steam|game/.test(lower)) {
      this.bump('video_watching', e, 0.25)
      this.resetBelief('focus')
    } else if (/ppt|powerpoint|keynote|会议|meeting|zoom|teams|dingtalk|wechatwork/.test(lower)) {
      this.bump('speaking', e, 0.2)
    } else {
      this.bump('focus', e, 0.05)
    }
  }

  private handleAudio(e: SensoryEvent): void {
    // audio_output：系统音频输出（播放中）
    if (e.payload?.playing !== undefined) {
      if (e.payload.playing === true) {
        this.win.audioPlaying = true
        this.bump('video_watching', e, 0.1)
      } else {
        this.win.audioPlaying = false
      }
    }

    // M3 听觉情境：audio_input 环境音场景（音乐/人声/敲门/音量）
    const level = String(e.payload?.level ?? 'silence')
    const speech = e.payload?.speech === true
    const music = e.payload?.music === true
    const transient = e.payload?.transient === true

    // 人声：附近有人说话 → 演讲/会客倾向
    if (speech) {
      this.bump('speaking', e, 0.3)
      this.resetBelief('absent')
    }
    // 音乐：环境在播放音乐 → 娱乐倾向
    if (music) {
      this.bump('video_watching', e, 0.15)
    }
    // 瞬态异响（敲门/拍桌/物体落地）→ 注意力被打断
    if (transient) {
      this.bump('distracted', e, 0.3)
    }
    // 音量过响 → 分心/嘈杂环境
    if (level === 'loud' && !speech && !music) {
      this.bump('distracted', e, 0.12)
    }
  }

  private handleTime(e: SensoryEvent): void {
    const hour = Number(e.payload?.hour ?? -1)
    if (hour >= 23 || hour < 5) {
      this.bump('late_night', e, 0.3)
      // 深夜 + 低输入 → 犯困
      if (this.win.inputRatePerMin < 5) this.bump('sleepy', e, 0.15)
    } else {
      this.resetBelief('late_night')
    }
  }

  private handlePhysio(e: SensoryEvent): void {
    // 生理预留：心率/压力
    const hr = Number(e.payload?.heartRate ?? 0)
    const stress = Number(e.payload?.stress ?? 0)
    if (hr > 0 && (hr > 95 || stress > 0.7)) this.bump('emotion_down', e, 0.12)
  }

  /* ==================== 信念操作 ==================== */

  /** 提升某信念置信度（带去抖稳定计数） */
  private bump(key: UserStateKey, e: SensoryEvent, step = CONFIDENCE_STEP): void {
    const belief = this.states[key]
    if (!belief) return
    const now = e.ts
    // 时间窗内同源不重复累计（防高频帧刷爆）
    if (belief.updatedAt > 0 && now - belief.updatedAt < 200 && belief.sources.includes(e.channel)) return
    belief.confidence = Math.min(1, belief.confidence + step)
    belief.updatedAt = now
    belief.stableCount++
    if (!belief.sources.includes(e.channel)) belief.sources.push(e.channel)
    if (belief.stableCount > 5) belief.stableCount = 5
  }

  /** 重置某信念 */
  private resetBelief(key: UserStateKey): void {
    const belief = this.states[key]
    if (!belief) return
    belief.confidence = 0
    belief.stableCount = 0
    belief.sources = []
  }

  /** 全量信念衰减（超时自动降级） */
  private decayAll(): void {
    const now = Date.now()
    for (const belief of Object.values(this.states)) {
      if (belief.confidence <= 0) continue
      const elapsed = now - belief.updatedAt
      if (elapsed > 60_000) {
        // 超 60s 无证据 → 快速归零
        belief.confidence = 0
        belief.stableCount = 0
        belief.sources = []
      } else {
        belief.confidence = Math.max(0, belief.confidence - DECAY_PER_MS * elapsed)
      }
    }
    // 环境态（深夜/时段）不衰减太狠
    const lateNight = this.states['late_night']
    if (lateNight.confidence > 0.5) {
      const hour = new Date(now).getHours()
      if (hour < 23 && hour >= 5) this.resetBelief('late_night')
    }
  }

  /** 初始化环境信号（时间/空闲基线） */
  private applyEnvironment(): void {
    const now = Date.now()
    const hour = new Date(now).getHours()
    if (hour >= 23 || hour < 5) {
      this.states['late_night'].confidence = 0.6
      this.states['late_night'].updatedAt = now
    }
  }
}

export const stateInference = new StateInferenceEngine()
