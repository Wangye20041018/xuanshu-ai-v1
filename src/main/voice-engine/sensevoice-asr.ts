/* ============================================================
 * SenseVoice-Small ASR — 离线语音识别
 * 通过 sherpa-onnx 子进程调用 / Python 桥接脚本
 * 模型大小: ~150 MB，CPU 实时率: 17x
 * ============================================================ */

import { logger } from '../../shared/logger'
import { EventEmitter } from 'events'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { spawn, SpawnOptions } from 'child_process'
import { app } from 'electron'
import { pythonRuntime } from '../runtime/python'

export interface ASRResult {
  text: string
  isFinal: boolean
  confidence: number
  duration: number
  emotion?: 'happy' | 'sad' | 'angry' | 'neutral' | 'surprised'
  audioEvents?: string[]  // 如 ['applause', 'laughter']
  error?: string
}

export interface ASRConfig {
  modelPath: string
  sampleRate: number
  language: string
  useGPU: boolean
  vadThreshold: number
  vadSilenceDuration: number
}

/** spawnSafe — spawn 封装，避免中文路径经 cmd.exe 时被 GBK 编码乱码 */
function spawnSafe(
  command: string,
  args: string[],
  options?: { timeout?: number; cwd?: string }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
    if (options?.cwd) spawnOpts.cwd = options.cwd
    const child = spawn(command, args, spawnOpts)
    const timer = options?.timeout
      ? setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`spawnSafe 超时 (${options.timeout}ms)`)) }, options.timeout)
      : null
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString('utf-8') })
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString('utf-8') })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr || `Exit code: ${code}`))
    })
    child.on('error', (err) => { if (timer) clearTimeout(timer); reject(err) })
  })
}

export class SenseVoiceASR extends EventEmitter {
  private config: ASRConfig
  private initialized: boolean = false
  private processing: boolean = false
  private audioBuffer: Float32Array[] = []
  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  private currentPartial: string = ''
  private modelReady: boolean = false

  constructor(config: Partial<ASRConfig> = {}) {
    super()
    this.config = {
      modelPath: config.modelPath || '',
      sampleRate: config.sampleRate || 16000,
      language: config.language || 'zh',
      useGPU: config.useGPU || false,
      vadThreshold: config.vadThreshold || 0.5,
      vadSilenceDuration: config.vadSilenceDuration || 800,
    }
  }

  async initialize(): Promise<boolean> {
    try {
      this.modelReady = false

      // 检查模型文件是否存在
      const modelOnnx = join(this.config.modelPath, 'model.onnx')
      const tokensFile = join(this.config.modelPath, 'tokens.txt')

      if (!existsSync(modelOnnx)) {
        logger.warn(`[SenseVoice] 模型文件不存在: ${modelOnnx}`)
      } else if (!existsSync(tokensFile)) {
        logger.warn(`[SenseVoice] tokens 文件不存在: ${tokensFile}`)
      } else {
        this.modelReady = true
        logger.info('[SenseVoice] 模型文件检查通过 (model.onnx + tokens.txt)')
      }

      // 检查 Python 桥接脚本是否可用
      if (!this.modelReady) {
        const pythonBridgeAvailable = pythonRuntime.isReady()
        if (pythonBridgeAvailable) {
          logger.info('[SenseVoice] 将使用 Python 桥接脚本进行识别')
        } else {
          logger.warn('[SenseVoice] Python 不可用，ASR 将返回空结果')
        }
      }

      this.initialized = true
      logger.info('[SenseVoice] ASR 引擎初始化成功')
      this.emit('ready')
      return true
    } catch (err) {
      logger.error('[SenseVoice] 初始化失败:', err)
      this.emit('error', err)
      return false
    }
  }

  /** 添加音频数据 */
  feedAudioData(audioData: Float32Array): void {
    if (!this.initialized) return

    this.audioBuffer.push(audioData)

    // VAD 检测
    const energy = this.computeEnergy(audioData)
    if (energy > this.config.vadThreshold) {
      this.resetSilenceTimer()
      if (!this.processing) {
        this.processAudio()
      }
    }
  }

