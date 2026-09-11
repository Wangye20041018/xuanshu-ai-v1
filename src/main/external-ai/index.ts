import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { logger } from '../../shared/logger'
import { createProxyAgent } from '../utils/proxy-resolver'

interface ImageGenerationResult {
  success: boolean
  url?: string
  localPath?: string
  error?: string
  provider: string
}

interface VideoGenerationResult {
  success: boolean
  url?: string
  localPath?: string
  error?: string
  provider: string
}

interface ExternalProvider {
  id: string
  name: string
  type: 'image' | 'video' | 'both'
  freeQuota: number
  remainingQuota: number
  enabled: boolean
  priority: number
  baseUrl: string
  apiKey?: string
  timeout: number
  maxRetries: number
}

interface CacheEntry {
  prompt: string
  result: ImageGenerationResult | VideoGenerationResult
  timestamp: number
  ttl: number
}

class ExternalAIClient {
  private providers: ExternalProvider[] = [
    {
      id: 'stable-diffusion',
      name: 'Stable Diffusion',
      type: 'image',
      freeQuota: 50,
      remainingQuota: 50,
      enabled: true,
      priority: 2,
      baseUrl: 'https://stablediffusionweb.com',
      timeout: 60000,
      maxRetries: 2
    },
    {
      id: 'flux',
      name: 'FLUX.1',
      type: 'image',
      freeQuota: 20,
      remainingQuota: 20,
      enabled: true,
      priority: 3,
      baseUrl: 'https://blackforestlabs.ai',
      timeout: 90000,
      maxRetries: 1
    },
    {
      id: 'pika',
      name: 'Pika',
      type: 'video',
      freeQuota: 10,
      remainingQuota: 10,
      enabled: true,
      priority: 1,
      baseUrl: 'https://pika.art',
      timeout: 120000,
      maxRetries: 2
    },
    {
      id: 'runway',
      name: 'Runway',
      type: 'video',
      freeQuota: 5,
      remainingQuota: 5,
      enabled: true,
      priority: 2,
      baseUrl: 'https://runwayml.com',
      timeout: 120000,
      maxRetries: 1
    },
    {
      id: 'kapwing',
      name: 'Kapwing',
      type: 'video',
      freeQuota: 25,
      remainingQuota: 25,
      enabled: true,
      priority: 3,
      baseUrl: 'https://kapwing.com',
      timeout: 90000,
      maxRetries: 2
    }
  ]

  private outputDir: string | null = null
  private cacheDir: string | null = null
  private settingsPath: string | null = null
  private historyPath: string | null = null
  private cache: Map<string, CacheEntry> = new Map()
  private requestHistory: Array<{ provider: string; success: boolean; timestamp: number; latency: number }> = []
  private initialized: boolean = false
  private quotaLock: Promise<void> = Promise.resolve()

  constructor() {
    // 延迟初始化，等待 app ready
  }

  initialize(): void {
    if (this.initialized) return
    this.outputDir = join(app.getPath('pictures'), '玄枢生成')
    this.cacheDir = join(app.getPath('userData'), 'ai-cache')
    this.settingsPath = join(app.getPath('userData'), 'external-ai-settings.json')
    this.historyPath = join(app.getPath('userData'), 'external-ai-history.json')
    mkdirSync(this.outputDir, { recursive: true })
    mkdirSync(this.cacheDir, { recursive: true })
    this.loadCache()
    this.loadHistory()
    this.initialized = true
  }

  private loadCache(): void {
    if (!this.cacheDir) this.initialize()
    if (!this.cacheDir) return
    const cacheFile = join(this.cacheDir, 'cache.json')
    if (existsSync(cacheFile)) {
      try {
        const data = JSON.parse(readFileSync(cacheFile, 'utf-8'))
        if (!Array.isArray(data)) return
        const now = Date.now()
        data.forEach((entry: CacheEntry) => {
          if (entry.timestamp + entry.ttl > now) {
            this.cache.set(entry.prompt, entry)
          }
        })
      } catch (e) { logger.error('[ExternalAI] 加载缓存文件失败:', e) }
    }
  }

  private saveCache(): void {
    if (!this.cacheDir) this.initialize()
    if (!this.cacheDir) return
    try {
      const cacheFile = join(this.cacheDir, 'cache.json')
      const data = Array.from(this.cache.values())
      writeFileSync(cacheFile, JSON.stringify(data))
    } catch (e) { logger.error('[ExternalAI] 保存缓存文件失败:', e) }
  }

