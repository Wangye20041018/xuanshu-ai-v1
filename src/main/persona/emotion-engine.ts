/**
 * 玄枢情感引擎 — Emotion Engine
 *
 * 让玄枢具备「情感审美拟人化」能力：
 *   1) 从用户输入中识别情绪（规则词典，无重型依赖，本地即时）
 *   2) 维护可衰减的情绪状态（valence 愉悦度 / arousal 唤醒度）
 *   3) 将情绪映射到视觉（悬浮球/能量环颜色）与语音（音调/语速）
 *
 * 情绪颜色与既有能量环 STATE_COLORS 保持一致的美学体系：
 *   idle #6366f1  listening #22d3ee  thinking #a855f7  speaking #f59e0b
 *
 * @module persona/emotion-engine
 */

export type EmotionType =
  | 'joy'
  | 'warmth'
  | 'sadness'
  | 'anger'
  | 'anxiety'
  | 'surprise'
  | 'calm'
  | 'confusion'

export interface EmotionResult {
  emotion: EmotionType
  label: string
  emoji: string
  /** 愉悦度 -1 ~ 1 */
  valence: number
  /** 唤醒度 0 ~ 1 */
  arousal: number
  /** 强度 0 ~ 1 */
  intensity: number
  /** 视觉主色（十六进制） */
  color: string
}

export interface EmotionVoiceParams {
  pitch: string
  rate: string
}

interface EmotionMeta {
  label: string
  emoji: string
  color: string
  valence: number
  arousal: number
}

const EMOTION_META: Record<EmotionType, EmotionMeta> = {
  joy: { label: '开心', emoji: '😊', color: '#f59e0b', valence: 0.9, arousal: 0.7 },
  warmth: { label: '温暖', emoji: '🤗', color: '#fb7185', valence: 0.8, arousal: 0.4 },
  sadness: { label: '难过', emoji: '😢', color: '#60a5fa', valence: -0.7, arousal: 0.3 },
  anger: { label: '生气', emoji: '😠', color: '#ef4444', valence: -0.8, arousal: 0.85 },
  anxiety: { label: '焦虑', emoji: '😰', color: '#f97316', valence: -0.5, arousal: 0.75 },
  surprise: { label: '惊喜', emoji: '😮', color: '#22d3ee', valence: 0.5, arousal: 0.9 },
  calm: { label: '平静', emoji: '😌', color: '#6366f1', valence: 0.2, arousal: 0.2 },
  confusion: { label: '困惑', emoji: '🤔', color: '#a855f7', valence: -0.1, arousal: 0.5 },
}

/** 情绪 → 语音合成参数（Edge TTS prosody 百分比） */
const EMOTION_VOICE: Record<EmotionType, EmotionVoiceParams> = {
  joy: { pitch: '+20%', rate: '+10%' },
  warmth: { pitch: '+5%', rate: '-5%' },
  sadness: { pitch: '-15%', rate: '-15%' },
  anger: { pitch: '+10%', rate: '+15%' },
  anxiety: { pitch: '+5%', rate: '+20%' },
  surprise: { pitch: '+15%', rate: '+10%' },
  calm: { pitch: '+0%', rate: '+0%' },
  confusion: { pitch: '+0%', rate: '-5%' },
}

/**
 * 情绪线索词典。value 为权重，强情绪词权重更高。
 * 命中次数越多、权重越高，最终得分越高。
 */
const CUE_WEIGHTS: Record<EmotionType, Record<string, number>> = {
  joy: {
    开心: 3, 高兴: 3, 太棒了: 4, 太好了: 4, 喜欢: 2, 喜欢这个: 3, 爱: 2, 哈哈: 4,
    嘻嘻: 4, 嘿嘿: 3, 兴奋: 3, 快乐: 3, 满意: 2, 棒: 2, 赞: 2, 完美: 2, 幸运: 2,
    nice: 3, great: 3, love: 3, happy: 4, awesome: 4, cool: 3, amazing: 4, wonderful: 4,
    '😊': 3, '😄': 3, '😂': 4, '🤣': 4, '🎉': 3, '🥳': 3, '😆': 3, '😁': 3,
  },
  warmth: {
    谢谢: 3, 感谢: 3, 感恩: 3, 关心: 3, 想你: 3, 抱抱: 3, 温暖: 3, 贴心: 3,
    辛苦了: 4, 爱你: 4, 喜欢和你聊: 4, 有你真好: 4, 放心: 2, 安慰: 2,
    thanks: 3, 'thank you': 3, care: 3, 'miss you': 3, sweet: 3, lovely: 3,
    '💖': 3, '💕': 3, '❤️': 3, '🥰': 3,
  },
  sadness: {
    难过: 3, 伤心: 3, 想哭: 4, 失落: 3, 沮丧: 3, 绝望: 4, 委屈: 3, 泪: 2,
    悲伤: 3, 郁闷: 2, 心碎: 4, 孤独: 3, 累: 2, 唉: 2,
    sad: 4, cry: 3, upset: 3, depressed: 4, lonely: 3, heartbroken: 4,
    '😢': 4, '😭': 5, '😔': 3, '💔': 4,
  },
  anger: {
    生气: 3, 愤怒: 4, 气死: 5, 讨厌: 3, 烦死: 4, 可恶: 4, 火大: 4, 气人: 3,
    怒: 2, 恶心: 3, 无语: 3, 受不了: 3,
    angry: 4, furious: 5, hate: 4, damn: 4, annoying: 3,
    '😠': 4, '😡': 5, '🤬': 5, '💢': 4,
  },
  anxiety: {
    焦虑: 4, 紧张: 3, 担心: 3, 害怕: 4, 不安: 3, 压力: 3, 压力大: 4, 急死: 3,
    慌张: 3, 忐忑: 3, 恐惧: 4, 怕: 2, 慌: 2,
    worried: 4, anxious: 4, nervous: 3, scared: 4, afraid: 4, stress: 3, stressed: 4,
    '😰': 4, '😨': 4, '😱': 4, '😟': 3,
  },
  surprise: {
    惊讶: 3, 惊喜: 3, 天哪: 4, 哇: 3, 没想到: 3, 居然: 3, 竟然: 3, 震惊: 4,
    不敢相信: 4, 我的天: 4, 太意外了: 4,
    wow: 4, omg: 5, surprised: 4, shocked: 4, unbelievable: 4, 'no way': 4,
    '😮': 4, '😲': 4, '🤯': 4, '😱': 4,
  },
  confusion: {
    疑惑: 3, 不懂: 3, 不明白: 3, 为什么: 2, 怎么回事: 3, 困惑: 4, 迷茫: 3,
    不知道: 2, 啥意思: 3, 什么意思: 3, 搞不懂: 3,
    confused: 4, huh: 3, 'what do you mean': 3, 'i dont get it': 3, '??': 2,
    '🤔': 4, '❓': 3, '🤨': 3,
  },
  calm: {
    平静: 3, 安心: 3, 放松: 3, 没事: 2, 淡定: 3, 好的: 1, 收到: 1, 了解了: 1,
    calm: 3, relax: 3, okay: 1, ok: 1, fine: 1, understood: 2,
    '😌': 3, '🙂': 2, '👌': 2,
  },
}

