/* ============================================================
 * TTS IPC Handlers — Piper 离线语音 + Edge 在线语音桥接
 *
 * 提供前端 Voice 页面所需的完整 IPC 通道：
 * - voice:tts-status     → 检查 Piper/Edge 引擎状态
 * - voice:get-voices     → 获取完整音色列表
 * - voice:set-current    → 保存当前选择的音色
 * - voice:get-settings   → 加载语音设置
 * - tts:speak            → 合成并播放文本
 * - voice:preview        → 试听音色
 * ============================================================ */

import { ipcMain, app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { PiperTTS, PIPER_VOICE_MODELS } from '../tts/piper'
import { edgeTTS } from '../tts/edge'
import { voiceEngine } from '../voice-engine'
import { logger } from '../../shared/logger'

/* ============================================================
 * 单例 — 延迟初始化，避免 app ready 前访问
 * ============================================================ */
let piperTTS: PiperTTS | null = null

function getPiper(): PiperTTS {
  if (!piperTTS) {
    piperTTS = new PiperTTS()
    piperTTS.initialize()
  }
  return piperTTS
}

/* ============================================================
 * 从 voicePresets 映射到 Piper 模型
 * ============================================================ */
interface VoiceSettings {
  currentVoiceId?: string
  speed?: number
  pitch?: number
  volume?: number
  ttsEngine?: string
}

function loadSettings(): VoiceSettings {
  try {
    const configPath = join(app.getPath('userData'), 'voice-settings.json')
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, 'utf-8'))
    }
  } catch { /* ignore */ }
  return {}
}

function saveSettings(settings: VoiceSettings): void {
  try {
    const configPath = join(app.getPath('userData'), 'voice-settings.json')
    writeFileSync(configPath, JSON.stringify(settings, null, 2))
  } catch (e: any) {
    logger.error('[TTS IPC] 保存配置失败:', e.message)
  }
}

/* ============================================================
 * 注册所有 TTS IPC Handler
 * ============================================================ */
