import { ipcMain, BrowserWindow } from 'electron'

import { LLMProviderRegistry } from '../llm/provider-registry'

import { getStore } from './config.ipc'

import { LLMProvider } from '../llm/provider'

import { modelManager } from '../model-manager'

import { taskRouter } from '../task-router'

import { RouteSignal, TierResult } from '../task-router/signals'

import { logger } from '../../shared/logger'
import { emotionEngine } from '../persona/emotion-engine'
import { sendToWindow } from '../utils/broadcast'

import { ReActAgent } from '../agent/react-loop'

import { AgentInput } from '../agent/types'

import { ContextWindowManager } from '../context-window/manager'
import { ConversationCompressor } from '../context-window/compressor'
import { apiQuotaTracker as quotaTracker } from '../api-quota-tracker'
import { setFloatingBallEmotion } from '../floating-ball'
import * as ragModule from '../rag/index'
import { cloudQuota } from '../cloud-quota'
import { localAiScanner } from '../local-ai-scanner'

const contextWindowManager = new ContextWindowManager()
const conversationCompressor = new ConversationCompressor()

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

}

// [comment]

class SafeAbortRegistry {

  private controllers: Map<string, AbortController> = new Map()

  set(sessionId: string, ctrl: AbortController): void {

// [comment]

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

// [comment]

  return request.id || `${event.sender.id}-${Date.now()}`

}

// [comment]

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
    const { tandemManager } = await import('../tandem-manager')
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

// [comment]

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

// [comment]

 */

function buildRouteSignal(request: ChatRequest): RouteSignal {

  const messages = request.messages || []

  const last = messages[messages.length - 1]

  const text = typeof last?.content === 'string' ? last.content : ''

// [comment]

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

// [comment]

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

      // 情感拟人化：识别用户当前情绪，广播到主界面并驱动悬浮球着色
      try {
        const lastMsg = request.messages[request.messages.length - 1]?.content
        if (typeof lastMsg === 'string' && lastMsg.trim()) {
          const emotion = emotionEngine.observeUserText(lastMsg)
          sendToWindow(win, 'emotion:state', emotion)
          try {
            if (typeof setFloatingBallEmotion === 'function') setFloatingBallEmotion(emotion.color ?? null)
          } catch { /* 悬浮球未启用时可忽略 */ }
        }
      } catch (emoErr) {
        logger.debug('[chat] emotion observe failed', emoErr)
      }

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

      let useCloud = false

      const isConfiguredCloud = !!activeProviderId && activeProviderId !== '__local_cpu__' && activeProviderId !== '__local_sglang__'

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
                apiKey: cfg.apiKey,
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

      let processedMessages: ChatMessage[] = request.messages

      let contextStats: any = null

// [comment]

// [comment]

      const userMsg = request.messages[request.messages.length - 1]?.content || ''

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

      if (request.messages.length > 1) {

        try {

          const systemPrompt = request.messages.find(m => m.role === 'system')?.content || ''

          const result = contextWindowManager.buildContext(

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

              win.webContents.send('chat:context-stats', contextStats)

            } catch { /* pipe broken */ }

          }

        } catch (ctxErr) {

          logger.warn('[info]', ctxErr)

          processedMessages = request.messages

        }

      } else if (memoryItems.length > 0) {

// [comment]

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

// [comment]

      if (request.stream) {

        // 注册 Map 便于 chat:stop 中止

        const abortController = new AbortController()

        streamAbortControllers.set(sessionId, abortController)

        let fullResponse = ''
        let streamError: { stopped: boolean; message: string } | null = null

        try {

          const streamPromise = provider.generateStream(

            processedMessages,

            (chunk: string) => {

              fullResponse += chunk

              try { win?.webContents.send('chat:stream', { chunk, done: false, sessionId }) } catch { /* pipe broken */ }

            },

            abortController.signal

          )

          const timeoutPromise = new Promise<never>((_, reject) => {

            setTimeout(() => reject(new Error('生成超时（120 秒）')), 120000)

          })

          await Promise.race([streamPromise, timeoutPromise])

        } catch (streamErr: any) {

          const aborted = abortController.signal.aborted

          streamError = {
            stopped: aborted,
            message: aborted ? '已停止' : (streamErr?.message || String(streamErr)),
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

        // 对话成功后更新模型 lastUsed

        try {

          const loaded = modelManager.getLoadedModel()

          if (loaded) {

            modelManager.updateModelUsage(loaded.modelId)

          }

        } catch { logger.error('[chat] Failed to update model usage (hybrid)') }

// [comment]

        if (quotaTracker && isApiProvider && activeProviderId) {

          try {

            const estimatedTokens = Math.ceil(fullResponse.length / 2)

            quotaTracker.trackUsage(activeProviderId, estimatedTokens)

          } catch { logger.warn('[chat] Failed to track API quota') }

        }

        // v12.2 云端用量记账（估算 tokens，余量监控用）

        if (useCloud && activeProviderId) {

          try {

            const promptTokens = cloudQuota.estimateTokens(processedMessages.map(m => m.content).join('\n'))

            const completionTokens = cloudQuota.estimateTokens(fullResponse)

            cloudQuota.recordUsage(activeProviderId, promptTokens, completionTokens)

          } catch (e) { logger.warn('[chat] cloudQuota 记录失败:', e) }

        }

// [comment]

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

        const response = await provider.generate(processedMessages)

// [comment]

        try {

          const loaded = modelManager.getLoadedModel()

          if (loaded) {

            modelManager.updateModelUsage(loaded.modelId)

          }

        } catch { logger.error('[chat] Failed to update model usage (direct)') }

// [comment]

        if (quotaTracker && isApiProvider && activeProviderId) {

          try {

            const estimatedTokens = Math.ceil(response.length / 2)

            quotaTracker.trackUsage(activeProviderId, estimatedTokens)

          } catch { logger.warn('[chat] Failed to track API quota') }

        }

        // v12.2 云端用量记账（估算 tokens，余量监控用）

        if (useCloud && activeProviderId) {

          try {

            const promptTokens = cloudQuota.estimateTokens(processedMessages.map(m => m.content).join('\n'))

            const completionTokens = cloudQuota.estimateTokens(response)

            cloudQuota.recordUsage(activeProviderId, promptTokens, completionTokens)

          } catch (e) { logger.warn('[chat] cloudQuota 记录失败:', e) }

        }

// [comment]

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

// [comment]

      for await (const evt of agent.run(agentInput)) {

        switch (evt.type) {

          case 'status':

            if (win) {

              try {

                win.webContents.send('chat:stream-step', {

                  stepIndex: 0,

                  modelType: 'agent',

                  content: evt.message,

                })

              } catch { /* pipe broken */ }

            }

            break

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

// [comment]

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

}
