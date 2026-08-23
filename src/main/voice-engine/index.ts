import path from "path"
import fs from "fs"
import { app, BrowserWindow, ipcMain } from "electron"
import { createLogger } from "../../shared/logger"
import { piperTTS } from "../tts/piper"
import { edgeTTS } from "../tts/edge"
import { openvoiceBridge } from "./openvoice-bridge"
import { SenseVoiceASR } from "./sensevoice-asr"
import { MeloTTS } from "./melotts-tts"
import { CosyVoiceClone } from "./cosyvoice-clone"
import { voiceWakeService } from "../wake"
import { getStore } from "../ipc/config.ipc"
import { LLMProviderRegistry } from "../llm/provider-registry"
import { verifyVoiceprintDirect } from "../ipc/voiceprint.ipc"

const logger = createLogger("VoiceEngine")

const VOICE_TTS_MAP: Record<string, { piperModelId: string; piperPitch?: number; piperSpeed?: number; edgeVoiceId: string; ttsEngine: string; ttsLabel: string }> = {
  xuanxu_warm_female: {
    piperModelId: "zh_female_warm",
    edgeVoiceId: "zh-CN-XiaoxiaoNeural",
    ttsEngine: "hybrid",
    ttsLabel: "在线(离线降级)"
  },
  xuanxu_calm_male: {
    piperModelId: "zh_male",
    edgeVoiceId: "zh-CN-YunxiNeural",
    ttsEngine: "hybrid",
    ttsLabel: "在线(离线降级)"
  },
  xuanxu_bright_female: {
    piperModelId: "zh_female_bright",
    edgeVoiceId: "zh-CN-XiaoyiNeural",
    ttsEngine: "hybrid",
    ttsLabel: "在线(离线降级)"
  },
  xuanxu_deep_male: {
    piperModelId: "zh_male",
    piperPitch: 0.9,
    piperSpeed: 0.95,
    edgeVoiceId: "zh-CN-YunjianNeural",
    ttsEngine: "hybrid",
    ttsLabel: "在线(离线降级)"
  },
  xuanxu_gentle_female: {
    piperModelId: "zh_female_warm",
    piperPitch: 0.95,
    piperSpeed: 0.95,
    edgeVoiceId: "zh-CN-XiaohanNeural",
    ttsEngine: "hybrid",
    ttsLabel: "在线(离线降级)"
  },
  xuanxu_professional_male: {
    piperModelId: "zh_male",
    piperPitch: 0.95,
    piperSpeed: 0.95,
    edgeVoiceId: "zh-CN-YunyangNeural",
    ttsEngine: "hybrid",
    ttsLabel: "在线(离线降级)"
  },
  xuanxu_cheerful_female: {
    piperModelId: "zh_female_bright",
    piperPitch: 1.08,
    piperSpeed: 1.05,
    edgeVoiceId: "zh-CN-XiaoxiaoNeural",
    ttsEngine: "hybrid",
    ttsLabel: "在线(离线降级)"
  },
  xuanxu_elder_male: {
    piperModelId: "zh_male",
    piperPitch: 0.8,
    piperSpeed: 0.85,
    edgeVoiceId: "zh-CN-YunxiaNeural",
    ttsEngine: "hybrid",
    ttsLabel: "在线(离线降级)"
  },
  xuanxu_sweet_female: {
    piperModelId: "zh_female_warm",
    edgeVoiceId: "zh-CN-XiaochenNeural",
    ttsEngine: "hybrid",
    ttsLabel: "在线(离线降级)"
  },
  xuanxu_serious_male: {
    piperModelId: "zh_male",
    edgeVoiceId: "zh-CN-YunjianNeural",
    ttsEngine: "hybrid",
    ttsLabel: "在线(离线降级)"
  }
}

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
  piperModelId?: string
  piperPitch?: number
  piperSpeed?: number
  edgeVoiceId?: string
  ttsEngine?: string
  ttsLabel?: string
}

export class VoiceEngine {
  voices = new Map<string, VoiceInfo>()
  settings = {
    currentVoiceId: "xuanxu_warm_female",
    volume: 1,
    speed: 1,
    pitch: 1,
    emotionEnabled: true,
    personalizeEnabled: false
  }
  settingsPath: string | null = null
  voiceDir: string | null = null
  onVoiceChange: ((voiceId: string) => void) | undefined
  initialized = false
  currentAudioPath: string | null = null
  discussionActive = false
  discussionAbortController: AbortController | null = null
  exitConfirmActive = false
  /** 最新音频缓冲区（由渲染进程通过 voice:speech-audio 发送） */
  latestAudioBuffer: unknown = null
  /** 语音文本到达时的 resolve 回调 */
  speechTextResolver: ((text: string) => void) | null = null
  /* ---------- 语音小模型引擎 ---------- */
  senseVoiceASR: SenseVoiceASR | null = null
  meloTTS: MeloTTS | null = null
  cosyVoiceClone: CosyVoiceClone | null = null

