import { logger } from '../../shared/logger'
import { getStore } from '../ipc/config.ipc'
import { cpuInferenceEngine } from '../inference/cpu-engine'
import { modelManager } from '../model-manager'
import { createProxyAgent } from '../utils/proxy-resolver'
import { memorySkeleton, sessionSummaryStore } from '../context-window/structured-memory'

/** 各 Provider 网络请求超时（毫秒） */
const REQUEST_TIMEOUT = 60_000
const LIST_TIMEOUT = 10_000

/** 本地回环地址不注入代理，避免误走系统代理 */
function isLoopbackUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(url)
}

/**
 * M-3 修复：读取用户"推理过程可见"开关，默认开启（思考型本地模型输出 reasoning_content）。
 * 读取失败或未配置时按默认 true 处理，绝不因配置缺失而回退为强制关闭。
 */
function getEnableThinkingDefault(): boolean {
  try {
    const v = getStore().get('enableThinking' as never)
    return v === undefined ? true : Boolean(v)
  } catch {
    return true
  }
}

/** 带超时 + 代理注入的 fetch 封装 */
async function providerFetch(url: string, options: RequestInit = {}, timeoutMs: number = REQUEST_TIMEOUT): Promise<Response> {
  const fetchOptions: RequestInit & { dispatcher?: unknown } = {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(timeoutMs),
  }
  if (!isLoopbackUrl(url)) {
    const agent = createProxyAgent()
    if (agent) fetchOptions.dispatcher = agent
  }
  return fetch(url, fetchOptions)
}

/** 网络错误分类，转为可读中文 */
export function classifyFetchError(e: unknown, context: string): Error {
  const err = e as NodeJS.ErrnoException & { name?: string }
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || (err?.message && /timeout|timed out/i.test(err.message))) {
    return new Error(`${context}请求超时（${REQUEST_TIMEOUT / 1000}s 无响应），请检查网络或服务状态`)
  }
  const code = err?.code
  if (code === 'ECONNREFUSED') return new Error(`${context}连接被拒绝（ECONNREFUSED），请确认服务已启动或端口未被占用`)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new Error(`${context}域名解析失败（ENOTFOUND），请检查网络连接或代理设置`)
  if (code === 'ETIMEDOUT') return new Error(`${context}连接超时（ETIMEDOUT），请检查网络或服务状态`)
  if (code === 'ECONNRESET') return new Error(`${context}连接被重置（ECONNRESET），请检查网络稳定性或代理配置`)
  if (code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return new Error(`${context}TLS 证书校验失败（${code}），自签名证书需先加入系统受信任列表`)
  }
  if (err?.message) return new Error(`${context}网络请求失败: ${err.message}`)
  return new Error(`${context}网络请求失败`)
}

/**
 * 云端 API HTTP 错误分类（大修第一批 · 云端调用修复）
 * 将笼统的 "API error: 401/402" 转为可操作的中文提示：
 *   - 401/403 → Key 无效/未授权
 *   - 402     → 余额不足
 *   - 429     → 限流
 * 同时保留服务端返回的 detail 供排查。
 */
export function classifyApiHttpError(status: number, detail: string, providerName: string): Error {
  const suffix = detail ? `（服务端: ${String(detail).slice(0, 200)}）` : ''
  switch (status) {
    case 401:
    case 403:
      return new Error(`云端模型 Key 无效或未授权（HTTP ${status}）。请在模型设置中检查并更新 ${providerName} 的 API Key，或切换回本地模型。${suffix}`)
    case 402:
      return new Error(`云端余额不足（HTTP 402）。请前往 ${providerName} 平台充值后再试；玄枢已自动回退本地模型继续回答。${suffix}`)
    case 429:
      return new Error(`云端请求过于频繁（HTTP 429），请稍后重试或切换本地模型。${suffix}`)
    default:
      return new Error(`云端模型调用失败（HTTP ${status}）。${suffix}`)
  }
}

/**
 * SSE 行解析回调：每收到一行 `data: ` 事件即调用一次。
 * 返回 true 表示流已结束（收到 [DONE] 或业务层 message_stop），应停止读取。
 */
type SseLineHandler = (data: string) => boolean | void

/**
 * 共享 SSE 流式读取器 —— 消除 SGLang/OpenAI/Ollama/Anthropic 四份重复的
 * 「读 body → 拆行 → 逐 data: 行回调」样板。各 Provider 仅需提供差异化的
 * 单行解析逻辑（如何从 JSON delta 提取 content/reasoning、如何判定结束）。
 *
 * 内置：
 *   - 30s 单次 read 超时（防流卡死）
 *   - AbortSignal 支持（取消时主动 cancel reader）
 *   - buffer 跨 chunk 拆行
 */
