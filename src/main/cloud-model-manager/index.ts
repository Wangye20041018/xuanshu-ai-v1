/**
 * CloudModelManager — 云端模型注册表 + 能力探测 + failover（施工单 §4）
 *
 * 职责（纯云端链路强化的 main 侧核心）：
 *  1. 云端模型 CRUD（add / remove / update / list），base_url + model_id + api_key 三项必填。
 *  2. 敏感字段 apiKey 用 safeStorage 加密存储，读取脱敏，绝不回显明文。
 *  3. 能力探测 ModelCapability（nativeTools / parallelTools / jsonMode / reasoning / vision /
 *     maxContextTokens），失败给保守默认并标注 probed=false（未探测），探测结果缓存。
 *  4. failover：主 provider 失败时解析备选 provider（按注册顺序 + 最近可用性）。
 *
 * 边界：本模块是「云端模型」的长效注册表，与 model-registry（本地 GGUF 注册表）平行。
 * UI 归豆包（renderer），本模块只出 main + IPC 契约（字段写死）。
 */

import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { logger } from '../../shared/logger'
import { getStore } from '../ipc/config.ipc'
import { encrypt, decrypt, mask } from '../secure/secure-store'
import { validateSender } from '../utils/ipc-guard'
import type { ModelCapability } from '../../shared/model-adapter'

/* ============================================================
 * 类型定义（IPC 契约，字段写死）
 * ============================================================ */

export interface CloudModelEntry {
  /** 唯一 id（注册时生成） */
  id: string
  /** 展示名 */
  name: string
  /** API 地址（如 https://api.deepseek.com/v1） */
  baseUrl: string
  /** 模型 id（如 deepseek-chat） */
  modelId: string
  /** 提供商标识（deepseek / kimi / doubao / custom） */
  provider: string
  /** API Key（加密存储，仅主进程可解密） */
  apiKey?: string
  /** 能力标记（用户可覆盖探测结果） */
  capability?: Partial<ModelCapability>
  /** 最近一次能力探测结果缓存 */
  probedCapability?: ModelCapability
  /** 最近一次探测时间戳 */
  probedAt?: number
  /** 最近一次可用性（true/false/未探测） */
  lastHealthy?: boolean
  /** 是否启用（禁用后不参与 failover） */
  enabled: boolean
  /** 注册时间 */
  registeredAt: number
}

/** 存储键：与 renderer Model 页实际写入的键对齐（A5 修复：弃用从未被写入的 cloudModels） */
const STORE_KEY = 'cloudApiModels'

/** 本地伪 provider 标识（不视为云端，也不参与 failover） */
const LOCAL_PROVIDER_IDS = new Set(['__local_tandem__', '__local_sglang__', '__local_gpu__', '__local_cpu__'])

/**
 * 云模型名校验/归一（A5 修复）：真实 DeepSeek API 模型名（deepseek-chat / deepseek-reasoner）
 * 与常见别名之间的对齐。命中别名的模型标记「未验证 + 建议规范名」，杜绝 400/404 假显示。
 */
const MODEL_NAME_ALIASES: Record<string, string> = {
  'deepseek-chat': 'deepseek-chat',
  'deepseek-reasoner': 'deepseek-reasoner',
  'deepseek-v3': 'deepseek-chat',
  'deepseek-v3.1': 'deepseek-chat',
  'deepseek-v4': 'deepseek-chat',
  'deepseek-v4-pro': 'deepseek-chat',
  'deepseek-v4-flash': 'deepseek-chat',
  'deepseek-v4-flash-vision-exp': 'deepseek-reasoner',
  'deepseek-r1': 'deepseek-reasoner',
}

/** 校验模型名：返回 { verified, canonicalModelId }。仅当命名命中已知 API 真实模型名或别名时，才视为「名已对齐」。 */
function validateModelName(modelId: string): { verified: boolean; canonicalModelId?: string } {
  const key = modelId.trim().toLowerCase()
  if (MODEL_NAME_ALIASES[key]) {
    const canonical = MODEL_NAME_ALIASES[key]
    return { verified: key === canonical, canonicalModelId: canonical }
  }
  // 未知命名：无法确认与真实 API 一致，标记未验证（不擅自判定其存在）
  return { verified: false }
}

