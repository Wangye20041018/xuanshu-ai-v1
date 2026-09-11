/**
 * Model Adapter —— 模型适配层（施工蓝本 §4，最核心）
 *
 * 职责：
 *  1. 能力探测（§4.2）：启动/切换模型时探测并缓存 ModelCapability，
 *     探测失败给保守默认并标注 probed=false（未探测），可由用户覆盖。
 *  2. 三阶降级链（§4.3，不变量）：原生 function calling → JSON 工具协议 → ReAct 文本，
 *     三路归一封进统一的 ModelAdapterToolCall 结构。
 *  3. 统一契约（§4.6）：ToolCall { toolName, args, callId } / ToolResult { callId, ok, ... }。
 *  4. 工具结果压缩回注（§4.7）：超长截断 + 结构化摘要优先。
 *
 * 边界：本模块只「消费」workbuddy 的 provider/capability 契约
 * （LLMProvider / modelRegistry / modelManager），不修改其实现。
 *
 * @module main/agent/model-adapter
 */

import { logger } from '../../shared/logger'
import {
  type ModelCapability,
  type ModelScale,
  type ModelAdapterToolCall,
  type ModelAdapterMessage,
  type ModelAdapterCompletion,
} from '../../shared/model-adapter'
import { getStore } from '../ipc/config.ipc'
import { modelManager } from '../model-manager'
import { modelRegistry } from '../model-registry'
import { LLMProviderRegistry } from '../llm/provider-registry'
import { decrypt } from '../secure/secure-store'
import { type LLMProvider, type FunctionCallingTool } from '../llm/provider'

/** 活跃 provider 配置结构（config.ipc 的 ProviderConfig 是局部类型，此处按契约消费） */
interface ProviderCfg {
  id: string
  name?: string
  type?: string
  baseUrl?: string
  apiKey?: string
  models?: string[]
  model?: unknown
  maxContextTokens?: number
}

/** 本地 provider 标识（与 chat.ipc 路由一致，避免误判为云端） */
const LOCAL_PROVIDER_IDS = new Set([
  '__local_tandem__',
  '__local_sglang__',
  '__local_gpu__',
  '__local_cpu__',
])

/** 结果压缩回注默认上限（字符） */
const DEFAULT_RESULT_MAX_CHARS = 2000

/* ============================================================
 * 纯函数：能力推断 / 解析 / 压缩（可单测，无副作用）
 * ============================================================ */

/** 从参数量字符串推断规模档（§4.1 scale） */
export function inferModelScale(params: string | undefined | null): ModelScale {
  if (!params) return 'small'
  const m = params.match(/(\d+(?:\.\d+)?)\s*[bB]/)
  if (!m) return 'small'
  const b = Number(m[1])
  if (b <= 3) return 'small'
  if (b <= 14) return 'medium'
  if (b <= 70) return 'large'
  return 'giant'
}

/** 解析原生 FC 返回的 arguments 字符串（失败给空对象） */
export function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 解析 JSON 工具协议输出（§4.3 ②）：
 * 强制单条 {"tool_call":{name,arguments}}。兼容 body 包裹在 ```json``` 代码块的情况。
 */
