import { ipcMain, BrowserWindow, dialog } from 'electron'
import fs from 'fs'
import AdmZip from 'adm-zip'

import { LLMProviderRegistry } from '../llm/provider-registry'

import { getStore } from './config.ipc'

import { LLMProvider, FunctionCallingTool, ToolCallRequest } from '../llm/provider'

import { modelManager } from '../model-manager'

import { taskRouter } from '../task-router'

import { RouteSignal, TierResult } from '../task-router/signals'

import { logger } from '../../shared/logger'

import { toolRegistry } from '../agent/tool-registry'

import { buildDefaultSystemContent } from '../../shared/default-persona'

import { ReActAgent } from '../agent/react-loop'

import { AgentInput } from '../agent/types'

import { ContextWindowManager } from '../context-window/manager'
import { ConversationCompressor } from '../context-window/compressor'
import { apiQuotaTracker as quotaTracker } from '../api-quota-tracker'
import * as ragModule from '../rag/index'
import { cloudQuota } from '../cloud-quota'
import { localAiScanner } from '../local-ai-scanner'
import { aggregateSearch } from '../search/web-search/search-aggregator'
import { getEngineById } from '../search/web-search/search-engine'
import { tandemManager } from '../tandem-manager'
import { cloudModelManager } from '../cloud-model-manager'
import { decrypt } from '../secure/secure-store'
import { initStructuredMemory, memorySkeleton, sessionSummaryStore } from '../context-window/structured-memory'

const contextWindowManager = new ContextWindowManager()
const conversationCompressor = new ConversationCompressor()

/** 结构化上下文懒初始化（首个会话前执行一次：骨架确保存在 + 今日摘要入 RAM） */
let structuredMemoryReady = false
function ensureStructuredReady(): void {
  if (structuredMemoryReady) return
  try {
    initStructuredMemory()
    structuredMemoryReady = true
    logger.info('[chat] 结构化上下文已初始化（三层组包 READY）')
  } catch (e) {
    logger.warn('[chat] 结构化上下文初始化失败，降级为普通组包:', e)
    structuredMemoryReady = true // 已尝试过，避免重复失败日志
  }
}

/**
 * 构建云端 provider 备选链（failover，§4.2-1）：
 * 优先从 cloudModelManager（云端模型注册表）解析；回退到 config.providers 里的 API provider。
 * 返回去重后的 provider 配置列表（含解密后的 apiKey），供主 provider 失败后依次切换。
 */
function resolveCloudFailoverChain(primaryProviderId: string): Array<{ id: string; name: string; baseUrl: string; apiKey: string; model: string }> {
  const chain: Array<{ id: string; name: string; baseUrl: string; apiKey: string; model: string }> = []
  const seen = new Set<string>()
  const push = (id: string, name: string, baseUrl: string, apiKey: string, model: string) => {
    if (!id || !baseUrl || !apiKey || seen.has(id)) return
    seen.add(id)
    chain.push({ id, name, baseUrl, apiKey, model })
  }
  try {
    // 云端模型注册表（cloud-model-manager）优先
    const order = cloudModelManager.failoverOrder(primaryProviderId)
    for (const m of order) {
      const key = cloudModelManager.getDecryptedApiKey(m.id)
      if (key) push(m.id, m.name, m.baseUrl, key, m.modelId)
    }
  } catch (e) {
    logger.warn('[chat] cloudModel failover 解析失败:', e)
  }
  // 回退：config.providers 里的 API provider（主 provider 排最前）
  try {
    const store = getStore()
    const providers: any[] = store.get('providers') || []
    const LOCAL = new Set(['__local_tandem__', '__local_sglang__', '__local_gpu__', '__local_cpu__'])
    const primary = providers.find((p: any) => p.id === primaryProviderId && !LOCAL.has(p.id))
    const rest = providers.filter((p: any) => p.id !== primaryProviderId && !LOCAL.has(p.id) && p.apiKey && p.baseUrl)
    for (const p of [primary, ...rest]) {
      if (!p) continue
      const model = Array.isArray(p.models) && p.models.length > 0 ? p.models[0] : undefined
      if (model) push(p.id, p.name || p.id, p.baseUrl, decrypt(p.apiKey), model)
    }
  } catch (e) {
    logger.warn('[chat] providers failover 解析失败:', e)
  }
  return chain
}

/**
 * 从备选链中创建（或复用）一个 OpenAI 兼容 provider。
 */
function createProviderFromChainEntry(entry: { id: string; name: string; baseUrl: string; apiKey: string; model: string }): LLMProvider {
  const existing = LLMProviderRegistry.getProvider(entry.id)
  if (existing) return existing
  const p = LLMProviderRegistry.createProvider({
    id: entry.id,
    name: entry.name,
    type: 'openai',
    baseUrl: entry.baseUrl,
    apiKey: entry.apiKey,
    model: entry.model,
  })
  LLMProviderRegistry.registerProvider(p)
  return p
}

/**
 * 滑动窗口截断：按实际窗口保留 system + 最近若干轮 + 当前消息，不再全量发送全部历史。
 * 返回截断后的消息数组（保底保留 system 与最后一条 user）。
 */
function truncateToWindow(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
  if (!messages || messages.length === 0) return messages
  const budget = Math.max(1024, Math.floor(maxTokens * 0.8))
  const systemMsgs = messages.filter(m => m.role === 'system')
  const others = messages.filter(m => m.role !== 'system')
  const systemTokens = systemMsgs.reduce((acc, m) => acc + contextWindowManager.countTokens(m.content), 0)
  // 从后往前保留最近消息
  const kept: ChatMessage[] = []
  let used = systemTokens
  for (let i = others.length - 1; i >= 0; i--) {
    const t = contextWindowManager.countTokens(others[i].content)
    if (used + t > budget && kept.length > 0) break
    if (used + t > budget) continue // 单条超预算（罕见长文本）则丢弃该条
    kept.unshift(others[i])
    used += t
  }
  const result = [...systemMsgs, ...kept]
  if (result.length !== messages.length) {
    logger.info(`[chat] 滑动窗口截断: ${messages.length} → ${result.length} 条 (budget=${budget} tokens)`)
  }
  return result
}

interface ChatMessage {

  id: string

  role: 'user' | 'assistant' | 'system'

  content: string

}

interface ChatRequest {

  id?: string

  messages: ChatMessage[]

  stream?: boolean

  model?: string

  /** 前端携带的已注册工具名白名单（后端校验后组装完整 schema 透传 provider） */
  tools?: string[]

}

class SafeAbortRegistry {

  private controllers: Map<string, AbortController> = new Map()

  set(sessionId: string, ctrl: AbortController): void {

    const old = this.controllers.get(sessionId)

    if (old) { try { old.abort() } catch { /* ignore */ } }

    this.controllers.set(sessionId, ctrl)

  }

  get(sessionId: string): AbortController | undefined {

    return this.controllers.get(sessionId)

  }

  has(sessionId: string): boolean {

    return this.controllers.has(sessionId)

  }

  delete(sessionId: string): boolean {

    const ctrl = this.controllers.get(sessionId)

    if (ctrl) { try { ctrl.abort() } catch { /* ignore */ } }

    return this.controllers.delete(sessionId)

  }

  forEach(callback: (ctrl: AbortController, sessionId: string) => void): void {

    this.controllers.forEach(callback)

  }

  clear(): void {

    this.controllers.clear()

  }