async function consumeSseStream(
  response: Response,
  signal: AbortSignal | undefined,
  onLine: SseLineHandler,
): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body')
  const decoder = new TextDecoder()
  let buffer = ''

  if (signal) {
    signal.addEventListener('abort', () => {
      reader.cancel().catch(() => {})
    })
  }

  try {
    while (true) {
      if (signal?.aborted) break
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((_, reject) =>
          setTimeout(() => reject(new Error('流式读取超时')), 30_000),
        ),
      ])
      if (result.done) break
      buffer += decoder.decode(result.value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') return
        if (!data.trim()) continue
        if (onLine(data) === true) return
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch (e) {
      logger.error('[LLM] SSE reader release failed:', e)
    }
  }
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
}

/** OpenAI 兼容 Function Calling 工具描述（用于注入 generate/generateStream 请求体 tools 字段） */
export interface FunctionCallingTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface LLMProvider {
  id: string
  name: string
  type: string

  generate(messages: ChatMessage[], tools?: FunctionCallingTool[]): Promise<string>
  generateStream(
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    signal: AbortSignal,
    onReasoning?: (chunk: string) => void,
    tools?: FunctionCallingTool[],
    onToolCall?: (toolCalls: ToolCallRequest[]) => void
  ): Promise<void>
  listModels(): Promise<string[]>
  dispose?(): void | Promise<void>
}

/** 模型请求的工具调用描述（OpenAI 流式 tool_calls 归一化结果） */
export interface ToolCallRequest {
  id: string
  name: string
  arguments: string
}

/** 在 SSE 数据行中累积流式分片 tool_calls，返回是否以 tool_calls 结束 */
function accumulateStreamToolCalls(_data: string, parsed: any, sink: Map<number, { id: string; name: string; args: string }>): boolean {
  const choice = parsed.choices?.[0]
  if (!choice) return false
  const deltas = choice.delta?.tool_calls
  if (Array.isArray(deltas)) {
    for (const tc of deltas) {
      const idx = tc.index ?? 0
      const slot = sink.get(idx) || { id: '', name: '', args: '' }
      if (tc.id) slot.id += tc.id
      if (tc.function?.name) slot.name += tc.function.name
      if (tc.function?.arguments) slot.args += tc.function.arguments
      sink.set(idx, slot)
    }
  }
  return choice.finish_reason === 'tool_calls'
}

/* ================================================================
 * SGLangProvider — 通过 HTTP 连接本地 SGLang 服务器（端口 30000）
 * ================================================================ */
export class SGLangProvider implements LLMProvider {
  id: string
  name: string
  type = 'sglang'
  private baseUrl: string
  private model: string

  constructor(config: { id: string; name: string; baseUrl: string; model: string }) {
    this.id = config.id
    this.name = config.name
    this.baseUrl = config.baseUrl
    this.model = config.model
  }

  async generate(messages: ChatMessage[], tools?: FunctionCallingTool[]): Promise<string> {
    const response = await providerFetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: false,
        ...(tools && tools.length > 0 ? { tools } : {}),
        chat_template_kwargs: { enable_thinking: getEnableThinkingDefault() },
      })
    })
    if (!response.ok) throw new Error(`SGLang API error: ${response.status}`)
    const data = await response.json()
    const msg = data.choices[0].message
    // 思考不串位：正文为空时不再把 reasoning_content 当作正文兜底返回，
    // 避免「只有思考没有回答」时思考被直接当作最终回答；思考可见性由流式链路处理
    return msg?.content || ''
  }

  async generateStream(
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    signal: AbortSignal,
    onReasoning?: (chunk: string) => void,
    tools?: FunctionCallingTool[]
  ): Promise<void> {
    const response = await providerFetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: true,
        ...(tools && tools.length > 0 ? { tools } : {}),
        chat_template_kwargs: { enable_thinking: getEnableThinkingDefault() },
      })
    })
    if (!response.ok) throw new Error(`SGLang API error: ${response.status}`)
    await consumeSseStream(response, signal, (data) => {
      try {
        const parsed = JSON.parse(data)
        const delta = parsed.choices?.[0]?.delta
        // M-3 修复：区分推理流与正文流，分别回调，渲染层可折叠展示思考过程
        if (delta?.reasoning_content && onReasoning) onReasoning(String(delta.reasoning_content))
        if (delta?.content) onChunk(String(delta.content))
      } catch (e) {
        logger.error('[LLM] SGLang SSE JSON parse failed:', e)
      }
    })
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await providerFetch(`${this.baseUrl}/v1/models`, {}, LIST_TIMEOUT)
      if (!response.ok) return [this.model]
      const data = await response.json()
      return data.data?.map((m: { id: string }) => m.id) || [this.model]
    } catch (e) { logger.error('[LLM] SGLang listModels failed:', e); return [this.model] }
  }

  dispose(): void {
    // SGLangProvider 通过 HTTP 连接，无需特殊清理
  }
}

