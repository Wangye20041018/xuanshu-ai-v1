/**
 * 云端模型余量监控 v12.2
 *
 * 职责：
 *   1. 持久化记录每个云端 provider 的用量估算（token 口径）
 *   2. 提供余量查询 / 上限设置 / 用量归零
 *   3. 粗略估算文本 token 数（无 usage 返回时兜底）
 *   4. 远程账单查询（OpenAI 兼容 /v1/dashboard/billing，多数中转站支持）
 *
 * 安全口径：仅做只读查询与本地记账，不触碰密钥明文；
 *          余量耗尽时提示降级本地模型，绝不静默绕行。
 */
import { ipcMain } from 'electron'
import { logger } from '../../shared/logger'
import { getStore } from '../ipc/config.ipc'

export interface QuotaEntry {
  /** 云 provider id（与 config.providers[].id 对齐） */
  providerId: string
  /** 估算上限 tokens；0 表示不限制 */
  limitTokens: number
  /** 已用估算 tokens */
  usedTokens: number
  /** 最近一次请求的 prompt tokens（估算） */
  lastPromptTokens: number
  /** 最近一次请求的 completion tokens（估算） */
  lastCompletionTokens: number
  /** 最近更新时间 */
  updatedAt: number
}

const QUOTA_KEY = 'cloudQuota'

class CloudQuotaManager {
  private get store() {
    return getStore()
  }

  private normalize(raw: Partial<QuotaEntry> | undefined, providerId: string): QuotaEntry {
    return {
      providerId: raw?.providerId || providerId,
      limitTokens: raw?.limitTokens ?? 0,
      usedTokens: raw?.usedTokens ?? 0,
      lastPromptTokens: raw?.lastPromptTokens ?? 0,
      lastCompletionTokens: raw?.lastCompletionTokens ?? 0,
      updatedAt: raw?.updatedAt ?? Date.now(),
    }
  }

  list(): QuotaEntry[] {
    try {
      const arr = this.store.get(QUOTA_KEY, [])
      return Array.isArray(arr) ? arr : []
    } catch {
      return []
    }
  }

  getQuota(providerId: string): QuotaEntry | null {
    return this.list().find(q => q.providerId === providerId) || null
  }

  setLimit(providerId: string, limitTokens: number): void {
    const arr = this.list()
    const idx = arr.findIndex(q => q.providerId === providerId)
    const entry = this.normalize(idx >= 0 ? arr[idx] : undefined, providerId)
    entry.limitTokens = Math.max(0, limitTokens)
    entry.updatedAt = Date.now()
    if (idx >= 0) arr[idx] = entry
    else arr.push(entry)
    this.store.set(QUOTA_KEY, arr)
    logger.info(`[CloudQuota] 设置余量上限: ${providerId} = ${limitTokens} tokens`)
  }

  /** 记录一次云端调用用量（累加），prompt/completion 未提供时按 0 处理 */
  recordUsage(providerId: string, promptTokens: number = 0, completionTokens: number = 0): void {
    try {
      const arr = this.list()
      const idx = arr.findIndex(q => q.providerId === providerId)
      const entry = this.normalize(idx >= 0 ? arr[idx] : undefined, providerId)
      entry.usedTokens += Math.max(0, promptTokens) + Math.max(0, completionTokens)
      entry.lastPromptTokens = promptTokens
      entry.lastCompletionTokens = completionTokens
      entry.updatedAt = Date.now()
      if (idx >= 0) arr[idx] = entry
      else arr.push(entry)
      this.store.set(QUOTA_KEY, arr)
      logger.debug(`[CloudQuota] 记录用量: ${providerId} +${promptTokens + completionTokens} tokens`)
    } catch (e) {
      logger.error('[CloudQuota] recordUsage 失败:', e)
    }
  }

