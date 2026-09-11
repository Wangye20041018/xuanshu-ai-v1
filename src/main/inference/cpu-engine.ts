/* ============================================================
 * CPU 推理引擎 v3.0 — 智能主模型推理
 * 升级：系统提示词 + 对话历史 + 流式输出 + 显存/内存自适应
 * ============================================================ */
import { existsSync } from 'fs'
import { EventEmitter } from 'events'
import { cpus, freemem } from 'os'
import { exec } from 'child_process'
import { promisify } from 'util'
import { POWERSHELL_EXE } from '../utils/powershell'
import { logger } from '../../shared/logger'

const execAsync = promisify(exec)

/* ==================== node-llama-cpp 最小化类型声明 ==================== */

interface LlamaContextSequence {}

interface LlamaChatSession {
  prompt(prompt: string, options?: SessionPromptOptions): Promise<string>
}

interface SessionPromptOptions {
  maxTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  repeatPenalty?: number
  onToken?: (tokens: number[]) => void
}

interface CpuModel {
  createContext(options: {
    contextSize: number
    threads: number
    /** flash attention 加速（实验特性，模型不支持时自动忽略） */
    flashAttention?: boolean
    /** KV cache 量化：q8_0 将 K/V cache 折半，6GB 显存下大幅降低 cache-ram 占用 */
    experimentalKvCacheKeyType?: string
    experimentalKvCacheValueType?: string
  }): Promise<CpuContext>
  detokenize(tokens: number[]): string
  dispose?(): Promise<void>
}

interface CpuContext {
  getSequence(): LlamaContextSequence
  dispose?(): Promise<void>
}

interface LlamaInstance {
  loadModel(options: { modelPath: string; gpuLayers?: number }): Promise<CpuModel>
  /** node-llama-cpp 事件（error/unhandledError 等），用于吞掉后台加载失败 */
  on?(event: string, listener: (err?: unknown) => void): void
}

interface LlamaModule {
  getLlama(options?: { gpu?: string | false }): Promise<LlamaInstance>
  LlamaChatSession: new (options: { contextSequence: LlamaContextSequence }) => LlamaChatSession
}

let llamaModule: LlamaModule | null = null

export interface CpuInferenceConfig {
  modelPath: string
  threads?: number
  contextSize?: number
  systemPrompt?: string
  /** v10.2 质量档全量加载层数（Qwen2-VL-2B 小模型完整驻留 GPU） */
  gpuLayers?: number
  /** v13.x 多模态主模型：mmproj 投影文件路径（node-llama-cpp vision 加载） */
  mmprojPath?: string
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface GenerateOptions {
  maxTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  repeatPenalty?: number
  presencePenalty?: number
  frequencyPenalty?: number
  stopTokens?: string[]
  seed?: number
}

interface ContextHistory {
  messages: ChatMessage[]
  summary: string
  tokenCount: number
  maxTokens: number
}

async function ensureLlamaModule(): Promise<LlamaModule> {
  if (llamaModule) return llamaModule
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    llamaModule = await import('node-llama-cpp') as any
    return llamaModule as LlamaModule
  } catch (e) {
    throw new Error(`node-llama-cpp 加载失败: ${e}`)
  }
}

