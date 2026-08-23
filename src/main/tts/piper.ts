/* ============================================================
 * Piper TTS Engine — 离线文本转语音
 *
 * 文件路径: %APPDATA%/xuanshu/piper/
 * 首次使用自动检测 → 弹窗确认 → 下载到用户数据目录
 * ============================================================ */

import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import {existsSync, mkdirSync, createReadStream, unlinkSync, writeFileSync, readdirSync, statSync} from 'fs'
import { app, dialog } from 'electron'
import { createProxyAgent } from '../utils/proxy-resolver'
import { execSync } from 'child_process'
import { POWERSHELL_EXE } from '../utils/powershell'
import { logger } from '../../shared/logger'

/* ============================================================
 * 类型定义
 * ============================================================ */
export interface VoiceModel {
  id: string
  name: string
  gender: 'male' | 'female'
  modelFile: string
  modelConfig: string
}

export interface PiperOptions {
  speed?: number       // 语速: 0.5 ~ 2.0, 默认 1.0
  pitch?: number       // 音调: 0.5 ~ 2.0 (通过 noise_scale 模拟)
  volume?: number      // 音量: 0.0 ~ 1.0 (客户端调节)
  timeout?: number     // 超时(ms): 默认 30000
}

export interface SynthesizeResult {
  success: boolean
  audioPath?: string
  error?: string
  engine: 'piper'
  modelId: string
}

/* ============================================================
 * 支持的语音模型
 * ============================================================ */
export const PIPER_VOICE_MODELS: VoiceModel[] = [
  {
    id: 'zh_female_warm',
    name: '中文女声·温暖 (Piper)',
    gender: 'female',
    modelFile: 'zh_CN-huayan-medium.onnx',
    modelConfig: 'zh_CN-huayan-medium.onnx.json'
  },
  {
    id: 'zh_female_bright',
    name: '中文女声·明亮 (Piper)',
    gender: 'female',
    modelFile: 'zh_CN-xiao_ya-medium.onnx',
    modelConfig: 'zh_CN-xiao_ya-medium.onnx.json'
  },
  {
    id: 'zh_male',
    name: '中文男声 (Piper)',
    gender: 'male',
    modelFile: 'zh_CN-chaowen-medium.onnx',
    modelConfig: 'zh_CN-chaowen-medium.onnx.json'
  }
]

/* ============================================================
 * PiperTTS 类
 * ============================================================ */
export class PiperTTS {
  private currentProcess: ChildProcess | null = null
  private isSpeakingFlag: boolean = false
  private piperExePath: string
  private modelDir: string
  private tempDir: string
  private initialized: boolean = false
  private piperAvailable: boolean = false

  constructor() {
    // 延迟初始化，等待 app ready
    this.piperExePath = ''
    this.modelDir = ''
    this.tempDir = ''
  }

  /* ------ 初始化：检测 piper.exe 和模型文件 ------ */
  initialize(): boolean {
    if (this.initialized) return this.piperAvailable

    try {
      this.tempDir = join(app.getPath('userData'), 'tts-temp')
      mkdirSync(this.tempDir, { recursive: true })

      // 搜索顺序: resources/piper/ → userData/piper/
      const searchPaths = [
        { exe: join(process.resourcesPath, 'piper', 'piper.exe'), dir: join(process.resourcesPath, 'piper') },
        { exe: join(app.getPath('userData'), 'piper', 'piper.exe'), dir: join(app.getPath('userData'), 'piper') },
      ]

      // 开发环境额外路径
      if (!app.isPackaged) {
        searchPaths.unshift({
          exe: join(app.getAppPath(), 'resources', 'piper', 'piper.exe'),
          dir: join(app.getAppPath(), 'resources', 'piper')
        })
      }

      for (const sp of searchPaths) {
        if (existsSync(sp.exe)) {
          this.piperExePath = sp.exe
          this.modelDir = sp.dir
          this.piperAvailable = true
          logger.debug('[PiperTTS] piper.exe found at:', sp.exe)
          break
        }
      }

      if (!this.piperAvailable) {
        logger.warn('[PiperTTS] piper.exe 未找到，需要下载')
        this.modelDir = join(app.getPath('userData'), 'piper')
        this.piperExePath = join(this.modelDir, 'piper.exe')
      }

      this.initialized = true
      return this.piperAvailable
    } catch (e) {
      logger.error('[PiperTTS] 初始化失败:', e)
      this.initialized = true
      return false
    }
  }