export function parseJsonProtocol(text: string): ModelAdapterToolCall | null {
  if (!text) return null
  const candidates: string[] = []
  // 1) 代码块内的 JSON
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/gi)
  if (fenced) {
    for (const f of fenced) candidates.push(f.replace(/```(?:json)?/gi, '').trim())
  }
  // 2) 整个文本找 tool_call 对象
  const direct = text.match(/\{\s*"tool_call"\s*:\s*\{[\s\S]*?\}\s*\}/)
  if (direct) candidates.push(direct[0])

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c)
      const tc = parsed?.tool_call
      if (tc && typeof tc.name === 'string') {
        return {
          toolName: tc.name,
          args: tc.arguments && typeof tc.arguments === 'object' ? tc.arguments : {},
          callId: `json-${Math.random().toString(36).slice(2, 10)}`,
        }
      }
    } catch {
      /* continue */
    }
  }
  return null
}

/**
 * 解析 ReAct 文本输出（§4.3 ③）：Thought / Action / ActionInput 正则解析。
 */
export function parseReactAction(text: string): ModelAdapterToolCall | null {
  if (!text) return null
  const action = text.match(/Action\s*[:：]\s*([A-Za-z_][A-Za-z0-9_]*)/)
  if (!action) return null
  const name = action[1].trim()
  let args: Record<string, unknown> = {}
  const inputMatch = text.match(/ActionInput\s*[:：]\s*([\s\S]*?)(?:\n\s*(?:Observation|Thought|Final Answer)\s*[:：]|$)/)
  if (inputMatch) {
    const rawInput = inputMatch[1].trim()
    try {
      const parsed = JSON.parse(rawInput)
      args = parsed && typeof parsed === 'object' ? parsed : { input: rawInput }
    } catch {
      args = { input: rawInput }
    }
  }
  return {
    toolName: name,
    args,
    callId: `react-${Math.random().toString(36).slice(2, 10)}`,
  }
}

/** 压缩工具结果用于回注模型（§4.7）：超长截断 + 结构化摘要优先 */
export function compressForReinject(payload: unknown, maxChars: number = DEFAULT_RESULT_MAX_CHARS): { text: string; truncated: boolean } {
  let text = ''
  try {
    if (payload === undefined || payload === null) {
      text = '(无返回)'
    } else if (typeof payload === 'string') {
      text = payload
    } else if (Array.isArray(payload)) {
      // 列表型结果：结构化摘要优先（截断到前若干条）
      text = payload.length > 0 ? `共 ${payload.length} 条：\n` + JSON.stringify(payload.slice(0, 20)) : '(空列表)'
    } else {
      text = JSON.stringify(payload)
    }
  } catch {
    text = String(payload)
  }
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(0, maxChars) + '…', truncated: true }
}

/* ============================================================
 * ModelAdapter 实现
 * ============================================================ */

interface CompleteOptions {
  tools?: FunctionCallingTool[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

/** 原生 provider 消息（providers 的 ChatMessage 结构：id + role + content） */
interface ProviderMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
}

export class ModelAdapter {
  private capabilityCache: ModelCapability | null = null
  private capabilityCacheAt = 0
  private readonly CAPABILITY_TTL_MS = 30_000

  /** 清除能力缓存（模型切换 / 用户覆盖后调用） */
  clearCapabilityCache(): void {
    this.capabilityCache = null
    this.capabilityCacheAt = 0
  }

  /** 能力探测（§4.2）：可信度低的字段标 probed=false，绝不制造「未探测但假装探测」 */
  async probeCapability(): Promise<ModelCapability> {
    const now = Date.now()
    if (this.capabilityCache && now - this.capabilityCacheAt < this.CAPABILITY_TTL_MS) {
      return this.capabilityCache
    }

    let cap: ModelCapability
    try {
      const store = getStore()
      const providers = (store.get('providers') as unknown as ProviderCfg[]) || []
      const activeProviderId = (store.get('activeProvider') as string) || providers[0]?.id || ''
      const activeCfg = activeProviderId ? providers.find((p) => p.id === activeProviderId) : undefined

      // 用户显式覆盖优先（manual-override）
      const override = store.get('modelCapabilityOverride') as Partial<ModelCapability> | undefined
      if (override && override.modelId) {
        cap = this.withOverride(override)
        logger.debug('[ModelAdapter] 能力探测命中用户覆盖:', override.modelId)
      } else if (activeProviderId && !LOCAL_PROVIDER_IDS.has(activeProviderId) && activeCfg) {
        cap = this.buildCloudCapability(activeProviderId, activeCfg)
      } else {
        cap = this.buildLocalCapability()
      }
    } catch (e) {
      logger.warn('[ModelAdapter] 能力探测失败，使用保守默认:', e instanceof Error ? e.message : String(e))
      cap = this.conservativeDefault()
    }

    this.capabilityCache = cap
    this.capabilityCacheAt = now
    return cap
  }

  /**
   * 统一推理入口（三阶降级）：
   * 返回「正文 or 工具调用（可并行）」，归一到 ModelAdapterCompletion。
   */
  async complete(messages: ModelAdapterMessage[], opts: CompleteOptions = {}): Promise<ModelAdapterCompletion> {
    const tools = opts.tools ?? []
    const cap = await this.probeCapability()

    // 无工具：纯文本补齐（推理型模型思考段单独透传，不污染正文）
    if (tools.length === 0) {
      const r = await this.generateText(messages, opts)
      return { content: r.content, toolCalls: [], degradeTier: 'react', reasoning: r.reasoning }
    }

    // ① 原生 function calling（cloud / 支持 nativeTools 的模型）
    if (cap.nativeTools) {
      try {
        const r = await this.completeNative(messages, tools, opts)
        if (r.toolCalls.length > 0 || r.content) {
          return { content: r.content, toolCalls: r.toolCalls, degradeTier: 'native', reasoning: r.reasoning }
        }
      } catch (e) {
        logger.warn('[ModelAdapter] 原生 FC 推理失败，降级 JSON 协议:', e instanceof Error ? e.message : String(e))
      }
    }

    // ② JSON 工具协议（本地 9B 主力路径，token 吝啬：工具描述极简）
    try {
      const jsonResult = await this.completeWithJsonProtocol(messages, tools, opts)
      if (jsonResult.toolCalls.length > 0) {
        return { content: jsonResult.content, toolCalls: jsonResult.toolCalls, degradeTier: 'json', reasoning: jsonResult.reasoning }
      }
      // 模型没按 JSON 协议返回工具调用，但正文非空 → 视为最终回答
      if (jsonResult.content) {
        return { content: jsonResult.content, toolCalls: [], degradeTier: 'json', reasoning: jsonResult.reasoning }
      }
    } catch (e) {
      logger.warn('[ModelAdapter] JSON 协议失败，降级 ReAct 文本:', e instanceof Error ? e.message : String(e))
    }

    // ③ ReAct 文本
    const reactResult = await this.completeWithReact(messages, tools, opts)
    return { content: reactResult.content, toolCalls: reactResult.toolCalls, degradeTier: 'react', reasoning: reactResult.reasoning }
  }

  /* ============================================================
   * 内部：能力构建
   * ============================================================ */

  private withOverride(o: Partial<ModelCapability>): ModelCapability {
    return {
      modelId: o.modelId || 'override',
      tier: o.tier ?? 'local',
      scale: o.scale ?? 'small',
      maxContextTokens: o.maxContextTokens ?? 4096,
      nativeTools: o.nativeTools ?? false,
      parallelTools: o.parallelTools ?? false,
      reasoning: o.reasoning ?? false,
      jsonMode: o.jsonMode ?? false,
      vision: o.vision ?? false,
      stream: o.stream ?? true,
      costHint: o.costHint ?? 'free',
      probed: true,
      source: 'manual-override',
    }
  }

  private buildCloudCapability(providerId: string, cfg: ProviderCfg): ModelCapability {
    const modelName = String(cfg.model || cfg.name || providerId)
    const type = String(cfg.type || 'openai')
    const isAnthropic = type === 'anthropic'
    return {
      modelId: providerId,
      tier: 'cloud',
      // 云端模型按名称粗分规模；明确 70B+ 视作 giant
      scale: /(405|671|mixtral|gpt-4\.5|claude.*opus|gemini.*ultra)/i.test(modelName) ? 'giant' : 'large',
      maxContextTokens: Number(cfg.maxContextTokens) || 128_000,
      nativeTools: type === 'openai' || isAnthropic || type === 'sglang',
      parallelTools: type === 'openai',
      reasoning: /(reasoning|o1|o3|deepseek-r1|qwq)/i.test(modelName),
      jsonMode: type === 'openai',
      vision: /(vision|vl|gpt-4o|gemini|claude.*sonnet|qwen.*vl)/i.test(modelName),
      stream: true,
      costHint: 'pricey',
      // 云端 provider 的 FC 能力由协议保证，视为已探测
      probed: true,
      source: 'provider',
    }
  }

  private buildLocalCapability(): ModelCapability {
    try {
      const loaded = modelManager.getLoadedModel()
      const models = modelRegistry.list()
      const model =
        models.find((m) => m.id === loaded?.modelId) ??
        models.find((m) => m.isDefault) ??
        models[0]
      const params = model?.params || loaded?.modelName || ''
      const localcaps: ModelCapability = {
        modelId: model?.id || loaded?.modelId || 'local',
        tier: 'local',
        scale: inferModelScale(params),
        maxContextTokens: model?.contextSize || 4096,
        // 本地 llama.cpp 原生 FC 支持取决于模型 chat 模板，默认保守为不支持（②JSON 路径）
        nativeTools: false,
        parallelTools: false,
        reasoning: /(qwen3|qwq|deepseek-r1|r1|reason)/i.test(params),
        jsonMode: false,
        vision: !!model?.isMultimodal,
        stream: true,
        costHint: 'free',
        // 静态注册表信息未做运行时 FC 探测 → 标注未探测（零假显示）
        probed: false,
        source: model ? 'registry-static' : 'conservative-default',
      }
      return localcaps
    } catch (e) {
      logger.warn('[ModelAdapter] 本地能力构建失败:', e instanceof Error ? e.message : String(e))
      return this.conservativeDefault()
    }
  }

  private conservativeDefault(): ModelCapability {
    return {
      modelId: 'unknown',
      tier: 'local',
      scale: 'small',
      maxContextTokens: 4096,
      nativeTools: false,
      parallelTools: false,
      reasoning: false,
      jsonMode: false,
      vision: false,
      stream: false,
      costHint: 'free',
      probed: false,
      source: 'conservative-default',
    }
  }

  /* ============================================================
   * 内部：三阶推理
   * ============================================================ */

  /** 纯文本补齐（无工具）：优先走 modelManager.generateResponse */
  private async generateText(
    messages: ModelAdapterMessage[],
    opts: CompleteOptions,
  ): Promise<{ content: string; reasoning: string }> {
    const prompt = messagesToPrompt(messages)
    const content = await modelManager.generateResponse(prompt, {
      temperature: opts.temperature ?? 0.7,
      maxTokens: opts.maxTokens ?? 2048,
    })
    return { content, reasoning: '' }
  }

  /** ① 原生 FC：通过 provider.generateStream(tools, onToolCall) 捕获归一化工具调用 */
  private completeNative(
    messages: ModelAdapterMessage[],
    tools: FunctionCallingTool[],
    opts: CompleteOptions,
  ): Promise<{ content: string; toolCalls: ModelAdapterToolCall[]; reasoning: string }> {
    const provider = this.resolveActiveProvider()
    if (!provider) {
      return Promise.reject(new Error('无可用原生 FC provider'))
    }
    const providerMessages = toProviderMessages(messages)
    const signal = opts.signal ?? new AbortController().signal

    return new Promise((resolve, reject) => {
      let content = ''
      let reasoning = ''
      const toolCalls: ModelAdapterToolCall[] = []
      let settled = false

      provider
        .generateStream(
          providerMessages,
          (chunk) => {
            content += chunk
          },
          signal,
          (rc) => {
            reasoning += rc
          },
          tools,
          (calls) => {
            for (const c of calls) {
              toolCalls.push({
                toolName: c.name,
                args: parseToolArguments(c.arguments),
                callId: c.id || `native-${Math.random().toString(36).slice(2, 10)}`,
              })
            }
          },
        )
        .then(() => {
          if (!settled) {
            settled = true
            resolve({ content: content.trim(), toolCalls, reasoning: reasoning.trim() })
          }
        })
        .catch((e) => {
          if (!settled) {
            settled = true
            reject(e)
          }
        })
    })
  }

  /** ② JSON 工具协议：注入极简 ToolSchema，强制单条 JSON，校验失败重试 1 次 */
  private async completeWithJsonProtocol(
    messages: ModelAdapterMessage[],
    tools: FunctionCallingTool[],
    opts: CompleteOptions,
  ): Promise<{ content: string; toolCalls: ModelAdapterToolCall[]; reasoning: string }> {
    let prompt = buildJsonProtocolPrompt(messages, tools)
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await modelManager.generateResponse(prompt, {
        temperature: opts.temperature ?? 0.1,
        maxTokens: opts.maxTokens ?? 2048,
      })
      const parsed = parseJsonProtocol(raw)
      if (parsed) {
        const valid = tools.some((t) => t.function.name === parsed.toolName)
        if (valid) {
          return { content: '', toolCalls: [parsed], reasoning: '' }
        }
        logger.warn(`[ModelAdapter] JSON 协议工具名非法: ${parsed.toolName}，重试`)
        // 追加纠错提示后重试
        prompt += `\n\n[系统] 工具名 "${parsed.toolName}" 不存在，请从可用工具中重新选择并严格输出 JSON。`
        continue
      }
      // 无工具调用 → 视为最终回答
      return { content: raw, toolCalls: [], reasoning: '' }
    }
    return { content: '', toolCalls: [], reasoning: '' }
  }

  /** ③ ReAct 文本：Thought/Action/ActionInput 正则解析，失败返回正文 */
  private async completeWithReact(
    messages: ModelAdapterMessage[],
    tools: FunctionCallingTool[],
    opts: CompleteOptions,
  ): Promise<{ content: string; toolCalls: ModelAdapterToolCall[]; reasoning: string }> {
    const prompt = buildReactPrompt(messages, tools)
    const raw = await modelManager.generateResponse(prompt, {
      temperature: opts.temperature ?? 0.7,
      maxTokens: opts.maxTokens ?? 2048,
    })
    const parsed = parseReactAction(raw)
    if (parsed) {
      const valid = tools.some((t) => t.function.name === parsed.toolName)
      if (valid) return { content: '', toolCalls: [parsed], reasoning: '' }
    }
    return { content: raw, toolCalls: [], reasoning: '' }
  }

  /** 解析当前活跃的云端 provider（仅 cloud 原生 FC 用；本地回退时返回 null） */
  private resolveActiveProvider(): LLMProvider | null {
    try {
      const store = getStore()
      const providers = (store.get('providers') as unknown as ProviderCfg[]) || []
      const activeProviderId = (store.get('activeProvider') as string) || providers[0]?.id || ''
      if (!activeProviderId || LOCAL_PROVIDER_IDS.has(activeProviderId)) return null

      let provider = LLMProviderRegistry.getProvider(activeProviderId) || null
      if (!provider) {
        const cfg = providers.find((p) => p.id === activeProviderId)
        if (cfg) {
          provider = LLMProviderRegistry.createProvider({
            id: cfg.id,
            name: cfg.name || cfg.id,
            type: cfg.type || 'openai',
            baseUrl: cfg.baseUrl,
            apiKey: decrypt(cfg.apiKey),
            model: cfg.models?.[0] || (cfg.model as string),
          })
          LLMProviderRegistry.registerProvider(provider)
        }
      }
      return provider
    } catch (e) {
      logger.warn('[ModelAdapter] 解析活跃 provider 失败:', e instanceof Error ? e.message : String(e))
      return null
    }
  }
}

/* ============================================================
 * Prompt 构建与消息转换（纯函数）
 * ============================================================ */

function messagesToPrompt(messages: ModelAdapterMessage[]): string {
  const parts: string[] = []
  for (const m of messages) {
    const label =
      m.role === 'system'
        ? '系统'
        : m.role === 'user'
          ? '用户'
          : m.role === 'assistant'
            ? '助手'
            : `工具(${m.name || 'unknown'})`
    parts.push(`[${label}]: ${m.content}`)
  }
  return parts.join('\n')
}

/** ModelAdapterMessage → 原生 provider 消息；'tool' 角色折叠为「工具结果」用户消息 */
function toProviderMessages(messages: ModelAdapterMessage[]): ProviderMessage[] {
  const out: ProviderMessage[] = []
  let idx = 0
  for (const m of messages) {
    if (m.role === 'tool') {
      const last = out[out.length - 1]
      const note = `[工具结果] ${m.name || 'tool'}: ${m.content}`
      if (last && last.role === 'user') {
        last.content = `${last.content}\n${note}`
      } else {
        out.push({ id: `m${idx++}`, role: 'user', content: note })
      }
      continue
    }
    out.push({ id: `m${idx++}`, role: m.role, content: m.content })
  }
  return out
}

/** 工具描述极简化（token 吝啬）：一句话 + 必填参数 */
function minimalToolDesc(tools: FunctionCallingTool[]): string {
  return tools
    .map((t) => {
      const req = t.function.parameters?.required
      const reqStr = Array.isArray(req) && req.length > 0 ? `必填: ${req.join(', ')}` : ''
      return `- ${t.function.name}: ${t.function.description}${reqStr ? `（${reqStr}）` : ''}`
    })
    .join('\n')
}

function buildJsonProtocolPrompt(messages: ModelAdapterMessage[], tools: FunctionCallingTool[]): string {
  const header = [
    '你只能通过调用工具完成任务。请严格输出单条 JSON，不要输出任何其他文字：',
    '{"tool_call":{"name":"工具名","arguments":{...}}}',
    '',
    '可用工具：',
    minimalToolDesc(tools),
    '',
  ].join('\n')
  return header + messagesToPrompt(messages)
}

function buildReactPrompt(messages: ModelAdapterMessage[], tools: FunctionCallingTool[]): string {
  const header = [
    '你是智能桌面助手，可通过调用工具完成任务。',
    '',
    '可用工具：',
    minimalToolDesc(tools),
    '',
    '工作方式（需要调用工具时严格按以下格式输出，每次一个工具）：',
    'Thought: 你的思考',
    'Action: 工具名',
    'ActionInput: {"参数":"值"}',
    '无需工具时直接输出最终回答。',
    '',
  ].join('\n')
  return header + messagesToPrompt(messages)
}

/* ============================================================
 * 全局单例
 * ============================================================ */

export const modelAdapter = new ModelAdapter()