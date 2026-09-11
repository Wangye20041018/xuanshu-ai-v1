import path from "path"
import fs from "fs"
import { app } from "electron"
import { createLogger } from "../../shared/logger"
import { embeddedTTS } from "../tts/embedded-tts"

const logger = createLogger("VoiceEngine")

/**
 * VoiceEngine —— 高质量 TTS 播报引擎（v13 重构 · 对标豆包）
 *
 * 施工单 §6.1 + §6.2 落地：
 * - 已删除：语音唤醒（wake）、声纹（voiceprint）、ASR（SenseVoice）、
 *   语音讨论循环、语音克隆（CosyVoiceClone/MeloTTS/OpenVoice）、旧音色（Piper/Edge）。
 * - 保留并重构：单一高质量 TTS 播报（内嵌 sherpa-onnx vits-melo 中文），供「逐条朗读」与
 *   GlobalTtsPlayer（tts:speak/stop/pause/resume）使用。
 * - 音色策略：不再保留十数个旧 Piper/Edge 音色，仅内嵌一个高质量中文音色
 *   （id: xuanxu_hq_female），质量对标豆包，不做降级、不桥接在线服务。
 */

interface VoiceInfo {
  id: string
  name: string
  description: string
  gender: string
  age: string
  emotion: string
  language: string
  pitch: number
  speed: number
  volume: number
  isBuiltIn: boolean
  engine?: string
  ttsLabel?: string
}

export class VoiceEngine {
  voices = new Map<string, VoiceInfo>()
  settings = {
    currentVoiceId: "xuanxu_hq_female",
    volume: 1,
    speed: 1,
    pitch: 1,
    ttsEngine: "embedded",
    autoSpeak: false,
  }
  settingsPath: string | null = null
  voiceDir: string | null = null
  onVoiceChange: ((voiceId: string) => void) | undefined
  initialized = false
  currentAudioPath: string | null = null

  constructor() {}

  initialize() {
    if (this.initialized) return
    this.settingsPath = path.join(app.getPath("userData"), "voice-settings.json")
    this.voiceDir = path.join(app.getPath("userData"), "voices")
    try { fs.mkdirSync(this.voiceDir, { recursive: true }) } catch { /* 非关键 */ }
    embeddedTTS.initialize().then((ready) => {
      logger.debug(`[VoiceEngine] 内嵌高质量 TTS ${ready ? "就绪" : "未就绪（模型待下载）"}`)
    }).catch((e) => {
      logger.error(`[VoiceEngine] 内嵌 TTS 初始化失败: ${e}`)
    })
    this.loadSettings()
    this.registerBuiltInVoices()
    this.initialized = true
    logger.debug(`[VoiceEngine] 初始化完成（内嵌 TTS），音色数=${this.voices.size}`)
  }

  getSettingsPath(): string {
    if (!this.settingsPath) this.initialize()
    return this.settingsPath!
  }

  getVoiceDirInternal(): string {
    if (!this.voiceDir) this.initialize()
    return this.voiceDir!
  }

  registerBuiltInVoices() {
    // §6.2：仅内嵌一个高质量中文音色（对标豆包），不再保留旧 Piper/Edge 音色。
    const builtIn: VoiceInfo[] = [
      {
        id: "xuanxu_hq_female",
        name: "玄枢自然女声",
        description: "内嵌 CosyVoice 2 高质量中文音色，自然度与情感层次对标豆包，本地离线发音",
        gender: "female",
        age: "young",
        emotion: "warm",
        language: "zh-CN",
        pitch: 1,
        speed: 1,
        volume: 1,
        isBuiltIn: true,
        engine: "embedded",
        ttsLabel: "本地离线",
      },
    ]
    builtIn.forEach((v) => this.voices.set(v.id, v))
  }

  loadSettings() {
    const p = this.getSettingsPath()
    if (fs.existsSync(p)) {
      try {
        this.settings = { ...this.settings, ...JSON.parse(fs.readFileSync(p, "utf-8")) }
      } catch (e) {
        logger.error(`[VoiceEngine] 加载语音设置失败: ${e}`)
      }
    }
  }

