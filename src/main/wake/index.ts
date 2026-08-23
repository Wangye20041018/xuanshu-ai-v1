import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { spawn, ChildProcess } from 'child_process'
import { pythonRuntime } from '../runtime/python'
import { getStore } from '../ipc/config.ipc'
import { logger } from '../../shared/logger'

interface WakeWordConfig {
  wakeWord: string
  sensitivity: number
  enabled: boolean
  autoStart: boolean
}

interface WakeWordResult {
  detected: boolean
  wakeWord: string
  confidence: number
  timestamp: number
}

interface WakeServiceStatus {
  running: boolean
  config: WakeWordConfig
  lastResult: WakeWordResult | null
  history: WakeWordResult[]
}

/** 唤醒服务运行状态 */
type WakeState = 'idle' | 'listening'

/** 退出确认状态（扩展于 listening 之上） */
type ExitConfirmState = 'listening' | 'exitConfirm' | 'waitingConfirm' | 'dismissed'

/** 获取退出词配置 */
function getExitConfig() {
  const store = getStore()
  return {
    exitWord: (store.get('voiceExitWord') as string) || '退出',
    confirmWords: (store.get('voiceExitConfirmWords') as string) || '确认退出,是的',
    cancelWords: (store.get('voiceExitCancelWords') as string) || '取消,不要',
    confirmTTS: (store.get('voiceExitConfirmTTS') as string) || '确认退出语音模式吗？',
  }
}

class VoiceWakeService {
  private config: WakeWordConfig = {
    wakeWord: '玄枢',
    sensitivity: 80,
    enabled: true,
    autoStart: true
  }

  private servicePath: string | null = null
  private configPath: string | null = null
  private isRunning: boolean = false
  private process: ChildProcess | null = null
  private onWakeUp?: () => void
  private lastResult: WakeWordResult | null = null
  private detectionHistory: WakeWordResult[] = []
  private initialized: boolean = false
  private wakeChildProcess: ChildProcess | null = null
  private currentState: WakeState = 'idle'
  private listeningTimeout: ReturnType<typeof setTimeout> | null = null
  private readonly LISTENING_TIMEOUT_MS = 30000

  /** sherpa-onnx KWS 集成 */
  // @ts-ignore
  private _useSherpaOnnx: boolean = false
  private sherpaProcess: ChildProcess | null = null

  /** 退出确认状态 */
  private exitConfirmState: ExitConfirmState = 'listening'
  private onExitRequested?: (confirmTTS: string) => void
  private onExitConfirmed?: () => void
  private onExitCancelled?: () => void

  /** v2.3: 声纹验证后文本转发回调 → voice-engine discussionLoop */
  private onVoiceTextForward?: (text: string) => void

  constructor() {
    // 延迟初始化，等待 app ready
  }

  initialize(): void {
    if (this.initialized) return
    try {
      this.servicePath = join(app.getPath('userData'), 'wake-service')
      this.configPath = join(this.servicePath, 'config.json')
      this.loadConfig()
      this.initialized = true
    } catch (error) {
      logger.error('VoiceWakeService initialize error:', error)
    }
  }

  private getServicePath(): string {
    if (!this.servicePath) {
      this.initialize()
    }
    return this.servicePath!
  }

  private getConfigPath(): string {
    if (!this.configPath) {
      this.initialize()
    }
    return this.configPath!
  }

  private loadConfig(): void {
    try {
      const configPath = this.getConfigPath()
      if (existsSync(configPath)) {
        try {
          const saved = JSON.parse(readFileSync(configPath, 'utf-8'))
          this.config = { ...this.config, ...saved }
        } catch (e) {
          logger.error('[Wake] 解析唤醒配置JSON失败:', e)
          this.saveConfig()
        }
      } else {
        this.saveConfig()
      }
    } catch (error) {
      logger.error('loadConfig error:', error)
    }
  }

