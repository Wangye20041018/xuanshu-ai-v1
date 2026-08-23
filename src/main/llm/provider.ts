import { logger } from '../../shared/logger'
import { getStore } from '../ipc/config.ipc'
import { cpuInferenceEngine } from '../inference/cpu-engine'
import { modelManager } from '../model-manager'
import { createProxyAgent } from '../utils/proxy-resolver'

/** 各 Provider 网络请求超时（毫秒） */
const REQUEST_TIMEOUT = 60_000
const LIST_TIMEOUT = 10_000

/** 本地回环地址不注入代理，避免误走系统代理 */
function isLoopbackUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(url)
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

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface LLMProvider {
  id: string
  name: string
  type: string

  generate(messages: ChatMessage[]): Promise<string>
  generateStream(
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    signal: AbortSignal
  ): Promise<void>
  listModels(): Promise<string[]>
  dispose?(): void | Promise<void>
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

  async generate(messages: ChatMessage[]): Promise<string> {
    const response = await providerFetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: false,
        chat_template_kwargs: { enable_thinking: false },
      })
    })
    if (!response.ok) throw new Error(`SGLang API error: ${response.status}`)
    const data = await response.json()
    const msg = data.choices[0].message
    if (msg?.content) return msg.content
    if (msg?.reasoning_content) return msg.reasoning_content
    return msg?.content || ''
  }

  async generateStream(
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    signal: AbortSignal
  ): Promise<void> {
    const response = await providerFetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: true,
        chat_template_kwargs: { enable_thinking: false },
      })
    })
    if (!response.ok) throw new Error(`SGLang API error: ${response.status}`)
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
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data === '[DONE]') return
            try {
              const parsed = JSON.parse(data)
              let content = parsed.choices?.[0]?.delta?.content
              if (!content) content = parsed.choices?.[0]?.delta?.reasoning_content
              if (content) onChunk(content)
            } catch (e) { logger.error('[LLM] SGLang SSE JSON parse failed:', e) }
          }
        }
      }
    } finally {
      try { reader.releaseLock() } catch (e) { logger.error('[LLM] SGLang reader release failed:', e) }
    }
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

  async generate(messages: ChatMessage[]): Promise<string> {
    const response = await providerFetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: false,
        // 本地思考型模型（Qwen3.5 等）默认输出 reasoning_content，正文可能为空。
        // 显式关闭思考模式，保证 message.content 直接产出正文；远端 OpenAI 兼容 API 会忽略未知字段。
        chat_template_kwargs: { enable_thinking: false },
      })
    })
    if (!response.ok) throw new Error(`API error: ${response.status}`)
    const data = await response.json()
    const msg = data.choices[0].message
    // 兜底：若正文为空但存在推理内容（如远端忽略 enable_thinking），取 reasoning_content 避免空回复
    if (msg?.content) return msg.content
    if (msg?.reasoning_content) return msg.reasoning_content
    return msg?.content || ''
  }

  async generateStream(messages: ChatMessage[], onChunk: (chunk: string) => void, signal: AbortSignal): Promise<void> {
    const response = await providerFetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: true,
        chat_template_kwargs: { enable_thinking: false },
      })
    })
    if (!response.ok) throw new Error(`API error: ${response.status}`)
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
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data === '[DONE]') return
            try {
              const parsed = JSON.parse(data)
              // 优先取正文，若为空（思考模型仍输出 reasoning）则回退取推理内容，保证不出现空回复
              let content = parsed.choices?.[0]?.delta?.content
              if (!content) content = parsed.choices?.[0]?.delta?.reasoning_content
              if (content) onChunk(content)
            } catch (e) { logger.error('[LLM] OpenAI SSE JSON parse failed:', e) }
          }
        }
      }
    } finally {
      try { reader.releaseLock() } catch (e) { logger.error('[LLM] OpenAI reader release failed:', e) }
    }
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

  async generate(messages: ChatMessage[]): Promise<string> {
    const systemMsg = messages.find(m => m.role === 'system')
    const chatMsgs = messages.filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    const body: AnthropicRequestBody = {
      model: this.model,
      max_tokens: 4096,
      messages: chatMsgs,
    }
    if (systemMsg) body.system = systemMsg.content

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
      throw new Error(`Anthropic API error ${response.status}: ${errText.substring(0, 200)}`)
    }
    const data = await response.json()
    return data.content?.[0]?.text || ''
  }

  async generateStream(messages: ChatMessage[], onChunk: (chunk: string) => void, signal: AbortSignal): Promise<void> {
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

    const response = await providerFetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`Anthropic API error: ${response.status}`)

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
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (!data.trim()) continue
            try {
              const parsed = JSON.parse(data)
              if (parsed.type === 'content_block_delta') {
                const text = parsed.delta?.text
                if (text) onChunk(text)
              }
              if (parsed.type === 'message_stop') return
            } catch (e) { logger.error('[LLM] Anthropic SSE JSON parse failed:', e) }
          }
        }
      }
    } finally {
      try { reader.releaseLock() } catch (e) { logger.error('[LLM] Anthropic reader release failed:', e) }
    }
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
        maxTokens: mc.maxTokens ?? 2048,
        temperature: mc.temperature ?? 0.7,
        topP: mc.topP ?? 0.9,
        topK: mc.topK ?? 40,
        repeatPenalty: mc.repeatPenalty ?? 1.1,
      }
    } catch {
      return { maxTokens: 2048, temperature: 0.7, topP: 0.9, topK: 40, repeatPenalty: 1.1 }
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

  async generate(messages: ChatMessage[]): Promise<string> {
    if (!(await this.ensureLoaded())) {
      throw new Error('本地 CPU 模型未加载，请先在模型页面加载一个模型')
    }
    const prompt = messages.map(m => {
      if (m.role === 'system') return `<|system|>\n${m.content}</s>`
      if (m.role === 'user') return `<|user|>\n${m.content}</s>`
      return `<|assistant|>\n${m.content}</s>`
    }).join('\n') + '\n<|assistant|>\n'

    const p = this.getModelParams()
    return await cpuInferenceEngine.generate(prompt, p)
  }

  async generateStream(
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    signal: AbortSignal
  ): Promise<void> {
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

  async generate(messages: ChatMessage[]): Promise<string> {
    const response = await providerFetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages: messages.map(m => ({ role: m.role, content: m.content })) })
    })
    if (!response.ok) throw new Error(`Ollama API error: ${response.status}`)
    const data = await response.json()
    return data.message?.content || ''
  }

  async generateStream(messages: ChatMessage[], onChunk: (chunk: string) => void, signal: AbortSignal): Promise<void> {
    const response = await providerFetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages: messages.map(m => ({ role: m.role, content: m.content })), stream: true })
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