  saveSettings() {
    const p = this.getSettingsPath()
    try { fs.writeFileSync(p, JSON.stringify(this.settings, null, 2)) } catch (e) { logger.error(`[VoiceEngine] 保存设置失败: ${e}`) }
  }

  getVoices() {
    return Array.from(this.voices.values())
  }

  getVoice(id: string) {
    return this.voices.get(id)
  }

  getCurrentVoice() {
    return this.voices.get(this.settings.currentVoiceId) || this.voices.get("xuanxu_hq_female")
  }

  setCurrentVoice(voiceId: string) {
    if (this.voices.has(voiceId)) {
      this.settings.currentVoiceId = voiceId
      this.saveSettings()
      this.onVoiceChange?.(voiceId)
      return true
    }
    return false
  }

  getSettings() {
    return { ...this.settings }
  }

  updateSettings(settings: Partial<typeof this.settings>) {
    this.settings = { ...this.settings, ...settings }
    this.saveSettings()
  }

  setVolume(volume: number) {
    this.settings.volume = Math.max(0, Math.min(1, volume))
    this.saveSettings()
  }

  setSpeed(speed: number) {
    this.settings.speed = Math.max(0.5, Math.min(2, speed))
    this.saveSettings()
  }

  setPitch(pitch: number) {
    this.settings.pitch = Math.max(0.5, Math.min(2, pitch))
    this.saveSettings()
  }

  setOnVoiceChange(callback: (voiceId: string) => void) {
    this.onVoiceChange = callback
  }

  /* ============================================================
   * 核心 TTS 合成 —— 统一走内嵌高质量 TTS（CosyVoice 2）
   * ============================================================ */
  async synthesize(text: string, voiceId?: string, overrides?: { speed?: number; pitch?: number; volume?: number }) {
    const effectiveVoiceId = voiceId || this.settings.currentVoiceId || "xuanxu_hq_female"
    const effSpeed = overrides?.speed ?? this.settings.speed
    const voice = this.voices.get(effectiveVoiceId)
    if (!voice) {
      return { success: false, error: `音色 "${effectiveVoiceId}" 不存在`, engine: "none", ttsLabel: "未知" }
    }
    const result = await embeddedTTS.synthesize(text, { speed: effSpeed, pitch: overrides?.pitch ?? this.settings.pitch })
    if (result.success && result.audioPath) {
      this.currentAudioPath = result.audioPath
    }
    return {
      success: result.success,
      audioPath: result.audioPath,
      error: result.error,
      engine: "embedded",
      ttsLabel: "本地离线",
    }
  }

  /** 播报（向后兼容：合成后广播 tts:speak 到渲染进程） */
  async speak(text: string, options?: any) {
    try {
      const voiceId = options?.voiceId || this.settings.currentVoiceId
      const result = await this.synthesize(text, voiceId)
      const { getMainWindow } = require("../index")
      const { sendToWindow } = require("../utils/broadcast")
      sendToWindow(getMainWindow(), "tts:speak", {
        text,
        options,
        settings: this.settings,
        voice: this.getCurrentVoice(),
        audioPath: result.audioPath,
        engine: result.engine,
        success: result.success,
      })
    } catch (e) {
      logger.error(`[VoiceEngine] speak 广播失败: ${e}`)
      const { getMainWindow } = require("../index")
      const { sendToWindow } = require("../utils/broadcast")
      sendToWindow(getMainWindow(), "tts:speak", {
        text,
        options,
        settings: this.settings,
        voice: this.getCurrentVoice(),
        success: false,
        error: "语音合成遇到内部错误",
      })
    }
  }

  stopSpeaking() {
    embeddedTTS.stop()
    const { getMainWindow } = require("../index")
    const { sendToWindow } = require("../utils/broadcast")
    sendToWindow(getMainWindow(), "tts:stop")
  }

  pauseSpeaking() {
    const { getMainWindow } = require("../index")
    const { sendToWindow } = require("../utils/broadcast")
    sendToWindow(getMainWindow(), "tts:pause")
  }

  resumeSpeaking() {
    const { getMainWindow } = require("../index")
    const { sendToWindow } = require("../utils/broadcast")
    sendToWindow(getMainWindow(), "tts:resume")
  }

  getVoiceDir() {
    return this.getVoiceDirInternal()
  }
}

export const voiceEngine = new VoiceEngine()