// v10.2: 解析 llama 实例 — 优先启用 Vulkan GPU 后端（NVIDIA/AMD/Intel 通用，无需 CUDA toolkit），
// 若 Vulkan 构建不可用则静默回退 CPU。实例全局缓存，避免重复构建。
// @ts-expect-error TS6133 — written as side effect, may be consumed externally
let resolvedLlamaGpu = false
let resolvedLlama: LlamaInstance | null = null
async function getResolvedLlama(mod: LlamaModule): Promise<LlamaInstance> {
  if (resolvedLlama) return resolvedLlama
  const getLlama = mod.getLlama
  const attachErrorListeners = (instance: LlamaInstance): void => {
    // M-14 修复：node-llama-cpp 在模型/上下文加载失败（如显存不足）时
    // 会 emit 'unhandledError'，若不监听会升级为进程级 ERR_UNHANDLED_ERROR
    // 未捕获异常，进而触发 CrashGuard 与应用崩溃。这里统一吞掉并记日志。
    try {
      const onLlamaError = (err: unknown): void => {
        const errMsg = err instanceof Error ? err.message : String(err)
        logger.error(`[CPUEngine] node-llama-cpp 后台错误: ${errMsg}`)
      }
      instance.on?.('error', onLlamaError)
      instance.on?.('unhandledError', onLlamaError)
    } catch (e) {
      logger.warn(`[CPUEngine] 注册 node-llama-cpp 错误监听失败: ${e}`)
    }
  }
  try {
    resolvedLlama = await getLlama({ gpu: 'vulkan' })
    resolvedLlamaGpu = true
    attachErrorListeners(resolvedLlama)
    logger.debug('[CPUEngine] 已启用 Vulkan GPU 后端')
  } catch (gpuErr: unknown) {
    const errMsg = gpuErr instanceof Error ? gpuErr.message : String(gpuErr)
    logger.warn('[CPUEngine] Vulkan GPU 不可用，回退 CPU 推理:', errMsg)
    resolvedLlama = await getLlama()
    resolvedLlamaGpu = false
    attachErrorListeners(resolvedLlama)
  }
  return resolvedLlama
}

export async function isGpuAvailable(): Promise<{ available: boolean; vramMB: number; reason?: string }> {
  // 优先检测 NVIDIA GPU
  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits',
      { timeout: 5000 }
    )
    const output = stdout.trim()
    const vramMB = parseInt(output)
    if (vramMB >= 4000) return { available: true, vramMB }
    return { available: false, vramMB, reason: `显存不足 (${vramMB}MB < 4000MB)` }
  } catch {
    // NVIDIA 检测失败，尝试 AMD ROCm / HIP
  }

  // 检测 AMD GPU (ROCm)
  try {
    const { stdout } = await execAsync('rocm-smi --showmeminfo vram --json', { timeout: 5000 })
    const data = JSON.parse(stdout)
    const totalVRAM = (Object.values(data || {}) as Array<{ 'VRAM Total Memory (B)'?: string | number }>).reduce(
      (sum, card) =>
        sum + (parseInt(String(card?.['VRAM Total Memory (B)'])) || 0) / (1024 * 1024),
      0
    ) as number
    if (totalVRAM >= 4000) return { available: true, vramMB: Math.round(totalVRAM) }
    return { available: false, vramMB: Math.round(totalVRAM), reason: `AMD 显存不足 (${Math.round(totalVRAM)}MB < 4000MB)` }
  } catch {
    // AMD 也检测失败，尝试通过 dxdiag 检测 DirectX GPU
  }

  // 通用 DirectX GPU 检测（适用于 Intel Arc / 部分 AMD）
  try {
    const { stdout } = await execAsync(
      `"${POWERSHELL_EXE}" -Command "Get-WmiObject Win32_VideoController | Select-Object Name, AdapterRAM | ConvertTo-Json"`,
      { timeout: 5000 }
    )
    const gpus = JSON.parse(stdout)
    if (Array.isArray(gpus)) {
      for (const gpu of gpus) {
        const vramMB = Math.round((gpu.AdapterRAM || 0) / (1024 * 1024))
        if (vramMB >= 4000) return { available: true, vramMB }
      }
      return { available: false, vramMB: 0, reason: '未找到≥4GB显存的 GPU' }
    }
  } catch {
    // 全部检测失败
  }

  return { available: false, vramMB: 0, reason: '未检测到可用 GPU (NVIDIA/AMD/Intel)' }
}

