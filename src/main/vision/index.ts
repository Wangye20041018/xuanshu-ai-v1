import {app, desktopCapturer} from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readdirSync } from 'fs'
import { createHash } from 'crypto'
import { spawn, ChildProcess } from 'child_process'
import { pythonRuntime } from '../runtime/python'
import { modelManager } from '../model-manager'
import { logger } from '../../shared/logger'

// ==================== 接口定义 ====================

interface VisionAnalysisResult {
  success: boolean
  description?: string
  text?: string
  objects?: string[]
  error?: string
}

interface ScreenCapture {
  dataUrl: string
  timestamp: number
  width: number
  height: number
}

interface LocateResult {
  x: number
  y: number
  confidence: number
  error?: string
}

interface SGLangMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | Array<{
    type: 'text' | 'image_url'
    text?: string
    image_url?: { url: string }
  }>
}

interface SGLangResponse {
  choices: Array<{
    message: {
      content: string
    }
  }>
}

interface CacheEntry {
  result: VisionAnalysisResult
  timestamp: number
}

// ==================== 常量 ====================

/** 缓存最大条目数 */
const MAX_CACHE_SIZE = 10

/**
 * 纯内存 CPU 视觉后端（Qwen2-VL-2B）：
 * - SGLang(30000) 不可用时自动拉起本地 llama-server，Qwen2-VL-2B 走纯 CPU（-ngl 0）内存推理，
 *   适配 6GB 显存机器闭环图片识别（上下文/图片 token 全由系统内存承载）。
 * - 端口固定 30001，避免与 tandem 本地文本引擎 8082 冲突。
 */
const LOCAL_VL_PORT = 30001
const LOCAL_VL_MODEL_ID = 'qwen2-vl-2b'
const LOCAL_VL_MODEL_FILE = 'Qwen2-VL-2B-Instruct-Q4_K_M.gguf'
const LOCAL_VL_MMPROJ_FILE = 'mmproj-Qwen2-VL-2B-Instruct-f16.gguf'

/** JPEG 压缩质量（0-100），70% 大幅减少传输量同时保持可读性 */
const JPEG_QUALITY = 70

/** 超时分级（毫秒） */
const TIMEOUTS = {
  LOCATE: 10000,    // 定位元素：10秒
  ANALYZE: 20000,   // 图像分析：20秒
  OCR: 15000,       // 文字识别：15秒
  DEFAULT: 30000,   // 默认：30秒
  PRELOAD: 5000,    // 预热：5秒
  BATCH: 60000,     // 批量分析：60秒（多图合并，适当放宽）
}

// ==================== VisionModel 类 ====================

class VisionModel {
  private modelPath: string | null = null
  private modelLoaded: boolean = false
  private lastCapture: ScreenCapture | null = null
  private analysisCache: Map<string, CacheEntry> = new Map()
  private cacheOrder: string[] = []  // LRU 顺序追踪
  private sglangBaseUrl: string = 'http://127.0.0.1:30000'
  private captureResolution: { width: number; height: number } = { width: 1280, height: 720 }
  // ---- 纯内存 CPU 视觉后端（Qwen2-VL-2B）状态 ----
  private cpuFallbackEnabled: boolean = true
  private localVLProcess: ChildProcess | null = null
  private localVLBaseUrl: string = `http://127.0.0.1:${LOCAL_VL_PORT}`
  private localVLReady: boolean = false
  private localVLAvailable: boolean = false
  private localVLLock: Promise<boolean> | null = null

  constructor() {
    // 延迟初始化，等待 app ready
  }

  // ==================== 初始化 ====================

  initialize(): void {
    if (this.modelPath) return
    this.modelPath = join(app.getPath('userData'), 'models', 'vision')
    mkdirSync(this.modelPath, { recursive: true })
    this.modelLoaded = true
  }

  isLoaded(): boolean {
    return this.modelLoaded
  }

  // ==================== 分辨率配置 ====================

  /**
   * 设置截图分辨率
   * @param width - 截图宽度（像素）
   * @param height - 截图高度（像素）
   */
  setResolution(width: number, height: number): void {
    try {
      if (width > 0 && height > 0 && width <= 7680 && height <= 4320) {
        this.captureResolution = { width: Math.round(width), height: Math.round(height) }
      }
    } catch (error) {
      logger.error('setResolution error:', error)
    }
  }

  /**
   * 获取当前截图分辨率
   */
  getResolution(): { width: number; height: number } {
    return { ...this.captureResolution }
  }

  // ==================== 纯内存 CPU 视觉后端（Qwen2-VL-2B） ====================

  /**
   * 开关：SGLang 不可用时回退本地纯内存 CPU 视觉推理
   * @param enabled - 是否启用 CPU 兜底
   */
  setCpuFallbackEnabled(enabled: boolean): void {
    this.cpuFallbackEnabled = enabled
    logger.info(`[vision cpu-fallback] CPU 视觉兜底 ${enabled ? '启用' : '关闭'}`)
  }