/** 保守默认能力（探测失败时使用，标注未探测；云端接入修复：模型名默认未验证） */
function conservativeCapability(modelId: string, provider: string): ModelCapability {
  const nameCheck = validateModelName(modelId)
  return {
    modelId,
    tier: 'cloud',
    scale: 'large',
    maxContextTokens: 8192,
    nativeTools: provider === 'deepseek' || provider === 'kimi' || provider === 'doubao',
    parallelTools: false,
    reasoning: /(deepseek-r1|qwq|reasoning|o1|o3)/i.test(modelId) || nameCheck.canonicalModelId === 'deepseek-reasoner',
    jsonMode: true,
    vision: /(vision|vl|glm-4v|qwen.*vl)/i.test(modelId),
    stream: true,
    costHint: 'pricey',
    probed: false,
    source: 'conservative-default',
    modelVerified: nameCheck.verified,
    canonicalModelId: nameCheck.canonicalModelId,
  }
}

/* ============================================================
 * CloudModelManager 实现
 * ============================================================ */

class CloudModelManager {
  private cache: CloudModelEntry[] | null = null
  private cacheAt = 0
  private readonly TTL_MS = 3000

  constructor() {
    try {
      this.migrateLegacyStore()
    } catch {
      /* 迁移失败不阻塞启动 */
    }
  }

  private getStore() {
    const store = getStore()
    if (!store) throw new Error('[CloudModelManager] config store 未初始化')
    return store
  }

  /** 一次性迁移：旧版 STORE_KEY 'cloudModels' 的遗留数据 → 对齐后的 'cloudApiModels' */
  private migrateLegacyStore(): void {
    try {
      const store = this.getStore()
      if (store.get('cloudModels') === undefined) return
      const legacy = store.get('cloudModels') as CloudModelEntry[] | undefined
      const current = store.get('cloudApiModels') as CloudModelEntry[] | undefined
      if (Array.isArray(legacy) && legacy.length > 0 && !(Array.isArray(current) && current.length > 0)) {
        store.set('cloudApiModels', legacy)
        logger.info(`[CloudModelManager] 已迁移旧注册表 cloudModels(${legacy.length} 条) → cloudApiModels`)
      }
      store.set('cloudModels', undefined)
    } catch (e) {
      logger.warn('[CloudModelManager] 旧注册表迁移失败（跳过）:', e)
    }
  }

  /** 读取所有云端模型；未命中时按 providers（唯一真相源）水合，保证注册表永不虚假为空 */
  list(): CloudModelEntry[] {
    const now = Date.now()
    if (this.cache !== null && now - this.cacheAt < this.TTL_MS) return this.cache
    try {
      let raw = this.getStore().get(STORE_KEY, []) as CloudModelEntry[]
      if (!Array.isArray(raw)) return (this.cache = [])
      // 防御：仅保留符合云端条目结构的数据（baseUrl + modelId），避免 renderer 侧同键异构数据污染注册表
      raw = raw.filter((m: any) => m && typeof m === 'object' && m.modelId && m.baseUrl)
      this.cache = this.hydrateFromProviders(raw)
      this.cacheAt = now
      return this.cache
    } catch (e) {
      logger.error('[CloudModelManager] list 失败:', e)
      return this.cache || []
    }
  }