  abortAll(): number {

    let count = 0

    this.controllers.forEach((ctrl) => {

      try { ctrl.abort() } catch { /* ignore */ }

      count++

    })

    this.controllers.clear()

    if (count > 0) {

      logger.warn(`[chat.ipc] 已清理 ${count} 个未释放的 AbortController`)

    }

    return count

  }

  get size(): number {

    return this.controllers.size

  }

}

const streamAbortControllers = new SafeAbortRegistry()

/** B1.3: 注册 Map 便于 chat:stop 按 sessionId 中止，防止流式会话泄漏 */

export function abortAllStreamControllers(): void {

  streamAbortControllers.abortAll()

}

function getSessionId(event: Electron.IpcMainInvokeEvent, request: ChatRequest): string {

  return request.id || `${event.sender.id}-${Date.now()}`

}

async function ensureLocalProvider(): Promise<LLMProvider | null> {

  // 优先复用已注册的本地 Provider

  const existing = LLMProviderRegistry.getProvider('__local_tandem__')

    || LLMProviderRegistry.getProvider('__local_sglang__')

    || LLMProviderRegistry.getProvider('__local_gpu__')

    || LLMProviderRegistry.getProvider('__local_cpu__')

  if (existing) {

    return existing  // 已存在 Provider

  }

  // v12.3 优先复用 tandem-manager 已启动的本地模型服务（统一引擎，避免模型重复加载占用内存/显存）
  try {
    const states = tandemManager.getServerStates()
    const running = states.find((s: any) => s.status === 'running' && s.port)
    if (running) {
      const provider = LLMProviderRegistry.createProvider({
        id: '__local_tandem__',
        name: `本地模型: ${running.modelId}`,
        type: 'openai',
        baseUrl: `http://127.0.0.1:${running.port}/v1`,
        model: running.modelId,
      })
      LLMProviderRegistry.registerProvider(provider)
      logger.debug(`[chat] 复用 tandem 本地模型引擎: ${running.modelId} (端口 ${running.port})`)
      return provider
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    logger.error('[chat] tandem detection failed', reason)
  }

  try {

    const resp = await fetch('http://127.0.0.1:30000/v1/models', {

      signal: AbortSignal.timeout(3000),

    })

    if (resp.ok) {

      const provider = LLMProviderRegistry.createProvider({

        id: '__local_sglang__',

        name: '本地 SGLang 服务',

        type: 'sglang',

        baseUrl: 'http://127.0.0.1:30000',

      })

      LLMProviderRegistry.registerProvider(provider)

      logger.debug('[chat] local SGLang engine ready')

      return provider

    }

  } catch (err) {

    const reason = err instanceof Error ? err.message : String(err)

    logger.error('[chat] SGLang detection failed', reason)

  }

  // v11.0 起本地引擎统一为 localcpu，不再区分 localgpu / localcpu

  try {

    const loaded = modelManager.getLoadedModel()

    if (loaded) {

      logger.debug(`[chat] CPU 引擎已加载: ${loaded.modelName}`)

      const provider = LLMProviderRegistry.createProvider({

        id: '__local_cpu__',

        name: `本地 CPU 推理: ${loaded.modelName}`,

        type: 'localcpu',

      })

      LLMProviderRegistry.registerProvider(provider)

      return provider

    }

  } catch (err) {

    const reason = err instanceof Error ? err.message : String(err)

    logger.error('[chat] CPU fallback check failed', reason)

  }

  return null

}

/**
 * F批/识图链路协作：从「内容数组」多模态消息中提取纯文本片段（供 RAG 检索 / 记忆落盘 / 用量估算等
 * 只关心文本的下游使用），图片分段折叠为 [图片:path] 占位，替代原 `[图片:path]` 文本标记语义。
 */
function extractTextContent(content: unknown): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p: any) => {
        if (!p || typeof p !== 'object') return ''
        if (p.type === 'text') return typeof p.text === 'string' ? p.text : ''
        if (p.type === 'image_url' && p.image_url && typeof p.image_url.url === 'string') {
          return `[图片:${p.image_url.url}]`
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function buildRouteSignal(request: ChatRequest): RouteSignal {
  const messages = request.messages || []

  const last = messages[messages.length - 1]

  const text = typeof last?.content === 'string' ? last.content : ''

  const imageUrls: string[] = []

  let hasImageContent = false

  for (const m of messages) {

    if (Array.isArray(m.content)) {

      hasImageContent = true

      for (const part of m.content) {

        if (part?.type === 'image_url' && part?.image_url?.url) {

          imageUrls.push(typeof part.image_url.url === 'string' ? part.image_url.url : '')

        }

      }

    }

  }

  const extra = request as ChatRequest & {

    hasImage?: boolean

    fileType?: string

    triggerWindow?: string

    audioText?: string

    personaId?: string

  }

  return {

    text,

    hasImage: hasImageContent || extra.hasImage === true,

    imageUrls: imageUrls.length > 0 ? imageUrls : undefined,

    fileType: extra.fileType,

    triggerWindow: extra.triggerWindow,

    audioText: extra.audioText,

    personaId: extra.personaId,

  }

}

function isAppRenderer(event: Electron.IpcMainInvokeEvent): boolean {

  const allowedIds = new Set(

    BrowserWindow.getAllWindows().map(w => w.webContents.id)

  )

  return allowedIds.has(event.sender.id)

}

export function setupChatHandlers(): void {

  ipcMain.handle('chat:send', async (event, request: ChatRequest) => {

    // IPC caller authorization check
    if (!isAppRenderer(event)) {
      logger.warn('[chat] Unauthorized caller', event.sender.id)
      return { error: 'unauthorized caller' }
    }

    // Input validation - DoS protection
    if (request.messages && request.messages.length > 100) {
      return { error: 'message limit exceeded' }
    }

    for (const msg of request.messages || []) {
      if (typeof msg.content === 'string' && msg.content.length > 131072) {
        return { error: 'error' }
      }
    }

    let provider: LLMProvider | null = null

    const sessionId = getSessionId(event, request)

    const win = BrowserWindow.fromWebContents(event.sender)

    try {

      const store = getStore()

      const providers: any[] = store.get('providers') || []

      const activeProviderId: string = store.get('activeProvider') || providers[0]?.id

      // v12.2 路由先行：意图分类 → 判断是否为复杂任务 → 决定模型调度

      const routeSignal = buildRouteSignal(request)

      let routeResult: TierResult | null = null

      try {

        routeResult = await taskRouter.route(routeSignal)

      } catch (routeErr) {

        logger.warn('[info]', routeErr)

      }

      const intent = routeResult?.intent || taskRouter.classify(routeSignal)

      const userText = request.messages[request.messages.length - 1]?.content || ''

      const isComplex = taskRouter.isComplexTask(intent, userText.length)

      // v12.2 模型调度原则：
      //   1) 所有任务无论简单复杂，默认由本地主模型推理
      //   2) 仅复杂任务（reasoning/math/code/longdoc/超长文本）且已接入云端 API 时，才调用云端模型
      //   3) 云端调用前检查余量，耗尽自动降级本地；调用后记录用量（节约使用）
      //   4) 大修：云端调用失败（无效 Key/402 余额不足/网络错误）自动回退本地模型保真

      let useCloud = false
      const LOCAL_PROVIDER_IDS = new Set(['__local_tandem__', '__local_sglang__', '__local_gpu__', '__local_cpu__'])
      const activeCfg = activeProviderId ? providers.find((p: any) => p.id === activeProviderId) : undefined
      const isConfiguredCloud = !!activeProviderId && !LOCAL_PROVIDER_IDS.has(activeProviderId) && !!activeCfg

      if (isComplex && isConfiguredCloud) {

        if (cloudQuota.isExhausted(activeProviderId)) {

          logger.warn(`[chat] 云端余量已耗尽(${activeProviderId})，降级本地主模型`)

        } else {

          useCloud = true

        }

      }

      if (useCloud && activeProviderId) {

        provider = LLMProviderRegistry.getProvider(activeProviderId) || null

        // 若 registry 未注册（如模型设置页通过 llm:add-provider 添加的 API Provider），按 store 配置动态创建并注册
        if (!provider) {
          const cfg = providers.find((p: any) => p.id === activeProviderId)
          if (cfg) {
            try {
              provider = LLMProviderRegistry.createProvider({
                id: cfg.id,
                name: cfg.name || cfg.id,
                type: cfg.type || 'openai',
                baseUrl: cfg.baseUrl,
                apiKey: decrypt(cfg.apiKey),
                model: Array.isArray(cfg.models) && cfg.models.length > 0 ? cfg.models[0] : undefined,
              })
              LLMProviderRegistry.registerProvider(provider)
              logger.info('[chat] 动态注册 API Provider:', activeProviderId)
            } catch (createErr) {
              logger.warn('[chat] 创建 API Provider 失败:', createErr)
              provider = null
            }
          }
        }
        if (provider) {

          logger.info(`[chat] 复杂任务使用云端模型: ${activeProviderId}（intent=${intent}）`)

        }

      }

      // v12.2 视觉任务调度：消息含图片且主模型非多模态 → 切换辅助视觉模型，强制走本地推理
      if (routeSignal.hasImage && !modelManager.isMainMultimodal()) {
        const visionOk = await modelManager.swapToVision()
        if (visionOk) {
          useCloud = false // 图片已送入本地视觉模型，不再走云端
          logger.info('[chat] 图片任务已切换辅助视觉模型，走本地推理')
        } else {
          // 发布级体验：本机无任何视觉能力时，直接给出可操作的中文提示，
          // 而不是把图片硬塞给无视觉模型导致晦涩的 "image input is not supported (mmproj)" 500 报错
          const hasVisionModel = !!modelManager.resolveVisionModelId()
          if (!hasVisionModel) {
            return {
              error: '当前主模型不支持识图，且本机未配置视觉模型。请在「模型」页接入带视觉能力的模型（如 Qwen-VL / GLM-4V），或改用支持图片输入的云端模型后重试。',
              visionUnsupported: true,
            }
          }
          logger.warn('[chat] 辅助视觉模型不可用，降级当前模型处理（可能无法理解图片）')
        }
      }

      // 非复杂任务或云端不可用 → 本地主模型

      if (!provider) {

        provider = await ensureLocalProvider()

        if (!provider) {

          return {
            error: 'No AI provider configured and no local model loaded.',
          }
        }
      }

      const isApiProvider = useCloud && !!activeProviderId

      // v12.2 任务前扫描建议：复杂任务未走云端（未接入 / 余量耗尽）时，
      // 扫描本机已安装的 AI 客户端并推送建议，用户可要求替换云端模型为本地 AI 客户端推理
      if (isComplex && !useCloud && win) {
        try {
          const localClients = await localAiScanner.scan()
          if (localClients && localClients.length > 0) {
            win.webContents.send('chat:ai-client-suggestion', {
              sessionId,
              reason: isConfiguredCloud ? '云端余量已耗尽' : '未接入云端 API',
              clients: localClients.slice(0, 8),
            })
          }
        } catch (e) {
          logger.warn('[chat] AI 客户端建议扫描失败:', e)
        }
      }

      // #修复3 上下文窗口对齐（渐进式）：启动模型后按实际 contextSize 对齐逻辑层窗口。
      // 精简重塑 v1 固定钳制到 8192 治好了超时，但长会话会被窗口硬截断、上下文利用不充分。
      // 渐进式：以会话实际已用 token 为基准，窗口从起步值随用量渐进上调（余量系数 1.7），
      // 封顶 MEMORY_CONTEXT_MAX —— 6GB 显存 + KV 全内存下，14k+ token 的 prefill 会撞双层超时，
      // 故渐进上限取内存可承受且压缩能及时兜底的安全值；短会话窗口小响应快，长会话窗口渐扩保留更多历史。
      const MEMORY_CONTEXT_MIN = 8192   // 起步安全窗口（与精简重塑 v1 一致）
      const MEMORY_CONTEXT_MAX = 16384  // 渐进上限：内存 KV 可承受 + prefill 可控 + 压缩兜底
      try {
        const runtimeInfo = await modelManager.getModelRuntimeInfo()
        const loadedModel = modelManager.getLoadedModel()
        const rt = runtimeInfo?.models?.find((m: any) => m.id === loadedModel?.modelId)
        const rawCtx = rt?.contextSize || 4096
        // 以本轮实际消息用量估算渐进窗口：used*1.7 预留生成与注入余量，窄幅起步、随用量渐扩、封顶安全上限
        const usedTokens = request.messages.reduce((acc, m) => acc + contextWindowManager.countTokens(String(m.content ?? '')), 0)
        const progressiveCtx = Math.min(rawCtx, Math.max(MEMORY_CONTEXT_MIN, Math.min(Math.ceil(usedTokens * 1.7), MEMORY_CONTEXT_MAX)))
        contextWindowManager.setMaxTokens(progressiveCtx)
        logger.info(`[chat] 上下文窗口对齐(渐进式): raw=${rawCtx} used=${usedTokens}t → window=${progressiveCtx} (${loadedModel?.modelId || 'unknown'})`)
      } catch (alignErr) {
        logger.warn('[chat] 上下文窗口对齐失败，保持默认窗口:', alignErr)
      }

      let processedMessages: ChatMessage[] = request.messages

      let contextStats: any = null

      const userMsg = extractTextContent(request.messages[request.messages.length - 1]?.content)

      let memoryItems: any[] = []

      if (ragModule && userMsg) {

        try {

          const ragResult = await ragModule.searchContext?.(userMsg, { topK: 5 })

          memoryItems = ragResult?.items || ragResult || []

          if (!Array.isArray(memoryItems)) memoryItems = []

        } catch (ragErr) {

          logger.warn('[chat] RAG retrieval failed', ragErr)

        }

      }

      if (request.messages.length > 0) {

        // 结构化上下文懒初始化：确保 MEMORY.md 骨架存在 + 今日会话摘要入 RAM（三层组包）
        ensureStructuredReady()

        try {

          // #修复1 人设预设打底：system 为空时兜底注入默认身份，保证任何模型都带单条 system
          const systemPrompt = request.messages.find(m => m.role === 'system')?.content || buildDefaultSystemContent()

          const result = contextWindowManager.buildStructuredContext(

            request.messages.map(m => ({ role: m.role, content: m.content })),

            systemPrompt,

            memoryItems

          )

          let ctxMessages = result.messages

          let ctxStats = result.stats

          // v12.1 上下文智能压缩接线：buildContext 后按需触发压缩，压缩结果替换推理上下文

          try {

            const compressResult = await contextWindowManager.checkAndCompress(

              result.messages,

              conversationCompressor,

              async (msgs, opts) => {

                // 摘要推理函数：优先使用本地主模型，失败时返回空串（压缩器会回退为不压缩）

                try {

                  return await modelManager.generateResponse(

                    msgs.map(m => `${m.role}: ${m.content}`).join('\n'),

                    { temperature: opts?.temperature ?? 0.2, maxTokens: opts?.maxTokens ?? 100 },

                  )

                } catch (e) {

                  logger.warn('[chat] 压缩摘要推理失败，跳过压缩:', e)

                  return ''

                }

              },

              false,

            )

            if (compressResult.triggered && compressResult.messages && compressResult.messages.length > 0) {

              ctxMessages = compressResult.messages

              ctxStats = { ...ctxStats, compressionRatio: compressResult.stats?.savedPercent ?? 0, compressedRounds: compressResult.stats?.compressedRounds ?? 0 }

              logger.info(`[chat] 自动压缩已触发: 压缩 ${compressResult.stats?.compressedRounds ?? 0} 轮`)

              // 结构化组包·会话摘要落库：压缩产生的摘要入 RAM 常驻 + 每日 jsonl 存档
              // （摘要仅追加，历史全文仍走既有落盘，绝不删除）
              const summaryText = compressResult.stats?.summary?.trim()
              if (summaryText) {
                try {
                  sessionSummaryStore.record({
                    sessionId, // 由 getSessionId(event, request) 统一解析（前端不携带时用会话级 id）
                    source: 'compression',
                    summary: summaryText,
                    meta: { rounds: compressResult.stats?.compressedRounds, mode: compressResult.stats?.compressMode, model: modelManager.getLoadedModel()?.modelId },
                  })
                  memorySkeleton.appendNote(`会话摘要已落库（压缩 ${compressResult.stats?.compressedRounds ?? 0} 轮，${compressResult.stats?.compressMode ?? 'summary'} 模式）`)
                } catch (recErr) {
                  logger.warn('[chat] 会话摘要落库失败（不影响主流程）:', recErr)
                }
              }

            }

          } catch (compressErr) {

            // 压缩失败不阻断主流程

            logger.warn('[chat] checkAndCompress 失败，继续使用原上下文:', compressErr)

          }

          processedMessages = ctxMessages.map(m => ({ id: `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, role: m.role, content: m.content }))

          contextStats = ctxStats

          if (contextStats && memoryItems.length > 0) {

            contextStats.memoryInjected = true

            contextStats.memoryCount = memoryItems.length

          }

          if (win) {

            try {

              // 映射为渲染层 ContextIndicator 的 schema：
              // totalTokens=窗口上限(maxTokens)、usedTokens=已用总量(totalTokens)、
              // currentInputTokens=本轮输入(currentTokens)。避免渲染端 0% 假显示。
              const rendererStats = ctxStats ? {
                totalTokens: ctxStats.maxTokens ?? 0,
                usedTokens: ctxStats.totalTokens ?? 0,
                systemTokens: ctxStats.systemTokens ?? 0,
                memoryTokens: ctxStats.memoryTokens ?? 0,
                historyTokens: ctxStats.historyTokens ?? 0,
                currentInputTokens: ctxStats.currentTokens ?? 0,
                compressedRounds: ctxStats.compressedRounds ?? 0,
                compressionRatio: ctxStats.compressionRatio ?? 0,
              } : ctxStats

              win.webContents.send('chat:context-stats', rendererStats)

            } catch { /* pipe broken */ }

          }

        } catch (ctxErr) {

          logger.warn('[info]', ctxErr)

          processedMessages = request.messages

        }

      } else if (memoryItems.length > 0) {

        const memoryText = memoryItems

          .sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0))

          .map((item: any) => `[记忆 ${item.id || ''}]: ${item.content}`)

          .join('\n')

        if (memoryText) {

          const memoryMessage: ChatMessage = { id: 'memory-context', role: 'system', content: `[Context Memory]:\n${memoryText}` }

          const sysIdx = request.messages.findIndex(m => m.role === 'system')

          if (sysIdx >= 0) {

            processedMessages = [

              ...request.messages.slice(0, sysIdx + 1),

              memoryMessage,

              ...request.messages.slice(sysIdx + 1),

            ]

          } else {

            processedMessages = [memoryMessage, ...request.messages]

          }

        }

      }

      // ===== 大修任务7：对话「查XXX」自动走内置浏览器搜索链路 =====
      // #修复4 意图化联网：搜索触发从「前缀指令」升级为「意图判定」——
      // 前缀指令（查/搜/搜索等）仍强触发，同时按关键词启发式识别自然问句
      // （天气/时间/新闻/股价/附近/最新/实时 等），命中则聚合多引擎搜索把结果
      // 注入推理上下文；搜索失败/无结果静默降级为本地推理，不阻断主流程。
      // 识图根因修复(F批)：多模态图片消息的 content 是内容数组，直接 .trim() 会触发
      // "(intermediate value) ''.trim is not a function" 崩溃；先用 extractTextContent 提取纯文本再 trim
      const trimmedUser = extractTextContent(request.messages[request.messages.length - 1]?.content).trim()
      const SEARCH_PREFIX_RE = /^(查|搜|搜索|查找|查询|查一下|查查|搜一下|帮我查|帮我搜|百度一下|搜搜)[:：,]?\s*/
      const SEARCH_INTENT_KEYWORDS = [
        '天气', '气温', '温度', '几点', '时间', '日期', '今天', '明天', '新闻', '资讯',
        '股票', '股价', '行情', '涨停', '汇率', '美元', '黄金', '油价', '附近', '周边',
        '最新', '实时', '热点', '热搜', '八卦', '赛事', '比分', '排名', '多少号', '几点开始',
        '发生了', '怎么样', '什么情况', '啥情况', '怎么回事', '最近', '怎么样',
      ]
      const hasPrefixIntent = SEARCH_PREFIX_RE.test(trimmedUser)
      const hasKeywordIntent = SEARCH_INTENT_KEYWORDS.some(k => trimmedUser.includes(k))
      const hasSearchIntent = (hasPrefixIntent || hasKeywordIntent) && trimmedUser.length > 1
      let webSearchContext: { text: string; sources: { title: string; url: string }[]; imageUrl?: string; videoUrl?: string } | null = null
      if (hasSearchIntent) {
        try {
          // 查询词提炼：取首句（去除指令/追问句），再去掉搜索缀词与意图填充词
          const firstSentence = (trimmedUser.split(/[。！？!?；;\n]/)[0] || trimmedUser).trim()
          const query = firstSentence
            .replace(SEARCH_PREFIX_RE, '')
            .replace(/请|麻烦|帮我|帮忙|给我|我要|我想|想|直接|告诉|一下|谢谢|多谢/g, '')
            .replace(/[，,：:、\s]+$/g, '')
            .trim() || firstSentence
          const searchQuery = query.slice(0, 80)
          const engines = (['bing', 'baidu', 'duckduckgo'] as string[])
            .map(id => getEngineById(id))
            .filter(Boolean) as any[]
          if (engines.length > 0) {
            const agg = await aggregateSearch(searchQuery, engines, { timeoutPerEngine: 8000, maxResultsPerEngine: 8 })
            const results: any[] = (agg?.results || []) as any[]
            if (results.length > 0) {
              const top = results.slice(0, 8)
              webSearchContext = {
                text: top
                  .map((r, i) => `${i + 1}. [${(r.title || r.url || '结果' + (i + 1)).replace(/\n/g, ' ')}](${r.url})\n${(r.snippet || r.desc || r.content || '').replace(/\n/g, ' ').slice(0, 200)}`)
                  .join('\n'),
                sources: top.map(r => ({ title: r.title || r.url || '来源' + (top.indexOf(r) + 1), url: r.url })).filter(s => !!s.url),
              }
              logger.info(`[chat] 对话搜索命中 ${results.length} 条结果（${searchQuery}）`)
            }
          }
          // D9-4：联网能搜图/视频并给链接 —— 用户查询含图片/视频意图时，附上
          // 真实可打开的多引擎图片/视频检索直达链接（结构化图片条目需媒体搜索 API，
          // 当前以检索入口方式提供，并引导模型在回答中给出这些入口供点击）。
          if (webSearchContext) {
            const MEDIA_INTENT_RE = /(图片|照片|图册|壁纸|截图|插画|表情包|表情图|海报|logo|头像|视频|短片|影视|预告片|直播)/i
            if (MEDIA_INTENT_RE.test(query)) {
              const escaped = encodeURIComponent(searchQuery)
              const wantImage = /图片|照片|图册|壁纸|截图|插画|表情包|表情图|海报|logo|头像|图/i.test(query)
              const wantVideo = /视频|短片|影视|预告片|直播/i.test(query)
              webSearchContext.imageUrl = wantImage ? `https://cn.bing.com/images/search?q=${escaped}` : undefined
              webSearchContext.videoUrl = wantVideo ? `https://cn.bing.com/videos/search?q=${escaped}` : undefined
            }
          }
        } catch (searchErr) {
          logger.warn('[chat] 对话搜索失败（忽略，继续本地推理）:', searchErr)
        }
      }
      if (webSearchContext) {
        const lastIdx = processedMessages.length - 1
        const lastMsg = processedMessages[lastIdx]
        // 强化引导：已有联网结果时直接基于结果作答，禁止绕道调用搜索/天气类工具
        let searchPrompt = `\n\n[联网搜索结果已注入。请直接根据上面的搜索结果回答用户刚才的问题，回答末尾用 Markdown 列表列出引用来源（- [标题](链接)）。不要编造结果中不存在的信息，也不要调用任何搜索/天气/网页工具，基于本段结果作答即可]\n${webSearchContext.text}`
        if (webSearchContext.imageUrl || webSearchContext.videoUrl) {
          const mediaLines: string[] = []
          if (webSearchContext.imageUrl) mediaLines.push(`- 图片检索：${webSearchContext.imageUrl}`)
          if (webSearchContext.videoUrl) mediaLines.push(`- 视频检索：${webSearchContext.videoUrl}`)
          searchPrompt += `\n\n[用户需要图片/视频内容。以下为可打开的多引擎图片/视频检索直达链接，请在回答中一并给出并以「图片检索」「视频检索」命名：\n${mediaLines.join('\n')}]`
        }
        if (lastMsg && lastMsg.role === 'user') {
          processedMessages = [
            ...processedMessages.slice(0, lastIdx),
            { ...lastMsg, content: `${lastMsg.content}${searchPrompt}` },
          ]
        } else {
          processedMessages = [...processedMessages, { id: 'web-search-context', role: 'user', content: searchPrompt.trim() }]
        }
      }

      // ===== #1 修复：合并多条 system 消息为一条 =====
      // 根因：本地 llama-server(Qwopus3.5-9B, --jinja) 对含多条 system 消息的请求体
      // 会触发 chat template 解析失败返回 400（"Unable to generate parser for this template"）。
      // 真实链路（buildContext + memory 注入）会拼出 2~3 条 system 消息，导致本地推理 400。
      // 此处统一把 system 消息聚合成一条（内容按序拼接），其余角色消息顺序不变。
      const systemMsgs = processedMessages.filter((m: any) => m.role === 'system')
      const nonSystemMsgs = processedMessages.filter((m: any) => m.role !== 'system')
      if (systemMsgs.length > 1) {
        const mergedContent = systemMsgs
          .map((m: any) => (typeof m.content === 'string' ? m.content : String(m.content ?? '')))
          .filter((s: string) => s.length > 0)
          .join('\n\n')
        processedMessages = [
          { ...systemMsgs[0], id: 'merged-system', content: mergedContent },
          ...nonSystemMsgs,
        ]
        logger.info(`[chat] #1 合并 ${systemMsgs.length} 条 system 消息为 1 条，避免本地模板解析 400`)
      }

      // ===== #修复2 工具能力注入：组装控制工具清单，白名单校验后透传 provider =====
      // 工具注入与具体模型无关：toolRegistry 注册的系统命令/浏览器/视觉操控等工具
      // 统一转成 FunctionCallingTool schema（name/description/parameters），随请求体
      // 一并发送；前端可携带已注册工具名白名单（request.tools），未注册/未知名称被过滤。
      let functionTools: FunctionCallingTool[] | undefined
      try {
        const whitelist = Array.isArray(request.tools) && request.tools.length > 0 ? request.tools : undefined
        let allTools = toolRegistry.getFunctionCallingTools(whitelist)
        if (allTools && allTools.length > 0) {
          // 联网结果已注入时，剔除搜索/天气/网页抓取类工具，避免模型绕道再搜
          if (webSearchContext) {
            const excludedSearchTools = new Set(['get_weather', 'web_search', 'fetch_webpage', 'get_news', 'get_exchange_rate'])
            allTools = allTools.filter(t => !excludedSearchTools.has(t.function.name))
          }
          functionTools = allTools
          logger.info(`[chat] 注入工具能力 ${allTools.length} 个（${whitelist ? '白名单' : '全量'}）: ${allTools.map(t => t.function.name).join(', ')}`)
        }
      } catch (toolErr) {
        logger.warn('[chat] 工具清单组装失败，本次请求不带 tools:', toolErr)
        functionTools = undefined
      }

      // ===== #修复3 滑动窗口截断：不再全量发送全部历史 =====
      // 按实际窗口（已 setMaxTokens 对齐）保留 system + 最近若干轮 + 当前消息
      try {
        const maxTokens = contextWindowManager.getStats().maxTokens || 4096
        processedMessages = truncateToWindow(processedMessages, maxTokens)
      } catch (truncErr) {
        logger.warn('[chat] 滑动截断失败，保持原上下文:', truncErr)
      }

      if (request.stream) {

        // 注册 Map 便于 chat:stop 中止

        const abortController = new AbortController()

        streamAbortControllers.set(sessionId, abortController)

        let fullResponse = ''
        let streamError: { stopped: boolean; message: string } | null = null

        // 非空引用（TS 闭包收窄）：provider 在上方已确保存在，此处固化供工具闭环使用
        const activeProvider: LLMProvider = provider

        try {
          // 工具调用闭环：模型返回 tool_calls 时执行工具并将结果回填，再让模型基于结果产出正文。
          // 发布级修复——此前 model 返回的 open_software 等 tool_calls 被流式层静默丢弃，
          // 导致「打开微信」等命令只有思考、无正文、工具从未执行。
          const MAX_TOOL_ROUNDS = 3
          let toolRounds = 0
          let workMessages = processedMessages

          const runModelStream = async (): Promise<void> => {
            // 每轮最多 120s
            const timeoutPromise = new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error('生成超时（120 秒）')), 120000)
            })
            // 用可变对象中转，规避 TS 对闭包捕获变量的控制流收窄（never 联合）
            const pending: { calls: Array<{ id: string; name: string; arguments: string }> | null } = { calls: null }
            const streamPromise = activeProvider.generateStream(
              workMessages,
              (chunk: string) => {
                fullResponse += chunk
                try { win?.webContents.send('chat:stream', { kind: 'content', chunk, done: false, sessionId }) } catch { /* pipe broken */ }
              },
              abortController.signal,
              (reasoning: string) => {
                // M-3 修复：推理内容独立事件流，渲染层折叠展示思考过程
                try { win?.webContents.send('chat:stream', { kind: 'reasoning', chunk: reasoning, done: false, sessionId }) } catch { /* pipe broken */ }
              },
              functionTools,
              (calls: ToolCallRequest[]) => { pending.calls = calls }
            )
            await Promise.race([streamPromise, timeoutPromise])

            // 模型请求了工具调用 -> 执行并回填，继续下一轮
            if (pending.calls && pending.calls.length > 0 && toolRounds < MAX_TOOL_ROUNDS) {
              toolRounds++
              const toolCalls = pending.calls
              pending.calls = null
              logger.info(`[chat] 第 ${toolRounds} 轮工具调用: ${toolCalls.map(c => `${c.name}(${c.arguments})`).join('; ')}`)
              const roundsReport: string[] = []
              for (const tc of toolCalls) {
                let params: Record<string, unknown> = {}
                try { params = tc.arguments ? JSON.parse(tc.arguments) : {} } catch { params = { raw: tc.arguments } }
                const toolResult = await toolRegistry.execute(tc.name, params)
                const preview = toolResult.success
                  ? (typeof toolResult.data === 'string' ? toolResult.data.slice(0, 240) : JSON.stringify(toolResult.data ?? '').slice(0, 240))
                  : (toolResult.error || '执行失败')
                const reportLine = `[工具 ${tc.name} ${toolResult.success ? '执行成功' : '执行失败'}] ${preview}`
                roundsReport.push(reportLine)
                const streamChunk = `\n> ${reportLine}\n`
                fullResponse += streamChunk
                try { win?.webContents.send('chat:stream', { kind: 'content', chunk: streamChunk, done: false, sessionId }) } catch { /* pipe broken */ }
              }
              // 把工具执行结果作为上下文追加，让模型基于结果生成最终回复
              workMessages = [
                ...workMessages,
                { id: `toolctx-${Date.now()}`, role: 'user', content: `[工具执行结果]\n${roundsReport.join('\n')}\n请基于以上结果用自然语言简洁回复用户（若工具已成功完成用户指令，直接告知结果即可，不要重复描述机制）。` },
              ]
              return runModelStream()
            }
          }

          await runModelStream()

        } catch (streamErr: any) {
          const aborted = abortController.signal.aborted
          const errMsg = streamErr?.message || String(streamErr)

          // 大修：云端调用失败（无效 Key / 402 余额不足 / 网络错误）且尚未输出任何内容时，
          // 先走 failover 切备选云端 provider（§4.2-1），仍失败再回退本地模型保真；
          // 超时或已输出部分内容则不回退（避免重复/加重延迟）
          let fallbackDone = false
          if (!aborted && isApiProvider && fullResponse.length === 0 && !errMsg.includes('超时')) {
            // 阶段 1：云端 failover（切备选 provider）
            const chain = resolveCloudFailoverChain(activeProviderId || '')
            const next = chain.find(c => c.id !== (activeProviderId || ''))
            if (next) {
              try {
                logger.warn(`[chat] 主云端 provider 失败，failover 切备选: ${next.name}/${next.model}`)
                const backupProvider = createProviderFromChainEntry(next)
                const backupController = new AbortController()
                streamAbortControllers.set(sessionId, backupController)
                await backupProvider.generateStream(
                  processedMessages,
                  (chunk: string) => {
                    fullResponse += chunk
                    try { win?.webContents.send('chat:stream', { kind: 'content', chunk, done: false, sessionId }) } catch { /* pipe broken */ }
                  },
                  backupController.signal,
                  (reasoning: string) => {
                    try { win?.webContents.send('chat:stream', { kind: 'reasoning', chunk: reasoning, done: false, sessionId }) } catch { /* pipe broken */ }
                  },
                  functionTools
                )
                streamAbortControllers.delete(sessionId)
                fallbackDone = true
                logger.info(`[chat] failover 备选云端完成回答: ${next.name}/${next.model}`)
              } catch (backupErr: any) {
                streamAbortControllers.delete(sessionId)
                logger.warn('[chat] 备选云端 failover 也失败，回退本地:', backupErr)
              }
            }
            // 阶段 2：本地回退
            if (!fallbackDone) {
              logger.warn(`[chat] 云端模型调用失败，自动回退本地模型: ${errMsg}`)
              try {
                const localProvider = await ensureLocalProvider()
                if (localProvider) {
                  const fallbackController = new AbortController()
                  streamAbortControllers.set(sessionId, fallbackController)
                  await localProvider.generateStream(
                    processedMessages,
                    (chunk: string) => {
                      fullResponse += chunk
                      try { win?.webContents.send('chat:stream', { kind: 'content', chunk, done: false, sessionId }) } catch { /* pipe broken */ }
                    },
                    fallbackController.signal,
                    (reasoning: string) => {
                      try { win?.webContents.send('chat:stream', { kind: 'reasoning', chunk: reasoning, done: false, sessionId }) } catch { /* pipe broken */ }
                    },
                    functionTools
                  )
                  streamAbortControllers.delete(sessionId)
                  fallbackDone = true
                  logger.info('[chat] 已自动回退本地模型完成回答（云端保真回退）')
                }
              } catch (fallbackErr: any) {
                streamAbortControllers.delete(sessionId)
                logger.warn('[chat] 本地回退也失败:', fallbackErr)
                streamError = {
                  stopped: false,
                  message: `云端调用失败：${errMsg}；本地回退也失败：${fallbackErr?.message || fallbackErr}`,
                }
              }
            }
          }

          if (!fallbackDone && !streamError) {
            streamError = {
              stopped: aborted,
              message: aborted ? '已停止' : errMsg,
            }
          }
        } finally {

          // done:true 放在 finally 中，保证任何情况都通知渲染层结束

          streamAbortControllers.delete(sessionId)

          try { win?.webContents.send('chat:stream', { chunk: '', done: true, sessionId }) } catch { /* pipe broken */ }

        }

        if (streamError) {

          if (!streamError.stopped) {
            logger.warn('[chat] stream ended with error:', streamError.message)
          }
          return { success: false, stopped: streamError.stopped, error: streamError.message }
        }

        // 大修任务7：模型未列出来源时，由主进程补充来源链接（防遗漏、保真）
        if (webSearchContext && webSearchContext.sources.length > 0) {
          const hasSource = webSearchContext.sources.some(s => s.url && fullResponse.includes(s.url))
          if (!hasSource) {
            const sourcesMd = webSearchContext.sources.map(s => `- [${(s.title || s.url).replace(/[\[\]]/g, '')}](${s.url})`).join('\n')
            fullResponse += `\n\n**来源：**\n${sourcesMd}`
          }
        }

        // 对话成功后更新模型 lastUsed

        try {

          const loaded = modelManager.getLoadedModel()

          if (loaded) {

            modelManager.updateModelUsage(loaded.modelId)

          }

        } catch { logger.error('[chat] Failed to update model usage (hybrid)') }

        if (quotaTracker && isApiProvider && activeProviderId) {

          try {

            const estimatedTokens = Math.ceil(fullResponse.length / 2)

            quotaTracker.trackUsage(activeProviderId, estimatedTokens)

          } catch { logger.warn('[chat] Failed to track API quota') }

        }

        // v12.2 云端用量记账（估算 tokens，余量监控用）

        if (useCloud && activeProviderId) {

          try {

            const promptTokens = cloudQuota.estimateTokens(processedMessages.map(m => extractTextContent(m.content)).join('\n'))

            const completionTokens = cloudQuota.estimateTokens(fullResponse)

            cloudQuota.recordUsage(activeProviderId, promptTokens, completionTokens)

          } catch (e) { logger.warn('[chat] cloudQuota 记录失败:', e) }

        }

        // v12.2 视觉推理完成后切回主模型（用完切回）

        if (modelManager.getGpuModelType() === 'vision') {

          modelManager.swapToMain().catch(e => logger.warn('[chat] 切回主模型失败:', e))

        }

        // P0-2 记忆落盘：对话写入跨会话历史（流式路径）

        try {

          if (fullResponse) {

            taskRouter.addToHistory('user', userMsg)

            taskRouter.addToHistory('assistant', fullResponse)

          }

        } catch { logger.warn('[chat] 记忆落盘失败（流式）') }

        return { success: true, content: fullResponse }

      } else {

        const response = await provider.generate(processedMessages, functionTools)

        try {

          const loaded = modelManager.getLoadedModel()

          if (loaded) {

            modelManager.updateModelUsage(loaded.modelId)

          }

        } catch { logger.error('[chat] Failed to update model usage (direct)') }

        if (quotaTracker && isApiProvider && activeProviderId) {

          try {

            const estimatedTokens = Math.ceil(response.length / 2)

            quotaTracker.trackUsage(activeProviderId, estimatedTokens)

          } catch { logger.warn('[chat] Failed to track API quota') }

        }

        // v12.2 云端用量记账（估算 tokens，余量监控用）

        if (useCloud && activeProviderId) {

          try {

            const promptTokens = cloudQuota.estimateTokens(processedMessages.map(m => extractTextContent(m.content)).join('\n'))

            const completionTokens = cloudQuota.estimateTokens(response)

            cloudQuota.recordUsage(activeProviderId, promptTokens, completionTokens)

          } catch (e) { logger.warn('[chat] cloudQuota 记录失败:', e) }

        }

        // v12.2 视觉推理完成后切回主模型（用完切回）

        if (modelManager.getGpuModelType() === 'vision') {

          modelManager.swapToMain().catch(e => logger.warn('[chat] 切回主模型失败:', e))

        }

        // P0-2 记忆落盘：对话写入跨会话历史（非流式路径）

        try {

          if (response) {

            taskRouter.addToHistory('user', userMsg)

            taskRouter.addToHistory('assistant', response)

          }

        } catch { logger.warn('[chat] 记忆落盘失败（非流式）') }

        // v2.0 本地与 API 统一走 generate

        return { success: true, content: response }

      }

    } catch (error) {

      logger.error('[chat] chat:send failed', error)

      streamAbortControllers.delete(sessionId)

      return { success: false, stopped: false, error: (error as Error)?.message || String(error) }

    }

  })

  // v11.3 Agent 对话通道（多步工具调用）

  ipcMain.handle('chat:send-agent', async (event, request: ChatRequest) => {

    // IPC caller authorization check
    if (!isAppRenderer(event)) {
      logger.warn('[chat] Unauthorized caller', event.sender.id)
      return { error: 'unauthorized caller' }
    }

    // Input validation
    if (request.messages && request.messages.length > 100) {
      return { error: 'Message count cannot exceed 100' }
    }

    for (const msg of request.messages || []) {
      if (typeof msg.content === 'string' && msg.content.length > 131072) {
        return { error: 'Message content exceeds 128KB limit' }
      }
    }

    const win = BrowserWindow.fromWebContents(event.sender)

    try {

      // 构造 Agent 输入

      const agentInput: AgentInput = {

        messages: (request.messages || []).map(m => ({

          role: m.role as 'system' | 'user' | 'assistant',

          content: m.content,

        })),

        stream: request.stream ?? true,

        maxSteps: 15,

      }

      const agent = new ReActAgent({ verbose: true })

      const agentSessionId = request.id || `${event.sender.id}-${Date.now()}`

      const agentId = agent.id

      let fullResponse = ''

      for await (const evt of agent.run(agentInput)) {

        switch (evt.type) {

          case 'thinking':

            if (win && request.stream) {

              try {

                win.webContents.send('chat:stream', {

                  chunk: `[思考中 ${evt.content.slice(0, 200)}...\n`,

                  done: false,

                  sessionId: agentSessionId,

                })

              } catch { /* pipe broken */ }

            }

            break

          case 'tool_call':

            if (win && request.stream) {

              try {

                win.webContents.send('chat:stream', {

                  chunk: `[调用工具: ${evt.tool}]\n`,

                  done: false,

                  sessionId: agentSessionId,

                })

              } catch { /* pipe broken */ }

            }

            break

          case 'tool_result':

            if (evt.result.success) {

              fullResponse += `[工具 ${evt.tool} 执行成功]\n`

            } else {

              fullResponse += `[工具 ${evt.tool} 执行失败: ${evt.result.error}]\n`

            }

            break

          case 'response':

            if (evt.isFinal) {

              fullResponse += evt.content

              if (win && request.stream) {

                try {

                  win.webContents.send('chat:stream', {

                    chunk: evt.content,

                    done: false,

                    sessionId: agentSessionId,

                  })

                } catch { /* pipe broken */ }

              }

            }

            break

          case 'error':

            logger.error('[info]', evt.message)

            if (win) {

              try {

                win.webContents.send('chat:stream', {

                  chunk: `\n[错误: ${evt.message}]\n`,

                  done: false,

                  sessionId: agentSessionId,

                })

              } catch { /* pipe broken */ }

            }

            break

        }

      }

      // 通知渲染层流式结束

      if (win) {

        try {

          win.webContents.send('chat:stream', {

            chunk: '',

            done: true,

            sessionId: agentSessionId,

            pipelineStats: {

              stepCount: 1,

              totalApiTokens: 0,

              totalLocalTokens: 0,

            },

          })

        } catch { /* pipe broken */ }

      }

      try {

        const loaded = modelManager.getLoadedModel()

        if (loaded) {

          modelManager.updateModelUsage(loaded.modelId)

        }

      } catch { logger.error('[chat] Failed to update model usage (agent)') }

      return { success: true, content: fullResponse, agentId }

    } catch (error) {

      logger.error('[chat] chat:send-agent failed', error)

      return { success: false, stopped: false, error: (error as Error)?.message || String(error) }

    }

  })

  ipcMain.handle('chat:stop', (event, sessionId?: string) => {

    // IPC 调用者授权校验

    if (!isAppRenderer(event)) {

      logger.warn('[info]', event.sender.id)

      return { error: 'unauthorized caller' }

    }

    try {

      if (sessionId && streamAbortControllers.has(sessionId)) {

        streamAbortControllers.get(sessionId)!.abort()

        streamAbortControllers.delete(sessionId)

        return true

      }

      // Fallback: abort all

      if (!sessionId) {

        streamAbortControllers.forEach((ctrl) => ctrl.abort())

        streamAbortControllers.clear()

      }

      return true

  } catch (e) { logger.error('[chat] Stop failed', e); return false }

  })

  // 一键导出回复为文档（md / docx / pdf），弹出保存对话框后落盘
  ipcMain.handle('chat:export-document', async (event, params: { text: string; title?: string; format?: 'md' | 'docx' | 'pdf' }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const format = params.format || 'md'
    const title = (params.title || '玄枢AI回复').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
    const filters: Electron.FileFilter[] =
      format === 'docx' ? [{ name: 'Word 文档', extensions: ['docx'] }]
        : format === 'pdf' ? [{ name: 'PDF 文档', extensions: ['pdf'] }]
          : [{ name: 'Markdown 文档', extensions: ['md'] }]
    const { canceled, filePath } = await dialog.showSaveDialog(win ?? undefined!, {
      title: '导出回复为文档',
      defaultPath: `${title}.${format}`,
      filters,
    })
    if (canceled || !filePath) return { success: false, canceled: true }
    try {
      if (format === 'md') {
        fs.writeFileSync(filePath, params.text, 'utf8')
      } else if (format === 'docx') {
        writeDocx(filePath, title, params.text)
      } else {
        await writePdf(filePath, title, params.text)
      }
      return { success: true, filePath }
    } catch (e) {
      logger.error('[chat] Export document failed', e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

}

/* ========== 回复一键导出文档（MD / DOCX / PDF） ========== */

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Markdown 文本 → docx 段落/表格 XML（轻量实现：标题加粗、代码块等宽、表格转 w:tbl） */
function mdToDocxXml(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let inCode = false
  let i = 0
  const pushPara = (content: string, bold = false, code = false, heading = false) => {
    const style = heading ? 'Heading1' : code ? 'CodeBlock' : bold ? 'StrongText' : 'Normal'
    out.push(`<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(content)}</w:t></w:r></w:p>`)
  }
  while (i < lines.length) {
    const line = lines[i]
    const t = line.trim()
    if (t.startsWith('```')) {
      if (inCode) { inCode = false } else { inCode = true }
      i++
      continue
    }
    if (inCode) {
      pushPara(line, false, true)
      i++
      continue
    }
    // 表格
    if (t.startsWith('|') && t.endsWith('|') && i + 1 < lines.length && /^[\s:\-|]+$/.test(lines[i + 1].trim())) {
      const headers = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim())
      i += 2
      const rows: string[][] = []
      while (i < lines.length) {
        const r = lines[i].trim()
        if (!(r.startsWith('|') && r.endsWith('|'))) break
        rows.push(r.replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim()))
        i++
      }
      out.push(`<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="999999"/><w:left w:val="single" w:sz="4" w:color="999999"/><w:bottom w:val="single" w:sz="4" w:color="999999"/><w:right w:val="single" w:sz="4" w:color="999999"/><w:insideH w:val="single" w:sz="4" w:color="999999"/><w:insideV w:val="single" w:sz="4" w:color="999999"/></w:tblBorders></w:tblPr>`)
      out.push(`<w:tr>${headers.map(h => `<w:tc><w:tcPr><w:shd w:val="clear" w:fill="EEEEEE"/></w:tcPr><w:p><w:pPr><w:pStyle w:val="StrongText"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(h)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`)
      for (const row of rows) {
        out.push(`<w:tr>${row.map(c => `<w:tc><w:p><w:r><w:t xml:space="preserve">${escapeXml(c)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`)
      }
      out.push('</w:tbl>')
      continue
    }
    // 标题
    const h = t.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      pushPara(h[2], true, false, true)
      i++
      continue
    }
    // 引用
    if (t.startsWith('>')) {
      pushPara(t.replace(/^>\s?/, ''))
      i++
      continue
    }
    if (!t) {
      out.push('<w:p/>')
      i++
      continue
    }
    const bold = /^\*\*.*\*\*$/.test(t) || /^【.+】/.test(t)
    pushPara(line, bold)
    i++
  }
  return out.join('')
}

function writeDocx(filePath: string, title: string, text: string): void {
  const body = mdToDocxXml(text)
  const zip = new AdmZip()
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`))
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`))
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`))
  zip.addFile('word/styles.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="StrongText"><w:name w:val="strong"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="CodeBlock"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="20"/><w:shd w:val="clear" w:fill="F2F2F2"/></w:rPr></w:style>
</w:styles>`))
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(title)}</w:t></w:r></w:p>
${body}
<w:sectPr/></w:body></w:document>`))
  zip.writeZip(filePath)
}

async function writePdf(filePath: string, title: string, text: string): Promise<void> {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:'Microsoft YaHei',sans-serif;padding:32px;color:#222;line-height:1.7}
h1{font-size:22px;border-bottom:1px solid #ddd;padding-bottom:8px}
pre{white-space:pre-wrap;word-break:break-word;font-family:'Microsoft YaHei',monospace;font-size:13px}
code{font-family:Consolas,monospace;font-size:12px;background:#f4f4f4;padding:1px 4px;border-radius:4px}
pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%;margin:8px 0}
th,td{border:1px solid #bbb;padding:6px 10px;font-size:13px;text-align:left}
th{background:#f0f0f0}
</style></head><body>${escapeXmlHtml(text, title)}</body></html>`
  const hidden = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  try {
    await hidden.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    const pdf = await hidden.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 } })
    fs.writeFileSync(filePath, pdf)
  } finally {
    if (!hidden.isDestroyed()) hidden.destroy()
  }
}