/* ================================================================
 * OpenAIProvider — 通用 OpenAI 兼容 API（GPT-4 / 自定义端点）
 * ================================================================ */
export class OpenAIProvider implements LLMProvider {
  id: string
  name: string
  type = 'openai'
  private baseUrl: string
  private apiKey: string
  private model: string

  constructor(config: { id: string; name: string; baseUrl: string; apiKey: string; model: string }) {
    this.id = config.id
    this.name = config.name
    this.baseUrl = config.baseUrl
    this.apiKey = config.apiKey
    this.model = config.model
  }

  async generate(messages: ChatMessage[], tools?: FunctionCallingTool[]): Promise<string> {
    // M-20 对齐修复：非流式路径同样处理 400 模板解析容错。
    // llama-server 对 chat_template_kwargs.enable_thinking 的兼容性取决于
    // 模板/版本，首请求偶发 400；本地引擎出错时读取响应体细节并在
    // 第二次重试中移除该参数，远端 OpenAI 兼容 API 不做重试避免副作用。
    let lastError: Error | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      const body: Record<string, unknown> = {
        model: this.model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: false,
        // 本地思考型模型（Qwen3.5 等）默认输出 reasoning_content，正文可能为空。
        // 显式关闭思考模式，保证 message.content 直接产出正文；远端 OpenAI 兼容 API 会忽略未知字段。
      }
      // 增量续算提速：本地 llama-server 单 slot（--parallel 1）保持 KV 前缀缓存，
      // 显式开启 cache_prompt 使连续对话复用已计算的 prompt 前缀，仅对新增 token 续算，
      // 避免每轮全量 prefill；远端 OpenAI 兼容 API 会忽略未知字段。
      if (isLoopbackUrl(this.baseUrl)) {
        body.cache_prompt = true
      }
      if (tools && tools.length > 0) {
        body.tools = tools
      }
      if (!(attempt === 1 && isLoopbackUrl(this.baseUrl))) {
        body.chat_template_kwargs = { enable_thinking: getEnableThinkingDefault() }
      }
      const response = await providerFetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body)
      })
      if (!response.ok) {
        let detail = ''
        try {
          const raw = await response.text()
          if (raw) {
            try {
              const parsed = JSON.parse(raw)
              detail = parsed?.error?.message || parsed?.error || parsed?.message || ''
            } catch { detail = raw }
          }
        } catch { detail = '' }
        const msg = classifyApiHttpError(response.status, detail, '云端 API').message
        if (response.status === 400 && attempt === 0 && isLoopbackUrl(this.baseUrl)) {
          logger.warn(`[LLM] 本地引擎 400，重试并移除 chat_template_kwargs: ${msg}`)
          lastError = new Error(msg)
          continue
        }
        throw new Error(msg)
      }
      const data = await response.json()
      const msg = data.choices[0].message
      // 思考不串位：正文为空时不再把 reasoning_content 当作正文兜底返回，
      // 避免「只有思考没有回答」时思考被直接当作最终回答；思考可见性由流式链路处理
      return msg?.content || ''
    }
    throw lastError || new Error('API error')
  }

  async generateStream(messages: ChatMessage[], onChunk: (chunk: string) => void, signal: AbortSignal, onReasoning?: (chunk: string) => void, tools?: FunctionCallingTool[], onToolCall?: (toolCalls: ToolCallRequest[]) => void): Promise<void> {
    // M-20 修复：400 模板解析容错。llama-server 对 chat_template_kwargs.enable_thinking
    // 的兼容性取决于模板/版本，首请求偶发 400；本地引擎出错时读取响应体细节并在
    // 第二次重试中移除该参数，远端 OpenAI 兼容 API 不做重试避免副作用。
    let lastError: Error | null = null
    const streamToolCalls = new Map<number, { id: string; name: string; args: string }>()
    for (let attempt = 0; attempt < 2; attempt++) {
      const body: Record<string, unknown> = {
        model: this.model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: true,
      }
      // 增量续算提速：本地 llama-server 单 slot 保持 KV 前缀缓存，显式 cache_prompt
      // 使连续对话复用已算前缀、仅增量续算，避免全量 prefill；远端 API 忽略未知字段
      if (isLoopbackUrl(this.baseUrl)) {
        body.cache_prompt = true
      }
      if (tools && tools.length > 0) {
        body.tools = tools
      }
      if (!(attempt === 1 && isLoopbackUrl(this.baseUrl))) {
        body.chat_template_kwargs = { enable_thinking: getEnableThinkingDefault() }
      }
      const response = await providerFetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        let detail = ''
        try {
          const raw = await response.text()
          if (raw) {
            try {
              const parsed = JSON.parse(raw)
              detail = parsed?.error?.message || parsed?.error || parsed?.message || ''
            } catch { detail = raw }
          }
        } catch { detail = '' }
        const msg = classifyApiHttpError(response.status, detail, '云端 API').message
        if (response.status === 400 && attempt === 0 && isLoopbackUrl(this.baseUrl)) {
          logger.warn(`[LLM] 本地引擎 400，重试并移除 chat_template_kwargs: ${msg}`)
          lastError = new Error(msg)
          continue
        }
        throw new Error(msg)
      }
      await consumeSseStream(response, signal, (data) => {
        try {
          const parsed = JSON.parse(data)
          // M-3 修复：推理内容与正文分流——reasoning_content 透传 onReasoning，
          // content 透传 onChunk；确保思考过程真实可见而非仅作正文兜底。
          const delta = parsed.choices?.[0]?.delta
          if (delta?.reasoning_content && onReasoning) onReasoning(String(delta.reasoning_content))
          if (delta?.content) onChunk(String(delta.content))
          // 工具调用捕获：模型返回 tool_calls（含流式分片）时累积并回调，供 chat 链路执行
          if (onToolCall) {
            const ended = accumulateStreamToolCalls(data, parsed, streamToolCalls)
            if (ended && streamToolCalls.size > 0) {
              const calls: ToolCallRequest[] = Array.from(streamToolCalls.values()).map(s => ({
                id: s.id || '',
                name: s.name,
                arguments: s.args,
              }))
              onToolCall(calls)
              streamToolCalls.clear()
            }
          }
        } catch (e) {
          logger.error('[LLM] OpenAI SSE JSON parse failed:', e)
        }
      })
      return
    }
    throw lastError || new Error('API error')
  }

  async listModels(): Promise<string[]> {
    const response = await providerFetch(`${this.baseUrl}/models`, { headers: { 'Authorization': `Bearer ${this.apiKey}` } }, LIST_TIMEOUT)
    if (!response.ok) return []
    const data = await response.json()
    return data.data?.map((m: { id: string }) => m.id) || []
  }

  dispose(): void {
    // OpenAIProvider 通过 HTTP 连接，无需特殊清理
  }
}

