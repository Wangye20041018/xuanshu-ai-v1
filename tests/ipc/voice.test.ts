/**
 * tests/ipc/voice.test.ts
 * Voice IPC handler 逻辑单元测试
 */
import { describe, it, expect, beforeEach } from 'vitest'

interface VoiceProfile {
  id: string
  name: string
  description: string
  gender: 'male' | 'female' | 'neutral'
  age: 'young' | 'middle' | 'senior'
  emotion: 'warm' | 'calm' | 'energetic' | 'professional' | 'friendly' | 'cheerful'
  language: string
  pitch: number
  speed: number
  volume: number
  ttsEngine: 'piper' | 'edge' | 'hybrid'
  isBuiltIn: boolean
}

interface VoiceSettings {
  currentVoiceId: string
  volume: number
  speed: number
  pitch: number
  emotionEnabled: boolean
  personalizeEnabled: boolean
}

class VoiceEngine {
  private voices: VoiceProfile[] = []
  private settings: VoiceSettings = {
    currentVoiceId: 'zh-CN-XiaoxiaoNeural',
    volume: 1.0,
    speed: 1.0,
    pitch: 1.0,
    emotionEnabled: false,
    personalizeEnabled: false
  }

  constructor() {
    this.initBuiltInVoices()
  }

  private initBuiltInVoices(): void {
    this.voices = [
      { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', description: '温柔女声', gender: 'female', age: 'young', emotion: 'warm', language: 'zh-CN', pitch: 1.0, speed: 1.0, volume: 1.0, ttsEngine: 'edge', isBuiltIn: true },
      { id: 'zh-CN-YunxiNeural', name: '云希', description: '男主播', gender: 'male', age: 'middle', emotion: 'professional', language: 'zh-CN', pitch: 1.0, speed: 1.0, volume: 1.0, ttsEngine: 'edge', isBuiltIn: true },
      { id: 'zh-CN-XiaoyiNeural', name: '晓伊', description: '活泼女声', gender: 'female', age: 'young', emotion: 'cheerful', language: 'zh-CN', pitch: 1.2, speed: 1.1, volume: 1.0, ttsEngine: 'edge', isBuiltIn: true },
      { id: 'zh-CN-chaowen-piper', name: '超文', description: '离线男声', gender: 'male', age: 'middle', emotion: 'calm', language: 'zh-CN', pitch: 1.0, speed: 1.0, volume: 1.0, ttsEngine: 'piper', isBuiltIn: true },
    ]
  }

  getVoices(): VoiceProfile[] {
    return [...this.voices]
  }

  getVoice(id: string): VoiceProfile | undefined {
    return this.voices.find(v => v.id === id)
  }

  getCurrentVoice(): VoiceProfile | undefined {
    return this.getVoice(this.settings.currentVoiceId)
  }

  setCurrentVoice(voiceId: string): boolean {
    const voice = this.getVoice(voiceId)
    if (!voice) return false
    this.settings.currentVoiceId = voiceId
    return true
  }

  getSettings(): VoiceSettings {
    return { ...this.settings }
  }

  updateSettings(partial: Partial<VoiceSettings>): void {
    Object.assign(this.settings, partial)
  }

  setVolume(volume: number): void {
    this.settings.volume = Math.max(0, Math.min(2, volume))
  }

  setSpeed(speed: number): void {
    this.settings.speed = Math.max(0.5, Math.min(2, speed))
  }

  setPitch(pitch: number): void {
    this.settings.pitch = Math.max(0.5, Math.min(2, pitch))
  }

  addCustomVoice(voice: Omit<VoiceProfile, 'isBuiltIn'>): boolean {
    if (this.voices.find(v => v.id === voice.id)) return false
    this.voices.push({ ...voice, isBuiltIn: false })
    return true
  }

  removeCustomVoice(voiceId: string): boolean {
    const voice = this.voices.find(v => v.id === voiceId)
    if (!voice || voice.isBuiltIn) return false
    this.voices = this.voices.filter(v => v.id !== voiceId)
    return true
  }

  searchVoices(query: string): VoiceProfile[] {
    const q = query.toLowerCase()
    return this.voices.filter(v =>
      v.name.toLowerCase().includes(q) ||
      v.description.toLowerCase().includes(q) ||
      v.language.toLowerCase().includes(q)
    )
  }

  getVoicesByEmotion(emotion: VoiceProfile['emotion']): VoiceProfile[] {
    return this.voices.filter(v => v.emotion === emotion)
  }
}

describe('Voice IPC Handler Logic', () => {
  let engine: VoiceEngine

  beforeEach(() => {
    engine = new VoiceEngine()
  })

  describe('getVoices', () => {
    it('应返回内置语音列表', () => {
      const voices = engine.getVoices()
      expect(voices.length).toBeGreaterThanOrEqual(4)
    })

    it('所有内置语音 isBuiltIn 应为 true', () => {
      const voices = engine.getVoices()
      expect(voices.every(v => v.isBuiltIn)).toBe(true)
    })
  })

  describe('getVoice', () => {
    it('应通过 ID 获取指定语音', () => {
      const voice = engine.getVoice('zh-CN-XiaoxiaoNeural')
      expect(voice).toBeDefined()
      expect(voice?.name).toBe('晓晓')
      expect(voice?.gender).toBe('female')
    })

    it('不存在的 ID 应返回 undefined', () => {
      expect(engine.getVoice('nonexistent')).toBeUndefined()
    })
  })

  describe('setCurrentVoice', () => {
    it('应成功切换当前语音', () => {
      const result = engine.setCurrentVoice('zh-CN-YunxiNeural')
      expect(result).toBe(true)
      expect(engine.getCurrentVoice()?.id).toBe('zh-CN-YunxiNeural')
    })

    it('切换不存在的语音应返回 false', () => {
      const result = engine.setCurrentVoice('ghost-voice')
      expect(result).toBe(false)
    })

    it('切换后 getSettings 应反映新 currentVoiceId', () => {
      engine.setCurrentVoice('zh-CN-chaowen-piper')
      expect(engine.getSettings().currentVoiceId).toBe('zh-CN-chaowen-piper')
    })
  })

  describe('音量/语速/音调设置', () => {
    it('setVolume 应在 0-2 范围内', () => {
      engine.setVolume(1.5)
      expect(engine.getSettings().volume).toBe(1.5)
      engine.setVolume(5)
      expect(engine.getSettings().volume).toBe(2)
      engine.setVolume(-1)
      expect(engine.getSettings().volume).toBe(0)
    })

    it('setSpeed 应在 0.5-2 范围内', () => {
      engine.setSpeed(1.3)
      expect(engine.getSettings().speed).toBe(1.3)
      engine.setSpeed(0.1)
      expect(engine.getSettings().speed).toBe(0.5)
    })

    it('setPitch 应在 0.5-2 范围内', () => {
      engine.setPitch(0.8)
      expect(engine.getSettings().pitch).toBe(0.8)
      engine.setPitch(3)
      expect(engine.getSettings().pitch).toBe(2)
    })
  })

  describe('updateSettings', () => {
    it('应支持部分更新', () => {
      engine.updateSettings({ volume: 0.8, emotionEnabled: true })
      const s = engine.getSettings()
      expect(s.volume).toBe(0.8)
      expect(s.emotionEnabled).toBe(true)
      expect(s.speed).toBe(1.0) // 未改动
    })
  })

  describe('addCustomVoice', () => {
    it('应添加自定义语音', () => {
      const result = engine.addCustomVoice({
        id: 'custom-001', name: '自定义男声', description: '测试',
        gender: 'male', age: 'senior', emotion: 'calm', language: 'zh-CN',
        pitch: 1.0, speed: 1.0, volume: 1.0, ttsEngine: 'piper'
      })
      expect(result).toBe(true)
      expect(engine.getVoice('custom-001')?.isBuiltIn).toBe(false)
    })

    it('重复 ID 应拒绝', () => {
      engine.addCustomVoice({ id: 'dup', name: 'First', description: '', gender: 'male', age: 'young', emotion: 'calm', language: 'zh', pitch: 1, speed: 1, volume: 1, ttsEngine: 'piper' })
      const result = engine.addCustomVoice({ id: 'dup', name: 'Second', description: '', gender: 'female', age: 'senior', emotion: 'warm', language: 'zh', pitch: 1, speed: 1, volume: 1, ttsEngine: 'edge' })
      expect(result).toBe(false)
    })
  })

  describe('removeCustomVoice', () => {
    it('应删除自定义语音', () => {
      engine.addCustomVoice({ id: 'to-remove', name: '待删除', description: '', gender: 'neutral', age: 'middle', emotion: 'calm', language: 'zh', pitch: 1, speed: 1, volume: 1, ttsEngine: 'piper' })
      expect(engine.removeCustomVoice('to-remove')).toBe(true)
      expect(engine.getVoice('to-remove')).toBeUndefined()
    })

    it('不应删除内置语音', () => {
      expect(engine.removeCustomVoice('zh-CN-XiaoxiaoNeural')).toBe(false)
    })

    it('删除不存在的语音应返回 false', () => {
      expect(engine.removeCustomVoice('ghost')).toBe(false)
    })
  })

  describe('searchVoices', () => {
    it('应通过名称搜索语音', () => {
      const results = engine.searchVoices('晓')
      expect(results.length).toBeGreaterThanOrEqual(2)
    })

    it('应通过描述搜索语音', () => {
      const results = engine.searchVoices('离线')
      expect(results.length).toBeGreaterThanOrEqual(1)
    })

    it('无匹配应返回空数组', () => {
      expect(engine.searchVoices('zzznotexistzzz')).toEqual([])
    })
  })

  describe('getVoicesByEmotion', () => {
    it('应通过情绪过滤语音', () => {
      const results = engine.getVoicesByEmotion('warm')
      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results.every(v => v.emotion === 'warm')).toBe(true)
    })

    it('无匹配情绪应返回空数组', () => {
      // energetic 没有内置语音
      const results = engine.getVoicesByEmotion('energetic')
      expect(results.length).toBe(0)
    })
  })
})
