import { ipcMain, BrowserWindow } from 'electron'
import { getStore } from './config.ipc'
import { logger } from '../../shared/logger'
import { apiQuotaTracker } from '../api-quota-tracker'
import { createProxyAgent } from '../utils/proxy-resolver'
import { classifyFetchError, classifyApiHttpError } from '../llm/provider'
import { encrypt, decrypt, mask } from '../secure/secure-store'

/** 带超时 + 代理的 fetch（外网 API 探测用） */
async function apiFetch(url: string, options: RequestInit = {}, timeoutMs: number = 15000): Promise<Response> {
  const agent = createProxyAgent()
  const fetchOptions: RequestInit & { dispatcher?: any } = {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(timeoutMs),
  }
  if (agent) fetchOptions.dispatcher = agent
  return fetch(url, fetchOptions as RequestInit)
}

interface ProviderConfig {
  id: string
  name: string
  type: string
  baseUrl?: string
  apiKey?: string
  models: string[]
}

// API 模型注册缓存（主进程内存）
interface APIModelCache {
  modelId: string
  provider: string
  alias: string
  mode: 'api'
  enabled: boolean
}

const apiModelCache = new Map<string, APIModelCache>()

/** 验证 URL 是否合法（必须以 https:// 开头） */
function isValidUrl(url: string): boolean {
  return /^https:\/\/.+/.test(url)
}

/** SSRF 防护：禁止访问内网地址 */
function isPrivateUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname
    // 127.0.0.x, 10.x.x.x, 172.16-31.x.x, 192.168.x.x, localhost
    if (/^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|localhost|0\.0\.0\.0)/.test(hostname)) {
      return true
    }
    // 169.254.x.x (link-local)
    if (/^169\.254\./.test(hostname)) {
      return true
    }
    return false
  } catch {
    return true // URL 解析失败，视为不安全
  }
}

/** 验证 IPC sender 是否为应用的渲染进程 */
function isAppRenderer(event: Electron.IpcMainInvokeEvent): boolean {
  const allowedIds = new Set(
    BrowserWindow.getAllWindows().map(w => w.webContents.id)
  )
  return allowedIds.has(event.sender.id)
}

