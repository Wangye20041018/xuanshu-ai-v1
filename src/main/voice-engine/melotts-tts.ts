/* ============================================================
 * MeloTTS — 离线中文语音合成
 * 通过 Python 桥接脚本调用 MeloTTS 推理
 * 模型大小: ~100 MB，CPU 实时率: 25x
 * 降级方案: Edge TTS
 * ============================================================ */

import { logger } from '../../shared/logger'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { spawn, SpawnOptions } from 'child_process'
import { app } from 'electron'
import { pythonRuntime } from '../runtime/python'

export interface TTSResult {
  success: boolean
  audioPath?: string
  audioBuffer?: Buffer
  duration: number
  error?: string
}

export interface TTSConfig {
  modelPath: string
  speaker: string
  speed: number
  language: string
  useGPU: boolean
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

export class MeloTTS {
  private _config: TTSConfig
  private initialized: boolean = false
  private modelReady: boolean = false
  private cudaAvailable: boolean = false

  constructor(config: Partial<TTSConfig> = {}) {
    this._config = {
      modelPath: config.modelPath || '',
      speaker: config.speaker || 'ZH',
      speed: config.speed || 1.0,
      language: config.language || 'ZH',
      useGPU: config.useGPU || false,
    }
  }

  async initialize(): Promise<boolean> {
    try {
      this.modelReady = false

      // 检查模型文件是否存在
      if (this._config.modelPath && existsSync(this._config.modelPath)) {
        const onnxFiles = this.findOnnxFiles(this._config.modelPath)
        if (onnxFiles.length > 0) {
          this.modelReady = true
          logger.info(`[MeloTTS] 模型文件检查通过，发现 ${onnxFiles.length} 个 .onnx 文件`)
        } else {
          logger.warn(`[MeloTTS] 模型路径下未找到 .onnx 文件: ${this._config.modelPath}`)
        }
      } else {
        logger.warn(`[MeloTTS] 模型路径不存在: ${this._config.modelPath}`)
      }

      // 检查 CUDA 可用性
      if (this._config.useGPU) {
        this.cudaAvailable = await this.checkCUDAAvailability()
        if (this.cudaAvailable) {
          logger.info('[MeloTTS] CUDA 可用，将使用 GPU 加速')
        } else {
          logger.warn('[MeloTTS] CUDA 不可用，将回退到 CPU 模式')
        }
      }

      this.initialized = true
      logger.info('[MeloTTS] TTS 引擎初始化成功')
      return true
    } catch (err) {
      logger.error('[MeloTTS] 初始化失败:', err)
      return false
    }
  }

  /** 合成语音 */
  async synthesize(text: string, options?: Partial<TTSConfig>): Promise<TTSResult> {
    if (!this.initialized) {
      return { success: false, error: 'MeloTTS 未初始化', duration: 0 }
    }

    if (!text || !text.trim()) {
      return { success: false, error: '合成文本为空', duration: 0 }
    }

    const startTime = Date.now()

    // 优先使用 Python 桥接进行 MeloTTS 推理
    if (pythonRuntime.isReady() && this.modelReady) {
      try {
        const result = await this.synthesizeWithPython(text, options)
        if (result.success) {
          return { ...result, duration: Date.now() - startTime }
        }
        logger.warn('[MeloTTS] Python 桥接合成失败，尝试降级')
      } catch (err) {
        logger.warn('[MeloTTS] Python 桥接异常，尝试降级:', err)
      }
    }

    // 降级：使用 Edge TTS
    try {
      const result = await this.synthesizeWithEdgeTTS(text)
      return {
        ...result,
        duration: Date.now() - startTime,
      }
    } catch (err) {
      logger.error('[MeloTTS] Edge TTS 降级也失败:', err)
      return {
        success: false,
        error: `MeloTTS 合成失败: Python桥接不可用, Edge TTS降级也失败: ${err}`,
        duration: Date.now() - startTime,
      }
    }
  }