/** 中文语义否定前缀：命中「不/没/别」时弱化该情绪（如「不开心」不判开心） */
const NEGATION_PREFIXES = /(不|没|别|没有|一点也不|并不|不太)/

function detectEmotion(text: string): EmotionResult {
  const t = String(text || '').trim()
  if (!t) {
    return toResult('calm', 0.1)
  }

  const scores = new Map<EmotionType, number>()
  let maxEmotion: EmotionType = 'calm'
  let maxScore = 0
  let totalHits = 0

  for (const [emotion, lexicon] of Object.entries(CUE_WEIGHTS)) {
    let score = 0
    const lower = t.toLowerCase()
    for (const [word, weight] of Object.entries(lexicon)) {
      const needle = word.toLowerCase()
      const idx = lower.indexOf(needle)
      if (idx < 0) continue

      // 否定弱化：紧邻「不/没/别」则权重减半，如「不开心」不判为开心
      const before = lower.slice(Math.max(0, idx - 1), idx)
      const before2 = lower.slice(Math.max(0, idx - 2), idx)
      const negated = NEGATION_PREFIXES.test(before) || NEGATION_PREFIXES.test(before2)
      score += negated ? Math.round(weight / 2) : weight
      totalHits++
    }
    scores.set(emotion as EmotionType, score)
    if (score > maxScore) {
      maxScore = score
      maxEmotion = emotion as EmotionType
    }
  }

  // 无显著线索 → 平静
  if (maxScore < 3) {
    return toResult('calm', 0.1)
  }

  // 若「平静」与某情绪并列最高且其他情绪明显（如「好的哈哈」），优先非平静
  if (maxEmotion === 'calm' && totalHits > 0) {
    const second = [...scores.entries()]
      .filter(([e]) => e !== 'calm')
      .sort((a, b) => b[1] - a[1])[0]
    if (second && second[1] >= 2) {
      maxEmotion = second[0]
      maxScore = second[1]
    }
  }

  const intensity = Math.min(1, maxScore / 10)
  return toResult(maxEmotion, intensity)
}

function toResult(emotion: EmotionType, intensity: number): EmotionResult {
  const meta = EMOTION_META[emotion]
  return {
    emotion,
    label: meta.label,
    emoji: meta.emoji,
    valence: meta.valence,
    arousal: meta.arousal,
    intensity,
    color: meta.color,
  }
}

/**
 * 情绪状态机：保持当前情绪并向「平静」缓慢衰减。
 * 强情绪（高唤醒/高强度）会被保留更久，避免闪烁。
 */
class EmotionEngine {
  private current: EmotionResult | null = null
  private lastObservedAt = 0
  private readonly DECAY_MS = 8_000

  observeUserText(text: string): EmotionResult {
    const result = detectEmotion(text)
    this.current = result
    this.lastObservedAt = Date.now()
    return result
  }

  /** 读取当前情绪；若已过衰减期则回落为平静 */
  getState(): EmotionResult {
    if (!this.current) return toResult('calm', 0.1)
    const elapsed = Date.now() - this.lastObservedAt
    if (elapsed > this.DECAY_MS) {
      this.current = toResult('calm', 0.1)
      this.lastObservedAt = Date.now()
    }
    return this.current
  }

  getVoiceParams(): EmotionVoiceParams {
    return EMOTION_VOICE[this.getState().emotion]
  }

  reset(): void {
    this.current = null
    this.lastObservedAt = 0
  }
}

export const emotionEngine = new EmotionEngine()

export { detectEmotion, EMOTION_META, EMOTION_VOICE }

/* ============================================================
 * IPC 处理器
 * ============================================================ */

export function setupEmotionHandlers(): void {
  const { ipcMain } = require('electron')

  ipcMain.handle('emotion:detect', (_event: unknown, text: string) => {
    return detectEmotion(text)
  })

  ipcMain.handle('emotion:get-state', () => {
    return emotionEngine.getState()
  })

  ipcMain.handle('emotion:observe', (_event: unknown, text: string) => {
    return emotionEngine.observeUserText(text)
  })
}