  /**
   * 当前 CPU 兜底状态（状态上报用）
   */
  getCpuFallbackStatus(): { enabled: boolean; available: boolean; ready: boolean } {
    return {
      enabled: this.cpuFallbackEnabled,
      available: this.localVLAvailable,
      ready: this.localVLReady,
    }
  }

  /**
   * 在指定目录顶层查找包含关键词的文件
   */
  private findFileInDir(dir: string, keywords: string[]): string | null {
    try {
      if (!existsSync(dir)) return null
      const files = readdirSync(dir, { withFileTypes: true })
      for (const f of files) {
        if (!f.isFile()) continue
        if (keywords.every(k => f.name.includes(k))) {
          return join(dir, f.name)
        }
      }
    } catch { /* ignore */ }
    return null
  }

  /**
   * 解析 Qwen2-VL-2B 纯内存 CPU 后端的模型 + mmproj 文件路径。
   * 路径来源（按优先级）：①model-registry 注册的 qwen2-vl-2b 模型路径 →
   * ②userData/models 及子目录 → ③E:\模型库。mmproj 优先取模型同目录，其次 E:\模型库。
   */
  private resolveLocalVLPaths(): { model: string; mmproj: string } | null {
    try {
      // ① 注册表中的 qwen2-vl-2b 路径
      let model: string | null = null
      const userDataModels = join(app.getPath('userData'), 'models')
      const candidates: string[] = []
      try {
        readdirSync(userDataModels, { withFileTypes: true }).forEach(ent => {
          if (ent.isDirectory()) candidates.push(join(userDataModels, ent.name))
        })
      } catch { /* ignore */ }
      candidates.unshift(userDataModels)
      for (const dir of candidates) {
        const hit = this.findFileInDir(dir, ['Qwen2-VL-2B', '.gguf'])
        if (hit) { model = hit; break }
      }

      // userData 未命中时尝试 E:\模型库
      if (!model) {
        model = this.findFileInDir('E:\\模型库', ['Qwen2-VL-2B', '.gguf'])
      }
      if (!model) return null

      // mmproj：模型同目录优先
      const modelDir = model.substring(0, model.lastIndexOf('\\'))
      let mmproj = this.findFileInDir(modelDir, ['mmproj', 'Qwen2-VL-2B', '.gguf'])
      if (!mmproj) {
        mmproj = this.findFileInDir('E:\\模型库', ['mmproj', 'Qwen2-VL-2B', '.gguf'])
      }
      if (!mmproj) return null

      return { model, mmproj }
    } catch (error) {
      logger.error('[vision cpu-fallback] resolveLocalVLPaths error:', error)
      return null
    }
  }

  /**
   * 探测 llama-server（与 tandem 本地引擎同源 discovery）
   */
  private resolveLlamaServerPath(): string | null {
    const candidates = [
      join(__dirname, '..', '..', '..', 'resources', 'llama-server.exe'),
      join(process.cwd(), 'resources', 'llama-server.exe'),
      join(app.getAppPath(), 'resources', 'llama-server.exe'),
    ]
    for (const c of candidates) {
      if (existsSync(c)) return c
    }
    return null
  }

  /**
   * 确保本地纯内存 CPU 视觉后端已拉起（单飞：并发只拉起一次）。
   * Qwen2-VL-2B 以 -ngl 0 纯 CPU + KV 走系统内存（--no-kv-offload）在 6GB 机器闭环图片推理。
   */
  private async ensureLocalVL(): Promise<boolean> {
    if (this.localVLReady) return true
    // 已确认不可用（文件缺失/启动失败且进程已退出）则直接返回
    if (this.localVLProcess === null && !this.localVLAvailable && this.localVLLock === null) {
      const paths = this.resolveLocalVLPaths()
      if (!paths) {
        this.localVLAvailable = false
        logger.warn('[vision cpu-fallback] 未找到 Qwen2-VL-2B GGUF/mmproj，纯内存视觉兜底不可用')
        return false
      }
      this.localVLAvailable = true
      this.localVLLock = this.spawnLocalVL(paths)
    } else if (this.localVLProcess === null && this.localVLLock) {
      // 等待已有拉起流程
    }

    if (this.localVLLock) {
      return await this.localVLLock
    }
    return this.localVLReady
  }