  private saveConfig(): void {
    try {
      const servicePath = this.getServicePath()
      const configPath = this.getConfigPath()
      mkdirSync(servicePath, { recursive: true })
      writeFileSync(configPath, JSON.stringify(this.config, null, 2))
    } catch (error) {
      logger.error('saveConfig error:', error)
    }
  }

  setConfig(config: Partial<WakeWordConfig>): void {
    try {
      this.config = { ...this.config, ...config }
      this.saveConfig()

      if (this.isRunning) {
        this.stop()
        setTimeout(() => this.start(), 1000)
      }
    } catch (error) {
      logger.error('setConfig error:', error)
    }
  }

  getConfig(): WakeWordConfig {
    return { ...this.config }
  }

  setOnWakeUp(callback: () => void): void {
    this.onWakeUp = callback
  }

  setOnExitRequested(callback: (confirmTTS: string) => void): void {
    this.onExitRequested = callback
  }

  setOnExitConfirmed(callback: () => void): void {
    this.onExitConfirmed = callback
  }

  setOnExitCancelled(callback: () => void): void {
    this.onExitCancelled = callback
  }

  /**
   * 通知主窗口悬浮球状态 + 桌面宠物状态（v2.5 修复时序）
   */
  private notifyFloatingBallState(state: 'idle' | 'listening' | 'speaking' | 'thinking'): void {
    try {
      // 1. 先通知主窗口悬浮球状态
      const windows = BrowserWindow.getAllWindows()
      windows.forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('floating-ball:set-state', state)
        }
      })

    } catch (error) {
      logger.error('notifyFloatingBallState error:', error)
    }
  }



  /**
   * 切换唤醒服务状态（idle ↔ listening）
   * 并处理退出确认子状态
   */
  private setWakeState(state: WakeState): void {
    if (this.currentState === state) return

    this.currentState = state

    // 清除旧超时
    if (this.listeningTimeout) {
      clearTimeout(this.listeningTimeout)
      this.listeningTimeout = null
    }

    if (state === 'listening') {
      // 重置退出确认子状态
      this.exitConfirmState = 'listening'
      this.notifyFloatingBallState('listening')
      logger.debug('[Wake] 状态: Listening → 等待语音指令')

      // 30 秒无语音输入后自动回到 idle
      this.listeningTimeout = setTimeout(() => {
        logger.debug('[Wake] 超时：30 秒无语音输入，回到 idle')
        this.setWakeState('idle')
      }, this.LISTENING_TIMEOUT_MS)
    } else {
      this.exitConfirmState = 'listening'
      this.notifyFloatingBallState('idle')
      logger.debug('[Wake] 状态: Idle → 等待唤醒词')
    }
  }

  /**
   * 进入退出确认流程
   * 1. 切换球体为 speaking 态
   * 2. 通知 voice-engine 播放确认 TTS
   */
  triggerExitConfirmation(): void {
    const cfg = getExitConfig()
    this.exitConfirmState = 'exitConfirm'
    this.notifyFloatingBallState('speaking')
    logger.debug('[Wake] 退出确认: speaking → 播报确认语音')

    // 通知外部回调（voice-engine 负责 TTS）
    this.onExitRequested?.(cfg.confirmTTS)

    // 清除 listening 超时
    if (this.listeningTimeout) {
      clearTimeout(this.listeningTimeout)
      this.listeningTimeout = null
    }
  }

  /**
   * TTS 确认播报完成后的回调：切换到等待确认状态
   */
  onExitConfirmTTSSpoke(): void {
    if (this.exitConfirmState !== 'exitConfirm') return
    this.exitConfirmState = 'waitingConfirm'
    this.notifyFloatingBallState('listening')
    logger.debug('[Wake] 退出确认: waitingConfirm → 等待用户说是/否')

    // 15 秒超时：如果用户不说话，取消退出
    this.listeningTimeout = setTimeout(() => {
      logger.debug('[Wake] 退出确认超时，取消退出')
      this.handleExitCancel()
    }, 15000)
  }

  /**
   * 用户说"确认" → 退出语音模式
   */
  handleExitConfirm(): void {
    this.exitConfirmState = 'dismissed'
    this.currentState = 'idle'
    if (this.listeningTimeout) {
      clearTimeout(this.listeningTimeout)
      this.listeningTimeout = null
    }
    this.notifyFloatingBallState('idle')
    logger.debug('[Wake] 退出确认: dismissed → 语音模式已退出')
    this.onExitConfirmed?.()
  }

  /**
   * 用户说"取消" → 回到 listening 继续对话
   */
  handleExitCancel(): void {
    this.exitConfirmState = 'listening'
    if (this.listeningTimeout) {
      clearTimeout(this.listeningTimeout)
      this.listeningTimeout = null
    }
    this.notifyFloatingBallState('listening')
    logger.debug('[Wake] 退出确认: cancelled → 回到 listening')

    // 重新设置 30 秒超时
    this.listeningTimeout = setTimeout(() => {
      logger.debug('[Wake] 超时：30 秒无语音输入，回到 idle')
      this.setWakeState('idle')
    }, this.LISTENING_TIMEOUT_MS)

    this.onExitCancelled?.()
  }

  /**
   * 收到语音识别文本时
   * - 在 waitingConfirm 状态：检测确认/取消词
   * - 在 listening 状态：检测退出词 + 重置超时
   */
  onVoiceRecognized(text: string): void {
    if (!text || text.trim().length === 0) return

    const trimmed = text.trim()

    // --- waitingConfirm 状态：判断确认/取消 ---
    if (this.exitConfirmState === 'waitingConfirm') {
      const cfg = getExitConfig()
      const confirmList = cfg.confirmWords.split(',').map((w: string) => w.trim())
      const cancelList = cfg.cancelWords.split(',').map((w: string) => w.trim())

      const isMatch = (input: string, keywords: string[]): boolean => {
        return keywords.some(kw => input.includes(kw))
      }

      if (isMatch(trimmed, confirmList)) {
        logger.debug('[Wake] 用户确认退出:', trimmed)
        this.handleExitConfirm()
        return
      }
      if (isMatch(trimmed, cancelList)) {
        logger.debug('[Wake] 用户取消退出:', trimmed)
        this.handleExitCancel()
        return
      }
      // 说了别的 → 也当作取消，回到 listening
      logger.debug('[Wake] waitingConfirm 收到不明确输入，取消退出:', trimmed)
      this.handleExitCancel()
      return
    }

    // --- listening 状态：检测退出词 ---
    if (this.exitConfirmState === 'listening' && this.currentState === 'listening') {
      const cfg = getExitConfig()
      if (cfg.exitWord && trimmed.includes(cfg.exitWord)) {
        logger.debug('[Wake] 检测到退出词:', trimmed)
        this.triggerExitConfirmation()
        return
      }

      // 正常语音输入 → 重置超时 + 转发到 voice-engine 讨论循环
      this.onVoiceInput()
      // v2.3: 转发语音文本到 voice-engine（声纹验证由 voice-engine 在 discussionLoop 中处理）
      if (this.onVoiceTextForward) {
        this.onVoiceTextForward(trimmed)
      }
    }
  }

  /**
   * v2.3: 设置语音文本转发回调（由 voice-engine 注册）
   */
  setOnVoiceTextForward(callback: (text: string) => void): void {
    this.onVoiceTextForward = callback
  }

  /**
   * 收到语音识别结果时，重置超时（由 voice-engine 调用）
   */
  onVoiceInput(): void {
    if (this.currentState !== 'listening') return

    // 重置 30 秒超时计时器
    if (this.listeningTimeout) {
      clearTimeout(this.listeningTimeout)
    }
    this.listeningTimeout = setTimeout(() => {
      logger.debug('[Wake] 超时：30 秒无语音输入，回到 idle')
      this.setWakeState('idle')
    }, this.LISTENING_TIMEOUT_MS)
  }

  /**
   * 一轮对话结束（TTS 播完）→ 保持 listening 不回到 idle
   * 返回 true 表示当前确实在 listening 态（持续对话模式）
   */
  stayInListening(): boolean {
    if (this.currentState !== 'listening') return false
    // 重置超时计时器
    if (this.listeningTimeout) {
      clearTimeout(this.listeningTimeout)
    }
    this.listeningTimeout = setTimeout(() => {
      logger.debug('[Wake] 超时：30 秒无语音输入，回到 idle')
      this.setWakeState('idle')
    }, this.LISTENING_TIMEOUT_MS)
    return true
  }

  getCurrentState(): WakeState {
    return this.currentState
  }

  getExitConfirmState(): ExitConfirmState {
    return this.exitConfirmState
  }

  /* ============================================================
   * sherpa-onnx KWS 集成
   * 使用 sherpa-onnx 的 keyword spotting 作为唤醒词检测
   * 替换原有的 pvporcupine / VAD 方案
   * Fallback: 如果 sherpa-onnx 不可用，退回原有 VAD
   * ============================================================ */

  /**
   * 尝试使用 sherpa-onnx 进行唤醒词检测
   * 如果 sherpa-onnx 二进制可用，使用它；否则退回原有实现
   */
  async trySherpaOnnxKWS(): Promise<boolean> {
    try {
      const sherpaPath = join(process.resourcesPath, 'sherpa-onnx', 'sherpa-onnx-keyword-spotter.exe')
      const modelPath = join(process.resourcesPath, 'voice-models', 'sherpa-onnx-kws-zh-wenetspeech-2024-07-30')

      // 检查 sherpa-onnx 是否可用
      if (!existsSync(sherpaPath)) {
        logger.debug('[Wake] sherpa-onnx 二进制不可用，使用原有 VAD 方案')
        return false
      }

      if (!existsSync(modelPath)) {
        logger.debug('[Wake] sherpa-onnx 模型不可用，使用原有 VAD 方案')
        return false
      }

      this._useSherpaOnnx = true
      logger.debug('[Wake] sherpa-onnx KWS 已就绪')
      return true
    } catch (e) {
      logger.error('[Wake] sherpa-onnx KWS 初始化失败:', e)
      return false
    }
  }

  /**
   * 启动 sherpa-onnx 关键词检测进程
   */
  private async startSherpaOnnxProcess(): Promise<void> {
    try {
      const sherpaPath = join(process.resourcesPath, 'sherpa-onnx', 'sherpa-onnx-keyword-spotter.exe')
      const modelPath = join(process.resourcesPath, 'voice-models', 'sherpa-onnx-kws-zh-wenetspeech-2024-07-30')

      this.sherpaProcess = spawn(sherpaPath, [
        '--model-dir', modelPath,
        '--keywords', this.config.wakeWord,
        '--threshold', String(this.config.sensitivity / 100),
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })

      this.sherpaProcess.stdout?.on('data', (data: Buffer) => {
        const output = data.toString().trim()
        if (output.startsWith('DETECTED:')) {
          const confidence = parseFloat(output.split(':')[1]) || 0.8
          const result: WakeWordResult = {
            detected: true,
            wakeWord: this.config.wakeWord,
            confidence,
            timestamp: Date.now(),
          }
          this.lastResult = result
          this.detectionHistory.push(result)
          if (this.detectionHistory.length > 50) {
            this.detectionHistory = this.detectionHistory.slice(-50)
          }
          this.setWakeState('listening')
          this.onWakeUp?.()
        }
      })

      this.sherpaProcess.stderr?.on('data', (data: Buffer) => {
        logger.debug('[Wake] sherpa-onnx stderr:', data.toString())
      })

      this.sherpaProcess.on('close', (code: number | null) => {
        logger.debug(`[Wake] sherpa-onnx 进程退出, code=${code}`)
        this.sherpaProcess = null
      })

      this.sherpaProcess.on('error', (err: Error) => {
        logger.error('[Wake] sherpa-onnx 进程错误:', err)
        this.sherpaProcess = null
        this._useSherpaOnnx = false
      })

      logger.debug('[Wake] sherpa-onnx KWS 进程已启动')
    } catch (e) {
      logger.error('[Wake] 启动 sherpa-onnx 进程失败:', e)
      this._useSherpaOnnx = false
    }
  }

  /**
   * 停止 sherpa-onnx 进程
   */
  private stopSherpaOnnxProcess(): void {
    if (this.sherpaProcess) {
      try {
        this.sherpaProcess.kill('SIGTERM')
      } catch (e) {
        logger.error('[Wake] 终止 sherpa-onnx 进程失败:', e)
      }
      this.sherpaProcess = null
    }
  }

  /**
   * 启动语音唤醒服务
   * 使用 Web Speech API（Chromium 内置）+ 独立进程确保不被关闭影响
   */
  async start(): Promise<void> {
    try {
      if (this.isRunning) return

      // 优先尝试 sherpa-onnx KWS
      const sherpaReady = await this.trySherpaOnnxKWS()
      if (sherpaReady) {
        this.isRunning = true
        await this.startSherpaOnnxProcess()
        this.notifyRendererWakeStatus(true)
        logger.debug('[Wake] 使用 sherpa-onnx KWS 模式')
        return
      }

      // Fallback: 使用原有 Python 进程方案
      const servicePath = this.getServicePath()
      mkdirSync(servicePath, { recursive: true })

      // 写入唤醒服务脚本
      const scriptPath = join(servicePath, 'wake_service.py')
      this.writeWakeScript(scriptPath)

      this.isRunning = true

      // 使用独立进程启动（detached: true 确保不被关闭软件影响）
      const pyPath = pythonRuntime.getPythonPath()
      this.process = spawn(pyPath, [
        scriptPath,
        this.config.wakeWord,
        String(this.config.sensitivity),
        servicePath
      ], {
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: servicePath,
        windowsHide: true
      })

      // 取消父进程关联，使子进程独立运行
      if (this.process.pid) {
        try {
          this.process.unref()
        } catch (e) { logger.error('[Wake] 取消进程引用失败:', e) }
      }

      this.process.stdout?.on('data', (data: Buffer) => {
        const output = data.toString().trim()
        this.handleOutput(output)
      })

      this.process.stderr?.on('data', (data: Buffer) => {
        logger.error('Wake service stderr:', data.toString())
      })

      this.process.on('close', (code: number | null) => {
        logger.debug(`Wake service closed with code: ${code}`)
        this.isRunning = false
        // 自动重启
        if (this.config.enabled && code !== 0) {
          setTimeout(() => {
            if (this.config.enabled && !this.isRunning) {
              this.start().catch(e => logger.error('Wake auto-restart failed:', e))
            }
          }, 5000)
        }
      })

      this.process.on('error', (err: Error) => {
        logger.error('Wake service error:', err)
        this.isRunning = false
      })

      // 同时准备渲染进程 Web Speech API 监听（通过 IPC 通知渲染进程启动监听）
      this.notifyRendererWakeStatus(true)
    } catch (error) {
      logger.error('Failed to start wake service:', error)
      this.isRunning = false
    }
  }

  /**
   * 通知渲染进程启动/停止 Web Speech API 监听
   */
  private notifyRendererWakeStatus(starting: boolean): void {
    try {
      const windows = BrowserWindow.getAllWindows()
      windows.forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('wake:renderer-status', {
            starting,
            wakeWord: this.config.wakeWord,
            sensitivity: this.config.sensitivity
          })
        }
      })
    } catch (error) {
      logger.error('notifyRendererWakeStatus error:', error)
    }
  }

  /**
   * 处理唤醒服务输出
   */
  private handleOutput(output: string): void {
    try {
      if (output.startsWith('WAKE_UP:')) {
        const parts = output.split(':')
        const confidence = parseFloat(parts[1]) || 0

        const result: WakeWordResult = {
          detected: true,
          wakeWord: this.config.wakeWord,
          confidence,
          timestamp: Date.now()
        }

        this.lastResult = result
        this.detectionHistory.push(result)

        if (this.detectionHistory.length > 50) {
          this.detectionHistory = this.detectionHistory.slice(-50)
        }

        if (confidence > this.config.sensitivity / 100) {
          // 切换为 listening 状态：悬浮球变红、启动 30s 超时
          this.setWakeState('listening')

          // 触发唤醒回调
          this.onWakeUp?.()

          // 通过 IPC 通知渲染进程，自动跳转到语音讨论页面
          try {
            const windows = BrowserWindow.getAllWindows()
            windows.forEach(win => {
              if (!win.isDestroyed()) {
                win.webContents.send('wake:detected', {
                  wakeWord: this.config.wakeWord,
                  confidence,
                  timestamp: Date.now()
                })
              }
            })
          } catch (e) {
            logger.error('Failed to notify renderer about wake:', e)
          }
        }
      } else if (output.startsWith('DETECTED:')) {
        const parts = output.split(':')
        const confidence = parseFloat(parts[1]) || 0

        this.lastResult = {
          detected: false,
          wakeWord: this.config.wakeWord,
          confidence,
          timestamp: Date.now()
        }
      }
    } catch (error) {
      logger.error('handleOutput error:', error)
    }
  }

  stop(): void {
    try {
      // 停止 sherpa-onnx 进程
      this.stopSherpaOnnxProcess()
      this._useSherpaOnnx = false

      if (this.process) {
        try {
          this.process.kill('SIGTERM')
        } catch (e) {
          logger.error('[Wake] 终止主进程失败:', e)
          // 进程可能已退出
        }
        this.process = null
      }
      if (this.wakeChildProcess) {
        try {
          this.wakeChildProcess.kill('SIGTERM')
        } catch (e) { logger.error('[Wake] 终止子进程失败:', e) }
        this.wakeChildProcess = null
      }
      this.isRunning = false
      this.notifyRendererWakeStatus(false)
    } catch (error) {
      logger.error('stop error:', error)
      this.isRunning = false
    }
  }

  isRunningStatus(): boolean {
    return this.isRunning
  }

  getLastResult(): WakeWordResult | null {
    return this.lastResult
  }

  getDetectionHistory(): WakeWordResult[] {
    return [...this.detectionHistory]
  }

  getStatus(): WakeServiceStatus {
    return {
      running: this.isRunning,
      config: this.getConfig(),
      lastResult: this.lastResult,
      history: this.getDetectionHistory()
    }
  }

  /**
   * 写入 Python 唤醒检测脚本
   * 使用 pvporcupine 或基于能量的VAD作为 fallback
   */
  private writeWakeScript(path: string): void {
    const script = `
import sys
import time
import json
import os
import wave
import struct
import math

try:
    import pyaudio
    HAS_PYAUDIO = True
except ImportError:
    HAS_PYAUDIO = False

WAKE_WORD = sys.argv[1] if len(sys.argv) > 1 else "玄枢"
SENSITIVITY = float(sys.argv[2]) / 100 if len(sys.argv) > 2 else 0.8
SERVICE_PATH = sys.argv[3] if len(sys.argv) > 3 else "./"

# 尝试导入 Porcupine 唤醒词引擎
try:
    import pvporcupine
    HAS_PORCUPINE = True
except ImportError:
    HAS_PORCUPINE = False

class WakeWordDetector:
    def __init__(self):
        self.audio = None
        self.stream = None
        self.chunk = 512
        self.format = None
        self.channels = 1
        self.rate = 16000
        self.porcupine = None
        self.vad_threshold = 500  # 能量阈值
        
    def start(self):
        if not HAS_PYAUDIO:
            print("PyAudio not available, using simulated mode", flush=True)
            self.simulated_mode()
            return
            
        self.audio = pyaudio.PyAudio()
        self.format = pyaudio.paInt16
        
        # 尝试初始化 Porcupine
        if HAS_PORCUPINE:
            try:
                keywords = ["porcupine", "computer", "jarvis", "alexa"]
                self.porcupine = pvporcupine.create(
                    keywords=keywords,
                    sensitivities=[SENSITIVITY] * len(keywords)
                )
                self.chunk = self.porcupine.frame_length
                print(f"Porcupine initialized with {len(keywords)} keywords", flush=True)
            except Exception as e:
                print(f"Porcupine init failed: {e}, falling back to VAD", flush=True)
                self.porcupine = None
        
        self.stream = self.audio.open(
            format=self.format,
            channels=self.channels,
            rate=self.rate,
            input=True,
            frames_per_buffer=self.chunk
        )
        
        print(f"Wake service started. Listening for: {WAKE_WORD}", flush=True)
        print(f"Sensitivity: {SENSITIVITY}", flush=True)
        
        while True:
            try:
                data = self.stream.read(self.chunk, exception_on_overflow=False)
                
                if self.porcupine:
                    # 使用 Porcupine 检测
                    pcm_data = struct.unpack_from("h" * self.chunk, data)
                    keyword_index = self.porcupine.process(pcm_data)
                    if keyword_index >= 0:
                        confidence = SENSITIVITY + (1 - SENSITIVITY) * 0.5
                        print(f"WAKE_UP:{confidence}", flush=True)
                        time.sleep(2)
                else:
                    # 使用 VAD（能量检测）作为 fallback
                    confidence = self.detect_energy(data)
                    if confidence > SENSITIVITY:
                        print(f"WAKE_UP:{confidence}", flush=True)
                        time.sleep(2)
                    elif confidence > 0.3:
                        print(f"DETECTED:{confidence}", flush=True)
                        
                time.sleep(0.01)
            except Exception as e:
                print(f"Loop error: {e}", flush=True)
                time.sleep(0.1)
    
    def detect_energy(self, audio_data):
        """基于能量的 VAD 检测"""
        try:
            # 计算音频能量
            data = struct.unpack_from("h" * (len(audio_data) // 2), audio_data)
            energy = sum(abs(x) for x in data) / len(data)
            
            # 归一化到 0-1
            normalized = min(energy / 32768.0, 1.0)
            return normalized
        except:
            return 0
    
    def simulated_mode(self):
        """模拟模式（当 PyAudio 不可用时）"""
        import random
print("Running in simulated mode", flush=True)
        while True:
            time.sleep(0.5)
            rand_val = random.random()
            if rand_val > 0.9:
                print(f"WAKE_UP:{rand_val}", flush=True)
            elif rand_val > 0.7:
                print(f"DETECTED:{rand_val}", flush=True)
    
    def stop(self):
        try:
            if self.stream:
                self.stream.stop_stream()
                self.stream.close()
        except:
            pass
        try:
            if self.audio:
                self.audio.terminate()
        except:
            pass
        try:
            if self.porcupine:
                self.porcupine.delete()
        except:
            pass

if __name__ == "__main__":
    detector = WakeWordDetector()
    try:
        detector.start()
    except KeyboardInterrupt:
        detector.stop()
    except Exception as e:
        print(f"Fatal error: {e}", flush=True)
        detector.stop()
`
    try {
      writeFileSync(path, script)
    } catch (error) {
      logger.error('Failed to write wake script:', error)
    }
  }

  async enableAutoStart(): Promise<void> {
    try {
      const { exec } = require('child_process')
      const { promisify } = require('util')
      const execAsync = promisify(exec)

      const appPath = process.execPath
      const appName = '玄枢语音唤醒'

      const command = `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${appName}" /t REG_SZ /d "\\"${appPath}\\" --wake-service" /f`

      await execAsync(command)
      this.config.autoStart = true
      this.saveConfig()
    } catch (error) {
      logger.error('Failed to enable auto start:', error)
    }
  }

  async disableAutoStart(): Promise<void> {
    try {
      const { exec } = require('child_process')
      const { promisify } = require('util')
      const execAsync = promisify(exec)

      const appName = '玄枢语音唤醒'

      const command = `reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${appName}" /f`

      await execAsync(command)
      this.config.autoStart = false
      this.saveConfig()
    } catch (error) {
      logger.error('Failed to disable auto start:', error)
    }
  }
}