  /** 处理音频流 */
  private async processAudio(): Promise<void> {
    this.processing = true

    try {
      // 合并音频缓冲
      const combined = this.mergeBuffers(this.audioBuffer)
      this.audioBuffer = []

      // 实际 ASR 处理
      const result = await this.recognize(combined)

      if (result.text) {
        if (result.isFinal) {
          this.currentPartial = ''
          this.emit('result', result)
        } else {
          this.currentPartial = result.text
          this.emit('partial', result)
        }
      }
    } catch (err) {
      logger.error('[SenseVoice] 识别失败:', err)
      this.emit('error', err)
    } finally {
      this.processing = false
    }
  }

  /** 实际识别调用 */
  private async recognize(audio: Float32Array): Promise<ASRResult> {
    const duration = audio.length / this.config.sampleRate

    // 如果模型未就绪，返回空结果
    if (!this.modelReady && !pythonRuntime.isReady()) {
      return {
        text: this.currentPartial || '',
        isFinal: false,
        confidence: 0,
        duration,
        error: 'ASR 模型未就绪，请先下载 SenseVoice 模型',
      }
    }

    try {
      // 将 Float32Array 写入临时 WAV 文件
      const tempDir = join(app.getPath('userData'), 'temp')
      mkdirSync(tempDir, { recursive: true })
      const wavPath = join(tempDir, `asr_input_${Date.now()}.wav`)

      try {
        this.writeWavFile(wavPath, audio, this.config.sampleRate)

        let result: ASRResult

        if (this.modelReady) {
          // 优先使用 sherpa-onnx 命令行工具
          result = await this.recognizeWithSherpaOnnx(wavPath, duration)
        } else {
          // 使用 Python 桥接脚本
          result = await this.recognizeWithPython(wavPath, duration)
        }

        return result
      } finally {
        // 清理临时文件
        try { unlinkSync(wavPath) } catch { /* ignore */ }
      }
    } catch (err) {
      logger.error('[SenseVoice] 识别调用失败:', err)
      return {
        text: this.currentPartial || '',
        isFinal: false,
        confidence: 0,
        duration,
        error: String(err),
      }
    }
  }

  /** 通过 sherpa-onnx 命令行工具识别 */
  private async recognizeWithSherpaOnnx(wavPath: string, duration: number): Promise<ASRResult> {
    try {
      const { stdout } = await spawnSafe(
        'sherpa-onnx-offline',
        [
          '--model-dir', this.config.modelPath,
          '--input-file', wavPath,
        ],
        { timeout: 30000 }
      )

      const result = this.parseSherpaOutput(stdout, duration)
      return result
    } catch (err) {
      logger.warn('[SenseVoice] sherpa-onnx 命令行调用失败，尝试 Python 桥接:', err)
      return this.recognizeWithPython(wavPath, duration)
    }
  }

  /** 通过 Python 桥接脚本识别 */
  private async recognizeWithPython(wavPath: string, duration: number): Promise<ASRResult> {
    if (!pythonRuntime.isReady()) {
      return {
        text: this.currentPartial || '',
        isFinal: false,
        confidence: 0,
        duration,
        error: 'Python 不可用，ASR 无法执行',
      }
    }

    try {
      // 获取 asr_bridge.py 路径
      const bridgeScript = this.getAsrBridgePath()
      const pyPath = pythonRuntime.getPythonPath()

      const { stdout } = await spawnSafe(pyPath, [
        bridgeScript,
        '--model', 'sensevoice',
        '--input', wavPath,
      ], { timeout: 60000 })

      const data = JSON.parse(stdout.trim().split('\n').pop() || '{}')
      if (data.status === 'ok') {
        return {
          text: data.text || '',
          isFinal: true,
          confidence: data.confidence || 0.9,
          duration,
          emotion: data.emotion,
          audioEvents: data.audio_events,
        }
      }

      return {
        text: this.currentPartial || '',
        isFinal: false,
        confidence: 0,
        duration,
        error: data.error || 'Python 桥接识别失败',
      }
    } catch (err) {
      throw new Error(`Python ASR 桥接失败: ${err}`)
    }
  }

