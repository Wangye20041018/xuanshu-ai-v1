/* ============================================================
 * TTS IPC Handlers —— 内嵌高质量 TTS（CosyVoice 2）
 *
 * 施工单 §6.2：删除旧 Piper/Edge 音色，统一走内嵌高质量 TTS。
 * 提供前端所需的播报通道（豆包「逐条朗读」+ GlobalTtsPlayer 保留项）：
 * - tts:speak     → 合成并播放文本
 * - voice:speak   → 渲染层播报（兼容通道）
 * - tts:stop / tts:pause / tts:resume → 由 voice-engine 广播，见 voice-engine/index.ts
 * ============================================================ */

import { ipcMain, app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { voiceEngine } from '../voice-engine'
import { logger } from '../../shared/logger'

/* ============================================================
 * 音色设置读写（保持 voice-settings.json 兼容）
 * ============================================================ */
interface VoiceSettings {
  currentVoiceId?: string
  speed?: number
  pitch?: number
  volume?: number
  ttsEngine?: string
  autoSpeak?: boolean
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
  /* ------ voice:tts-status —— 内嵌 TTS 引擎状态（零假显示） ------ */
  ipcMain.handle('voice:tts-status', async () => {
    await voiceEngine.initialize()
    const ready = (await import('../tts/embedded-tts')).embeddedTTS.isReady()
    return {
      engine: 'embedded',
      engineLabel: '内嵌 CosyVoice 2',
      ready,
      voices: voiceEngine.getVoices().map((v: any) => ({ id: v.id, name: v.name })),
    }
  })

  /* ------ voice:get-voices / voice:list-voices ------ */
  async function listVoices() {
    return voiceEngine.getVoices().map((v: any) => ({
      id: v.id,
      name: v.name,
      gender: v.gender,
      isBuiltIn: v.isBuiltIn,
      engine: v.engine || 'embedded',
      ttsLabel: v.ttsLabel || '本地离线',
      description: v.description,
    }))
  }
  ipcMain.handle('voice:get-voices', () => listVoices())
  ipcMain.handle('voice:list-voices', () => listVoices())

  /* ------ voice:set-current ------ */
  ipcMain.handle('voice:set-current', async (_event, voiceId: string) => {
    const settings = loadSettings()
    settings.currentVoiceId = voiceId
    saveSettings(settings)
    voiceEngine.setCurrentVoice(voiceId)
    return { success: true, currentVoiceId: voiceId }
  })

  /* ------ voice:get-current ------ */
  ipcMain.handle('voice:get-current', async () => {
    const settings = loadSettings()
    return { currentVoiceId: settings.currentVoiceId || voiceEngine.getSettings().currentVoiceId || 'xuanxu_hq_female' }
  })

  /* ------ voice:get-settings ------ */
  ipcMain.handle('voice:get-settings', async () => {
    const settings = loadSettings()
    return {
      currentVoiceId: settings.currentVoiceId || 'xuanxu_hq_female',
      speed: settings.speed ?? 1.0,
      pitch: settings.pitch ?? 1.0,
      volume: settings.volume ?? 0.9,
      ttsEngine: settings.ttsEngine || 'embedded',
      autoSpeak: settings.autoSpeak ?? false,
    }
  })

  /* ------ voice:update-settings ------ */
  ipcMain.handle('voice:update-settings', async (_event, patch: { speed?: number; pitch?: number; volume?: number; autoSpeak?: boolean }) => {
    const settings = loadSettings()
    if (patch && typeof patch === 'object') {
      if (typeof patch.speed === 'number') settings.speed = patch.speed
      if (typeof patch.pitch === 'number') settings.pitch = patch.pitch
      if (typeof patch.volume === 'number') settings.volume = patch.volume
      if (typeof patch.autoSpeak === 'boolean') settings.autoSpeak = patch.autoSpeak
    }
    saveSettings(settings)
    voiceEngine.settings = { ...voiceEngine.settings, ...settings }
    return { success: true, ...settings }
  })

  /* ------ tts:speak（播报主通道） ------ */
  ipcMain.handle('tts:speak', async (_event, params: { text: string; voiceId?: string; speed?: number; pitch?: number; volume?: number }) => {
    try {
      if (!params?.text) {
        return { success: false, error: 'text 参数无效', engine: 'none', ttsLabel: '未知' }
      }
      const effectiveVoiceId = params.voiceId || loadSettings().currentVoiceId || voiceEngine.getSettings().currentVoiceId || 'xuanxu_hq_female'
      return await voiceEngine.synthesize(params.text, effectiveVoiceId, {
        speed: params.speed,
        pitch: params.pitch,
        volume: params.volume,
      })
    } catch (e: any) {
      logger.error('[TTS IPC] tts:speak 失败:', e?.message ?? e)
      return { success: false, error: String(e?.message ?? e), engine: 'embedded' }
    }
  })

  /* ------ voice:speak（渲染层播报兼容通道） ------ */
  ipcMain.handle('voice:speak', async (_event, text: string, voiceId?: string, overrides?: { speed?: number; pitch?: number; volume?: number }) => {
    try {
      if (!text || typeof text !== 'string') {
        return { success: false, error: 'text 参数无效', engine: 'none', ttsLabel: '未知' }
      }
      const effectiveVoiceId = voiceId || loadSettings().currentVoiceId || voiceEngine.getSettings().currentVoiceId || 'xuanxu_hq_female'
      return await voiceEngine.synthesize(text, effectiveVoiceId, overrides)
    } catch (e: any) {
      logger.error('[TTS IPC] voice:speak 失败:', e?.message ?? e)
      return { success: false, error: String(e?.message ?? e), engine: 'embedded' }
    }
  })

  logger.debug('[TTS IPC] Handler 注册完成（内嵌 CosyVoice 2）')
}