export const voiceWakeService = new VoiceWakeService()

export function setupVoiceWakeHandlers(): void {
  ipcMain.handle('wake:start', async () => {
    try {
      await voiceWakeService.start()
      return { running: voiceWakeService.isRunningStatus() }
    } catch (error) {
      return { running: false, error: String(error) }
    }
  })

  ipcMain.handle('wake:stop', () => {
    try {
      voiceWakeService.stop()
      return { running: voiceWakeService.isRunningStatus() }
    } catch (error) {
      return { running: false, error: String(error) }
    }
  })

  ipcMain.handle('wake:status', () => {
    try {
      return voiceWakeService.getStatus()
    } catch (error) {
      return {
        running: false,
        config: voiceWakeService.getConfig(),
        lastResult: null,
        history: []
      }
    }
  })

  ipcMain.handle('wake:set-config', async (_event, config: Partial<WakeWordConfig>) => {
    try {
      voiceWakeService.setConfig(config)
      return voiceWakeService.getConfig()
    } catch (error) {
      return voiceWakeService.getConfig()
    }
  })

  ipcMain.handle('wake:auto-start', async (_event, enable: boolean) => {
    try {
      if (enable) {
        await voiceWakeService.enableAutoStart()
      } else {
        await voiceWakeService.disableAutoStart()
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('wake:history', () => {
    try {
      return voiceWakeService.getDetectionHistory()
    } catch (error) {
      return []
    }
  })

  // 渲染进程通知主进程：Web Speech API 检测到唤醒词
  ipcMain.on('wake:renderer-detected', (_event, data: { wakeWord: string; confidence: number }) => {
    try {
      const result: WakeWordResult = {
        detected: true,
        wakeWord: data.wakeWord,
        confidence: data.confidence,
        timestamp: Date.now()
      }

      // 切换为 listening 状态
      voiceWakeService['setWakeState']('listening')

      // 触发回调
      const windows = BrowserWindow.getAllWindows()
      windows.forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('wake:detected', result)
        }
      })
    } catch (error) {
      logger.error('wake:renderer-detected error:', error)
    }
  })

  // voice-engine 通知：收到语音识别文本，重置超时 + 退出词检测
  ipcMain.on('wake:voice-input', () => {
    try {
      voiceWakeService.onVoiceInput()
    } catch (error) {
      logger.error('wake:voice-input error:', error)
    }
  })

  // voice-engine 通知：收到已识别的文本，检测退出词
  ipcMain.on('wake:recognized-text', (_event, text: string) => {
    try {
      voiceWakeService.onVoiceRecognized(text)
    } catch (error) {
      logger.error('wake:recognized-text error:', error)
    }
  })

  // voice-engine/TTS 通知：退出确认 TTS 已播完，切换到等待确认
  ipcMain.on('wake:exit-confirm-tts-done', () => {
    try {
      voiceWakeService.onExitConfirmTTSSpoke()
    } catch (error) {
      logger.error('wake:exit-confirm-tts-done error:', error)
    }
  })

  // voice-engine 通知：一轮对话结束 → 保持 listening
  ipcMain.handle('wake:stay-listening', () => {
    try {
      return { success: voiceWakeService.stayInListening() }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // voice-engine 通知：用户确认了退出
  ipcMain.on('wake:exit-confirmed', () => {
    try {
      voiceWakeService.handleExitConfirm()
    } catch (error) {
      logger.error('wake:exit-confirmed error:', error)
    }
  })

  // 获取退出确认状态
  ipcMain.handle('wake:exit-state', () => {
    try {
      return { exitState: voiceWakeService.getExitConfirmState() }
    } catch (error) {
      return { exitState: 'listening' }
    }
  })

  // 手动重置唤醒状态（外部强制回到 idle）
  ipcMain.handle('wake:reset-state', () => {
    try {
      voiceWakeService['setWakeState']('idle')
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // 获取当前唤醒状态
  ipcMain.handle('wake:current-state', () => {
    try {
      return { state: voiceWakeService.getCurrentState() }
    } catch (error) {
      return { state: 'idle' }
    }
  })
}