  private addCache(prompt: string, result: ImageGenerationResult | VideoGenerationResult, ttl: number = 3600000): void {
    this.cache.set(prompt, { prompt, result, timestamp: Date.now(), ttl })
    
    if (this.cache.size > 100) {
      const oldestKey = Array.from(this.cache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp)[0][0]
      this.cache.delete(oldestKey)
    }
    
    this.saveCache()
  }

  private getCache(prompt: string): ImageGenerationResult | VideoGenerationResult | null {
    const entry = this.cache.get(prompt)
    if (entry && entry.timestamp + entry.ttl > Date.now()) {
      return entry.result
    }
    return null
  }

  private recordRequest(provider: string, success: boolean, latency: number): void {
    this.requestHistory.push({ provider, success, timestamp: Date.now(), latency })
    
    if (this.requestHistory.length > 100) {
      this.requestHistory = this.requestHistory.slice(-100)
    }
    this.saveHistory()
  }

  private loadHistory(): void {
    if (!this.historyPath) return
    try {
      if (existsSync(this.historyPath)) {
        const data = JSON.parse(readFileSync(this.historyPath, 'utf-8'))
        if (Array.isArray(data)) this.requestHistory = data
      }
    } catch (e) { logger.error('[ExternalAI] 加载历史记录失败:', e) }
  }

  private saveHistory(): void {
    if (!this.historyPath) return
    try {
      writeFileSync(this.historyPath, JSON.stringify(this.requestHistory))
    } catch (e) { logger.error('[ExternalAI] 保存历史记录失败:', e) }
  }

  private getProviderStats(providerId: string): { successRate: number; avgLatency: number } {
    const providerRequests = this.requestHistory.filter(r => r.provider === providerId)
    if (providerRequests.length === 0) {
      return { successRate: 0.8, avgLatency: 30000 }
    }
    
    const successCount = providerRequests.filter(r => r.success).length
    const avgLatency = providerRequests.reduce((sum, r) => sum + r.latency, 0) / providerRequests.length
    
    return {
      successRate: successCount / providerRequests.length,
      avgLatency
    }
  }

  async generateImage(prompt: string, style?: string): Promise<ImageGenerationResult> {
    const cacheKey = `${prompt}-${style || 'default'}`
    const cachedResult = this.getCache(cacheKey)
    if (cachedResult) {
      return cachedResult as ImageGenerationResult
    }

    const imageProviders = this.providers
      .filter(p => p.type === 'image' && p.enabled && p.remainingQuota > 0)
      .sort((a, b) => {
        const statsA = this.getProviderStats(a.id)
        const statsB = this.getProviderStats(b.id)
        const scoreA = a.priority * 10 + statsA.successRate * 100 - statsA.avgLatency / 1000
        const scoreB = b.priority * 10 + statsB.successRate * 100 - statsB.avgLatency / 1000
        return scoreB - scoreA
      })

    for (const provider of imageProviders) {
      const result = await this.tryGenerateImage(prompt, provider, style)
      if (result.success) {
        await this.withQuotaLock(async () => {
          provider.remainingQuota--
        })
        this.addCache(cacheKey, result)
        return result
      }
    }

    return {
      success: false,
      error: '所有图片生成服务均失败',
      provider: 'fallback'
    }
  }

  private async tryGenerateImage(
    prompt: string,
    provider: ExternalProvider,
    style?: string
  ): Promise<ImageGenerationResult> {
    const startTime = Date.now()
    
    for (let attempt = 0; attempt < provider.maxRetries + 1; attempt++) {
      try {
        let result: ImageGenerationResult
        
        switch (provider.id) {
          case 'stable-diffusion':
            result = await this.generateWithStableDiffusion(prompt, style)
            break
          case 'flux':
            result = await this.generateWithFlux(prompt)
            break
          default:
            result = { success: false, error: 'Unsupported provider', provider: provider.id }
        }

        const latency = Date.now() - startTime
        this.recordRequest(provider.id, result.success, latency)
        
        if (result.success) {
          return result
        }
        
        if (attempt < provider.maxRetries) {
          await this.delay((attempt + 1) * 2000)
        }
        
      } catch (error) {
        if (attempt >= provider.maxRetries) {
          const latency = Date.now() - startTime
          this.recordRequest(provider.id, false, latency)
          return { success: false, error: String(error), provider: provider.id }
        }
        await this.delay((attempt + 1) * 2000)
      }
    }
    
    return { success: false, error: 'Max retries exceeded', provider: provider.id }
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  private async withQuotaLock<T>(fn: () => Promise<T>): Promise<T> {
    const currentLock = this.quotaLock
    let releaseLock: () => void
    this.quotaLock = new Promise<void>(resolve => { releaseLock = resolve })
    await currentLock
    try {
      return await fn()
    } finally {
      releaseLock!()
    }
  }

  private async fetchWithTimeout(url: string, options: RequestInit, timeout: number): Promise<Response> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)
    const agent = createProxyAgent()
    const fetchOptions: RequestInit & { dispatcher?: any } = { ...options, signal: controller.signal }
    if (agent) fetchOptions.dispatcher = agent

