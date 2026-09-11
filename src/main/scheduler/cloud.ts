/**
 * 智能模型调度系统 — 云端补救模块
 *
 * 职责：复杂任务本地能力不足 / 本地模型全部失败时，升级调用云端 Provider。
 * 复用项目已有链路（不重复实现）：
 * - 云端 Provider：config.providers + LLMProviderRegistry（OpenAIProvider）
 * - 配额校验：cloudQuota.setLimit / isExhausted
 * - 用量记账：cloudQuota.recordUsage / estimateTokens
 *
 * 降级保证：云端调用失败（无效 key / 余额不足 / 网络错误 / 无网）返回结构化
 * 失败结果，由调用方（scheduler.run）回退本地模型，保证离线可用。
 *
 * @module scheduler/cloud
 */

import { randomUUID } from 'node:crypto'
import { logger } from '../../shared/logger'
import { getStore } from '../ipc/config.ipc'
import { cloudQuota } from '../cloud-quota'
import { LLMProviderRegistry } from '../llm/provider-registry'
import { decrypt } from '../secure/secure-store'
import type { LLMProvider } from '../llm/provider'
import type { SchedulerCloudConfig } from './types'

export interface CloudCallOptions {
  /** 用户请求原文（用于 token 估算与生成） */
  text: string
  /** 云端配置 */
  cloud: SchedulerCloudConfig
  /** 生成参数 */
  temperature?: number
  maxTokens?: number
}

export interface CloudCallResult {
  success: boolean
  content?: string
  providerId?: string
  modelId?: string
  /** 失败/跳过原因 */
  reason?: string
  /** 失败是否可判定为"配额耗尽"（前端提示充值/降级） */
  exhausted?: boolean
  elapsedMs?: number
  tokensPerSec?: number
  promptTokens?: number
  completionTokens?: number
}

/** 从 config.providers 中解析云端 Provider 配置（无有效配置返回 null） */
export function resolveCloudProviderConfig(preferredId?: string): {
  id: string
  name: string
  type: string
  baseUrl: string
  apiKey: string
  models: string[]
} | null {
  try {
    const store = getStore()
    const providers: any[] = store.get('providers') || []
    const activeProviderId: string = store.get('activeProvider') || ''
    // 优先取指定 providerId（调度云端配置）；否则取全局 activeProvider（跳过本地伪 provider）
    const targetId =
      (preferredId && !preferredId.startsWith('__local')) ? preferredId
      : (!activeProviderId.startsWith('__local') ? activeProviderId : '')
    if (!targetId) return null
    const cfg = providers.find((p: any) => p.id === targetId)
    if (!cfg || !cfg.apiKey || !cfg.baseUrl) return null
    if (cfg.type !== 'openai') return null // 调度系统云端补救目前支持 OpenAI 兼容
    return {
      id: cfg.id,
      name: cfg.name || cfg.id,
      type: cfg.type,
      baseUrl: cfg.baseUrl,
      apiKey: decrypt(cfg.apiKey),
      models: Array.isArray(cfg.models) ? cfg.models : [],
    }
  } catch (e) {
    logger.warn(`[SchedulerCloud] 解析云端 Provider 失败: ${(e as Error)?.message ?? String(e)}`)
    return null
  }
}

/** 获取（或惰性创建并注册）云端 Provider 实例 */
function getOrCreateProvider(cfg: { id: string; name: string; type: string; baseUrl: string; apiKey: string; model: string }): LLMProvider {
  const existing = LLMProviderRegistry.getProvider(cfg.id)
  if (existing) return existing
  const provider = LLMProviderRegistry.createProvider({
    id: cfg.id,
    name: cfg.name,
    type: cfg.type,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
  })
  LLMProviderRegistry.registerProvider(provider)
  return provider
}

/** 判定任务是否属于"复杂任务"（应升级云端） */
export function isComplexForCloud(taskType: string, textLength: number, cloud: SchedulerCloudConfig): boolean {
  if (!cloud.complexOnly) return true
  const complexTypes = ['deep', 'code', 'longctx']
  if (complexTypes.includes(taskType)) return true
  if (textLength >= (cloud.complexThreshold || 8000)) return true
  return false
}

/**
 * 升级云端调用（配额前置校验 + 调用后记账）。
 * 返回结构化结果，失败不抛异常（由调用方决定回退本地）。
 */
export async function callCloud(opts: CloudCallOptions): Promise<CloudCallResult> {
  const { text, cloud } = opts
  const t0 = Date.now()

  // 0) 云端开关检查
  if (!cloud || !cloud.enabled) {
    return { success: false, reason: '云端补救未启用' }
  }
  if (!cloud.providerId) {
    return { success: false, reason: '未配置云端 Provider id' }
  }

  // 1) 解析云端 Provider（从 config.providers）
  const resolved = resolveCloudProviderConfig(cloud.providerId)
  if (!resolved || resolved.id !== cloud.providerId) {
    return { success: false, reason: '云端 Provider 未配置或未激活（请在模型设置中启用云端并填写 API Key）' }
  }

  // 2) 配额前置校验：耗尽即不升云端
  if (cloudQuota.isExhausted(resolved.id)) {
    return { success: false, reason: '云端 token 配额已耗尽（本地模型保持可用）', exhausted: true }
  }

  // 3) 选择云端模型（配置指定 > provider.models 第一个）
  const modelId = cloud.modelId || resolved.models[0] || ''
  if (!modelId) {
    return { success: false, reason: '云端模型未指定' }
  }

  // 4) 获取/创建 Provider 并调用
  const provider = getOrCreateProvider({ ...resolved, model: modelId })
  const messages = [{ id: randomUUID(), role: 'user' as const, content: text }]
  try {
    const content = await provider.generate(messages)
    const elapsed = Date.now() - t0

    // 5) 调用后记账（估算 token）
    const promptTokens = cloudQuota.estimateTokens(text)
    const completionTokens = cloudQuota.estimateTokens(content)
    cloudQuota.recordUsage(resolved.id, promptTokens, completionTokens)

    const tokensPerSec = elapsed > 0 ? Math.round((promptTokens + completionTokens) / (elapsed / 1000)) : 0
    logger.info(`[SchedulerCloud] 云端 ${resolved.id}/${modelId} 成功，${elapsed}ms`)
    return {
      success: true,
      content,
      providerId: resolved.id,
      modelId,
      elapsedMs: elapsed,
      tokensPerSec,
      promptTokens,
      completionTokens,
    }
  } catch (e: any) {
    const elapsed = Date.now() - t0
    const reason = e?.message || '云端调用失败'
    logger.warn(`[SchedulerCloud] 云端调用失败（${elapsed}ms）: ${reason}，将回退本地模型`)
    return { success: false, reason, elapsedMs: elapsed }
  }
}