  constructor() {}

  initialize() {
    if (this.initialized) return
    this.settingsPath = path.join(app.getPath("userData"), "voice-settings.json")
    this.voiceDir = path.join(app.getPath("userData"), "voices")
    fs.mkdirSync(this.voiceDir, { recursive: true })
    piperTTS.initialize()
    edgeTTS.initialize()
    openvoiceBridge.initialize().then((ready) => {
      logger.debug(`[VoiceEngine] OpenVoice 桥接 ${ready ? "就绪" : "未就绪"}`)
    }).catch((e) => {
      logger.error(`[VoiceEngine] OpenVoice 桥接初始化失败: ${e}`)
    })
    this.loadSettings()
    this.registerBuiltInVoices()
    this.loadCustomVoices()
    this.initialized = true
    logger.debug(`[VoiceEngine] 初始化完成: Piper可用=${piperTTS.isAvailable()}, 语音包数=${this.voices.size}`)
  }

  getSettingsPath(): string {
    if (!this.settingsPath) {
      this.initialize()
    }
    return this.settingsPath!
  }

  getVoiceDirInternal(): string {
    if (!this.voiceDir) {
      this.initialize()
    }
    return this.voiceDir!
  }

  getTTSMapping(voiceId: string) {
    const voice = this.voices.get(voiceId)
    const mapped = VOICE_TTS_MAP[voiceId]
    if (mapped) return mapped
    if (voice) {
      const isMale = voice.gender === "male" || voice.id.includes("male")
      const piperModelId = isMale ? "zh_male" : "zh_female_warm"
      const edgeVoiceId = isMale ? "zh-CN-YunxiNeural" : "zh-CN-XiaoxiaoNeural"
      return { piperModelId, edgeVoiceId, ttsEngine: "hybrid", ttsLabel: "在线(离线降级)" }
    }
    return {
      piperModelId: "zh_female_warm",
      edgeVoiceId: "zh-CN-XiaoxiaoNeural",
      ttsEngine: "hybrid",
      ttsLabel: "在线(离线降级)"
    }
  }