/* ================================================================
 * AnthropicProvider — Claude API (/v1/messages)
 * ================================================================ */

interface AnthropicRequestBody {
  model: string
  max_tokens: number
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  system?: string
  stream?: boolean
  tools?: Array<{
    name: string
    description: string
    input_schema: Record<string, unknown>
  }>
}

export class AnthropicProvider implements LLMProvider {
  id: string
  name: string
  type = 'anthropic'
  private baseUrl: string
  private apiKey: string
  private model: string

  constructor(config: { id: string; name: string; baseUrl: string; apiKey: string; model: string }) {
    this.id = config.id
    this.name = config.name
    this.baseUrl = config.baseUrl || 'https://api.anthropic.com'
    this.apiKey = config.apiKey || ''
    this.model = config.model || 'claude-3-opus-20240229'
  }

  async generate(messages: ChatMessage[], tools?: FunctionCallingTool[]): Promise<string> {
    const systemMsg = messages.find(m => m.role === 'system')
    const chatMsgs = messages.filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    const body: AnthropicRequestBody = {
      model: this.model,
      max_tokens: 4096,
      messages: chatMsgs,
    }
    if (systemMsg) body.system = systemMsg.content
    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        name: t.function.name,
        description: t.function.description || '',
        input_schema: t.function.parameters,
      }))
    }

    const response = await providerFetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw classifyApiHttpError(response.status, errText, 'Anthropic')
    }
    const data = await response.json()
    return data.content?.[0]?.text || ''
  }

  async generateStream(messages: ChatMessage[], onChunk: (chunk: string) => void, signal: AbortSignal, _onReasoning?: (chunk: string) => void, tools?: FunctionCallingTool[]): Promise<void> {
    const systemMsg = messages.find(m => m.role === 'system')
    const chatMsgs = messages.filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    const body: AnthropicRequestBody = {
      model: this.model,
      max_tokens: 4096,
      messages: chatMsgs,
      stream: true,
    }
    if (systemMsg) body.system = systemMsg.content
    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        name: t.function.name,
        description: t.function.description || '',
        input_schema: t.function.parameters,
      }))
    }

    const response = await providerFetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw classifyApiHttpError(response.status, errText, 'Anthropic')
    }

    await consumeSseStream(response, signal, (data) => {
      try {
        const parsed = JSON.parse(data)
        if (parsed.type === 'content_block_delta') {
          const text = parsed.delta?.text
          if (text) onChunk(text)
        }
        if (parsed.type === 'message_stop') return true
      } catch (e) {
        logger.error('[LLM] Anthropic SSE JSON parse failed:', e)
      }
    })
  }

  async listModels(): Promise<string[]> {
    return [this.model]
  }

  dispose(): void {
    // AnthropicProvider 通过 HTTP 连接，无需特殊清理
  }
}