  /* ------ 检查是否需要下载 ------ */
  needsDownload(): boolean {
    this.initialize()
    if (this.piperAvailable) return false
    // 检查模型文件
    for (const model of PIPER_VOICE_MODELS) {
      if (!existsSync(join(this.modelDir, model.modelFile))) return true
    }
    return !existsSync(this.piperExePath)
  }

  /* ------ 自动下载 piper.exe 和中文模型（用户确认后） ------ */
  async downloadPiper(parentWindow?: any): Promise<boolean> {
    const win = parentWindow || undefined
    const { response } = await dialog.showMessageBox(win || undefined as any, {
      type: 'question',
      title: '下载离线语音引擎',
      message: '离线语音合成需要 Piper 引擎（约 55MB），是否下载？',
      detail: '下载内容：\n• piper.exe 语音合成引擎（5MB）\n• 中文女声模型（50MB）\n\n下载位置：%APPDATA%\\xuanshu\\piper\n不会污染系统环境，仅限本软件使用。',
      buttons: ['确认下载', '取消'],
      defaultId: 0,
      cancelId: 1
    })

    if (response !== 0) {
      logger.debug('[PiperTTS] 用户取消下载')
      return false
    }

    try {
      mkdirSync(this.modelDir, { recursive: true })

      const proxyAgent = createProxyAgent()
      const fetchOpts: any = {}
      if (proxyAgent) fetchOpts.dispatcher = proxyAgent

      // 1. 下载 piper.exe
      const piperUrl = 'https://github.com/rhasspy/piper/releases/download/v1.2.0/piper_windows_amd64.zip'
      const piperTemp = join(this.tempDir, 'piper.zip')

      logger.debug('[PiperTTS] 下载 piper.exe...')
      const piperResp = await fetch(piperUrl, fetchOpts)
      if (!piperResp.ok) throw new Error(`piper.exe 下载失败: HTTP ${piperResp.status}`)
      const piperBuffer = Buffer.from(await piperResp.arrayBuffer())
      require('fs').writeFileSync(piperTemp, piperBuffer)

      // 解压 piper.exe
      try {
        execSync(`"${POWERSHELL_EXE}" -Command "Expand-Archive -Path '${piperTemp}' -DestinationPath '${this.modelDir}' -Force"`, { timeout: 30000 })
        unlinkSync(piperTemp)
      } catch {
        // 备用：使用 7z
        try {
          execSync(`7z e "${piperTemp}" -o"${this.modelDir}" piper.exe -y`, { timeout: 30000 })
          unlinkSync(piperTemp)
        } catch {
          unlinkSync(piperTemp)
          throw new Error('piper.exe 解压失败')
        }
      }

      // 2. 下载中文女声模型
      const modelUrl = 'https://hf-mirror.com/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx'
      const modelConfigUrl = 'https://hf-mirror.com/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx.json'

      logger.debug('[PiperTTS] 下载中文模型...')
      const [modelResp, configResp] = await Promise.all([
        fetch(modelUrl, fetchOpts),
        fetch(modelConfigUrl, fetchOpts),
      ])

      if (!modelResp.ok) throw new Error(`模型下载失败: HTTP ${modelResp.status}`)
      if (!configResp.ok) throw new Error(`模型配置下载失败: HTTP ${configResp.status}`)

      const modelBuffer = Buffer.from(await modelResp.arrayBuffer())
      const configBuffer = Buffer.from(await configResp.arrayBuffer())

      require('fs').writeFileSync(join(this.modelDir, 'zh_CN-huayan-medium.onnx'), modelBuffer)
      require('fs').writeFileSync(join(this.modelDir, 'zh_CN-huayan-medium.onnx.json'), configBuffer)

      // 重新检测
      this.piperAvailable = true
      logger.debug('[PiperTTS] 下载完成，Piper 可用')
      return true
    } catch (e: any) {
      logger.error('[PiperTTS] 下载失败:', e.message)
      dialog.showErrorBox('下载失败', `离线语音引擎下载失败:\n${e.message}\n\n请检查网络连接后重试。`)
      return false
    }
  }