  registerBuiltInVoices() {
    const builtInVoices: VoiceInfo[] = [
      {
        id: "xuanxu_warm_female",
        name: "温暖女声",
        description: "温暖亲切的女性音色，语调柔和自然，适合日常助手、情感交流和轻松聊天",
        gender: "female",
        age: "young",
        emotion: "warm",
        language: "zh-CN",
        pitch: 1,
        speed: 0.97,
        volume: 0.95,
        isBuiltIn: true,
        ...VOICE_TTS_MAP["xuanxu_warm_female"]
      },
      {
        id: "xuanxu_calm_male",
        name: "沉稳男声",
        description: "冷静理性的男性音色，语速从容节奏分明，适合系统播报、监控通知和技术讲解",
        gender: "male",
        age: "middle",
        emotion: "calm",
        language: "zh-CN",
        pitch: 0.9,
        speed: 0.82,
        volume: 0.85,
        isBuiltIn: true,
        ...VOICE_TTS_MAP["xuanxu_calm_male"]
      },
      {
        id: "xuanxu_bright_female",
        name: "明亮女声",
        description: "明亮清脆的女性音色，语调活泼有辨识度，适合语音助手、导航播报和提醒通知",
        gender: "female",
        age: "young",
        emotion: "cheerful",
        language: "zh-CN",
        pitch: 1.05,
        speed: 1.05,
        volume: 1,
        isBuiltIn: true,
        ...VOICE_TTS_MAP["xuanxu_bright_female"]
      },
      {
        id: "xuanxu_deep_male",
        name: "阳刚男声",
        description: "低沉阳刚的男性音色，声音浑厚有力，适合权威播报、重要通知和正式演讲",
        gender: "male",
        age: "middle",
        emotion: "professional",
        language: "zh-CN",
        pitch: 0.85,
        speed: 0.88,
        volume: 0.9,
        isBuiltIn: true,
        ...VOICE_TTS_MAP["xuanxu_deep_male"]
      },
      {
        id: "xuanxu_gentle_female",
        name: "温柔女声",
        description: "温柔细腻的女性音色，语调柔和舒缓，适合睡前故事、冥想引导和情感陪伴",
        gender: "female",
        age: "young",
        emotion: "warm",
        language: "zh-CN",
        pitch: 0.95,
        speed: 0.92,
        volume: 0.9,
        isBuiltIn: true,
        ...VOICE_TTS_MAP["xuanxu_gentle_female"]
      },
      {
        id: "xuanxu_professional_male",
        name: "专业男声",
        description: "沉稳专业的男性商务音色，字正腔圆节奏稳，适合数据播报、分析报告和正式场合",
        gender: "male",
        age: "middle",
        emotion: "professional",
        language: "zh-CN",
        pitch: 0.95,
        speed: 0.88,
        volume: 0.9,
        isBuiltIn: true,
        ...VOICE_TTS_MAP["xuanxu_professional_male"]
      },
      {
        id: "xuanxu_cheerful_female",
        name: "活泼女声",
        description: "元气满满的年轻女性音色，语调轻快有活力，适合轻松互动、游戏聊天和娱乐场景",
        gender: "female",
        age: "young",
        emotion: "cheerful",
        language: "zh-CN",
        pitch: 1.1,
        speed: 1.15,
        volume: 1,
        isBuiltIn: true,
        ...VOICE_TTS_MAP["xuanxu_cheerful_female"]
      },
      {
        id: "xuanxu_elder_male",
        name: "慈祥男声",
        description: "沧桑慈祥的男性音色，语速和缓沉稳，适合长辈陪伴、历史讲述和传统文化内容",
        gender: "male",
        age: "senior",
        emotion: "calm",
        language: "zh-CN",
        pitch: 0.8,
        speed: 0.8,
        volume: 0.85,
        isBuiltIn: true,
        ...VOICE_TTS_MAP["xuanxu_elder_male"]
      },
      {
        id: "xuanxu_sweet_female",
        name: "甜美女声",
        description: "甜美可爱的女性音色，语调轻盈温柔，适合早安问候、温馨提醒和陪伴关怀",
        gender: "female",
        age: "young",
        emotion: "sweet",
        language: "zh-CN",
        pitch: 1.08,
        speed: 1.06,
        volume: 0.98,
        isBuiltIn: true,
        ...VOICE_TTS_MAP["xuanxu_sweet_female"]
      },
      {
        id: "xuanxu_serious_male",
        name: "严肃男声",
        description: "严肃庄重的男性音色，语气坚定有力，适合安全警告、重要通知和紧急播报",
        gender: "male",
        age: "middle",
        emotion: "serious",
        language: "zh-CN",
        pitch: 0.88,
        speed: 0.79,
        volume: 0.9,
        isBuiltIn: true,
        ...VOICE_TTS_MAP["xuanxu_serious_male"]
      }
    ]
    builtInVoices.forEach((voice) => {
      this.voices.set(voice.id, voice)
    })
  }

  loadCustomVoices() {
    const voiceDir = this.getVoiceDirInternal()
    const customVoicesPath = path.join(voiceDir, "custom-voices.json")
    if (fs.existsSync(customVoicesPath)) {
      try {
        const customVoices = JSON.parse(fs.readFileSync(customVoicesPath, "utf-8"))
        customVoices.forEach((voice: VoiceInfo) => {
          voice.isBuiltIn = false
          if (!voice.ttsEngine) {
            voice.ttsEngine = "hybrid"
            voice.ttsLabel = "在线(离线降级)"
          }
          this.voices.set(voice.id, voice)
        })
      } catch (e) {
        logger.error(`[VoiceEngine] 加载自定义语音失败: ${e}`)
      }
    }
  }

  saveCustomVoices() {
    const customVoices = Array.from(this.voices.values()).filter((v) => !v.isBuiltIn)
    const voiceDir = this.getVoiceDirInternal()
    const customVoicesPath = path.join(voiceDir, "custom-voices.json")
    fs.writeFileSync(customVoicesPath, JSON.stringify(customVoices, null, 2))
  }

  loadSettings() {
    const settingsPath = this.getSettingsPath()
    if (fs.existsSync(settingsPath)) {
      try {
        this.settings = { ...this.settings, ...JSON.parse(fs.readFileSync(settingsPath, "utf-8")) }
      } catch (e) {
        logger.error(`[VoiceEngine] 加载语音设置失败: ${e}`)
      }
    }
  }

  saveSettings() {
    const settingsPath = this.getSettingsPath()
    fs.writeFileSync(settingsPath, JSON.stringify(this.settings, null, 2))
  }

  getVoices() {
    return Array.from(this.voices.values())
  }

  getVoice(id: string) {
    return this.voices.get(id)
  }