  /** 以 config.providers 为唯一真相源：为已注册的 API provider 的每个模型补建云条目（去重） */
  private hydrateFromProviders(registry: CloudModelEntry[]): CloudModelEntry[] {
    try {
      const providers: any[] = this.getStore().get('providers') || []
      const keyOf = (m: CloudModelEntry) => `${m.baseUrl}::${m.modelId}`
      const seen = new Set(registry.map(keyOf))
      const out = [...registry]
      for (const p of providers) {
        if (!p || LOCAL_PROVIDER_IDS.has(p.id)) continue
        if (!p.baseUrl || !p.apiKey) continue
        if (p.type !== 'openai') continue
        const models = Array.isArray(p.models) ? p.models : []
        for (const modelId of models) {
          if (!modelId) continue
          const entry: CloudModelEntry = {
            id: p.id,
            name: modelId,
            baseUrl: p.baseUrl.replace(/\/+$/, ''),
            modelId,
            provider: p.id,
            apiKey: p.apiKey, // 密文随 provider 存，读取时才解密
            capability: undefined,
            enabled: true,
            registeredAt: 0,
          }
          const k = keyOf(entry)
          if (seen.has(k)) continue
          seen.add(k)
          out.push(entry)
        }
      }
      return out
    } catch (e) {
      logger.warn('[CloudModelManager] providers 水合失败，仅用注册表数据:', e)
      return registry
    }
  }

  private save(models: CloudModelEntry[]): void {
    this.getStore().set(STORE_KEY, models)
    this.cache = models
    this.cacheAt = Date.now()
  }

  /** 注册云端模型（add）：baseUrl + modelId + apiKey 三项必填，唯一性校验 */
  add(input: {
    name: string
    baseUrl: string
    modelId: string
    provider?: string
    apiKey: string
    capability?: Partial<ModelCapability>
  }): { success: boolean; model?: CloudModelEntry; error?: string } {
    try {
      if (!input.baseUrl || !input.modelId || !input.apiKey) {
        return { success: false, error: 'baseUrl / modelId / apiKey 三项必填' }
      }
      const models = this.list()
      // 唯一性校验：同 baseUrl + modelId 视为重复
      const dup = models.find(m => m.baseUrl === input.baseUrl && m.modelId === input.modelId)
      if (dup) {
        return { success: false, error: `模型已存在（${dup.name || dup.modelId}），请勿重复注册` }
      }
      const encryptedKey = encrypt(input.apiKey)
      if (!encryptedKey) {
        return { success: false, error: 'apiKey 加密失败（safeStorage 不可用）' }
      }
      const entry: CloudModelEntry = {
        id: randomUUID(),
        name: input.name || input.modelId,
        baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
        modelId: input.modelId,
        provider: input.provider || 'custom',
        apiKey: encryptedKey,
        capability: input.capability,
        enabled: true,
        registeredAt: Date.now(),
      }
      models.push(entry)
      this.save(models)
      logger.info(`[CloudModelManager] 注册云端模型: ${entry.name} (${entry.provider}/${entry.modelId})`)
      return { success: true, model: { ...entry, apiKey: undefined } }
    } catch (e: any) {
      logger.error('[CloudModelManager] add 失败:', e)
      return { success: false, error: e?.message || '注册失败' }
    }
  }

  /** 脱敏后的列表（供 renderer 展示，绝不回显 apiKey 明文） */
  listSanitized(): Array<Omit<CloudModelEntry, 'apiKey'> & { apiKeyMasked?: string }> {
    return this.list().map(m => ({
      ...m,
      apiKey: undefined,
      apiKeyMasked: m.apiKey ? mask(decrypt(m.apiKey)) : undefined,
    }))
  }
  /** 删除云端模型（remove）：校验无活动会话占用 */
  remove(id: string): { success: boolean; error?: string } {
    try {
      const models = this.list()
      const idx = models.findIndex(m => m.id === id)
      if (idx === -1) return { success: false, error: '模型未找到' }
      const removed = models.splice(idx, 1)[0]
      this.save(models)
      logger.info(`[CloudModelManager] 移除云端模型: ${removed.name}`)
      return { success: true }
    } catch (e: any) {
      logger.error('[CloudModelManager] remove 失败:', e)
      return { success: false, error: e?.message || '删除失败' }
    }
  }