export function setupTTSHandlers(): void {
  /* ------ voice:tts-status ------ */
  ipcMain.handle('voice:tts-status', async () => {
    const piper = getPiper()
    const piperAvailable = piper.isAvailable()
    const piperModels = piperAvailable
      ? PIPER_VOICE_MODELS.map((m) => ({ id: m.id, name: m.name, gender: m.gender }))
      : []
    // 在线音色列表：基于内置 Edge 语音映射（无需网络探测，UI 用于展示与试听状态）
    const edgeVoices = edgeTTS.getVoices().map((v) => ({ id: v.id, name: v.name }))

    return {
      edgeAvailable: edgeVoices.length > 0, // Edge TTS 在线服务可用（是否连通由合成时判断并降级）
      edgeVoices,
      piperAvailable,
      piperModels,
      piperModelCount: piperModels.length,
    }
  })

  /* ------ voice:get-voices ------ */
  async function listVoices() {
    // 返回所有可用音色（基于 Piper 模型映射 + Edge 在线）
    const piper = getPiper()
    const piperAvailable = piper.isAvailable()

    // 从 voicePresets.ts 的结构来构建响应
    // 每个 Piper 模型可以对应多种音色风格（通过 pitch/speed/volume 调节）
    const voices = [
      {
        id: 'xuanxu_warm_female', name: '温暖女声', gender: 'female', age: 'young',
        emotion: 'warm', pitch: 1.0, speed: 0.97, volume: 0.95, isBuiltIn: true,
        ttsEngine: 'hybrid', piperModelId: 'zh_female_warm',
        edgeVoiceId: 'zh-CN-XiaoxiaoNeural', ttsLabel: piperAvailable ? '在线(离线降级)' : '仅在线',
        description: '温暖亲切的女性音色，语调柔和自然',
      },
      {
        id: 'xuanxu_calm_male', name: '沉稳男声', gender: 'male', age: 'middle',
        emotion: 'calm', pitch: 0.90, speed: 0.82, volume: 0.85, isBuiltIn: true,
        ttsEngine: 'hybrid', piperModelId: 'zh_male',
        edgeVoiceId: 'zh-CN-YunxiNeural', ttsLabel: piperAvailable ? '在线(离线降级)' : '仅在线',
        description: '冷静理性的男性音色，语速从容节奏分明',
      },
      {
        id: 'xuanxu_bright_female', name: '明亮女声', gender: 'female', age: 'young',
        emotion: 'cheerful', pitch: 1.05, speed: 1.05, volume: 1.0, isBuiltIn: true,
        ttsEngine: 'hybrid', piperModelId: 'zh_female_bright',
        edgeVoiceId: 'zh-CN-XiaoyiNeural', ttsLabel: piperAvailable ? '在线(离线降级)' : '仅在线',
        description: '明亮清脆的女性音色，语调活泼有辨识度',
      },
      {
        id: 'xuanxu_deep_male', name: '阳刚男声', gender: 'male', age: 'middle',
        emotion: 'professional', pitch: 0.85, speed: 0.88, volume: 0.90, isBuiltIn: true,
        ttsEngine: 'hybrid', piperModelId: 'zh_male',
        edgeVoiceId: 'zh-CN-YunjianNeural', ttsLabel: piperAvailable ? '在线(离线降级)' : '仅在线',
        description: '低沉阳刚的男性音色，声音浑厚有力',
      },
      {
        id: 'xuanxu_gentle_female', name: '温柔女声', gender: 'female', age: 'young',
        emotion: 'warm', pitch: 0.95, speed: 0.92, volume: 0.90, isBuiltIn: true,
        ttsEngine: 'hybrid', piperModelId: 'zh_female_warm',
        edgeVoiceId: 'zh-CN-XiaohanNeural', ttsLabel: piperAvailable ? '在线(离线降级)' : '仅在线',
        description: '温柔细腻的女性音色，语调柔和舒缓',
      },
      {
        id: 'xuanxu_professional_male', name: '专业男声', gender: 'male', age: 'middle',
        emotion: 'professional', pitch: 0.95, speed: 0.88, volume: 0.90, isBuiltIn: true,
        ttsEngine: 'hybrid', piperModelId: 'zh_male',
        edgeVoiceId: 'zh-CN-YunyangNeural', ttsLabel: piperAvailable ? '在线(离线降级)' : '仅在线',
        description: '沉稳专业的男性商务音色，字正腔圆节奏稳',
      },
      {
        id: 'xuanxu_cheerful_female', name: '活泼女声', gender: 'female', age: 'young',
        emotion: 'cheerful', pitch: 1.1, speed: 1.15, volume: 1.0, isBuiltIn: true,
        ttsEngine: 'hybrid', piperModelId: 'zh_female_bright',
        edgeVoiceId: 'zh-CN-XiaoxiaoNeural', ttsLabel: piperAvailable ? '在线(离线降级)' : '仅在线',
        description: '元气满满的年轻女性音色，语调轻快有活力',
      },
      {
        id: 'xuanxu_elder_male', name: '慈祥男声', gender: 'male', age: 'senior',
        emotion: 'calm', pitch: 0.80, speed: 0.80, volume: 0.85, isBuiltIn: true,
        ttsEngine: 'hybrid', piperModelId: 'zh_male',
        edgeVoiceId: 'zh-CN-YunxiaNeural', ttsLabel: piperAvailable ? '在线(离线降级)' : '仅在线',
        description: '沧桑慈祥的男性音色，语速和缓沉稳',
      },
      {
        id: 'xuanxu_sweet_female', name: '甜美女声', gender: 'female', age: 'young',
        emotion: 'sweet', pitch: 1.08, speed: 1.06, volume: 0.98, isBuiltIn: true,
        ttsEngine: 'hybrid', piperModelId: 'zh_female_warm',
        edgeVoiceId: 'zh-CN-XiaochenNeural', ttsLabel: piperAvailable ? '在线(离线降级)' : '仅在线',
        description: '甜美可爱的女性音色，语调轻盈温柔',
      },
      {
        id: 'xuanxu_serious_male', name: '严肃男声', gender: 'male', age: 'middle',
        emotion: 'serious', pitch: 0.88, speed: 0.79, volume: 0.90, isBuiltIn: true,
        ttsEngine: 'hybrid', piperModelId: 'zh_male',
        edgeVoiceId: 'zh-CN-YunjianNeural', ttsLabel: piperAvailable ? '在线(离线降级)' : '仅在线',
        description: '严肃庄重的男性音色，语气坚定有力',
      },
    ]

    return voices
  }

  /* ------ voice:get-voices（渲染层 Voice 页调用） ------ */
  ipcMain.handle('voice:get-voices', () => listVoices())

  /* ------ voice:list-voices（兼容别名，设置页/其他渲染层调用） ------ */
  ipcMain.handle('voice:list-voices', () => listVoices())

  /* ------ voice:set-current ------ */
  ipcMain.handle('voice:set-current', async (_event, voiceId: string) => {
    const settings = loadSettings()
    settings.currentVoiceId = voiceId
    saveSettings(settings)
    return { success: true, currentVoiceId: voiceId }
  })

  /* ------ voice:get-current ------ */
  ipcMain.handle('voice:get-current', async () => {
    const settings = loadSettings()
    return { currentVoiceId: settings.currentVoiceId || voiceEngine.getSettings().currentVoiceId || 'xuanxu_warm_female' }
  })

  /* ------ voice:get-settings ------ */
  ipcMain.handle('voice:get-settings', async () => {
    const settings = loadSettings()
    return {
      currentVoiceId: settings.currentVoiceId || 'xuanxu_warm_female',
      speed: settings.speed ?? 1.0,
      pitch: settings.pitch ?? 1.0,
      volume: settings.volume ?? 0.9,
      ttsEngine: settings.ttsEngine || 'hybrid',
    }
  })

  /* ------ tts:speak ------ */
  ipcMain.handle('tts:speak', async (_event, params: {
    text: string
    voiceId?: string
    speed?: number
    pitch?: number
    volume?: number
  }) => {
    try {
      const piper = getPiper()
      if (!piper.isAvailable()) {
        return { success: false, error: 'Piper 离线引擎不可用，请确保已下载 Piper 语音模型', engine: 'piper' }
      }

      // 根据 voiceId 查找对应的 Piper 模型
      const voicePresets = {
        'xuanxu_warm_female': 'zh_female_warm',
        'xuanxu_gentle_female': 'zh_female_warm',
        'xuanxu_sweet_female': 'zh_female_warm',
        'xuanxu_bright_female': 'zh_female_bright',
        'xuanxu_cheerful_female': 'zh_female_bright',
        'xuanxu_calm_male': 'zh_male',
        'xuanxu_deep_male': 'zh_male',
        'xuanxu_professional_male': 'zh_male',
        'xuanxu_elder_male': 'zh_male',
        'xuanxu_serious_male': 'zh_male',
      } as Record<string, string>

      const modelId = voicePresets[params.voiceId || 'xuanxu_warm_female'] || 'zh_female_warm'

      const result = await piper.speak(
        params.text,
        modelId,
        {
          speed: params.speed,
          timeout: 30000,
        }
      )

      return result
    } catch (e: any) {
      logger.error('[TTS IPC] tts:speak 失败:', e.message)
      return { success: false, error: e.message, engine: 'piper' }
    }
  })

  /* ------ voice:speak（渲染层 Home/Voice 页调用，转发 VoiceEngine.synthesize）------ */
  ipcMain.handle('voice:speak', async (_event, text: string, voiceId?: string) => {
    try {
      if (!text || typeof text !== 'string') {
        return { success: false, error: 'text 参数无效', engine: 'none', ttsLabel: '未知' }
      }
      return await voiceEngine.synthesize(text, voiceId)
    } catch (e: any) {
      logger.error('[TTS IPC] voice:speak 失败:', e?.message ?? e)
      return { success: false, error: String(e?.message ?? e), engine: 'fallback', ttsLabel: '降级到浏览器语音', fallback: true, fallbackText: text }
    }
  })

  /* ------ piper:needs-download ------ */
  ipcMain.handle('piper:needs-download', () => {
    try {
      return getPiper().needsDownload()
    } catch (e: any) {
      logger.error('[TTS IPC] piper:needs-download 失败:', e?.message ?? e)
      return true
    }
  })

  /* ------ piper:download ------ */
  ipcMain.handle('piper:download', async () => {
    try {
      const ok = await getPiper().downloadPiper()
      return { success: ok }
    } catch (e: any) {
      logger.error('[TTS IPC] piper:download 失败:', e?.message ?? e)
      return { success: false, error: String(e?.message ?? e) }
    }
  })

  /* ------ piper:download-models ------ */
  ipcMain.handle('piper:download-models', async () => {
    try {
      const ok = await getPiper().downloadPiper()
      return { success: ok }
    } catch (e: any) {
      logger.error('[TTS IPC] piper:download-models 失败:', e?.message ?? e)
      return { success: false, error: String(e?.message ?? e) }
    }
  })

  /* ------ voice:speech-input（SenseVoice 离线 ASR）------ */
  ipcMain.handle('voice:speech-input', async (_event, params?: { action?: 'start' | 'stop' | 'recognize'; audio?: unknown }) => {
    try {
      const action = params?.action || 'recognize'
      if (action === 'start') {
        await voiceEngine.startASR()
        return { success: true, started: true }
      }
      if (action === 'stop') {
        voiceEngine.stopASR()
        return { success: true, stopped: true }
      }
      if (params?.audio) {
        voiceEngine.feedASRAudio(params.audio)
      }
      const result = await voiceEngine.getASRResult()
      return { success: true, text: result.text, isFinal: result.isFinal }
    } catch (e: any) {
      logger.error('[TTS IPC] voice:speech-input 失败:', e?.message ?? e)
      return { success: false, error: String(e?.message ?? e) }
    }
  })

  logger.debug('[TTS IPC] Handler 注册完成')
}