    try {
      const response = await fetch(url, fetchOptions as RequestInit)
      clearTimeout(timeoutId)
      return response
    } catch (e) {
      clearTimeout(timeoutId)
      const err = e as Error
      if (err?.name === 'AbortError') throw new Error('Request timed out')
      throw e
    }
  }

  // 从环境变量或配置读取API Key，未配置时返回明确错误
  private getApiKey(providerId: string): string | null {
    // 优先从环境变量读取
    const envKey = process.env[`XUANSHU_API_KEY_${providerId.toUpperCase().replace(/-/g, '_')}`]
    if (envKey && envKey !== 'empty') return envKey

    // 从配置文件中读取（如果有的话）
    try {
      const configPath = join(app.getPath('userData'), 'external-ai-config.json')
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'))
        if (config[providerId]?.apiKey) return config[providerId].apiKey
      }
    } catch (e) { logger.error('[ExternalAI] 读取API配置失败:', e) }

    return null
  }

  private async generateWithStableDiffusion(prompt: string, style?: string): Promise<ImageGenerationResult> {
    const apiKey = this.getApiKey('stable-diffusion')
    if (!apiKey) {
      return { success: false, error: '未配置 DeepInfra API Key，请在设置中添加', provider: 'stable-diffusion' }
    }

    try {
      const stylePrompt = style ? `${prompt}, ${style}` : prompt
      
      const response = await this.fetchWithTimeout('https://api.deepinfra.com/v1/inference/stability-ai/stable-diffusion-xl-base-1.0', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          prompt: stylePrompt,
          negative_prompt: 'low quality, blurry, distorted, ugly',
          width: 1024,
          height: 1024,
          num_inference_steps: 30,
          guidance_scale: 7
        })
      }, 60000)

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}`, provider: 'stable-diffusion' }
      }

      const data = await response.json()
      if (data.output?.image_url) {
        const localPath = await this.downloadAndSave(data.output.image_url, 'png')
        return { success: true, url: data.output.image_url, localPath, provider: 'stable-diffusion' }
      }

      return { success: false, error: 'No image returned', provider: 'stable-diffusion' }
    } catch (error) {
      return { success: false, error: String(error), provider: 'stable-diffusion' }
    }
  }

  private async generateWithFlux(prompt: string): Promise<ImageGenerationResult> {
    try {
      const response = await this.fetchWithTimeout('https://api.blackforestlabs.ai/api/v1/generation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt,
          model: 'flux.1-schnell',
          width: 1024,
          height: 1024
        })
      }, 90000)

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}`, provider: 'flux' }
      }

      const data = await response.json()
      if (data.output?.image_url) {
        const localPath = await this.downloadAndSave(data.output.image_url, 'png')
        return { success: true, url: data.output.image_url, localPath, provider: 'flux' }
      }

      return { success: false, error: 'No image returned', provider: 'flux' }
    } catch (error) {
      return { success: false, error: String(error), provider: 'flux' }
    }
  }

  async generateVideo(prompt: string): Promise<VideoGenerationResult> {
    const cacheKey = `video-${prompt}`
    const cachedResult = this.getCache(cacheKey)
    if (cachedResult) {
      return cachedResult as VideoGenerationResult
    }

    const videoProviders = this.providers
      .filter(p => p.type === 'video' && p.enabled && p.remainingQuota > 0)
      .sort((a, b) => {
        const statsA = this.getProviderStats(a.id)
        const statsB = this.getProviderStats(b.id)
        const scoreA = a.priority * 10 + statsA.successRate * 100 - statsA.avgLatency / 1000
        const scoreB = b.priority * 10 + statsB.successRate * 100 - statsB.avgLatency / 1000
        return scoreB - scoreA
      })

    for (const provider of videoProviders) {
      const result = await this.tryGenerateVideo(prompt, provider)
      if (result.success) {
        await this.withQuotaLock(async () => {
          provider.remainingQuota--
        })
        this.addCache(cacheKey, result, 7200000)
        return result
      }
    }

    return {
      success: false,
      error: '所有视频生成服务均失败',
      provider: 'fallback'
    }
  }

  private async tryGenerateVideo(
    prompt: string,
    provider: ExternalProvider
  ): Promise<VideoGenerationResult> {
    const startTime = Date.now()
    
    for (let attempt = 0; attempt < provider.maxRetries + 1; attempt++) {
      try {
        let result: VideoGenerationResult
        
        switch (provider.id) {
          case 'pika':
            result = await this.generateWithPika(prompt)
            break
          case 'runway':
            result = await this.generateWithRunway(prompt)
            break
          default:
            result = { success: false, error: 'Unsupported provider', provider: provider.id }
        }

        const latency = Date.now() - startTime
        this.recordRequest(provider.id, result.success, latency)
        
        if (result.success) {
          return result
        }
        
        if (attempt < provider.maxRetries) {
          await this.delay((attempt + 1) * 3000)
        }
        
      } catch (error) {
        if (attempt >= provider.maxRetries) {
          const latency = Date.now() - startTime
          this.recordRequest(provider.id, false, latency)
          return { success: false, error: String(error), provider: provider.id }
        }
        await this.delay((attempt + 1) * 3000)
      }
    }
    
    return { success: false, error: 'Max retries exceeded', provider: provider.id }
  }

  private async generateWithPika(prompt: string): Promise<VideoGenerationResult> {
    try {
      const response = await this.fetchWithTimeout('https://api.pika.art/api/v1/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt,
          duration: 3,
          aspect_ratio: '16:9'
        })
      }, 120000)

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}`, provider: 'pika' }
      }

      const data = await response.json()
      if (data.output?.video_url) {
        const localPath = await this.downloadAndSave(data.output.video_url, 'mp4')
        return { success: true, url: data.output.video_url, localPath, provider: 'pika' }
      }

      return { success: false, error: 'No video returned', provider: 'pika' }
    } catch (error) {
      return { success: false, error: String(error), provider: 'pika' }
    }
  }

  private async generateWithRunway(prompt: string): Promise<VideoGenerationResult> {
    try {
      const response = await this.fetchWithTimeout('https://api.runwayml.com/v1/generate/video', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt,
          model: 'gen-2',
          duration: 5
        })
      }, 120000)

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}`, provider: 'runway' }
      }

      const data = await response.json()
      if (data.output?.video_url) {
        const localPath = await this.downloadAndSave(data.output.video_url, 'mp4')
        return { success: true, url: data.output.video_url, localPath, provider: 'runway' }
      }

      return { success: false, error: 'No video returned', provider: 'runway' }
    } catch (error) {
      return { success: false, error: String(error), provider: 'runway' }
    }
  }

  private async downloadAndSave(url: string, extension: string): Promise<string> {
    if (!url.startsWith('https://')) {
      throw new Error('Only HTTPS URLs are allowed for downloads')
    }
    if (!this.outputDir) this.initialize()
    if (!this.outputDir) throw new Error('outputDir not initialized')
    const response = await this.fetchWithTimeout(url, {}, 120000)
    const blob = await response.blob()
    const buffer = Buffer.from(await blob.arrayBuffer())
    
    const filename = `generated_${Date.now()}.${extension}`
    const filepath = join(this.outputDir, filename)
    
    writeFileSync(filepath, buffer)
    return filepath
  }

  getProviders(): ExternalProvider[] {
    return [...this.providers]
  }

  updateProvider(id: string, updates: Partial<ExternalProvider>): void {
    const allowedFields: Array<keyof ExternalProvider> = [
      'name', 'type', 'freeQuota', 'enabled', 'priority', 'baseUrl', 'apiKey', 'timeout', 'maxRetries'
    ]
    const index = this.providers.findIndex(p => p.id === id)
    if (index !== -1) {
      const sanitized: Partial<ExternalProvider> = {}
      for (const key of allowedFields) {
        if (key in updates) {
          (sanitized as any)[key] = (updates as any)[key]
        }
      }
      this.providers[index] = { ...this.providers[index], ...sanitized }
    }
  }

  getQuota(): { total: number; remaining: number } {
    const imageQuota = this.providers.filter(p => p.type === 'image')
    const videoQuota = this.providers.filter(p => p.type === 'video')
    
    return {
      total: imageQuota.reduce((a, b) => a + b.freeQuota, 0) + videoQuota.reduce((a, b) => a + b.freeQuota, 0),
      remaining: imageQuota.reduce((a, b) => a + b.remainingQuota, 0) + videoQuota.reduce((a, b) => a + b.remainingQuota, 0)
    }
  }

  getStats(): {
    cacheSize: number
    requestHistory: Array<{ provider: string; success: boolean; timestamp: number; latency: number }>
    providerStats: Record<string, { successRate: number; avgLatency: number }>
  } {
    const providerStats: Record<string, { successRate: number; avgLatency: number }> = {}
    this.providers.forEach(p => {
      providerStats[p.id] = this.getProviderStats(p.id)
    })
    
    return {
      cacheSize: this.cache.size,
      requestHistory: [...this.requestHistory],
      providerStats
    }
  }

  clearCache(): void {
    this.cache.clear()
    this.saveCache()
  }

  getSettings(): Record<string, unknown> {
    if (!this.settingsPath) this.initialize()
    if (!this.settingsPath) return {}
    try {
      if (existsSync(this.settingsPath)) {
        const data = JSON.parse(readFileSync(this.settingsPath, 'utf-8'))
        return data && typeof data === 'object' ? data : {}
      }
    } catch (e) { logger.error('[ExternalAI] 读取设置失败:', e) }
    return {}
  }

  updateSettings(updates: Record<string, unknown>): Record<string, unknown> {
    if (!this.settingsPath) this.initialize()
    const merged = { ...this.getSettings(), ...(updates || {}) }
    if (this.settingsPath) {
      try {
        writeFileSync(this.settingsPath, JSON.stringify(merged, null, 2))
      } catch (e) { logger.error('[ExternalAI] 保存设置失败:', e) }
    }
    return merged
  }

  getHistory(): Array<{ provider: string; success: boolean; timestamp: number; latency: number }> {
    return [...this.requestHistory]
  }

  clearHistory(): void {
    this.requestHistory = []
    this.saveHistory()
  }
}