  /** 更新云端模型（update）：展示名/地址/能力标记/启用状态；apiKey 单独传才更新 */
  update(id: string, patch: Partial<Omit<CloudModelEntry, 'id' | 'registeredAt' | 'apiKey'> & { apiKey?: string }>): { success: boolean; model?: CloudModelEntry; error?: string } {
    try {
      const models = this.list()
      const idx = models.findIndex(m => m.id === id)
      if (idx === -1) return { success: false, error: '模型未找到' }
      const cur = models[idx]
      const next: CloudModelEntry = { ...cur, ...patch }
      // apiKey 单独处理：传了才更新，且重新加密
      if (patch.apiKey) {
        const encryptedKey = encrypt(patch.apiKey)
        if (!encryptedKey) return { success: false, error: 'apiKey 加密失败' }
        next.apiKey = encryptedKey
      }
      // 能力标记变更时清除探测缓存（触发重探测）
      if (patch.capability) {
        next.probedCapability = undefined
        next.probedAt = undefined
      }
      models[idx] = next
      this.save(models)
      logger.info(`[CloudModelManager] 更新云端模型: ${next.name}`)
      return { success: true, model: { ...next, apiKey: undefined } }
    } catch (e: any) {
      logger.error('[CloudModelManager] update 失败:', e)
      return { success: false, error: e?.message || '更新失败' }
    }
  }

  /** 获取单个模型的解密 apiKey（仅主进程内部使用，不出 IPC） */
  getDecryptedApiKey(id: string): string {
    const m = this.list().find(x => x.id === id)
    if (!m) return ''
    if (m.apiKey) return decrypt(m.apiKey)
    // A5 修复：注册表条目无 apiKey（如从 providers 水合而来）时，回退到 providers（唯一真相源）按 provider id 取密文解密
    try {
      const providers: any[] = this.getStore().get('providers') || []
      const p = providers.find((x: any) => x.id === m.provider) || providers.find((x: any) => x.baseUrl && m.baseUrl && x.baseUrl.replace(/\/+$/, '') === m.baseUrl)
      return p?.apiKey ? decrypt(p.apiKey) : ''
    } catch {
      return ''
    }
  }