  getCurrentVoice() {
    return this.voices.get(this.settings.currentVoiceId)
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

  addCustomVoice(voice: VoiceInfo) {
    if (this.voices.has(voice.id)) {
      return false
    }
    this.voices.set(voice.id, { ...voice, isBuiltIn: false })
    this.saveCustomVoices()
    return true
  }

  removeCustomVoice(voiceId: string) {
    const voice = this.voices.get(voiceId)
    if (voice && !voice.isBuiltIn) {
      this.voices.delete(voiceId)
      this.saveCustomVoices()
      if (this.settings.currentVoiceId === voiceId) {
        this.settings.currentVoiceId = "xuanxu_warm_female"
        this.saveSettings()
      }
      return true
    }
    return false
  }

  searchVoices(query: string) {
    const queryLower = query.toLowerCase()
    return Array.from(this.voices.values()).filter(
      (voice) => voice.name.toLowerCase().includes(queryLower) || voice.description.toLowerCase().includes(queryLower) || voice.emotion.includes(queryLower) || voice.gender.includes(queryLower)
    )
  }

  getVoicesByEmotion(emotion: string) {
    return Array.from(this.voices.values()).filter((v) => v.emotion === emotion)
  }

  getVoicesByGender(gender: string) {
    return Array.from(this.voices.values()).filter((v) => v.gender === gender)
  }

  /* ============================================================
   * 语音讨论功能
   * ============================================================ */
  async startDiscussion() {
    try {
      if (this.discussionActive) return true
      this.discussionActive = true
      this.discussionAbortController = new AbortController()
      this.exitConfirmActive = false
      this.latestAudioBuffer = null
      voiceWakeService.setOnExitRequested(async (confirmTTS) => {
        logger.debug(`[VoiceEngine] 收到退出确认请求，播报: ${confirmTTS}`)
        await this.handleExitConfirmTTS(confirmTTS)
      })
      voiceWakeService.setOnExitConfirmed(() => {
        logger.debug("[VoiceEngine] 退出已确认，停止讨论")
        this.stopDiscussion()
      })
      voiceWakeService.setOnExitCancelled(() => {
        logger.debug("[VoiceEngine] 退出已取消，继续对话")
      })
      voiceWakeService.setOnVoiceTextForward((text) => {
        if (this.speechTextResolver) {
          const resolver = this.speechTextResolver
          this.speechTextResolver = null
          resolver(text)
        }
      })
      this.registerAudioDataListener()
      const mod = await import("../index")
      try {
        // M-13 修复：通过 getMainWindow 获取动态主窗口引用
        mod.getMainWindow()?.webContents.send("voice:discussion:started")
      } catch {
      // 非关键操作，失败可安全忽略
      }
      logger.debug("[VoiceEngine] 语音讨论已启动 - 持续对话模式")
      this.discussionLoop().catch((err) => {
        logger.error(`[VoiceEngine] 讨论循环异常: ${err}`)
        this.stopDiscussion()
      })
      return true
    } catch (e) {
      logger.error(`[VoiceEngine] 启动讨论失败: ${e}`)
      this.discussionActive = false
      return false
    }
  }

  stopDiscussion() {
    try {
      if (!this.discussionActive) return false
      this.discussionActive = false
      this.discussionAbortController?.abort()
      this.discussionAbortController = null
      this.latestAudioBuffer = null
      if (this.speechTextResolver) {
        this.speechTextResolver("")
        this.speechTextResolver = null
      }
      // M-13 修复：通过 getMainWindow 获取动态主窗口引用
      const { getMainWindow } = require("../index")
      getMainWindow()?.webContents?.send("voice:discussion:stopped")
      logger.debug("[VoiceEngine] 语音讨论已停止")
      return true
    } catch (e) {
      logger.error(`[VoiceEngine] 停止讨论失败: ${e}`)
      return false
    }
  }

  /**
   * 处理退出确认 TTS 播报
   * 播报完成后通知 wake 进入等待确认状态
   */
  async handleExitConfirmTTS(confirmTTS: string) {
    try {
      this.exitConfirmActive = true
      const result = await this.synthesize(confirmTTS)
      if (result.success && result.audioPath) {
        const mainWin = BrowserWindow.getAllWindows()[0]
        if (mainWin && !mainWin.isDestroyed()) {
          try {
            mainWin.webContents.send("tts:speak", {
              text: confirmTTS,
              options: {},
              settings: this.settings,
              voice: this.getCurrentVoice(),
              audioPath: result.audioPath,
              engine: result.engine,
              success: true
            })
          } catch {
          // 非关键操作，失败可安全忽略
          }
        }
        const estimatedMs = Math.max(2000, confirmTTS.length * 250)
        setTimeout(() => {
          voiceWakeService.onExitConfirmTTSSpoke()
          this.exitConfirmActive = false
        }, estimatedMs)
      } else {
        voiceWakeService.onExitConfirmTTSSpoke()
        this.exitConfirmActive = false
      }
    } catch (e) {
      logger.error(`[VoiceEngine] 退出确认 TTS 异常: ${e}`)
      voiceWakeService.onExitConfirmTTSSpoke()
      this.exitConfirmActive = false
    }
  }

  /**
   * 持续对话循环：
   * 监听语音输入 → 声纹验证 → 识别文本 → 检测退出词 → 发送LLM → TTS朗读回复 → 继续监听
   *
   * v2.3 声纹验证：
   * - 识别用户声音（已注册声纹匹配）
   * - 踢出他人声音（声纹不匹配 → 拒绝并提示）
   * - 过滤环境噪音（RMS能量过低 → 忽略）
   */
  async discussionLoop() {
    while (this.discussionActive) {
      try {
        if (this.discussionAbortController?.signal.aborted) break
        const recognizedText = await this.waitForSpeechInput(15000)
        if (this.exitConfirmActive) continue
        if (!recognizedText) continue
        const voiceprintPassed = await this.verifyVoiceprint()
        if (!voiceprintPassed) {
          if (this.discussionActive && !this.exitConfirmActive) {
            try {
              await this.speak("声纹验证未通过，请确认是本人操作", {
                voiceId: this.settings.currentVoiceId,
                speed: this.settings.speed,
                volume: this.settings.volume
              })
            } catch {
            // 非关键操作，失败可安全忽略
            }
          }
          continue
        }
        try {
          voiceWakeService.onVoiceRecognized(recognizedText)
          if (!this.discussionActive || this.exitConfirmActive) continue
        } catch {
        // 非关键操作，失败可安全忽略
        }
        let response = ""
        try {
          const store = getStore()
          const llmCfg: any = store.get("llm") || {}
          const activeProviderId: string | null = llmCfg?.activeProviderId ?? null
          const isApiProvider = activeProviderId && activeProviderId !== "__local_cpu__" && activeProviderId !== "__local_sglang__"
          if (isApiProvider) {
            const provider: any = LLMProviderRegistry.getProvider(activeProviderId)
            if (provider) {
              const messages = [{
                id: `voice-${Date.now()}`,
                role: "user",
                content: recognizedText
              }]
              response = await provider.generate(messages)
              logger.debug(`[VoiceEngine] API provider 响应: ${response.length} 字符`)
            }
          }
          if (!response) {
            const mod = await import("../model-manager")
            response = await mod.modelManager.generateResponse(
              recognizedText,
              { temperature: 0.7, maxTokens: 512 }
            )
          }
        } catch (e: any) {
          logger.error(`[VoiceEngine] LLM推理失败: ${e.message}，回退本地模型`)
          try {
            const mod = await import("../model-manager")
            response = await mod.modelManager.generateResponse(
              recognizedText,
              { temperature: 0.7, maxTokens: 512 }
            )
          } catch (e2: any) {
            logger.error(`[VoiceEngine] 本地模型也失败: ${e2.message}`)
            continue
          }
        }
        if (response && this.discussionActive && !this.exitConfirmActive) {
          await this.speak(response, {
            voiceId: this.settings.currentVoiceId,
            speed: this.settings.speed,
            volume: this.settings.volume
          })
        }
        if (this.discussionActive && !this.exitConfirmActive) {
          voiceWakeService.stayInListening()
        }
      } catch (err: any) {
        if (err?.name === "AbortError" || !this.discussionActive) break
        logger.error(`[VoiceEngine] 讨论循环迭代错误: ${err}`)
      }
    }
  }

  /**
   * v2.3: 等待语音输入（通过 wake 服务回调，替代 IPC 监听）
   */
  waitForSpeechInput(timeoutMs: number) {
    return new Promise<string>((resolve) => {
      const signal = this.discussionAbortController?.signal
      let timeout: NodeJS.Timeout
      this.speechTextResolver = (text) => {
        clearTimeout(timeout)
        resolve(text || "")
      }
      timeout = setTimeout(() => {
        this.speechTextResolver = null
        resolve("")
      }, timeoutMs)
      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(timeout)
          this.speechTextResolver = null
          resolve("")
        }, { once: true })
      }
    })
  }

  /**
   * v2.3: 声纹验证 — 识别用户声音，踢出他人声音和环境噪音
   *
   * 流程：
   *   1. 检查是否已注册声纹（未注册则跳过验证，允许所有输入）
   *   2. 检查是否有可用音频数据（无音频则跳过）
   *   3. 调用 verifyVoiceprintDirect 进行噪声检测 + MFCC 匹配
   *   4. 匹配成功 → 返回 true（允许继续）
   *   5. 匹配失败 → 返回 false（拒绝处理）
   */
  async verifyVoiceprint() {
    try {
      const store = getStore()
      const vp = store.get("voiceprint")
      const hasSamples = vp?.samples && vp.samples.length > 0
      if (!hasSamples) {
        return true
      }
      const audioData = this.latestAudioBuffer
      if (!audioData || (audioData as any[]).length === 0) {
        logger.debug("[VoiceEngine] 声纹验证跳过：无音频数据")
        return true
      }
      const result: any = await verifyVoiceprintDirect(audioData as Float32Array)
      if (result.match) {
        logger.debug(`[VoiceEngine] 声纹验证通过，得分 ${result.score.toFixed(3)}`)
        return true
      }
      const reason = result.reason || "unknown"
      if (reason.startsWith("noise:")) {
        logger.debug(`[VoiceEngine] 声纹验证拒绝（环境噪音）: ${reason}`)
      } else if (reason === "not_enrolled") {
        logger.debug("[VoiceEngine] 声纹验证跳过：未注册")
        return true
      } else {
        logger.debug(`[VoiceEngine] 声纹验证拒绝（他人声音）: score=${result.score}, reason=${reason}`)
      }
      return false
    } catch (e: any) {
      logger.error(`[VoiceEngine] 声纹验证异常: ${e.message}`)
      return true
    }
  }

  /**
   * v2.3: 注册音频数据监听器（接收渲染进程的原始音频用于声纹验证）
   */
  registerAudioDataListener() {
    const handler = (_e: any, audioData: unknown) => {
      if (audioData && (audioData as any[]).length > 0) {
        this.latestAudioBuffer = audioData
      }
    }
    ipcMain.removeListener("voice:speech-audio", handler)
    ipcMain.on("voice:speech-audio", handler)
  }

  /* ============================================================
   * 核心 TTS 合成方法
   * ============================================================ */
  /**
   * 合成语音并返回音频文件路径
   * 根据语音包的 TTS 引擎配置，选择 Edge 或 Piper 进行合成
   */
  async synthesize(text: string, voiceId?: string) {
    const effectiveVoiceId = voiceId || this.settings.currentVoiceId
    const voice = this.voices.get(effectiveVoiceId)
    if (!voice) {
      return {
        success: false,
        error: `语音包 "${effectiveVoiceId}" 不存在`,
        engine: "none",
        ttsLabel: "未知"
      }
    }
    const mapping = this.getTTSMapping(effectiveVoiceId)
    try {
      if (mapping.ttsEngine === "piper") {
        const piperOptions = {
          speed: voice.speed * this.settings.speed * (mapping.piperSpeed ?? 1),
          pitch: voice.pitch * this.settings.pitch * (mapping.piperPitch ?? 1)
        }
        const result = await piperTTS.speak(text, mapping.piperModelId, piperOptions)
        return {
          success: result.success,
          audioPath: result.audioPath,
          error: result.error,
          engine: "piper",
          ttsLabel: "离线"
        }
      } else if (mapping.ttsEngine === "edge") {
        const result = await edgeTTS.speak(text, mapping.edgeVoiceId, {
          rate: this.speedToEdgeRate(voice.speed * this.settings.speed),
          pitch: this.pitchToEdgePitch(voice.pitch * this.settings.pitch)
        })
        return {
          success: result.success,
          audioPath: result.audioPath,
          error: result.error,
          engine: "edge",
          ttsLabel: "在线"
        }
      } else {
        const result = await edgeTTS.speakWithFallback(
          text,
          mapping.edgeVoiceId,
          mapping.piperModelId,
          {
            rate: this.speedToEdgeRate(voice.speed * this.settings.speed),
            pitch: this.pitchToEdgePitch(voice.pitch * this.settings.pitch)
          },
          {
            speed: voice.speed * this.settings.speed * (mapping.piperSpeed ?? 1),
            pitch: voice.pitch * this.settings.pitch * (mapping.piperPitch ?? 1)
          }
        )
        return {
          success: result.success,
          audioPath: result.audioPath,
          error: result.error,
          engine: result.engine,
          ttsLabel: result.engine === "edge" ? "在线" : "离线(降级)"
        }
      }
    } catch (e) {
      logger.error(`[VoiceEngine] 合成异常: ${e}`)
      return {
        success: false,
        error: "语音合成遇到内部错误",
        engine: "fallback",
        ttsLabel: "降级到浏览器语音",
        fallback: true,
        fallbackText: text
      }
    }
  }

  /**
   * 使用 Edge TTS 在线合成（强制在线）
   */
  async synthesizeEdge(text: string, voiceId?: string) {
    const effectiveVoiceId = voiceId || this.settings.currentVoiceId
    const voice = this.voices.get(effectiveVoiceId)
    if (!voice) {
      return {
        success: false,
        error: `语音包 "${effectiveVoiceId}" 不存在`
      }
    }
    const mapping = this.getTTSMapping(effectiveVoiceId)
    try {
      const result = await edgeTTS.speak(text, mapping.edgeVoiceId, {
        rate: this.speedToEdgeRate(voice.speed * this.settings.speed),
        pitch: this.pitchToEdgePitch(voice.pitch * this.settings.pitch)
      })
      return {
        success: result.success,
        audioPath: result.audioPath,
        error: result.error
      }
    } catch (e) {
      logger.error(`[VoiceEngine] synthesizeEdge 错误: ${e}`)
      return {
        success: false,
        error: "语音合成遇到内部错误"
      }
    }
  }

  /**
   * 遗留兼容：通过 IPC 广播到渲染进程的 speak 方法
   * 保留用于向后兼容，新代码请使用 synthesize()
   */
  async speak(text: string, options?: any) {
    try {
      const voiceId = options?.voiceId || this.settings.currentVoiceId
      const result = await this.synthesize(text, voiceId)
      const mainWin = BrowserWindow.getAllWindows()[0]
      if (mainWin && !mainWin.isDestroyed()) {
        try {
          mainWin.webContents.send("tts:speak", {
            text,
            options,
            settings: this.settings,
            voice: this.getCurrentVoice(),
            audioPath: result.audioPath,
            engine: result.engine,
            success: result.success
          })
        } catch {
        // 非关键操作，失败可安全忽略
        }
      }
    } catch (e) {
      logger.error(`[VoiceEngine] speak 广播失败: ${e}`)
      const mainWin = BrowserWindow.getAllWindows()[0]
      if (mainWin && !mainWin.isDestroyed()) {
        try {
          mainWin.webContents.send("tts:speak", {
            text,
            options,
            settings: this.settings,
            voice: this.getCurrentVoice(),
            success: false,
            error: "语音合成遇到内部错误"
          })
        } catch {
        // 非关键操作，失败可安全忽略
        }
      }
    }
  }

  stopSpeaking() {
    piperTTS.stop()
    edgeTTS.stop()
    const mainWin = BrowserWindow.getAllWindows()[0]
    if (mainWin && !mainWin.isDestroyed()) {
      try {
        mainWin.webContents.send("tts:stop")
      } catch {
      // 非关键操作，失败可安全忽略
      }
    }
  }

  pauseSpeaking() {
    const mainWin = BrowserWindow.getAllWindows()[0]
    if (mainWin && !mainWin.isDestroyed()) {
      try {
        mainWin.webContents.send("tts:pause")
      } catch {
      // 非关键操作，失败可安全忽略
      }
    }
  }

  resumeSpeaking() {
    const mainWin = BrowserWindow.getAllWindows()[0]
    if (mainWin && !mainWin.isDestroyed()) {
      try {
        mainWin.webContents.send("tts:resume")
      } catch {
      // 非关键操作，失败可安全忽略
      }
    }
  }

  setOnVoiceChange(callback: (voiceId: string) => void) {
    this.onVoiceChange = callback
  }

  getVoiceDir() {
    return this.getVoiceDirInternal()
  }

  exportVoiceSettings() {
    return JSON.stringify({
      settings: this.settings,
      customVoices: Array.from(this.voices.values()).filter((v) => !v.isBuiltIn)
    }, null, 2)
  }

  importVoiceSettings(jsonData: string) {
    try {
      const data = JSON.parse(jsonData)
      if (data.settings) {
        this.settings = { ...this.settings, ...data.settings }
      }
      if (data.customVoices) {
        data.customVoices.forEach((voice: VoiceInfo) => {
          voice.isBuiltIn = false
          if (!voice.ttsEngine) {
            voice.ttsEngine = "hybrid"
            voice.ttsLabel = "在线(离线降级)"
          }
          this.voices.set(voice.id, voice)
        })
        this.saveCustomVoices()
      }
      this.saveSettings()
      return true
    } catch (e) {
      logger.error(`[VoiceEngine] 导入语音设置失败: ${e}`)
      return false
    }
  }

  /* ============================================================
   * Piper 模型下载
   * ============================================================ */
  async downloadPiperModels() {
    try {
      const piperDir = path.join(app.getPath("userData"), "piper")
      if (!fs.existsSync(piperDir)) fs.mkdirSync(piperDir, { recursive: true })
      logger.debug("[VoiceEngine] Piper模型目录已就绪: " + piperDir)
      return true
    } catch (e) {
      logger.error(`Piper download error: ${e}`)
      return false
    }
  }

  /* ============================================================
   * SenseVoice-Small ASR 方法
   * ============================================================ */
  /** 启动离线 ASR */
  async startASR() {
    if (!this.senseVoiceASR) {
      this.senseVoiceASR = new SenseVoiceASR({
        modelPath: this.getVoiceModelPath("sensevoice-small"),
        sampleRate: 16000,
        language: "zh",
        vadThreshold: 0.5,
        vadSilenceDuration: 800
      })
    }
    await this.senseVoiceASR.initialize()
    return true
  }

  /** 停止离线 ASR */
  stopASR() {
    if (this.senseVoiceASR) {
      this.senseVoiceASR.dispose()
      this.senseVoiceASR = null
    }
  }

  /** 获取 ASR 识别结果 */
  async getASRResult() {
    if (!this.senseVoiceASR) return { text: "", isFinal: false }
    const result = await this.senseVoiceASR.finalize()
    return { text: result.text, isFinal: result.isFinal }
  }

  /** 添加音频数据到 ASR */
  feedASRAudio(audioData: unknown) {
    this.senseVoiceASR?.feedAudioData(audioData as Float32Array)
  }

  /* ============================================================
   * MeloTTS 方法
   * ============================================================ */
  /** 使用 MeloTTS 合成语音 */
  async synthesizeWithMeloTTS(text: string, options?: any) {
    if (!this.meloTTS) {
      this.meloTTS = new MeloTTS({
        modelPath: this.getVoiceModelPath("melotts-zh"),
        speaker: "ZH",
        speed: 1,
        language: "ZH"
      })
      await this.meloTTS.initialize()
    }
    const result = await this.meloTTS.synthesize(text, {
      speaker: options?.speaker || "ZH",
      speed: options?.speed || 1
    })
    return {
      success: result.success,
      audioBuffer: result.audioBuffer,
      error: result.error
    }
  }

  /* ============================================================
   * CosyVoice 语音克隆方法
   * ============================================================ */
  /** 使用 CosyVoice 真实克隆声音 */
  async cloneVoiceReal(audioBase64: string, voiceName: string) {
    if (!this.cosyVoiceClone) {
      this.cosyVoiceClone = new CosyVoiceClone({
        modelPath: this.getVoiceModelPath("cosyvoice"),
        outputDir: path.join(app.getPath("userData"), "cosyvoice-cloned")
      })
      await this.cosyVoiceClone.initialize()
    }
    const result = await this.cosyVoiceClone.cloneVoice(audioBase64, voiceName)
    return {
      success: result.success,
      voiceId: result.voiceId,
      voiceName: result.voiceName,
      error: result.error
    }
  }

  /** 获取所有克隆声音 */
  getClonedVoices() {
    if (!this.cosyVoiceClone) return []
    return this.cosyVoiceClone.getVoices()
  }

  /** 删除克隆声音 */
  deleteClonedVoice(voiceId: string) {
    if (!this.cosyVoiceClone) return false
    return this.cosyVoiceClone.deleteVoice(voiceId)
  }

  /** 使用克隆声音合成 */
  async synthesizeWithClone(voiceId: string, text: string) {
    if (!this.cosyVoiceClone) return { success: false, error: "CosyVoice 未初始化" }
    return await this.cosyVoiceClone.synthesizeWithClone(voiceId, text)
  }

  /* ============================================================
   * 本地语音模型路径（模型已集成到 resources/voice-models/）
   * ============================================================ */
  getVoiceModelPath(modelName: string) {
    const candidates = [
      path.join(process.resourcesPath, "voice-models", modelName),
      path.join(app.getAppPath(), "resources", "voice-models", modelName)
    ]
    for (const p of candidates) {
      if (fs.existsSync(p)) return p
    }
    return path.join(app.getAppPath(), "resources", "voice-models", modelName)
  }

  /* ============================================================
   * 参数转换辅助方法
   * ============================================================ */
  speedToEdgeRate(speed: number) {
    const percentage = Math.round((speed - 1) * 100)
    if (percentage === 0) return "default"
    if (percentage > 0) return `+${percentage}%`
    return `${percentage}%`
  }

  pitchToEdgePitch(pitch: number) {
    const percentage = Math.round((pitch - 1) * 100)
    if (percentage === 0) return "default"
    if (percentage > 0) return `+${percentage}%`
    return `${percentage}%`
  }
}

export const voiceEngine = new VoiceEngine()