  /* ------ 检查是否可用 ------ */
  isAvailable(): boolean {
    return this.piperAvailable
  }

  /* ------ 获取模型路径 ------ */
  getModelPath(modelId: string): { modelFile: string; configFile: string } | null {
    const model = PIPER_VOICE_MODELS.find(m => m.id === modelId)
    if (!model) return null
    const modelPath = join(this.modelDir, model.modelFile)
    const configPath = join(this.modelDir, model.modelConfig)
    if (!existsSync(modelPath) || !existsSync(configPath)) {
      return null
    }
    return { modelFile: modelPath, configFile: configPath }
  }

  /* ------ 语音合成 ------ */
  async speak(
    text: string,
    voiceModelId: string,
    options: PiperOptions = {}
  ): Promise<SynthesizeResult> {
    if (!this.piperAvailable) {
      return {
        success: false,
        error: 'Piper TTS 引擎不可用：piper.exe 未找到，请将 piper.exe 放入 resources/piper/ 目录',
        engine: 'piper',
        modelId: voiceModelId
      }
    }

    if (!text || text.trim().length === 0) {
      return {
        success: false,
        error: '合成文本为空',
        engine: 'piper',
        modelId: voiceModelId
      }
    }

    const modelPaths = this.getModelPath(voiceModelId)
    if (!modelPaths) {
      return {
        success: false,
        error: `语音模型 "${voiceModelId}" 未找到，请确保模型文件已放入 resources/piper/ 目录`,
        engine: 'piper',
        modelId: voiceModelId
      }
    }

    const {
      speed = 1.0,
      timeout = 30000
    } = options

    // 约束参数范围
    const safeSpeed = Math.max(0.5, Math.min(2.0, speed))

    // 生成临时文件路径
    const timestamp = Date.now()
    const inputFile = join(this.tempDir, `piper_input_${timestamp}.txt`)
    const outputFile = join(this.tempDir, `piper_output_${timestamp}.wav`)

    try {
      // 写入文本到临时文件
      writeFileSync(inputFile, text, 'utf-8')

      // 构建 piper 命令参数
      // piper.exe --model <model> --config <config> --output_file <output> --length_scale <speed>
      const args = [
        '--model', modelPaths.modelFile,
        '--config', modelPaths.configFile,
        '--output_file', outputFile,
        '--length_scale', safeSpeed.toFixed(2),
        '--output_raw'
      ]

      logger.debug(`[PiperTTS] 开始合成: voiceModel=${voiceModelId}, textLen=${text.length}, speed=${safeSpeed}`)

      // 通过子进程调用 piper.exe
      const result = await this.runPiper(args, inputFile, timeout)

      if (!result.success) {
        return {
          success: false,
          error: result.error || 'Piper 合成失败',
          engine: 'piper',
          modelId: voiceModelId
        }
      }

      // 清理历史临时音频，防止磁盘无限增长（保留最近 30 个）
      this.cleanupTempAudio('piper_output_', 30)

      return {
        success: true,
        audioPath: outputFile,
        engine: 'piper',
        modelId: voiceModelId
      }
    } catch (e) {
      logger.error('[PiperTTS] 合成异常:', e)
      return {
        success: false,
        error: String(e),
        engine: 'piper',
        modelId: voiceModelId
      }
    } finally {
      // 清理输入文件
      try { unlinkSync(inputFile) } catch (e) { logger.error('[PiperTTS] 清理输入文件失败:', e) }
    }
  }