export class CpuInferenceEngine extends EventEmitter {
  model: CpuModel | null = null
  private context: CpuContext | null = null
  private session: LlamaChatSession | null = null
  private loaded = false
  // @ts-expect-error TS6133 — may be used for model tracking
  private currentModelPath: string = ''
  private systemPrompt: string = ''
  private chatHistory: ContextHistory = { messages: [], summary: '', tokenCount: 0, maxTokens: 4096 }
  private modelToRam: boolean = false  // 模型是否被迁移到RAM
  /** KV 暂挂时保存的加载配置（用于恢复时重建模型/上下文） */
  private lastLoadConfig: CpuInferenceConfig | null = null
  /** KV 暂挂时保存的对话上下文（含摘要与 token 统计） */
  private parkedHistory: ContextHistory | null = null
  private parkedSystemPrompt: string = ''
  /** 结构化上下文·RAM 常驻层（全局骨架 + 会话摘要）：由本地 CPU provider 每次生成前
   *  从 memorySkeleton / sessionSummaryStore 真实读取后注入，不再从磁盘拼接 */
  private ramContext: { skeleton?: string; summaries?: string } = {}
  private stats = { totalTokens: 0, totalRequests: 0, avgLatency: 0, requests: [] as number[] }

  /** 引擎是否已加载模型 */
  isLoaded(): boolean { return this.loaded }