  /** 通过 Python 桥接合成 */
  private async synthesizeWithPython(text: string, _options?: Partial<TTSConfig>): Promise<TTSResult> {
    const tempDir = join(app.getPath('userData'), 'temp')
    mkdirSync(tempDir, { recursive: true })
    const outputPath = join(tempDir, `melo_output_${Date.now()}.wav`)

    try {
      const bridgeScript = this.getTTSBridgePath()
      const pyPath = pythonRuntime.getPythonPath()

      const speaker = _options?.speaker || this._config.speaker
      const speed = _options?.speed || this._config.speed

      const args = [
        bridgeScript,
        '--model', 'melotts',
        '--text', text,
        '--output', outputPath,
        '--speaker', speaker,
        '--speed', String(speed),
      ]

      if (this._config.useGPU && this.cudaAvailable) {
        args.push('--use-gpu')
      }

      const { stdout } = await spawnSafe(pyPath, args, { timeout: 60000 })

      const data = JSON.parse(stdout.trim().split('\n').pop() || '{}')
      if (data.status === 'ok' && existsSync(outputPath)) {
        const audioBuffer = readFileSync(outputPath)
        return {
          success: true,
          audioPath: outputPath,
          audioBuffer,
          duration: 0,
        }
      }

      return {
        success: false,
        error: data.error || 'Python 桥接合成失败',
        duration: 0,
      }
    } catch (err) {
      return {
        success: false,
        error: `Python 桥接异常: ${err}`,
        duration: 0,
      }
    }
  }

  /** 通过 Edge TTS 合成（降级方案） */
  private async synthesizeWithEdgeTTS(text: string): Promise<{ success: boolean; audioBuffer?: Buffer; error?: string }> {
    try {
      // 动态导入 Edge TTS 模块
      const { edgeTTS } = await import('../tts/edge')

      const voiceId = this._config.language === 'EN' ? 'en-US-AriaNeural' : 'zh-CN-XiaoxiaoNeural'
      const speed = this._config.speed

      const result = await edgeTTS.speak(text, voiceId, {
        rate: this.speedToEdgeRate(speed),
        pitch: 'default',
      })

      if (result.success && result.audioPath) {
        const audioBuffer = readFileSync(result.audioPath)
        return { success: true, audioBuffer }
      }

      return { success: false, error: result.error || 'Edge TTS 合成失败' }
    } catch (err) {
      return { success: false, error: `Edge TTS 降级失败: ${err}` }
    }
  }

  /** 流式合成 */
  async *synthesizeStream(text: string): AsyncGenerator<Buffer> {
    // 逐句合成，边生成边返回
    const sentences = text.split(/(?<=[。！？.!?])/g)
    for (const sentence of sentences) {
      if (!sentence.trim()) continue
      const result = await this.synthesize(sentence)
      if (result.audioBuffer) {
        yield result.audioBuffer
      }
    }
  }

  /** 检查 CUDA 可用性 */
  private async checkCUDAAvailability(): Promise<boolean> {
    // 检查 CUDA DLL 文件是否存在
    const cudaDllPaths = [
      join(process.resourcesPath, 'cudart64_12.dll'),
      join(app.getAppPath(), 'resources', 'cudart64_12.dll'),
    ]
    for (const p of cudaDllPaths) {
      if (existsSync(p)) {
        logger.debug(`[MeloTTS] 找到 CUDA DLL: ${p}`)
        return true
      }
    }

    // 如果 Python 可用，通过 Python 脚本检查
    if (pythonRuntime.isReady()) {
      try {
        const pyPath = pythonRuntime.getPythonPath()
        const { stdout } = await spawnSafe(pyPath, [
          '-c',
          'import torch; print("cuda_available=" + str(torch.cuda.is_available()))',
        ], { timeout: 10000 })
        return stdout.includes('cuda_available=True')
      } catch {
        logger.debug('[MeloTTS] 无法通过 Python 检测 CUDA')
      }
    }

    return false
  }

  /** 获取 TTS 桥接脚本路径 */
  private getTTSBridgePath(): string {
    const candidates = [
      join(process.resourcesPath, 'python', 'tts_bridge.py'),
      join(app.getAppPath(), 'resources', 'python', 'tts_bridge.py'),
    ]
    for (const p of candidates) {
      if (existsSync(p)) return p
    }
    return join(app.getAppPath(), 'resources', 'python', 'tts_bridge.py')
  }

  /** 在模型路径下查找 .onnx 文件 */
  private findOnnxFiles(dir: string): string[] {
    try {
      const { readdirSync } = require('fs') as typeof import('fs')
      return readdirSync(dir).filter((f: string) => f.endsWith('.onnx'))
    } catch {
      return []
    }
  }

  private speedToEdgeRate(speed: number): string {
    const percentage = Math.round((speed - 1.0) * 100)
    if (percentage === 0) return 'default'
    if (percentage > 0) return `+${percentage}%`
    return `${percentage}%`
  }

  /** 获取当前配置 */
  get config(): TTSConfig {
    return this._config
  }

  /** 获取可用音色 */
  getSpeakers(): string[] {
    return ['ZH', 'ZH-male', 'ZH-female', 'EN', 'EN-male', 'EN-female']
  }

  dispose(): void {
    this.initialized = false
  }
}