/* ================================================================
 * LocalCPUProvider — 进程内调用 node-llama-cpp（不经过 HTTP）
 * 修复了 CPU 推理完全不可用的致命缺陷
 * ================================================================ */

interface LLMSession {
  prompt?(prompt: string, options?: Record<string, unknown>): Promise<string>
}

interface LLMModel {
  dispose?(): Promise<void>
}

export class LocalCPUProvider implements LLMProvider {
  id: string
  name: string
  type = 'localcpu'
  private session: LLMSession | null = null
  // @ts-expect-error TS6133 - model reserved for future use
  private model: LLMModel | null = null
  private loaded = false

  constructor(config: { id: string; name: string; modelPath?: string }) {
    this.id = config.id
    this.name = config.name
  }

  /** 从 electron-store 读取 modelConfig，合并采样参数 */
  private getModelParams(): { maxTokens: number; temperature: number; topP: number; topK: number; repeatPenalty: number } {
    try {
      const mc = (getStore().get('modelConfig') || {}) as Record<string, number | undefined>
      return {
        maxTokens: mc.maxTokens ?? 4096, // P3: 默认提高本地推理 maxTokens，避免 thinking 兜底内容被截断成思考片段
        temperature: mc.temperature ?? 0.7,
        topP: mc.topP ?? 0.9,
        topK: mc.topK ?? 40,
        repeatPenalty: mc.repeatPenalty ?? 1.1,
      }
    } catch {
      return { maxTokens: 4096, temperature: 0.7, topP: 0.9, topK: 40, repeatPenalty: 1.1 }
    }
  }

  private async ensureLoaded(): Promise<boolean> {
    if (this.loaded && this.session) return true
    try {
      if (!cpuInferenceEngine || !(cpuInferenceEngine as { model: unknown }).model) {
        // 尝试通过 modelManager 获取已加载状态
        const loaded = (modelManager as unknown as { getLoadedModel: () => unknown }).getLoadedModel()
        if (!loaded) return false
      }
      // CPU engine 已经加载（通过 modelManager.loadModel 完成的）
      this.loaded = true
      return true
    } catch (e) {
      logger.error('[LLM] LocalCPU ensureLoaded failed:', e);
      return false
    }
  }

  async generate(messages: ChatMessage[], _tools?: FunctionCallingTool[]): Promise<string> {
    // LocalCPU 通过拼接 prompt 推理，不支持标准 function calling，tools 参数占位
    if (!(await this.ensureLoaded())) {
      throw new Error('本地 CPU 模型未加载，请先在模型页面加载一个模型')
    }
    const prompt = messages.map(m => {
      if (m.role === 'system') return `<|system|>\n${m.content}</s>`
      if (m.role === 'user') return `<|user|>\n${m.content}</s>`
      return `<|assistant|>\n${m.content}</s>`
    }).join('\n') + '\n<|assistant|>\n'

    const p = this.getModelParams()
    // 结构化组包·真实内存态：生成前注入 RAM 常驻骨架与会话摘要
    cpuInferenceEngine.setRamContext({
      skeleton: memorySkeleton.getSkeleton() || undefined,
      summaries: sessionSummaryStore.composeInjection() || undefined,
    })
    return await cpuInferenceEngine.generate(prompt, p)
  }