  async loadModel(config: CpuInferenceConfig): Promise<boolean> {
    try {
      const llama = await ensureLlamaModule()
      if (!existsSync(config.modelPath)) {
        throw new Error(`模型文件不存在: ${config.modelPath}`)
      }

      logger.debug(`[CPUEngine] 加载模型: ${config.modelPath}`)
      this.emit('progress', { stage: 'loading', message: '正在加载模型到内存...' })

      // 释放旧模型，防止内存泄漏 (D3-5)
      if (this.loaded || this.model) {
        await this.unload().catch(() => {})
      }

      const llamaInstance = await getResolvedLlama(llama)
      this.model = await llamaInstance.loadModel({
        modelPath: config.modelPath,
        // v10.2: 透传 gpuLayers（质量档部分卸载；默认 0 = 纯 CPU）
        gpuLayers: config.gpuLayers ?? 0,
        // v13.x 多模态主模型：挂载 mmproj 视觉头，Qwopus 主模型直接支持发图
        ...(config.mmprojPath ? { mmprojPath: config.mmprojPath } : {}),
      })

      const threads = config.threads || Math.min(4, Math.max(1, Math.floor(cpus().length / 2)))
      const ctxSize = config.contextSize || 4096
      // P0-动态预算：q8_0 KV cache 按空闲系统内存兜底收缩，避免 cache-ram 溢出系统内存
      const finalCtx = this.budgetContextSize(ctxSize)

      this.context = await this.model.createContext({
        contextSize: finalCtx,
        threads,
        // P0-上下文与显存优化：flash attention 必开（模型不支持时自动忽略）
        flashAttention: true,
        // P0-上下文与显存优化：KV cache q8_0 量化（K/V 折半），6GB 显存下显著降低 cache-ram 占用
        experimentalKvCacheKeyType: 'Q8_0',
        experimentalKvCacheValueType: 'Q8_0',
      })

      const { LlamaChatSession } = llama
      this.session = new LlamaChatSession({
        contextSequence: this.context.getSequence(),
      })

      // 保存系统提示词
      if (config.systemPrompt) {
        this.systemPrompt = config.systemPrompt
        this.chatHistory.messages = [{ role: 'system', content: config.systemPrompt }]
      }

      this.loaded = true
      this.currentModelPath = config.modelPath
      this.modelToRam = false
      // KV 暂挂/恢复：保存本次加载配置，供 migrateToRAM 卸载后再 restoreFromRAM 重建
      this.lastLoadConfig = { ...config }
      this.chatHistory.maxTokens = finalCtx
      this.emit('loaded')
      logger.debug(`[CPUEngine] 模型加载完成 (threads=${threads}, ctx=${finalCtx}, flashAttention=on, kvCache=q8_0)`)
      return true
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e)
      logger.error('[CPUEngine] 加载失败:', errMsg)
      this.emit('error', errMsg)
      return false
    }
  }

  /**
   * 智能生成 — 支持完整对话上下文和所有采样参数
   */
  async generate(prompt: string, options?: GenerateOptions): Promise<string> {
    if (!this.loaded || !this.session) {
      throw new Error('模型未加载')
    }

    const maxTokens = options?.maxTokens || 2048
    const temperature = options?.temperature ?? 0.7
    const startTime = Date.now()
    let result = ''

    // 构建带历史的消息
    this.chatHistory.messages.push({ role: 'user', content: prompt })
    this.chatHistory.tokenCount += Math.ceil(prompt.length / 3)

    // 超出上下文窗口则自动摘要压缩
    if (this.chatHistory.tokenCount > this.chatHistory.maxTokens * 0.8) {
      this.compressHistory()
    }

    try {
      const fullPrompt = this.buildFullPrompt(prompt)
      const response = await this.session.prompt(fullPrompt, {
        maxTokens,
        temperature,
        topP: options?.topP ?? 0.9,
        topK: options?.topK ?? 40,
        repeatPenalty: options?.repeatPenalty ?? 1.1,
        onToken: (tokens: number[]) => {
          if (!this.model) return
          const text = this.model.detokenize(tokens)
          result += text
          this.emit('token', text)
        },
      })
      result = response || result

      // 保存助手回复
      this.chatHistory.messages.push({ role: 'assistant', content: result })
      this.chatHistory.tokenCount += Math.ceil(result.length / 3)

      // 性能统计
      const latency = Date.now() - startTime
      this.stats.totalRequests++
      this.stats.totalTokens += Math.ceil(result.length / 3)
      this.stats.requests.push(latency)
      if (this.stats.requests.length > 100) this.stats.requests.shift()
      this.stats.avgLatency = this.stats.requests.reduce((a, b) => a + b, 0) / this.stats.requests.length

      return result
    } catch (e: unknown) {
      this.emit('error', e instanceof Error ? e.message : String(e))
      throw e
    }
  }

  /**
   * 迁移模型到RAM（KV 暂挂机制）：真实卸载模型/上下文释放显存，
   * 保留加载配置与对话上下文，供后续 restoreFromRAM 重建后无缝续聊。
   */
  async migrateToRAM(): Promise<boolean> {
    if (!this.loaded && !this.modelToRam) return false
    if (this.modelToRam) return true // 已暂挂，幂等
    if (!this.lastLoadConfig) {
      logger.warn('[CPUEngine] migrateToRAM 失败：无加载配置可恢复')
      return false
    }

    // 保存对话上下文（含摘要与统计），暂挂期间不丢失
    this.parkedHistory = this.getChatHistory()
    this.parkedSystemPrompt = this.systemPrompt

    // 真实释放模型/上下文/会话，归还显存与内存
    await this.releaseResources()
    this.loaded = false
    this.modelToRam = true
    this.emit('unloaded')
    logger.debug('[CPUEngine] 模型已迁移到RAM（上下文与加载配置已保留）')
    return true
  }

  /**
   * 从RAM恢复（KV 恢复机制）：用暂挂前保存的配置重建模型与上下文，并恢复对话历史。
   */
  async restoreFromRAM(): Promise<boolean> {
    if (!this.modelToRam) return false
    if (!this.lastLoadConfig) {
      logger.warn('[CPUEngine] restoreFromRAM 失败：无加载配置')
      return false
    }
    const ok = await this.loadModel(this.lastLoadConfig)
    if (!ok) {
      logger.error('[CPUEngine] restoreFromRAM 失败：模型重建失败')
      return false
    }
    // 恢复暂挂前的系统提示词与对话历史
    if (this.parkedSystemPrompt) this.setSystemPrompt(this.parkedSystemPrompt)
    if (this.parkedHistory) {
      this.chatHistory = {
        messages: [...this.parkedHistory.messages],
        summary: this.parkedHistory.summary,
        tokenCount: this.parkedHistory.tokenCount,
        maxTokens: this.parkedHistory.maxTokens,
      }
    }
    this.parkedHistory = null
    this.parkedSystemPrompt = ''
    this.modelToRam = false
    logger.debug('[CPUEngine] 模型已从RAM恢复（上下文已重建）')
    return true
  }

  isInRAM(): boolean { return this.modelToRam }

  /**
   * 注入 RAM 常驻上下文（结构化组包）：全局骨架 + 会话摘要。
   * 由本地 CPU provider 在每次生成前从 memorySkeleton / sessionSummaryStore 真实读取后写入。
   */
  setRamContext(ram: { skeleton?: string; summaries?: string }): void {
    this.ramContext = ram || {}
  }

  /** 读取当前 RAM 常驻上下文（供状态上报/诊断） */
  getRamContext(): { skeleton?: string; summaries?: string } {
    return { ...this.ramContext }
  }

  /**
   * migrateToRAM 停车后再加载同模型时恢复暂挂上下文（真实内存态续聊）。
   * 模型路径一致 → 恢复历史；不一致 → 丢弃陈旧暂挂，避免脏上下文串会话。
   */
  restoreParkedIfSame(modelPath: string): void {
    if (!this.modelToRam) return
    const parkPath = this.lastLoadConfig?.modelPath
    if (parkPath && parkPath === modelPath && this.parkedHistory) {
      if (this.parkedSystemPrompt) this.setSystemPrompt(this.parkedSystemPrompt)
      this.chatHistory = {
        messages: [...this.parkedHistory.messages],
        summary: this.parkedHistory.summary,
        tokenCount: this.parkedHistory.tokenCount,
        maxTokens: this.parkedHistory.maxTokens,
      }
      logger.debug('[CPUEngine] 已从 RAM 恢复同一模型的对话上下文')
    } else {
      logger.debug('[CPUEngine] 暂挂上下文模型不一致，丢弃陈旧暂挂')
    }
    this.parkedHistory = null
    this.parkedSystemPrompt = ''
    this.modelToRam = false
  }

  /**
   * 释放模型/上下文/会话资源（不重置对话状态；供 KV 暂挂复用）
   */
  private async releaseResources(): Promise<void> {
    this.session = null
    try { if (this.context && typeof (this.context as any).dispose === 'function') await (this.context as any).dispose() } catch (e) { logger.error('[CPUEngine] 释放上下文失败:', e) }
    this.context = null
    try { if (this.model && typeof this.model.dispose === 'function') await this.model.dispose() } catch (e) { logger.error('[CPUEngine] 释放模型失败:', e) }
    this.model = null
  }

  /**
   * 动态 contextSize 预算：q8_0 KV cache 约 85B/token，按空闲系统内存兜底收缩，
   * 避免超长上下文导致 cache-ram 溢出系统内存（32GB 本机实测 16384~32768 均稳定）。
   */
  private budgetContextSize(requested: number): number {
    try {
      const freememMB = Math.floor(freemem() / 1024 / 1024)
      // 预留 4GB 系统内存给系统与其它应用；q8 KV ≈ 85B/token
      const safeMB = Math.max(512, freememMB - 4096)
      const maxByRam = Math.floor((safeMB * 1024) / 85)
      const final = Math.max(1024, Math.min(requested, maxByRam))
      if (final < requested) {
        logger.warn(`[CPUEngine] 空闲内存 ${freememMB}MB 偏紧，contextSize 预算 ${requested} → ${final}（q8 KV 防溢出）`)
      }
      return final
    } catch (e) {
      logger.warn(`[CPUEngine] contextSize 预算计算失败，使用原值 ${requested}:`, e)
      return requested
    }
  }

  /**
   * 获取对话历史
   */
  getChatHistory(): ContextHistory {
    return {
      messages: [...this.chatHistory.messages],
      summary: this.chatHistory.summary,
      tokenCount: this.chatHistory.tokenCount,
      maxTokens: this.chatHistory.maxTokens,
    }
  }

  /**
   * 设置系统提示词
   */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt
    // 替换或插入系统消息
    if (this.chatHistory.messages.length > 0 && this.chatHistory.messages[0].role === 'system') {
      this.chatHistory.messages[0] = { role: 'system', content: prompt }
    } else {
      this.chatHistory.messages.unshift({ role: 'system', content: prompt })
    }
    logger.debug(`[CPUEngine] 系统提示词已更新 (${prompt.length}字)`)
  }

  /**
   * 清空对话历史（保留系统提示词）
   */
  clearHistory(): void {
    const sysMsg = this.chatHistory.messages.find(m => m.role === 'system')
    this.chatHistory = {
      messages: sysMsg ? [sysMsg] : [],
      summary: '',
      tokenCount: sysMsg ? Math.ceil(sysMsg.content.length / 3) : 0,
      maxTokens: this.chatHistory.maxTokens,
    }
  }

  /**
   * 获取性能统计
   */
  getStats() {
    return { ...this.stats }
  }

  /**
   * 构建完整提示词（ChatML 格式，与 SGLang GPU 路径一致）
   */
  private buildFullPrompt(newMessage: string): string {
    const parts: string[] = []

    if (this.systemPrompt) {
      // P3-1: 使用 ChatML 格式与 SGLang 保持一致
      parts.push(`<|im_start|>system\n${this.systemPrompt}<|im_end|>`)
    }

    // 结构化组包·RAM 常驻层注入：全局骨架 + 会话摘要（真实内存态，非磁盘拼接）
    if (this.ramContext.skeleton) {
      parts.push(`<|im_start|>system\n[全局记忆 MEMORY.md] ${this.ramContext.skeleton}<|im_end|>`)
    }
    if (this.ramContext.summaries) {
      parts.push(`<|im_start|>system\n[会话摘要] ${this.ramContext.summaries}<|im_end|>`)
    }

    if (this.chatHistory.summary) {
      parts.push(`<|im_start|>system\n[前文摘要] ${this.chatHistory.summary}<|im_end|>`)
    }

    // 最近6轮对话
    const recentMsgs = this.chatHistory.messages.filter(m => m.role !== 'system').slice(-12)
    for (const msg of recentMsgs) {
      if (msg.content === newMessage && msg.role === 'user' && msg === recentMsgs[recentMsgs.length - 1]) continue
      parts.push(`<|im_start|>${msg.role}\n${msg.content}<|im_end|>`)
    }

    parts.push(`<|im_start|>user\n${newMessage}<|im_end|>`)
    parts.push('<|im_start|>assistant\n')
    return parts.join('\n')
  }

  /**
   * 对话历史压缩（超出上下文窗口时自动触发）
   * 将早期对话压缩为摘要
   */
  private compressHistory(): void {
    const sysMsg = this.chatHistory.messages.find(m => m.role === 'system')
    const nonSysMsgs = this.chatHistory.messages.filter(m => m.role !== 'system')

    if (nonSysMsgs.length <= 4) return  // 太少不压缩

    // 保留最近4条，之前的压缩为摘要
    const oldMsgs = nonSysMsgs.slice(0, -4)
    const recentMsgs = nonSysMsgs.slice(-4)

    const oldText = oldMsgs.map(m => `${m.role}: ${m.content.slice(0, 200)}`).join('\n')
    this.chatHistory.summary = `[历史摘要] ${oldMsgs.length} 条旧消息已压缩: ${oldText.slice(0, 500)}`
    this.chatHistory.messages = sysMsg ? [sysMsg, ...recentMsgs] : recentMsgs
    this.chatHistory.tokenCount = Math.ceil(
      (this.chatHistory.summary.length + recentMsgs.reduce((s, m) => s + m.content.length, 0)) / 3
    )
    logger.debug('[CPUEngine] 对话历史已压缩')
  }

  async unload(): Promise<void> {
    this.session = null
    this.lastLoadConfig = null
    this.parkedHistory = null
    this.parkedSystemPrompt = ''
    this.modelToRam = false
    try { if (this.context && typeof this.context.dispose === 'function') await this.context.dispose() } catch (e) { logger.error('[CPUEngine] 释放上下文失败:', e) }
    this.context = null
    try { if (this.model && typeof this.model.dispose === 'function') await this.model.dispose() } catch (e) { logger.error('[CPUEngine] 释放模型失败:', e) }
    this.model = null
    this.loaded = false
    this.ramContext = {}
    this.chatHistory = { messages: [], summary: '', tokenCount: 0, maxTokens: 4096 }
    logger.debug('[CPUEngine] 模型已卸载')
  }
}

export const cpuInferenceEngine = new CpuInferenceEngine()