/** 简单 Markdown → HTML（PDF 用；代码块/表格/标题/粗体） */
function escapeXmlHtml(text: string, title: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const lines = text.split('\n')
  const out: string[] = [`<h1>${esc(title)}</h1>`]
  let inCode = false
  let codeBuf: string[] = []
  let i = 0
  while (i < lines.length) {
    const t = lines[i].trim()
    if (t.startsWith('```')) {
      if (inCode) {
        out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`)
        codeBuf = []
        inCode = false
      } else {
        inCode = true
      }
      i++
      continue
    }
    if (inCode) { codeBuf.push(lines[i]); i++; continue }
    if (t.startsWith('|') && t.endsWith('|') && i + 1 < lines.length && /^[\s:\-|]+$/.test(lines[i + 1].trim())) {
      const headers = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim())
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        rows.push(lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim()))
        i++
      }
      out.push(`<table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      continue
    }
    const h = t.match(/^(#{1,6})\s+(.*)$/)
    if (h) { out.push(`<h${Math.min(h[1].length, 4)}>${esc(h[2])}</h${Math.min(h[1].length, 4)}>`); i++; continue }
    if (t.startsWith('>')) { out.push(`<p style="border-left:3px solid #ccc;padding-left:10px;color:#666">${esc(t.replace(/^>\s?/, ''))}</p>`); i++; continue }
    if (!t) { i++; continue }
    let line = esc(lines[i])
    line = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    line = line.replace(/`([^`]+)`/g, '<code>$1</code>')
    out.push(`<p>${line}</p>`)
    i++
  }
  return out.join('\n')
}