  /* ------ 流式合成（通过 IPC 发送音频 buffer） ------ */
  async speakStream(
    text: string,
    voiceModelId: string,
    onChunk: (buffer: Buffer) => void,
    options: PiperOptions = {}
  ): Promise<SynthesizeResult> {
    if (!this.piperAvailable) {
      return {
        success: false,
        error: 'Piper TTS 引擎不可用',
        engine: 'piper',
        modelId: voiceModelId
      }
    }

    if (!text || text.trim().length === 0) {
      return {
        success: false,
        error: '合成文本为空',
        engine: 'piper',
        modelId: voiceModelId
      }
    }

    const modelPaths = this.getModelPath(voiceModelId)
    if (!modelPaths) {
      return {
        success: false,
        error: `语音模型 "${voiceModelId}" 未找到`,
        engine: 'piper',
        modelId: voiceModelId
      }
    }

    const {
      speed = 1.0,
      timeout = 30000
    } = options

    const safeSpeed = Math.max(0.5, Math.min(2.0, speed))

    return new Promise((resolve) => {
      // 使用 --output-raw 输出原始 PCM 到 stdout
      const args = [
        '--model', modelPaths.modelFile,
        '--config', modelPaths.configFile,
        '--output-raw',
        '--length_scale', safeSpeed.toFixed(2)
      ]

      logger.debug(`[PiperTTS] 开始流式合成: voiceModel=${voiceModelId}, textLen=${text.length}`)

      try {
        this.currentProcess = spawn(this.piperExePath, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          // @ts-ignore TS2769 — maxBuffer not in spawn options type
          maxBuffer: 16 * 1024 * 1024
        })

        this.isSpeakingFlag = true

        const timeoutId = setTimeout(() => {
          this.killProcess()
          this.isSpeakingFlag = false
          resolve({
            success: false,
            error: 'Piper 合成超时',
            engine: 'piper',
            modelId: voiceModelId
          })
        }, timeout)

        // 写入文本到 stdin
        this.currentProcess!.stdin?.write(text, 'utf-8')
        this.currentProcess!.stdin?.end()

        // 读取 stdout 的原始 PCM 数据
        const chunks: Buffer[] = []
        this.currentProcess!.stdout?.on('data', (data: Buffer) => {
          chunks.push(data)
          onChunk(data)
        })

        this.currentProcess!.stderr?.on('data', (data: Buffer) => {
          logger.warn('[PiperTTS] stderr:', data.toString())
        })

        this.currentProcess!.on('close', (code) => {
          clearTimeout(timeoutId)
          this.currentProcess = null
          this.isSpeakingFlag = false
          if (code === 0) {
            resolve({
              success: true,
              audioPath: undefined,
              engine: 'piper',
              modelId: voiceModelId
            })
          } else {
            resolve({
              success: false,
              error: `Piper 进程退出，代码: ${code}`,
              engine: 'piper',
              modelId: voiceModelId
            })
          }
        })

        this.currentProcess!.on('error', (err) => {
          clearTimeout(timeoutId)
          this.currentProcess = null
          this.isSpeakingFlag = false
          resolve({
            success: false,
            error: `Piper 进程错误: ${err.message}`,
            engine: 'piper',
            modelId: voiceModelId
          })
        })
      } catch (e) {
        this.currentProcess = null
        this.isSpeakingFlag = false
        resolve({
          success: false,
          error: `启动 Piper 失败: ${String(e)}`,
          engine: 'piper',
          modelId: voiceModelId
        })
      }
    })
  }

  /* ------ 停止合成 ------ */
  stop(): void {
    this.killProcess()
  }

  /* ------ 是否正在合成 ------ */
  isSpeaking(): boolean {
    return this.isSpeakingFlag
  }

  /* ------ 获取可用模型列表 ------ */
  getAvailableModels(): VoiceModel[] {
    if (!this.piperAvailable) return []
    return PIPER_VOICE_MODELS.filter(model => {
      const modelPath = join(this.modelDir, model.modelFile)
      const configPath = join(this.modelDir, model.modelConfig)
      return existsSync(modelPath) && existsSync(configPath)
    })
  }

  /* ------ 获取临时目录 ------ */
  getTempDir(): string {
    return this.tempDir
  }

  /* ============================================================
   * 私有方法
   * ============================================================ */

  /* ------ 清理历史临时音频（保留最近 N 个，防止 tts-temp 无限增长） ------ */
  private cleanupTempAudio(prefix: string, keep: number): void {
    try {
      const files = readdirSync(this.tempDir)
        .filter((f) => f.startsWith(prefix) && f.endsWith('.wav'))
        .map((f) => {
          const p = join(this.tempDir, f)
          try { return { p, m: statSync(p).mtimeMs } } catch { return null }
        })
        .filter((x): x is { p: string; m: number } => x !== null)
        .sort((a, b) => b.m - a.m)
      for (const f of files.slice(keep)) {
        try { unlinkSync(f.p) } catch { /* 忽略并发占用 */ }
      }
      if (files.length > keep) logger.debug(`[PiperTTS] 清理旧音频: 删除 ${files.length - keep} 个`)
    } catch (e) {
      logger.error('[PiperTTS] 清理临时音频失败:', e)
    }
  }

  /* ------ 运行 piper.exe 子进程 ------ */
  private runPiper(
    args: string[],
    inputFile: string,
    timeout: number
  ): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      try {
        this.currentProcess = spawn(this.piperExePath, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          // @ts-ignore TS2769 — maxBuffer not in spawn options type
          maxBuffer: 16 * 1024 * 1024
        })
      } catch (e) {
        resolve({ success: false, error: 'Piper 合成启动失败: ' + String(e) })
        return
      }

      const timeoutId = setTimeout(() => {
          this.killProcess()
          resolve({ success: false, error: 'Piper 合成超时' })
        }, timeout)

        // 将输入文件内容通过 stdin 传入
        const inputStream = createReadStream(inputFile)
        inputStream.pipe(this.currentProcess!.stdin!)

        let stderr = ''
        this.currentProcess!.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString()
        })

        this.currentProcess!.on('close', (code) => {
          clearTimeout(timeoutId)
          this.currentProcess = null
          if (code === 0) {
            resolve({ success: true })
          } else {
            resolve({
              success: false,
              error: stderr || `Piper 进程退出，代码: ${code}`
            })
          }
        })

        this.currentProcess!.on('error', (err) => {
          clearTimeout(timeoutId)
          this.currentProcess = null
          resolve({ success: false, error: `Piper 进程错误: ${err.message}` })
        })
    })
  }

  /* ------ 终止当前子进程 ------ */
  private killProcess(): void {
    if (this.currentProcess) {
      try {
        this.currentProcess.kill('SIGTERM')
        // Windows 上 SIGTERM 可能无效，使用 taskkill 兜底
        if (process.platform === 'win32' && this.currentProcess.pid) {
          try {
            const { execSync } = require('child_process')
            execSync(`taskkill /PID ${this.currentProcess.pid} /T /F 2>nul`, { timeout: 3000 })
          } catch (e) { logger.error('[PiperTTS] taskkill清理进程失败:', e) }
        }
      } catch (e) {
        logger.error('[PiperTTS] 终止进程失败:', e)
      } finally {
        this.currentProcess = null
      }
    }
    this.isSpeakingFlag = false
  }
}

/* ============================================================
 * 单例导出
 * ============================================================ */
export const piperTTS = new PiperTTS()