  /** A5 修复：真实连通性校验（替代假显示）—— 真实请求 /models，返回健康度、延迟与模型存在性 */
  async verifyConnectivity(id: string): Promise<{
    healthy: boolean
    latencyMs: number
    modelExists: boolean
    models: string[]
    error?: string
  }> {
    const m = this.list().find(x => x.id === id)
    if (!m) return { healthy: false, latencyMs: 0, modelExists: false, models: [], error: '模型未找到' }
    const apiKey = this.getDecryptedApiKey(id)
    if (!apiKey) return { healthy: false, latencyMs: 0, modelExists: false, models: [], error: 'API Key 缺失或解密失败' }
    const t0 = Date.now()
    try {
      const resp = await fetch(`${m.baseUrl.replace(/\/+$/, '')}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      })
      const latencyMs = Date.now() - t0
      const healthy = resp.ok
      let models: string[] = []
      if (resp.ok) {
        try {
          const data: any = await resp.json()
          models = Array.isArray(data?.data) ? data.data.map((x: any) => x?.id).filter(Boolean) : []
        } catch { /* 忽略 body 解析失败 */ }
      }
      const modelExists = models.includes(m.modelId)
      // A5：连通性与模型存在性写入最近可用性缓存（真实探测，非推断）
      this.update(id, { lastHealthy: healthy })
      this.cacheProbe(id, {
        ...(m.probedCapability ?? conservativeCapability(m.modelId, m.provider)),
        modelVerified: modelExists,
        probed: healthy,
        source: healthy ? 'connectivity-verify' : m.probedCapability?.source || 'conservative-default',
      })
      logger.info(`[CloudModelManager] 连通性校验 ${m.modelId}: healthy=${healthy}, exists=${modelExists}, ${latencyMs}ms, models=${models.length}`)
      return { healthy, latencyMs, modelExists, models, error: healthy ? undefined : `HTTP ${resp.status}` }
    } catch (e) {
      const latencyMs = Date.now() - t0
      const err = (e as Error)?.message || String(e)
      this.update(id, { lastHealthy: false })
      logger.warn(`[CloudModelManager] 连通性校验失败（${m.modelId}）: ${err}`)
      return { healthy: false, latencyMs, modelExists: false, models: [], error: err }
    }
  }

  /**
   * 能力探测（§4.1）：通过 /models 端点真实探测，成功则缓存，失败给保守默认。
   * 结果写入 probedCapability + probedAt，供豆包 UI 展示「已探测/未探测」。
   */
  async probeCapability(id: string): Promise<ModelCapability> {
    const m = this.list().find(x => x.id === id)
    if (!m) {
      return conservativeCapability(id, 'custom')
    }
    // 有缓存直接返回（TTL 由 probedAt 控制，30s 内复用）
    if (m.probedCapability && m.probedAt && Date.now() - m.probedAt < 30_000) {
      return m.probedCapability
    }
    // 用户显式覆盖优先
    if (m.capability && m.capability.modelId) {
      const override: ModelCapability = {
        modelId: m.modelId,
        tier: 'cloud',
        scale: m.capability.scale ?? 'large',
        maxContextTokens: m.capability.maxContextTokens ?? 8192,
        nativeTools: m.capability.nativeTools ?? false,
        parallelTools: m.capability.parallelTools ?? false,
        reasoning: m.capability.reasoning ?? false,
        jsonMode: m.capability.jsonMode ?? false,
        vision: m.capability.vision ?? false,
        stream: m.capability.stream ?? true,
        costHint: m.capability.costHint ?? 'pricey',
        probed: true,
        source: 'manual-override',
      }
      this.cacheProbe(id, override)
      return override
    }

    const apiKey = this.getDecryptedApiKey(id)
    let cap: ModelCapability
    let healthy = false
    let modelExists = false
    try {
      const resp = await fetch(`${m.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      })
      healthy = resp.ok
      if (!resp.ok) {
        cap = conservativeCapability(m.modelId, m.provider)
      } else {
        cap = this.buildProbedCapability(m, apiKey)
        // A5：模型存在性 = 真实 /models 响应清单里包含本模型 id，杜绝假显示
        try {
          const data: any = await resp.clone().json()
          const models = Array.isArray(data?.data) ? data.data.map((x: any) => x?.id).filter(Boolean) : []
          modelExists = models.includes(m.modelId)
          cap.modelVerified = modelExists
        } catch { /* body 解析失败则保留 buildProbedCapability 的默认（未验证） */}
      }
    } catch (e) {
      logger.warn(`[CloudModelManager] 能力探测失败（${m.modelId}）: ${(e as Error)?.message}`)
      cap = conservativeCapability(m.modelId, m.provider)
    }
    // 更新最近可用性
    this.update(id, { lastHealthy: healthy })
    this.cacheProbe(id, cap)
    if (!modelExists && healthy) {
      logger.warn(`[CloudModelManager] 模型 ${m.modelId} 不在真实 /models 清单中（nameCheck 建议 ${cap.canonicalModelId || '未知'}）`)
    }
    return cap
  }

  /** 基于 provider 类型 + modelId 名称特征构建「已探测」能力；模型存在性由调用方经真实 /models 清单确认为准 */
  private buildProbedCapability(m: CloudModelEntry, _apiKey: string): ModelCapability {
    const modelId = m.modelId.toLowerCase()
    const nameCheck = validateModelName(m.modelId)
    return {
      modelId: m.modelId,
      tier: 'cloud',
      scale: /(405|671|mixtral|gpt-4\.5|claude.*opus|gemini.*ultra)/i.test(modelId) ? 'giant' : 'large',
      maxContextTokens: 128_000,
      nativeTools: true,
      parallelTools: true,
      reasoning: /(deepseek-r1|qwq|reasoning|o1|o3|kimi.*k2)/i.test(modelId) || nameCheck.canonicalModelId === 'deepseek-reasoner',
      jsonMode: true,
      vision: /(vision|vl|glm-4v|qwen.*vl|gpt-4o|gemini|claude.*sonnet)/i.test(modelId),
      stream: true,
      costHint: 'pricey',
      probed: true,
      source: 'probe',
      modelVerified: nameCheck.verified, // 名对齐才默认已验证；最终以真实 /models 清单为准（见 probeCapability）
      canonicalModelId: nameCheck.canonicalModelId,
    }
  }

