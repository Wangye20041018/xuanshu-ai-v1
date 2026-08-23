/**
 * audio-sense.ts — 听觉环境感知桥接 v1.0 (M3 听觉情境)
 *
 * 职责：
 * - 启动/停止 Python 音频环境感知进程（audio_sense.py）
 * - 解析 stdout JSON 场景事件（音量/人声/音乐/瞬态敲门）
 * - 场景变化时注入感官总线（audio 通道），供状态推理/情境引擎消费
 * - 通过 IPC 广播音频感知状态到渲染进程
 */

import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import { createInterface } from 'readline'
import { BrowserWindow } from 'electron'
import { createLogger } from '../../shared/logger'
import { sensoryBus } from './sensory-bus'

const logger = createLogger('AudioSense')

/* ============================================================
 * 类型定义
 * ============================================================ */

export type AudioSenseStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'error'

export interface AudioSenseState {
  status: AudioSenseStatus
  db: number
  level: string
  speech: boolean
  music: boolean
  transient: boolean
  error?: string
}

interface AudioScene {
  ts: number
  db: number
  level: string
  speech: boolean
  music: boolean
  transient: boolean
}

/* ============================================================
 * AudioSenseBridge
 * ============================================================ */

export class AudioSenseBridge {
  private process: ChildProcess | null = null
  private state: AudioSenseState = {
    status: 'idle',
    db: -70,
    level: 'silence',
    speech: false,
    music: false,
    transient: false,
  }

  private pythonScriptPath: string

  constructor() {
    this.pythonScriptPath = join(__dirname, '../../scripts/audio_sense.py')
  }

  /* ==========================================================
   * 生命周期
   * ========================================================== */

  async start(): Promise<boolean> {
    if (this.state.status === 'running') {
      logger.warn('[AudioSense] 已在运行中')
      return true
    }

    this.state.status = 'starting'
    this.broadcastState()

    try {
      logger.info(`[AudioSense] 启动 Python 音频感知服务: ${this.pythonScriptPath}`)

      this.process = spawn('python', [this.pythonScriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      })

      // 监听 stderr
      if (this.process.stderr) {
        const stderrLines = createInterface({ input: this.process.stderr })
        stderrLines.on('line', (line: string) => {
          logger.debug(`[AudioSense:py] ${line}`)
        })
      }

      // 监听 stdout（JSON 场景事件）
      if (this.process.stdout) {
        const stdoutLines = createInterface({ input: this.process.stdout })
        stdoutLines.on('line', (line: string) => {
          try {
            const data = JSON.parse(line.trim())
            this.handleMessage(data)
          } catch {
            // 非 JSON 行，忽略
          }
        })
      }

      // 监听进程退出
      this.process.on('exit', (code) => {
        logger.info(`[AudioSense] Python 进程退出: code=${code}`)
        this.process = null
        if (this.state.status === 'running' || this.state.status === 'starting') {
          this.state.status = 'error'
          this.state.error = `Python 进程意外退出 (code=${code})`
          this.broadcastState()
        }
      })

      this.process.on('error', (err) => {
        logger.error(`[AudioSense] 进程错误: ${err.message}`)
        this.state.status = 'error'
        this.state.error = err.message
        this.broadcastState()
      })

      // 发送 start 命令
      this.sendCommand({ cmd: 'start' })

      // 等待一小段时间确认启动
      await new Promise(resolve => setTimeout(resolve, 500))

      if ((this.state as AudioSenseState).status !== 'error') {
        this.state.status = 'running'
        // M3 听觉情境：音频感知启动后打开听觉通道（隐私模式下 sensoryBus 会自动拦截）
        sensoryBus.setChannel('audio', { enabled: true, sampling: 'low' })
        this.broadcastState()
        logger.info('[AudioSense] 音频感知服务已启动')
        return true
      }

      return false
    } catch (e: any) {
      logger.error(`[AudioSense] 启动失败: ${e.message}`)
      this.state.status = 'error'
      this.state.error = e.message
      this.broadcastState()
      return false
    }
  }

  async stop(): Promise<void> {
    if (this.state.status !== 'running') return

    this.state.status = 'stopping'
    this.broadcastState()

    if (this.process) {
      this.sendCommand({ cmd: 'stop' })
      // 给 Python 进程一点时间优雅退出
      await new Promise(resolve => setTimeout(resolve, 500))
      if (this.process && !this.process.killed) {
        this.sendCommand({ cmd: 'exit' })
        this.process.kill()
      }
      this.process = null
    }

    this.state.status = 'idle'
    this.state.db = -70
    this.state.level = 'silence'
    this.state.speech = false
    this.state.music = false
    this.state.transient = false
    // M3 听觉情境：音频感知停止后关闭听觉通道
    sensoryBus.setChannel('audio', { enabled: false, sampling: 'off' })
    this.broadcastState()
    logger.info('[AudioSense] 音频感知服务已停止')
  }

  getState(): AudioSenseState {
    return { ...this.state }
  }

  /* ==========================================================
   * 消息处理
   * ========================================================== */

  private handleMessage(data: any): void {
    // 状态消息
    if (data.type === 'status') {
      logger.info(`[AudioSense] 状态: ${data.status}`)
      return
    }

    // 错误消息
    if (data.error) {
      logger.error(`[AudioSense] 错误: ${data.error}`)
      this.state.status = 'error'
      this.state.error = data.error
      this.broadcastState()
      return
    }

    // 场景事件（含 changed 标志，只有场景变化才输出）
    if (data.level !== undefined) {
      const scene: AudioScene = {
        ts: data.ts ?? Date.now(),
        db: data.db ?? -70,
        level: String(data.level),
        speech: Boolean(data.speech),
        music: Boolean(data.music),
        transient: Boolean(data.transient),
      }
      this.state.db = scene.db
      this.state.level = scene.level
      this.state.speech = scene.speech
      this.state.music = scene.music
      this.state.transient = scene.transient
      this.broadcastState()

      // M3 听觉情境：场景注入感官总线（audio 通道 / audio_input 类型）
      sensoryBus.emit({
        channel: 'audio',
        type: 'audio_input',
        ts: scene.ts,
        confidence: this.sceneConfidence(scene),
        payload: {
          db: scene.db,
          level: scene.level,
          speech: scene.speech,
          music: scene.music,
          transient: scene.transient,
        },
      })
    }
  }

  /** 场景置信度：级别越明确、事件越显著，置信度越高 */
  private sceneConfidence(scene: AudioScene): number {
    if (scene.transient) return 0.85
    if (scene.speech) return 0.8
    if (scene.music) return 0.75
    if (scene.level === 'silence') return 0.9
    if (scene.level === 'quiet') return 0.7
    if (scene.level === 'loud') return 0.8
    return 0.6
  }

  /* ==========================================================
   * 内部工具
   * ========================================================== */

  private sendCommand(cmd: object): void {
    if (this.process && this.process.stdin && !this.process.stdin.destroyed) {
      this.process.stdin.write(JSON.stringify(cmd) + '\n')
    }
  }

  private broadcastState(): void {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send('audio:state', this.state)
        } catch { /* pipe broken */ }
      }
    })
  }
}

export const audioSense = new AudioSenseBridge()