  /** 解析 sherpa-onnx 输出 */
  private parseSherpaOutput(output: string, duration: number): ASRResult {
    // sherpa-onnx 输出格式: 每行一条识别结果，JSON 格式
    const lines = output.trim().split('\n')
    const lastLine = lines[lines.length - 1] || ''

    try {
      const data = JSON.parse(lastLine)
      return {
        text: data.text || '',
        isFinal: true,
        confidence: data.confidence || 0.9,
        duration,
        emotion: data.emotion,
        audioEvents: data.audio_events,
      }
    } catch {
      // 非 JSON 输出，直接作为文本
      const text = lastLine.trim()
      return {
        text,
        isFinal: true,
        confidence: text.length > 0 ? 0.8 : 0,
        duration,
      }
    }
  }

  /** 获取 ASR 桥接脚本路径 */
  private getAsrBridgePath(): string {
    const candidates = [
      join(process.resourcesPath, 'python', 'asr_bridge.py'),
      join(app.getAppPath(), 'resources', 'python', 'asr_bridge.py'),
    ]
    for (const p of candidates) {
      if (existsSync(p)) return p
    }
    // 回退到开发环境路径
    return join(app.getAppPath(), 'resources', 'python', 'asr_bridge.py')
  }

  /** 将 Float32Array 写入 WAV 文件 */
  private writeWavFile(filePath: string, audio: Float32Array, sampleRate: number): void {
    const numChannels = 1
    const bitsPerSample = 16
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
    const blockAlign = numChannels * (bitsPerSample / 8)
    const dataSize = audio.length * (bitsPerSample / 8)
    const headerSize = 44

    const buffer = Buffer.alloc(headerSize + dataSize)

    // RIFF header
    buffer.write('RIFF', 0)
    buffer.writeUInt32LE(36 + dataSize, 4)
    buffer.write('WAVE', 8)

    // fmt chunk
    buffer.write('fmt ', 12)
    buffer.writeUInt32LE(16, 16) // chunk size
    buffer.writeUInt16LE(1, 20) // PCM format
    buffer.writeUInt16LE(numChannels, 22)
    buffer.writeUInt32LE(sampleRate, 24)
    buffer.writeUInt32LE(byteRate, 28)
    buffer.writeUInt16LE(blockAlign, 32)
    buffer.writeUInt16LE(bitsPerSample, 34)

    // data chunk
    buffer.write('data', 36)
    buffer.writeUInt32LE(dataSize, 40)

    // 写入音频数据
    for (let i = 0; i < audio.length; i++) {
      const sample = Math.max(-1, Math.min(1, audio[i]))
      const intSample = sample < 0 ? sample * 32768 : sample * 32767
      buffer.writeInt16LE(intSample, headerSize + i * 2)
    }

    writeFileSync(filePath, buffer)
  }

  /** 结束识别，返回最终结果 */
  async finalize(): Promise<ASRResult> {
    const combined = this.mergeBuffers(this.audioBuffer)
    this.audioBuffer = []

    if (combined.length === 0) {
      return {
        text: this.currentPartial,
        isFinal: true,
        confidence: 0,
        duration: 0,
      }
    }

    // 尝试最终识别
    try {
      return await this.recognize(combined)
    } catch {
      return {
        text: this.currentPartial,
        isFinal: true,
        confidence: 0.9,
        duration: combined.length / this.config.sampleRate,
      }
    }
  }

  private computeEnergy(audio: Float32Array): number {
    let sum = 0
    for (let i = 0; i < audio.length; i++) {
      sum += audio[i] * audio[i]
    }
    return Math.sqrt(sum / audio.length)
  }

  private mergeBuffers(buffers: Float32Array[]): Float32Array {
    const totalLength = buffers.reduce((sum, b) => sum + b.length, 0)
    const result = new Float32Array(totalLength)
    let offset = 0
    for (const buf of buffers) {
      result.set(buf, offset)
      offset += buf.length
    }
    return result
  }

  private resetSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    this.silenceTimer = setTimeout(() => {
      this.emit('silence')
    }, this.config.vadSilenceDuration)
  }

  dispose(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    this.removeAllListeners()
    this.initialized = false
  }
}