  /**
   * 拉起本地 llama-server（Qwen2-VL-2B，纯 CPU 内存推理），并等待就绪。
   */
  private async spawnLocalVL(paths: { model: string; mmproj: string }): Promise<boolean> {
    try {
      const serverPath = this.resolveLlamaServerPath()
      if (!serverPath) {
        logger.warn('[vision cpu-fallback] 未找到 resources/llama-server.exe，纯内存视觉兜底不可用')
        this.localVLAvailable = false
        return false
      }

      const args = [
        '-m', paths.model,
        '--mmproj', paths.mmproj,
        '--host', '127.0.0.1',
        '--port', String(LOCAL_VL_PORT),
        '-ngl', '0',                    // 纯 CPU：-ngl 0 权重全在系统内存，不占用显存
        '-c', '16384',                  // 2B 截图推理缺省 16K（KV 走 RAM，安全）
        '--parallel', '1',
        '--jinja',
        '--no-kv-offload',              // KV cache 放系统内存（纯 CPU 同理，避免 OOM）
        '-fa',                          // flash attention
      ]

      logger.info(`[vision cpu-fallback] 拉起本地 VL 后端: ${serverPath} --port ${LOCAL_VL_PORT} -ngl 0`)
      const child = spawn(serverPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      this.localVLProcess = child

      let stderrBuf = ''
      child.stdout?.on('data', d => { stderrBuf = `${stderrBuf}${d}`.slice(-4000) })
      child.stderr?.on('data', d => { stderrBuf = `${stderrBuf}${d}`.slice(-4000) })
      child.on('error', err => {
        logger.error(`[vision cpu-fallback] llama-server 启动失败: ${err.message}`)
        this.localVLAvailable = false
        this.localVLReady = false
        this.localVLProcess = null
      })
      child.on('exit', code => {
        logger.warn(`[vision cpu-fallback] 本地 VL 后端退出 code=${code}，残留日志: ${stderrBuf.slice(-500)}`)
        this.localVLReady = false
        this.localVLProcess = null
      })

      // 等待健康检查就绪（最多 120s，2B 纯 CPU 首次加载较慢）
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        if (!this.localVLProcess) return false
        try {
          const resp = await fetch(`${this.localVLBaseUrl}/health`, { signal: AbortSignal.timeout(2000) })
          if (resp.ok) {
            const body = await resp.json().catch(() => ({}))
            if ((body as any).status !== 'loading error') {
              this.localVLReady = true
              logger.info('[vision cpu-fallback] Qwen2-VL-2B 纯内存 CPU 后端就绪 (30001)')
              return true
            }
          }
        } catch { /* 未就绪，继续轮询 */ }
        await new Promise(r => setTimeout(r, 1500))
      }
      logger.warn('[vision cpu-fallback] 等待本地 VL 后端就绪超时')
      return false
    } catch (error) {
      logger.error(`[vision cpu-fallback] spawnLocalVL error: ${error}`)
      this.localVLAvailable = false
      this.localVLProcess = null
      return false
    }
  }