  private cacheProbe(id: string, cap: ModelCapability): void {
    const models = this.list()
    const idx = models.findIndex(x => x.id === id)
    if (idx === -1) return
    models[idx].probedCapability = cap
    models[idx].probedAt = Date.now()
    this.save(models)
  }

  /**
   * failover（§4.2-1）：返回启用模型的备选链（主模型排最前，其余按注册顺序）。
   * 调用方在发起请求失败（鉴权/超时/限流/断网）后按此链切换。
   */
  failoverOrder(primaryId: string): CloudModelEntry[] {
    const all = this.list().filter(m => m.enabled)
    const primary = all.find(m => m.id === primaryId)
    const rest = all.filter(m => m.id !== primaryId)
    return primary ? [primary, ...rest] : rest
  }
}

export const cloudModelManager = new CloudModelManager()

/* ============================================================
 * IPC 处理器注册（契约字段写死，供豆包 renderer 消费）
 * ============================================================ */

export function setupCloudModelHandlers(): void {
  /* 列表（脱敏，含能力探测缓存 + 最近可用性） */
  ipcMain.handle('cloud-model:list', () => {
    try {
      return { success: true, models: cloudModelManager.listSanitized() }
    } catch (e: any) {
      logger.error('[CloudModel] list 失败:', e)
      return { success: false, error: e?.message || '获取失败' }
    }
  })

  /* 注册（baseUrl + modelId + apiKey 三项必填） */
  ipcMain.handle('cloud-model:add', (event, input: any) => {
    if (!validateSender(event)) return { success: false, error: '未授权的 IPC 调用' }
    return cloudModelManager.add(input)
  })

  /* 删除（校验无活动会话占用：删除不影响本地/其它 provider 推理） */
  ipcMain.handle('cloud-model:remove', (event, id: string) => {
    if (!validateSender(event)) return { success: false, error: '未授权的 IPC 调用' }
    return cloudModelManager.remove(id)
  })

  /* 更新（展示名/地址/能力标记/启用状态/apiKey） */
  ipcMain.handle('cloud-model:update', (event, id: string, patch: any) => {
    if (!validateSender(event)) return { success: false, error: '未授权的 IPC 调用' }
    return cloudModelManager.update(id, patch)
  })

  /* A5 修复：真实连通性校验（替代假显示 —— 真实请求 /models 并返回模型存在性） */
  ipcMain.handle('cloud-model:verify', async (event, id: string) => {
    if (!validateSender(event)) return { success: false, error: '未授权的 IPC 调用' }
    try {
      const result = await cloudModelManager.verifyConnectivity(id)
      return { success: true, ...result }
    } catch (e: any) {
      logger.error('[CloudModel] verify 失败:', e)
      return { success: false, error: e?.message || '校验失败' }
    }
  })

  /* 能力探测（真实 /models 探测，写 probedCapability 缓存） */
  ipcMain.handle('cloud-model:probe', async (event, id: string) => {
    if (!validateSender(event)) return { success: false, error: '未授权的 IPC 调用' }
    try {
      const cap = await cloudModelManager.probeCapability(id)
      return { success: true, capability: cap }
    } catch (e: any) {
      logger.error('[CloudModel] probe 失败:', e)
      return { success: false, error: e?.message || '探测失败' }
    }
  })

  /* failover 备选链 */
  ipcMain.handle('cloud-model:failover-order', (_event, primaryId: string) => {
    try {
      const order = cloudModelManager.failoverOrder(primaryId).map(m => ({ id: m.id, name: m.name, modelId: m.modelId }))
      return { success: true, order }
    } catch (e: any) {
      return { success: false, error: e?.message || '获取失败' }
    }
  })

  logger.info('[CloudModelManager] IPC handlers 已注册')
}