  /** 是否已耗尽（设置了上限且已用 ≥ 上限） */
  isExhausted(providerId: string): boolean {
    const q = this.getQuota(providerId)
    if (!q || q.limitTokens <= 0) return false
    return q.usedTokens >= q.limitTokens
  }

  reset(providerId?: string): void {
    if (providerId) {
      const arr = this.list().filter(q => q.providerId !== providerId)
      this.store.set(QUOTA_KEY, arr)
    } else {
      this.store.set(QUOTA_KEY, [])
    }
    logger.info(`[CloudQuota] 用量已重置: ${providerId || '全部'}`)
  }

  /**
   * 粗略估算文本 token 数（无 usage 返回时兜底）：
   * 中文约 1.5 字符/token，英文约 4 字符/token，混合取 3 字符/token。
   */
  estimateTokens(text: string): number {
    if (!text) return 0
    const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
    const other = text.length - cjk
    return Math.ceil(cjk / 1.5 + other / 4)
  }

  /**
   * 查询远程账单余量（OpenAI 兼容 billing 接口，多数中转站支持）。
   * 只读查询；失败返回 null（不阻塞主流程）。
   */
  async queryRemoteBalance(baseUrl: string, apiKey: string): Promise<{ total: number; used: number; remaining: number } | null> {
    try {
      const normalized = baseUrl.replace(/\/+$/, '')
      const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
      const subUrl = `${normalized}/v1/dashboard/billing/subscription`
      const subRes = await fetch(subUrl, { headers, signal: AbortSignal.timeout(8000) })
      if (!subRes.ok) return null
      const sub = await subRes.json()
      const hardLimitUsd = Number(sub?.hard_limit_usd ?? 0)
      if (!hardLimitUsd) return null
      const usageRes = await fetch(
        `${normalized}/v1/dashboard/billing/usage?start_date=${encodeURIComponent('1970-01-01')}&end_date=${encodeURIComponent(new Date().toISOString().slice(0, 10))}`,
        { headers, signal: AbortSignal.timeout(8000) },
      )
      const usage = usageRes.ok ? await usageRes.json() : null
      const usedUsd = Number(usage?.total_usage ?? 0) / 100
      return {
        total: hardLimitUsd,
        used: usedUsd,
        remaining: Math.max(0, hardLimitUsd - usedUsd),
      }
    } catch (e) {
      logger.debug(`[CloudQuota] 远程账单查询失败（忽略）: ${e}`)
      return null
    }
  }
}

export const cloudQuota = new CloudQuotaManager()

/**
 * 注册 cloud-quota IPC 通道
 */
export function setupCloudQuotaHandlers(): void {
  ipcMain.handle('cloud-quota:list', () => cloudQuota.list())

  ipcMain.handle('cloud-quota:get', (_e, providerId: string) => {
    if (!providerId) return null
    return cloudQuota.getQuota(providerId)
  })

  ipcMain.handle('cloud-quota:set-limit', (_e, providerId: string, limitTokens: number) => {
    if (!providerId) return { success: false, error: 'providerId 不能为空' }
    cloudQuota.setLimit(providerId, Number(limitTokens) || 0)
    return { success: true, quota: cloudQuota.getQuota(providerId) }
  })

  ipcMain.handle('cloud-quota:record-usage', (_e, providerId: string, promptTokens: number, completionTokens: number) => {
    if (!providerId) return { success: false, error: 'providerId 不能为空' }
    cloudQuota.recordUsage(providerId, Number(promptTokens) || 0, Number(completionTokens) || 0)
    return { success: true, quota: cloudQuota.getQuota(providerId) }
  })

  ipcMain.handle('cloud-quota:reset', (_e, providerId?: string) => {
    cloudQuota.reset(providerId || undefined)
    return { success: true }
  })

  ipcMain.handle('cloud-quota:remote-balance', async (_e, baseUrl: string, apiKey: string) => {
    if (!baseUrl || !apiKey) return null
    return cloudQuota.queryRemoteBalance(baseUrl, apiKey)
  })
}