  /**
   * 在本地纯内存 CPU 后端补齐一条流式差异：首次触发时若进程已被外部 kill 会重建。
   * 实际单次推理调用：SGLang 空 → 本兜底。
   */
  private async callLocalVL(messages: SGLangMessage[], timeout: number): Promise<SGLangResponse | null> {
    try {
      const ok = await this.ensureLocalVL()
      if (!ok || !this.localVLReady) {
        return null
      }
      const url = `${this.localVLBaseUrl}/v1/chat/completions`
      const body = {
        model: LOCAL_VL_MODEL_ID,
        messages,
        max_tokens: 1024,
        temperature: 0.1,
      }
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)
      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error')
        logger.error(`[vision cpu-fallback] 本地 VL API error: ${response.status} ${errorText}`)
        return null
      }
      return await response.json() as SGLangResponse
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        logger.error(`[vision cpu-fallback] 本地 VL 调用超时(${timeout}ms)`)
      } else {
        logger.error(`[vision cpu-fallback] 本地 VL 调用失败: ${error}`)
      }
      return null
    }
  }

  /**
   * SGLang 不可用时按开关回退本地纯内存 CPU 后端
   */
  private async maybeLocalVLCall(messages: SGLangMessage[], timeout: number): Promise<SGLangResponse | null> {
    if (!this.cpuFallbackEnabled) return null
    return await this.callLocalVL(messages, timeout)
  }

  // ==================== 截图 ====================

  /**
   * 截取全屏，使用配置的分辨率，输出 JPEG 压缩后的 base64
   */
  async captureScreen(): Promise<ScreenCapture> {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: this.captureResolution
      })

      if (sources.length === 0) {
        throw new Error('No screen sources found')
      }

      // 图片压缩：转为 JPEG quality 70%，大幅减少传输量
      const jpegBuffer = sources[0].thumbnail.toJPEG(JPEG_QUALITY)
      const base64 = jpegBuffer.toString('base64')
      const dataUrl = `data:image/jpeg;base64,${base64}`

      const thumbSize = sources[0].thumbnail.getSize()
      const capture: ScreenCapture = {
        dataUrl,
        timestamp: Date.now(),
        width: thumbSize.width,
        height: thumbSize.height
      }

      this.lastCapture = capture
      return capture
    } catch (error) {
      throw new Error(`Screen capture failed: ${error}`)
    }
  }

  /**
   * 截取指定区域（x, y, w, h 坐标相对于当前配置的分辨率）
   * 先截取全屏再裁剪，减少无关内容传输
   */
  async captureRegion(x: number, y: number, w: number, h: number): Promise<ScreenCapture> {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: this.captureResolution
      })

      if (sources.length === 0) {
        throw new Error('No screen sources found')
      }

      // 裁剪指定区域
      const cropped = sources[0].thumbnail.crop({
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(w),
        height: Math.round(h)
      })

      // JPEG 压缩
      const jpegBuffer = cropped.toJPEG(JPEG_QUALITY)
      const base64 = jpegBuffer.toString('base64')
      const dataUrl = `data:image/jpeg;base64,${base64}`

      const croppedSize = cropped.getSize()
      const capture: ScreenCapture = {
        dataUrl,
        timestamp: Date.now(),
        width: croppedSize.width,
        height: croppedSize.height
      }

      return capture
    } catch (error) {
      throw new Error(`Region capture failed: ${error}`)
    }
  }

  // ==================== 缓存策略 ====================

  /**
   * 计算图片 base64 的 SHA256 哈希，作为缓存 key
   */
  private hashImage(base64: string): string {
    try {
      return createHash('sha256').update(base64).digest('hex')
    } catch {
      // 降级：使用截断的 base64 前缀作为简易 key
      return base64.substring(0, 64)
    }
  }

  /**
   * 构造缓存 key（图片 hash + prompt 联合）
   */
  private buildCacheKey(base64: string, prompt: string): string {
    return `${this.hashImage(base64)}::${prompt}`
  }

  /**
   * 查询缓存
   */
  private getFromCache(key: string): VisionAnalysisResult | null {
    try {
      const entry = this.analysisCache.get(key)
      if (entry) {
        return entry.result
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * 写入缓存，超出上限时淘汰最旧的条目
   */
  private addToCache(key: string, result: VisionAnalysisResult): void {
    try {
      // 如果 key 已存在，先移除旧位置（更新场景）
      const existingIdx = this.cacheOrder.indexOf(key)
      if (existingIdx !== -1) {
        this.cacheOrder.splice(existingIdx, 1)
      }

      // 淘汰最旧的条目
      while (this.cacheOrder.length >= MAX_CACHE_SIZE) {
        const oldest = this.cacheOrder.shift()
        if (oldest) {
          this.analysisCache.delete(oldest)
        }
      }

      // 写入缓存
      this.analysisCache.set(key, {
        result,
        timestamp: Date.now()
      })
      this.cacheOrder.push(key)
    } catch (error) {
      logger.error('addToCache error:', error)
    }
  }

  /**
   * 清空缓存
   */
  clearCache(): void {
    try {
      this.analysisCache.clear()
      this.cacheOrder = []
    } catch (error) {
      logger.error('clearCache error:', error)
    }
  }

  /**
   * 获取缓存统计
   */
  getCacheStats(): { size: number; maxSize: number; entries: Array<{ key: string; timestamp: number }> } {
    try {
      const entries = this.cacheOrder.map(key => ({
        key: key.substring(0, 32) + '...',  // 截断显示
        timestamp: this.analysisCache.get(key)?.timestamp || 0
      }))
      return {
        size: this.cacheOrder.length,
        maxSize: MAX_CACHE_SIZE,
        entries
      }
    } catch {
      return { size: 0, maxSize: MAX_CACHE_SIZE, entries: [] }
    }
  }

  // ==================== 视觉分析 ====================

  /**
   * 通过 SGLang API 调用 qwen2-vl 模型进行视觉分析
   * 带缓存：相同图片+相同 prompt 秒回
   */
  async analyzeImage(imageBase64: string, prompt: string = '请详细描述这张图片的内容'): Promise<VisionAnalysisResult> {
    try {
      const base64Data = this.extractBase64(imageBase64)
      const cacheKey = this.buildCacheKey(base64Data, prompt)

      // 缓存命中：秒回
      const cached = this.getFromCache(cacheKey)
      if (cached) {
        return cached
      }

      const messages: SGLangMessage[] = [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: base64Data.startsWith('data:')
                  ? base64Data
                  : `data:image/jpeg;base64,${base64Data}`
              }
            },
            {
              type: 'text',
              text: prompt
            }
          ]
        }
      ]

      let response = await this.callSGLangAPI(messages, TIMEOUTS.ANALYZE)

      // SGLang 不可用时回退本地纯内存 CPU 后端（Qwen2-VL-2B，-ngl 0，KV/内存）
      if (!response) {
        logger.warn('[vision cpu-fallback] SGLang 不可用，切 Qwen2-VL-2B 纯内存 CPU 后端')
        response = await this.maybeLocalVLCall(messages, TIMEOUTS.ANALYZE + 30_000)
      }

      if (!response) {
        const fallbackResult: VisionAnalysisResult = { success: false, error: `视觉推理不可用（SGLang 不可用且纯内存 CPU 兜底未就绪/未找到 Qwen2-VL-2B）` }
        return fallbackResult
      }

      let result: VisionAnalysisResult

      try {
        const content = response.choices[0]?.message?.content || ''

        // 尝试解析 JSON 格式的返回
        try {
          const jsonMatch = content.match(/\{[\s\S]*\}/)
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0])
            if (parsed.success !== undefined) {
              result = parsed
            } else {
              result = {
                success: true,
                description: content,
                text: content,
                objects: []
              }
            }
          } else {
            result = {
              success: true,
              description: content,
              text: content,
              objects: []
            }
          }
        } catch {
          result = {
            success: true,
            description: content,
            text: content,
            objects: []
          }
        }
      } catch (parseError) {
        result = {
          success: true,
          description: response.choices[0]?.message?.content || '',
          text: response.choices[0]?.message?.content || ''
        }
      }

      // 写入缓存
      this.addToCache(cacheKey, result)

      return result
    } catch (error) {
      return {
        success: false,
        error: `SGLang vision analysis failed: ${error}`
      }
    }
  }

  /**
   * 批量分析：多张图片+多个问题合并为一次 API 调用
   * 减少网络往返，提升吞吐量
   */
  async analyzeBatch(images: string[], prompts: string[]): Promise<VisionAnalysisResult[]> {
    try {
      const count = Math.min(images.length, prompts.length)
      if (count === 0) {
        return []
      }

      const contentBlocks: Array<{
        type: 'text' | 'image_url'
        text?: string
        image_url?: { url: string }
      }> = []

      const results: VisionAnalysisResult[] = []
      const cacheMissIndices: number[] = []
      const cacheMissImages: string[] = []
      const cacheMissPrompts: string[] = []

      // 第一遍：检查缓存
      for (let i = 0; i < count; i++) {
        const base64Data = this.extractBase64(images[i])
        const cacheKey = this.buildCacheKey(base64Data, prompts[i])
        const cached = this.getFromCache(cacheKey)

        if (cached) {
          results[i] = cached
        } else {
          cacheMissIndices.push(i)
          cacheMissImages.push(images[i])
          cacheMissPrompts.push(prompts[i])
        }
      }

      // 如果全部命中缓存，直接返回
      if (cacheMissIndices.length === 0) {
        return results
      }

      // 构建批量请求内容
      for (let i = 0; i < cacheMissImages.length; i++) {
        const base64Data = this.extractBase64(cacheMissImages[i])
        contentBlocks.push({
          type: 'image_url',
          image_url: {
            url: base64Data.startsWith('data:')
              ? base64Data
              : `data:image/jpeg;base64,${base64Data}`
          }
        })
        contentBlocks.push({
          type: 'text',
          text: `[图片${i + 1}] ${cacheMissPrompts[i]}`
        })
      }

      const batchPrompt = `请依次分析以上${cacheMissImages.length}张图片，对每张图片按照对应的提示词进行分析。请以JSON数组格式返回结果，数组中每个元素对应一张图片，格式为：{"index": 数字, "success": true, "description": "描述", "text": "文字", "objects": []}。只返回JSON数组，不要包含其他文字。`

      contentBlocks.push({
        type: 'text',
        text: batchPrompt
      })

      const messages: SGLangMessage[] = [
        {
          role: 'user',
          content: contentBlocks
        }
      ]

      let response = await this.callSGLangAPI(messages, TIMEOUTS.BATCH)

      if (!response) {
        logger.warn('[vision cpu-fallback] SGLang 批量不可用，逐张走本地纯内存 CPU 后端')
        // 批量失败时：逐张回退 analyzeImage（内部含纯内存 CPU 兜底）
        for (let i = 0; i < cacheMissIndices.length; i++) {
          const idx = cacheMissIndices[i]
          const single = await this.analyzeImage(cacheMissImages[i], cacheMissPrompts[i])
          results[idx] = single
          if (single.success) {
            const cacheKey = this.buildCacheKey(
              this.extractBase64(cacheMissImages[i]),
              cacheMissPrompts[i]
            )
            this.addToCache(cacheKey, single)
          }
        }
        return results
      }

      // 解析批量返回
      try {
        const content = response.choices[0]?.message?.content || ''
        const jsonMatch = content.match(/\[[\s\S]*\]/)
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0])
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              const idx = cacheMissIndices[item.index]
              if (idx !== undefined) {
                const result: VisionAnalysisResult = {
                  success: item.success !== false,
                  description: item.description || '',
                  text: item.text || '',
                  objects: item.objects || []
                }
                results[idx] = result
                // 写入缓存
                const cacheKey = this.buildCacheKey(
                  this.extractBase64(cacheMissImages[item.index]),
                  cacheMissPrompts[item.index]
                )
                this.addToCache(cacheKey, result)
              }
            }
            // 填充未返回的项
            for (let i = 0; i < cacheMissIndices.length; i++) {
              const idx = cacheMissIndices[i]
              if (!results[idx]) {
                results[idx] = { success: false, error: 'Item not found in batch response' }
              }
            }
            return results
          }
        }

        // 无法解析 JSON 数组，当作单个文本分配给所有图片
        for (let i = 0; i < cacheMissIndices.length; i++) {
          const idx = cacheMissIndices[i]
          const result: VisionAnalysisResult = {
            success: true,
            description: content,
            text: content,
            objects: []
          }
          results[idx] = result
          const cacheKey = this.buildCacheKey(
            this.extractBase64(cacheMissImages[i]),
            cacheMissPrompts[i]
          )
          this.addToCache(cacheKey, result)
        }
        return results
      } catch (parseError) {
        for (let i = 0; i < cacheMissIndices.length; i++) {
          const idx = cacheMissIndices[i]
          results[idx] = { success: false, error: `Batch parse error: ${parseError}` }
        }
        return results
      }
    } catch (error) {
      const count = Math.min(images.length, prompts.length)
      return Array(count).fill(null).map(() => ({
        success: false,
        error: `Batch analysis failed: ${error}`
      }))
    }
  }

  // ==================== 元素定位 ====================

  /**
   * 分析截图，定位目标元素，返回屏幕坐标
   * 超时：10秒
   */
  async locateElement(imageBase64: string, targetDescription: string): Promise<LocateResult> {
    try {
      const base64Data = this.extractBase64(imageBase64)

      const prompt = `分析这张截图，找到"${targetDescription}"的位置。请以JSON格式返回该元素的屏幕坐标，格式为：{"x": 数字, "y": 数字, "confidence": 0.0到1.0之间的数字, "description": "元素描述"}。x和y是元素中心点的像素坐标。如果找不到该元素，返回 {"x": -1, "y": -1, "confidence": 0, "description": "未找到"}。只返回JSON，不要包含其他文字。`

      const messages: SGLangMessage[] = [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: base64Data.startsWith('data:')
                  ? base64Data
                  : `data:image/jpeg;base64,${base64Data}`
              }
            },
            {
              type: 'text',
              text: prompt
            }
          ]
        }
      ]

      let response = await this.callSGLangAPI(messages, TIMEOUTS.LOCATE)

      // SGLang 不可用时回退本地纯内存 CPU 后端
      if (!response) {
        logger.warn('[vision cpu-fallback] SGLang 不可用，locateElement 切 Qwen2-VL-2B 纯内存 CPU 后端')
        response = await this.maybeLocalVLCall(messages, TIMEOUTS.LOCATE + 30_000)
      }

      if (!response) {
        return { x: -1, y: -1, confidence: 0, error: 'SGLang API returned empty response' }
      }

      try {
        const content = response.choices[0]?.message?.content || ''
        const jsonMatch = content.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0])
          return {
            x: parsed.x || -1,
            y: parsed.y || -1,
            confidence: parsed.confidence || 0,
          }
        }
        return { x: -1, y: -1, confidence: 0, error: 'Failed to parse coordinates from response' }
      } catch (parseError) {
        return { x: -1, y: -1, confidence: 0, error: `Parse error: ${parseError}` }
      }
    } catch (error) {
      return { x: -1, y: -1, confidence: 0, error: `SGLang locate element failed: ${error}` }
    }
  }

  // ==================== OCR 文字识别 ====================

  /**
   * 通过 SGLang 视觉模型 OCR 读取屏幕文字
   * 超时：15秒
   */
  async readTextFromScreen(imageBase64: string): Promise<string> {
    try {
      const base64Data = this.extractBase64(imageBase64)

      const prompt = '请识别并提取这张截图中的所有文字内容。只返回文字内容，不要包含其他解释或说明。如果截图中没有文字，请返回"（无文字）"。'

      const messages: SGLangMessage[] = [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: base64Data.startsWith('data:')
                  ? base64Data
                  : `data:image/jpeg;base64,${base64Data}`
              }
            },
            {
              type: 'text',
              text: prompt
            }
          ]
        }
      ]

      let response = await this.callSGLangAPI(messages, TIMEOUTS.OCR)

      // SGLang 不可用时回退本地纯内存 CPU 后端
      if (!response) {
        logger.warn('[vision cpu-fallback] SGLang 不可用，readTextFromScreen 切 Qwen2-VL-2B 纯内存 CPU 后端')
        response = await this.maybeLocalVLCall(messages, TIMEOUTS.OCR + 30_000)
      }

      if (!response) {
        return 'OCR failed: SGLang API returned empty response'
      }

      const content = response.choices[0]?.message?.content || ''
      return content.trim()
    } catch (error) {
      return `OCR error: ${error}`
    }
  }

  // ==================== 降级策略：模板匹配 ====================

  /**
   * 降级策略：当视觉模型不可用时，使用 pyautogui 模板匹配作为兜底
   * 在截图（imageBase64）中搜索模板图片（templatePath）的位置
   */
  async templateMatch(imageBase64: string, templatePath: string): Promise<LocateResult> {
    try {
      // 确保模板文件存在
      if (!existsSync(templatePath)) {
        return { x: -1, y: -1, confidence: 0, error: `Template file not found: ${templatePath}` }
      }

      // 将 base64 截图写入临时文件
      const base64Data = this.extractBase64(imageBase64)
      const tempDir = join(app.getPath('userData'), 'temp')
      mkdirSync(tempDir, { recursive: true })
      const tempImagePath = join(tempDir, `vision_match_${Date.now()}.png`)
      writeFileSync(tempImagePath, Buffer.from(base64Data, 'base64'))

      // Python 模板匹配脚本
      const pythonScript = `
import sys
import json
import pyautogui

def template_match(screenshot_path, template_path):
    try:
        location = pyautogui.locate(template_path, screenshot_path, confidence=0.8)
        if location:
            center = pyautogui.center(location)
            print(json.dumps({
                "x": center.x,
                "y": center.y,
                "confidence": 0.9,
                "found": True
            }))
        else:
            print(json.dumps({
                "x": -1,
                "y": -1,
                "confidence": 0,
                "found": False
            }))
    except Exception as e:
        print(json.dumps({
            "x": -1,
            "y": -1,
            "confidence": 0,
            "found": False,
            "error": str(e)
        }))

if __name__ == '__main__':
    template_match(sys.argv[1], sys.argv[2])
`

      const result = await pythonRuntime.runScript(pythonScript, [tempImagePath, templatePath])

      // 清理临时文件
      try { unlinkSync(tempImagePath) } catch { /* ignore */ }

      if (!result.success || !result.output) {
        return { x: -1, y: -1, confidence: 0, error: result.error || 'Python script failed' }
      }

      try {
        const parsed = JSON.parse(result.output.trim())
        return {
          x: parsed.x ?? -1,
          y: parsed.y ?? -1,
          confidence: parsed.confidence ?? 0,
          error: parsed.error
        }
      } catch {
        return { x: -1, y: -1, confidence: 0, error: 'Failed to parse template match result' }
      }
    } catch (error) {
      return { x: -1, y: -1, confidence: 0, error: `Template match failed: ${error}` }
    }
  }

  // ==================== 预热机制 ====================

  /**
   * 预热 SGLang 连接，在用户打开"电脑控制"时后台调用
   * 发送一个轻量级请求预热模型，减少首次调用的延迟
   */
  async preload(): Promise<boolean> {
    try {
      const messages: SGLangMessage[] = [
        {
          role: 'user',
          content: 'ping'
        }
      ]

      const response = await this.callSGLangAPI(messages, TIMEOUTS.PRELOAD)
      return response !== null
    } catch (error) {
      logger.error('preload error:', error)
      return false
    }
  }

  // ==================== SGLang API 调用 ====================

  /**
   * 调用 SGLang API
   * @param messages - 消息列表
   * @param timeout - 超时时间（毫秒），默认 30 秒
   */
  private async callSGLangAPI(messages: SGLangMessage[], timeout: number = TIMEOUTS.DEFAULT): Promise<SGLangResponse | null> {
    try {
      const url = `${this.sglangBaseUrl}/v1/chat/completions`

      const body = {
        // v10.2 方案X：视觉调用打到当前常驻模型（VL-7B / 质量态 Qwen2-VL-2B），消除硬编码 'qwen2-vl' 回归源
        model: modelManager.getLoadedModel()?.modelId || 'qwen2-vl',
        messages: messages,
        max_tokens: 1024,
        temperature: 0.1
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error')
        logger.error(`SGLang API error: ${response.status} ${errorText}`)
        return null
      }

      const data = await response.json() as SGLangResponse
      return data
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        logger.error(`SGLang API call timed out after ${timeout}ms`)
      } else {
        logger.error(`SGLang API call failed: ${error}`)
      }
      return null
    }
  }

  // ==================== 工具方法 ====================

  /**
   * 从 data URL 或纯 base64 中提取 base64 数据
   */
  private extractBase64(dataUrl: string): string {
    try {
      if (dataUrl.includes(',')) {
        const parts = dataUrl.split(',')
        return parts.length >= 2 ? parts[1] : dataUrl
      }
      return dataUrl
    } catch {
      return dataUrl
    }
  }

  /**
   * 验证操作是否成功（兼容旧方法）
   */
  // @ts-expect-error TS6133 - target reserved for future use
  async verifyOperation(target: string, expected: string): Promise<boolean> {
    try {
      const capture = await this.captureScreen()
      const base64 = this.extractBase64(capture.dataUrl)
      const analysis = await this.analyzeImage(base64, `请确认屏幕上是否包含"${expected}"相关内容。只回答"是"或"否"`)

      if (!analysis.success) {
        return false
      }

      if (analysis.text && analysis.text.includes(expected)) {
        return true
      }

      if (analysis.description && analysis.description.includes(expected)) {
        return true
      }

      return false
    } catch (error) {
      logger.error('verifyOperation error:', error)
      return false
    }
  }

  getLastCapture(): ScreenCapture | null {
    return this.lastCapture
  }

  /**
   * 设置 SGLang 服务地址
   */
  setBaseUrl(url: string): void {
    this.sglangBaseUrl = url
  }
}