export const externalAIClient = new ExternalAIClient()

export function setupExternalAIHandlers(): void {
  const { ipcMain } = require('electron')

  ipcMain.handle('external-ai:generate-image', async (_event: Electron.IpcMainInvokeEvent, prompt: string, style?: string) => {
    try {
      return await externalAIClient.generateImage(prompt, style)
    } catch (e) {
      logger.error('external-ai:generate-image error:', e)
      return { success: false, error: String(e), provider: 'fallback' }
    }
  })

  ipcMain.handle('external-ai:generate-video', async (_event: Electron.IpcMainInvokeEvent, prompt: string) => {
    try {
      return await externalAIClient.generateVideo(prompt)
    } catch (e) {
      logger.error('external-ai:generate-video error:', e)
      return { success: false, error: String(e), provider: 'fallback' }
    }
  })

  ipcMain.handle('external-ai:providers', () => {
    try {
      return externalAIClient.getProviders()
    } catch (e) {
      logger.error('external-ai:providers error:', e)
      return []
    }
  })

  ipcMain.handle('external-ai:update-provider', (_event: Electron.IpcMainInvokeEvent, id: string, updates: Partial<ExternalProvider>) => {
    try {
      externalAIClient.updateProvider(id, updates)
      return externalAIClient.getProviders()
    } catch (e) {
      logger.error('external-ai:update-provider error:', e)
      return []
    }
  })

  ipcMain.handle('external-ai:quota', () => {
    try {
      return externalAIClient.getQuota()
    } catch (e) {
      logger.error('external-ai:quota error:', e)
      return { total: 0, remaining: 0 }
    }
  })

  ipcMain.handle('external-ai:stats', () => {
    try {
      return externalAIClient.getStats()
    } catch (e) {
      logger.error('external-ai:stats error:', e)
      return { cacheSize: 0, requestHistory: [], providerStats: {} }
    }
  })

  ipcMain.handle('external-ai:clear-cache', () => {
    try {
      externalAIClient.clearCache()
      return { success: true }
    } catch (e) {
      logger.error('external-ai:clear-cache error:', e)
      return { success: false }
    }
  })

  ipcMain.handle('external-ai:settings', () => {
    try {
      return externalAIClient.getSettings()
    } catch (e) {
      logger.error('external-ai:settings error:', e)
      return {}
    }
  })

  ipcMain.handle('external-ai:update-settings', (_event: Electron.IpcMainInvokeEvent, updates: Record<string, unknown>) => {
    try {
      return externalAIClient.updateSettings(updates)
    } catch (e) {
      logger.error('external-ai:update-settings error:', e)
      return {}
    }
  })

  ipcMain.handle('external-ai:history', () => {
    try {
      return externalAIClient.getHistory()
    } catch (e) {
      logger.error('external-ai:history error:', e)
      return []
    }
  })

  ipcMain.handle('external-ai:clear-history', () => {
    try {
      externalAIClient.clearHistory()
      return { success: true }
    } catch (e) {
      logger.error('external-ai:clear-history error:', e)
      return { success: false }
    }
  })
}