  async generateStream(
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    signal: AbortSignal,
    _onReasoning?: (chunk: string) => void,
    _tools?: FunctionCallingTool[]
  ): Promise<void> {
    // LocalCPU 通过拼接 prompt 推理，不支持标准 function calling，tools 参数占位
    if (!(await this.ensureLoaded())) {
      throw new Error('本地 CPU 模型未加载')
    }

    // 使用 EventEmitter 模式接收 token
    const handler = (text: string) => {
      if (signal.aborted) return
      onChunk(text)
    }
    cpuInferenceEngine.on('token', handler)

    try {
      const prompt = messages.map(m => {
        if (m.role === 'system') return `<|system|>\n${m.content}</s>`
        if (m.role === 'user') return `<|user|>\n${m.content}</s>`
        return `<|assistant|>\n${m.content}</s>`
      }).join('\n') + '\n<|assistant|>\n'

      const p = this.getModelParams()
      // 结构化组包·真实内存态：生成前注入 RAM 常驻骨架与会话摘要
      cpuInferenceEngine.setRamContext({
        skeleton: memorySkeleton.getSkeleton() || undefined,
        summaries: sessionSummaryStore.composeInjection() || undefined,
      })
      await cpuInferenceEngine.generate(prompt, p)
    } finally {
      cpuInferenceEngine.removeListener('token', handler)
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const loaded = (modelManager as unknown as { getLoadedModel: () => unknown }).getLoadedModel()
      return loaded ? [(loaded as { modelName: string }).modelName] : []
    } catch (e) { logger.error('[LLM] LocalCPU listModels failed:', e); return [] }
  }

  dispose(): void {
    // 基础实现：清理 AbortController 和连接
    // 子类可覆盖添加更多清理逻辑
    this.loaded = false
    this.session = null
    this.model = null
  }
}

/* ================================================================
 * OllamaProvider — 本地 Ollama 服务
 * ================================================================ */
export class OllamaProvider implements LLMProvider {
  id: string
  name: string
  type = 'ollama'
  private baseUrl: string
  private model: string

  constructor(config: { id: string; name: string; baseUrl: string; model: string }) {
    this.id = config.id
    this.name = config.name
    this.baseUrl = config.baseUrl
    this.model = config.model
  }

  async generate(messages: ChatMessage[], tools?: FunctionCallingTool[]): Promise<string> {
    const response = await providerFetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages: messages.map(m => ({ role: m.role, content: m.content })), ...(tools && tools.length > 0 ? { tools } : {}) })
    })
    if (!response.ok) throw new Error(`Ollama API error: ${response.status}`)
    const data = await response.json()
    return data.message?.content || ''
  }

  async generateStream(messages: ChatMessage[], onChunk: (chunk: string) => void, signal: AbortSignal, _onReasoning?: (chunk: string) => void, tools?: FunctionCallingTool[]): Promise<void> {
    const response = await providerFetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages: messages.map(m => ({ role: m.role, content: m.content })), stream: true, ...(tools && tools.length > 0 ? { tools } : {}) })
    })
    if (!response.ok) throw new Error(`Ollama API error: ${response.status}`)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')
    const decoder = new TextDecoder()
    let buffer = ''
    if (signal) {
      signal.addEventListener('abort', () => reader.cancel().catch(() => {}))
    }
    try {
      while (true) {
        if (signal.aborted) break
        const result = await Promise.race([
          reader.read(),
          new Promise<{done: true, value: undefined}>((_, reject) =>
            setTimeout(() => reject(new Error('流式读取超时')), 30000)
          ),
        ])
        if (result.done) break
        buffer += decoder.decode(result.value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const data = JSON.parse(line)
            const content = data.message?.content
            if (content) onChunk(content)
            if (data.done) return
          } catch (e) { logger.error('[LLM] Ollama SSE JSON parse failed:', e) }
        }
      }
    } finally {
      try { reader.releaseLock() } catch (e) { logger.error('[LLM] Ollama reader release failed:', e) }
    }
  }

  async listModels(): Promise<string[]> {
    const response = await providerFetch(`${this.baseUrl}/api/tags`, {}, LIST_TIMEOUT)
    if (!response.ok) return []
    const data = await response.json()
    return data.models?.map((m: { name: string }) => m.name) || []
  }

  dispose(): void {
    // OllamaProvider 通过 HTTP 连接，无需特殊清理
  }
}