// ==================== 导出单例 ====================

export const visionModel = new VisionModel()

// ==================== IPC Handlers ====================

export function setupVisionHandlers(): void {
  const { ipcMain } = require('electron')

  // --- 原有 handlers（保持兼容） ---

  ipcMain.handle('vision:capture', async () => {
    try {
      return await visionModel.captureScreen()
    } catch (error) {
      return { error: String(error) }
    }
  })

  ipcMain.handle('vision:analyze', async (_event: any, imageData: ScreenCapture | string, prompt?: string) => {
    try {
      if (typeof imageData === 'string') {
        return await visionModel.analyzeImage(imageData, prompt)
      }
      return await visionModel.analyzeImage(imageData.dataUrl, prompt)
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('vision:locate', async (_event: any, imageData: string | ScreenCapture, targetDescription: string) => {
    try {
      const base64 = typeof imageData === 'string'
        ? imageData
        : imageData.dataUrl
      return await visionModel.locateElement(base64, targetDescription)
    } catch (error) {
      return { x: -1, y: -1, confidence: 0, error: String(error) }
    }
  })

  ipcMain.handle('vision:read-text', async (_event: any, imageData: string | ScreenCapture) => {
    try {
      const base64 = typeof imageData === 'string'
        ? imageData
        : imageData.dataUrl
      return await visionModel.readTextFromScreen(base64)
    } catch (error) {
      return `Error: ${error}`
    }
  })

  ipcMain.handle('vision:verify', async (_event: any, target: string, expected: string) => {
    try {
      return await visionModel.verifyOperation(target, expected)
    } catch (error) {
      return false
    }
  })

  ipcMain.handle('vision:status', () => {
    try {
      return { loaded: visionModel.isLoaded(), cpuFallback: visionModel.getCpuFallbackStatus() }
    } catch (error) {
      return { loaded: false, error: String(error) }
    }
  })

  /**
   * 纯内存 CPU 视觉后端状态（配置用了 enableStandbyModels / visionCpuFallback）
   */
  ipcMain.handle('vision:cpu-fallback-status', () => {
    try {
      return { success: true, ...visionModel.getCpuFallbackStatus() }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('vision:set-base-url', (_event: any, url: string) => {
    try {
      visionModel.setBaseUrl(url)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // --- 新增 handlers ---

  /**
   * 设置截图分辨率
   * 参数: { width: number, height: number }
   */
  ipcMain.handle('vision:set-resolution', (_event: any, width: number, height: number) => {
    try {
      visionModel.setResolution(width, height)
      return { success: true, resolution: visionModel.getResolution() }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  /**
   * 截取指定区域
   * 参数: x, y, w, h
   */
  ipcMain.handle('vision:capture-region', async (_event: any, x: number, y: number, w: number, h: number) => {
    try {
      return await visionModel.captureRegion(x, y, w, h)
    } catch (error) {
      return { error: String(error) }
    }
  })

  /**
   * 批量分析：多张图片+多个问题合并为一次 API 调用
   * 参数: { images: string[], prompts: string[] }
   */
  ipcMain.handle('vision:analyze-batch', async (_event: any, images: string[], prompts: string[]) => {
    try {
      return await visionModel.analyzeBatch(images, prompts)
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  /**
   * 预热 SGLang 连接
   */
  ipcMain.handle('vision:preload', async () => {
    try {
      const result = await visionModel.preload()
      return { success: result }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  /**
   * 降级策略：pyautogui 模板匹配
   * 参数: imageBase64 (截图的 base64), templatePath (模板图片路径)
   */
  ipcMain.handle('vision:template-match', async (_event: any, imageBase64: string, templatePath: string) => {
    try {
      return await visionModel.templateMatch(imageBase64, templatePath)
    } catch (error) {
      return { x: -1, y: -1, confidence: 0, error: String(error) }
    }
  })

  /**
   * 获取缓存统计信息
   */
  ipcMain.handle('vision:cache-stats', () => {
    try {
      return visionModel.getCacheStats()
    } catch (error) {
      return { size: 0, maxSize: MAX_CACHE_SIZE, entries: [], error: String(error) }
    }
  })

  /**
   * 清空缓存
   */
  ipcMain.handle('vision:clear-cache', () => {
    try {
      visionModel.clearCache()
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
}