export function setupLLMHandlers(): void {
  // A5 修复：一次性迁移历史上已明文落盘的 providers apiKey（$ENC$ 前缀为已加密）
  try {
    const store0 = getStore()
    const legacy: any[] = store0.get('providers') || []
    const needsMigration = legacy.some((p: any) => p.apiKey && !String(p.apiKey).startsWith('$ENC$'))
    if (needsMigration) {
      const migrated = legacy.map((p: any) => {
        if (!p.apiKey || String(p.apiKey).startsWith('$ENC$')) return p
        const encrypted = encrypt(p.apiKey)
        return { ...p, apiKey: encrypted ?? p.apiKey }
      })
      store0.set('providers', migrated)
      logger.info(`[llm.ipc] 已迁移 ${migrated.filter((p, i) => p.apiKey !== legacy[i]?.apiKey).length} 个 provider 的明文 apiKey 为 safeStorage 加密`)
    }
  } catch (e) {
    logger.warn('[llm.ipc] providers 明文 key 迁移失败（跳过）:', e)
  }

  ipcMain.handle('llm:list-providers', () => {
    try {
      const providers = getStore().get('providers') || []
      return providers.map((p: any) => ({
        ...p,
        apiKey: p.apiKey ? mask(decrypt(p.apiKey)) : undefined,
      }))
    } catch (error) {
      logger.error('llm:list-providers error:', error)
      return []
    }
  })

  ipcMain.handle('llm:add-provider', (event, config: ProviderConfig) => {
    // IPC 调用者授权校验
    if (!isAppRenderer(event)) {
      logger.warn('[llm.ipc] llm:add-provider 被未授权调用者访问，sender.id:', event.sender.id)
      return { error: '未授权的调用者' }
    }

    try {
      const store = getStore()
      const providers = store.get('providers') || []
      const exists = providers.find((p: ProviderConfig) => p.id === config.id)

      if (exists) {
        return { error: 'Provider already exists' }
      }

      // URL 验证 + SSRF 防护
      if (config.baseUrl && !isValidUrl(config.baseUrl)) {
        return { error: 'Invalid baseUrl: must start with https://' }
      }
      if (config.baseUrl && isPrivateUrl(config.baseUrl)) {
        return { error: 'Security: internal/private addresses are not allowed' }
      }

      // A5 修复：apiKey 以 safeStorage 加密后落盘，杜绝明文
      const encrypted = config.apiKey ? (encrypt(config.apiKey) ?? '') : undefined
      const toStore: ProviderConfig = { ...config, apiKey: encrypted }

      providers.push(toStore)
      store.set('providers', providers)

      // 同步初始化 API 配额记录
      if (apiQuotaTracker && config.type !== 'ollama') {
        for (const modelId of config.models) {
          apiQuotaTracker.trackUsage(modelId, 0)
          apiModelCache.set(modelId, {
            modelId,
            provider: config.id,
            alias: modelId,
            mode: 'api',
            enabled: true,
          })
        }
      }

      return { success: true }
    } catch (error) {
      logger.error('llm:add-provider error:', error)
      logger.error('llm:add-provider 内部错误:', error)
      return { error: 'LLM Provider 操作遇到内部错误' }
    }
  })

  ipcMain.handle('llm:update-provider', (event, id: string, config: Partial<ProviderConfig>) => {
    // IPC 调用者授权校验（与 add/delete 保持一致）
    if (!isAppRenderer(event)) {
      logger.warn('[llm.ipc] llm:update-provider 被未授权调用者访问，sender.id:', event.sender.id)
      return { error: '未授权的调用者' }
    }

    try {
      const store = getStore()
      const providers = store.get('providers') || []
      const index = providers.findIndex((p: ProviderConfig) => p.id === id)

      if (index === -1) {
        return { error: 'Provider not found' }
      }

      // URL 验证 + SSRF 防护
      if (config.baseUrl && !isValidUrl(config.baseUrl)) {
        return { error: 'Invalid baseUrl: must start with https://' }
      }
      if (config.baseUrl && isPrivateUrl(config.baseUrl)) {
        return { error: 'Security: internal/private addresses are not allowed' }
      }
      const merged = { ...providers[index], ...config }
      // 前端未提供新 key（如页面刷新后内存态为空）时保留原 key，防止误清空已保存的密钥
      if (!config.apiKey) {
        merged.apiKey = providers[index].apiKey
      } else if (!String(config.apiKey).startsWith('$ENC$')) {
        // A5 修复：新 key 以 safeStorage 加密后落盘，杜绝明文
        merged.apiKey = encrypt(config.apiKey) ?? ''
      }
      providers[index] = merged
      store.set('providers', providers)

      // 同步更新 API 配额记录（如果 models 有变化）
      if (apiQuotaTracker && config.models && providers[index].type !== 'ollama') {
        for (const modelId of config.models) {
          if (!apiModelCache.has(modelId)) {
            apiQuotaTracker.trackUsage(modelId, 0)
            apiModelCache.set(modelId, {
              modelId,
              provider: providers[index].id,
              alias: modelId,
              mode: 'api',
              enabled: true,
            })
          }
        }
      }

      return { success: true }
    } catch (error) {
      logger.error('llm:update-provider 内部错误:', error)
      return { error: 'LLM Provider 操作遇到内部错误' }
    }
  })

  ipcMain.handle('llm:delete-provider', (event, id: string) => {
    // IPC 调用者授权校验
    if (!isAppRenderer(event)) {
      logger.warn('[llm.ipc] llm:delete-provider 被未授权调用者访问，sender.id:', event.sender.id)
      return { error: '未授权的调用者' }
    }

    try {
      const store = getStore()
      const providers = store.get('providers') || []
      const filtered = providers.filter((p: ProviderConfig) => p.id !== id)
      store.set('providers', filtered)
      return { success: true }
    } catch (error) {
      logger.error('llm:delete-provider 内部错误:', error)
      return { error: 'LLM Provider 操作遇到内部错误' }
    }
  })

  ipcMain.handle('llm:set-active-provider', (event, id: string) => {
    // IPC 调用者授权校验
    if (!isAppRenderer(event)) {
      logger.warn('[llm.ipc] llm:set-active-provider 被未授权调用者访问，sender.id:', event.sender.id)
      return { error: '未授权的调用者' }
    }

    try {
      getStore().set('activeProvider', id)
      return true
    } catch (error) {
      logger.error('llm:set-active-provider error:', error)
      return false
    }
  })

  ipcMain.handle('llm:test-provider', async (_event, config: ProviderConfig) => {
    try {
      if (!config.baseUrl) {
        return { error: 'baseUrl is required' }
      }

      // URL 验证
      if (!isValidUrl(config.baseUrl)) {
        return { error: 'Invalid baseUrl: must start with https://' }
      }

      // SSRF 防护
      if (isPrivateUrl(config.baseUrl)) {
        return { error: 'Access to internal/private networks is not allowed' }
      }

      const response = await apiFetch(config.baseUrl + '/models', {
        headers: {
          'Authorization': `Bearer ${config.apiKey}`
        }
      }, 10000)
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
        return { error: classifyApiHttpError(response.status, detail, config.name || '云端 API').message }
      }
      return { success: true }
    } catch (error) {
      logger.error('llm:test-provider 内部错误:', error)
      return { error: classifyFetchError(error, '连接测试').message }
    }
  })

  // 拉取 API 模型列表（/v1/models 端点），供模型设置页“拉取模型”使用
  ipcMain.handle('llm:fetch-models', async (_event, config: { provider: string; apiKey?: string; baseUrl?: string; url?: string }) => {
    try {
      const target = (config.url || (config.baseUrl ? `${config.baseUrl.replace(/\/+$/, '')}/models` : '')).replace(/\/+$/, '')
      if (!target) {
        return { error: 'baseUrl is required' }
      }

      // URL 验证 + SSRF 防护
      if (!isValidUrl(target)) {
        return { error: 'Invalid URL: must start with https://' }
      }
      if (isPrivateUrl(target)) {
        return { error: 'Access to internal/private networks is not allowed' }
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`
      }

      const response = await apiFetch(target, { headers })
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
        return { error: classifyApiHttpError(response.status, detail, config.provider || '云端 API').message }
      }
      const data = await response.json()
      const rawModels = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []
      const models = rawModels.map((m: { id?: string }) => ({ id: m.id || '', name: m.id || '' })).filter((m: { id: string }) => m.id)
      return { models }
    } catch (error) {
      logger.error('llm:fetch-models error:', error)
      return { error: classifyFetchError(error, '拉取模型列表').message }
    }
  })

  // ========== 玄枢 API 配额与模型管理 ==========

  ipcMain.handle('llm:api-quotas', () => {
    try {
      if (!apiQuotaTracker) {
        return { error: 'api-quota-tracker 模块未就绪' }
      }
      return apiQuotaTracker.getAllQuotas()
    } catch (error) {
      logger.error('llm:api-quotas error:', error)
      return { error: '获取配额失败' }
    }
  })

  ipcMain.handle('llm:api-quota', (_event, modelId: string) => {
    try {
      if (!apiQuotaTracker) {
        return { error: 'api-quota-tracker 模块未就绪' }
      }
      return apiQuotaTracker.getQuota(modelId)
    } catch (error) {
      logger.error('llm:api-quota error:', error)
      return { error: '获取单个模型配额失败' }
    }
  })

  ipcMain.handle('llm:set-quota-alert', (_event, modelId: string, threshold: number) => {
    try {
      if (!apiQuotaTracker) {
        return { error: 'api-quota-tracker 模块未就绪' }
      }
      apiQuotaTracker.setAlertThreshold(modelId, threshold)
      return { success: true }
    } catch (error) {
      logger.error('llm:set-quota-alert error:', error)
      return { error: '设置告警阈值失败' }
    }
  })

  ipcMain.handle('llm:toggle-api-model', (event, modelId: string, enabled: boolean) => {
    // IPC 调用者授权校验
    if (!isAppRenderer(event)) {
      logger.warn('[llm.ipc] llm:toggle-api-model 被未授权调用者访问，sender.id:', event.sender.id)
      return { error: '未授权的调用者' }
    }

    try {
      const cached = apiModelCache.get(modelId)
      if (!cached) {
        return { error: `模型 ${modelId} 未在 API 缓存中` }
      }
      cached.enabled = enabled
      apiModelCache.set(modelId, cached)
      return { success: true, modelId, enabled }
    } catch (error) {
      logger.error('llm:toggle-api-model error:', error)
      return { error: '切换 API 模型状态失败' }
    }
  })

  ipcMain.handle('llm:list-api-models', () => {
    try {
      const result: Array<APIModelCache & { quota?: any }> = []
      for (const [modelId, cached] of apiModelCache) {
        const entry: any = { ...cached }
        if (apiQuotaTracker) {
          entry.quota = apiQuotaTracker.getQuota(modelId)
        }
        result.push(entry)
      }
      return { models: result }
    } catch (error) {
      logger.error('llm:list-api-models error:', error)
      return { error: '获取 API 模型列表失败' }
    }
  })
}
