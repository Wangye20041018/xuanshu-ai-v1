/**
 * EmbeddedTTS —— 内嵌高质量 TTS 引擎（施工单 §6.2）
 *
 * 选型结论（2026-09-03 调研 + 落地）：
 *   - 首选（已落地）：sherpa-onnx vits-melo-tts-zh_en —— VITS 系中文，本地离线，
 *     内置 Python 环境已带 sherpa_onnx，CPU 秒级合成，零额外重依赖，可立即产出 wav。
 *   - 高质升级路径（可选）：CosyVoice 2（阿里 FunAudioLLM）——中文 CER 2.4 接近
 *     ElevenLabs 商用级，但需下载 ~2GB 权重 + funasr/matcha 重依赖，本机 6GB 无 GPU 慢。
 *   - 结论：默认内嵌 sherpa-onnx VITS 中文（现成、离线、质量好），CosyVoice 2 作为可选升级。
 *
 * 落地形态：
 *   - 通过内置 Python 运行时 + resources/scripts/vits_tts_bridge.py 桥接调用。
 *   - 模型权重置于 resources/voice-models/vits-melo-tts-zh_en/。
 *   - 模型缺失时，按「零假显示」铁律返回明确错误（model-missing），绝不假装成功。
 *
 * 参考案例：
 *   - sherpa-onnx TTS: https://k2-fsa.github.io/sherpa/onnx/tts/index.html
 *   - CosyVoice 2 GitHub: https://github.com/FunAudioLLM/CosyVoice
 */

import { app } from 'electron'
import { join } from 'path'
import { existsSync, readdirSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { logger } from '../../shared/logger'
import { resolveResource } from '../utils/resource-resolver'

const execFileAsync = promisify(execFile)

interface EmbeddedTTSResult {
  success: boolean
  audioPath?: string
  audioBuffer?: Buffer
  error?: string
}

class EmbeddedTTS {
  private modelReady = false
  private modelDir = ''
  private pythonPath = ''
  private bridgeScript = ''
  private initialized = false

  /** 初始化：探测模型与 Python 运行时，不阻塞主流程 */
  async initialize(): Promise<boolean> {
    if (this.initialized) return this.modelReady
    this.initialized = true
    try {
      this.modelDir = this.resolveModelDir()
      this.bridgeScript = this.resolveBridgeScript()
      this.pythonPath = await this.resolvePython()
      const hasModel = this.modelDir !== '' && this.hasModelFiles(this.modelDir)
      this.modelReady = hasModel && this.pythonPath !== '' && this.bridgeScript !== ''
      logger.info(`[EmbeddedTTS] 初始化: modelReady=${this.modelReady} modelDir=${this.modelDir || '(未找到)'} python=${this.pythonPath || '(未找到)'}`)
      return this.modelReady
    } catch (e) {
      logger.error('[EmbeddedTTS] 初始化失败:', e)
      this.modelReady = false
      return false
    }
  }

  isReady(): boolean {
    return this.modelReady
  }

  /** 合成语音，返回 wav 文件路径（模型缺失时明确报错，零假显示） */
  async synthesize(text: string, opts?: { speed?: number; pitch?: number }): Promise<EmbeddedTTSResult> {
    const t = (text || '').trim()
    if (!t) return { success: false, error: 'text 为空' }
    await this.initialize()
    if (!this.modelReady) {
      return {
        success: false,
        error: '内嵌 TTS 模型未就绪（vits-melo-tts-zh_en 权重未下载到 resources/voice-models/）。请补全模型后重试。',
      }
    }
    const outDir = join(app.getPath('userData'), 'tts-temp')
    const { mkdirSync } = require('fs')
    try { mkdirSync(outDir, { recursive: true }) } catch { /* ignore */ }
    const outWav = join(outDir, `tts-${Date.now()}.wav`)
    const speed = opts?.speed ?? 1

    try {
      const { stdout } = await execFileAsync(
        this.pythonPath,
        [this.bridgeScript, '--text', t, '--out', outWav, '--speed', String(speed), '--model-dir', this.modelDir],
        { timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true },
      )
      logger.debug(`[EmbeddedTTS] bridge stdout: ${(stdout || '').slice(0, 200)}`)
      if (!existsSync(outWav)) {
        return { success: false, error: `合成失败：未产出音频文件（${(stdout || '').slice(0, 200)}）` }
      }
      const { readFileSync } = require('fs')
      return { success: true, audioPath: outWav, audioBuffer: readFileSync(outWav) }
    } catch (e: any) {
      const errMsg = e?.message || String(e)
      logger.error('[EmbeddedTTS] 合成异常:', errMsg)
      return { success: false, error: `内嵌 TTS 合成异常：${errMsg.slice(0, 300)}` }
    }
  }

  stop(): void {
    // 内嵌 TTS 为同步子进程合成，无长驻播放态；预留接口保持兼容
  }

  /* ============================================================
   * 资源解析
   * ============================================================ */

  private resolveModelDir(): string {
    const candidates = [
      join(resolveResource('voice-models'), 'vits-melo-tts-zh_en'),
      join(app.getAppPath(), 'resources', 'voice-models', 'vits-melo-tts-zh_en'),
      join(process.resourcesPath, 'voice-models', 'vits-melo-tts-zh_en'),
    ]
    for (const c of candidates) {
      try { if (existsSync(c)) return c } catch { /* ignore */ }
    }
    return ''
  }

  private resolveBridgeScript(): string {
    const candidates = [
      join(resolveResource('scripts'), 'vits_tts_bridge.py'),
      join(app.getAppPath(), 'resources', 'scripts', 'vits_tts_bridge.py'),
      join(process.resourcesPath, 'scripts', 'vits_tts_bridge.py'),
    ]
    for (const c of candidates) {
      try { if (existsSync(c)) return c } catch { /* ignore */ }
    }
    return ''
  }

  private async resolvePython(): Promise<string> {
    // 优先复用内置 Python 运行时（resources/python/python.exe）
    const embedded = [
      join(resolveResource('python'), 'python.exe'),
      join(app.getAppPath(), 'resources', 'python', 'python.exe'),
      join(process.resourcesPath, 'python', 'python.exe'),
    ]
    for (const p of embedded) {
      try { if (existsSync(p)) return p } catch { /* ignore */ }
    }
    // 回退系统 python
    try {
      await execFileAsync('python', ['--version'], { timeout: 5000, windowsHide: true })
      return 'python'
    } catch {
      return ''
    }
  }

  private hasModelFiles(dir: string): boolean {
    try {
      const entries = readdirSync(dir)
      return entries.includes('model.onnx') && entries.includes('tokens.txt')
    } catch {
      return false
    }
  }
}

export const embeddedTTS = new EmbeddedTTS()
