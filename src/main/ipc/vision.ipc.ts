import { ipcMain, desktopCapturer } from 'electron'
import { writeFileSync, existsSync, mkdirSync } from 'fs'
import path from 'path'
import { app } from 'electron'
import { getStore } from './config.ipc'
import { logger } from '../../shared/logger'
import { createProxyAgent } from '../utils/proxy-resolver'

/** 视觉 API 请求超时（毫秒） */
const VISION_TIMEOUT = 60_000

/** 带超时 + 代理的 fetch（外网视觉 provider 走代理，本地回环不代理） */
async function visionFetch(url: string, options: RequestInit = {}, timeoutMs: number = VISION_TIMEOUT): Promise<Response> {
  const fetchOptions: RequestInit & { dispatcher?: any } = {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(timeoutMs),
  }
  if (!/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(url)) {
    const agent = createProxyAgent()
    if (agent) fetchOptions.dispatcher = agent
  }
  return fetch(url, fetchOptions as RequestInit)
}

interface ScreenSource {
  id: string
  name: string
  thumbnail: string
}

/**
 * 统一的视觉模型 API 调用，路由策略：
 *   1. 已配置 visionProvider → 走对应 OpenAI 兼容 API
 *   2. SGLang 本地服务 (127.0.0.1:30000) → 走 /v1/chat/completions
 *   3. 均不可用时返回错误，不再硬编码 Ollama
 */
async function callVisionAPI(
  imageBase64: string,
  prompt: string,
  visionModel: string,
  imageMimeType: string = 'image/png'
): Promise<{ content: string; error?: string }> {
  const store = getStore()
  const visionProviderId = (store as any).get('visionProvider')

  if (visionProviderId && visionProviderId !== 'ollama') {
    const providers = (store as any).get('providers') || []
    const provider = providers.find((p: any) => p.id === visionProviderId)
    if (provider && provider.baseUrl) {
      try {
        const response = await visionFetch(`${provider.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${provider.apiKey || ''}`
          },
          body: JSON.stringify({
            model: visionModel,
            messages: [{
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: `data:${imageMimeType};base64,${imageBase64}` } },
                { type: 'text', text: prompt }
              ]
            }],
            max_tokens: 1000
          })
        })

        if (!response.ok) {
          return { content: '', error: `HTTP ${response.status}` }
        }

        const data = await response.json()
        return { content: data.choices?.[0]?.message?.content || '' }
      } catch (error) {
        logger.error('vision: 配置的视觉provider调用失败，回退到SGLang本地:', error)
        // 失败后 fall through 到 SGLang 本地兜底
      }
    }
  }

  // SGLang 本地推理兜底（127.0.0.1:30000，OpenAI 兼容 API）
  try {
    const response = await visionFetch('http://127.0.0.1:30000/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: visionModel,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${imageMimeType};base64,${imageBase64}` } },
            { type: 'text', text: prompt }
          ]
        }],
        max_tokens: 1000
      })
    })

    if (!response.ok) {
      return { content: '', error: `SGLang HTTP ${response.status}` }
    }

    const data = await response.json()
    return { content: data.choices?.[0]?.message?.content || '' }
  } catch (error) {
    logger.error('vision: SGLang 本地调用失败:', error)
    return { content: '', error: '本地视觉推理不可用，请确保 SGLang 服务已启动' }
  }
}

export function setupVisionHandlers(): void {
  ipcMain.handle('vision:get-sources', async (): Promise<ScreenSource[]> => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 }
      })

      return sources.map(source => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail.toDataURL()
      }))
    } catch (error) {
      logger.error('Failed to get screen sources:', error)
      return []
    }
  })

  ipcMain.handle('vision:capture-screen', async (_event, sourceId: string): Promise<{ success: boolean; imageBase64?: string; error?: string }> => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      })

      const source = sources.find(s => s.id === sourceId)
      if (!source) {
        return { success: false, error: 'Source not found' }
      }

      const imageBuffer = source.thumbnail.toPNG()
      const base64 = imageBuffer.toString('base64')

      return { success: true, imageBase64: base64 }
    } catch (error) {
      logger.error('vision:capture-screen 内部错误:', error)
      return { success: false, error: '视觉处理遇到内部错误' }
    }
  })

  ipcMain.handle('vision:capture-window', async (_event, sourceId: string): Promise<{ success: boolean; imageBase64?: string; error?: string }> => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 1920, height: 1080 }
      })

      const source = sources.find(s => s.id === sourceId)
      if (!source) {
        return { success: false, error: 'Window not found' }
      }

      const imageBuffer = source.thumbnail.toPNG()
      const base64 = imageBuffer.toString('base64')

      return { success: true, imageBase64: base64 }
    } catch (error) {
      logger.error('vision:capture-window 内部错误:', error)
      return { success: false, error: '视觉处理遇到内部错误' }
    }
  })

  ipcMain.handle('vision:save-screenshot', async (_event, imageBase64: string, filename?: string): Promise<{ success: boolean; path?: string; error?: string }> => {
    try {
      const screenshotsDir = path.join(app.getPath('userData'), 'screenshots')
      // 确保目录存在
      if (!existsSync(screenshotsDir)) {
        mkdirSync(screenshotsDir, { recursive: true })
      }
      const name = filename || `screenshot_${Date.now()}.png`
      const filepath = path.join(screenshotsDir, name)

      const buffer = Buffer.from(imageBase64, 'base64')
      writeFileSync(filepath, buffer)

      return { success: true, path: filepath }
    } catch (error) {
      logger.error('vision:save-screenshot 内部错误:', error)
      return { success: false, error: '视觉处理遇到内部错误' }
    }
  })

  ipcMain.handle('vision:analyze-screen', async (_event, sourceId: string, prompt: string, visionModel: string): Promise<{ content: string; error?: string }> => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      })

      const source = sources.find(s => s.id === sourceId)
      if (!source) {
        return { content: '', error: 'Screen source not found' }
      }

      const imageBuffer = source.thumbnail.toPNG()
      const base64 = imageBuffer.toString('base64')

      return await callVisionAPI(base64, prompt, visionModel, 'image/png')
    } catch (error) {
      logger.error('vision:analyze-screen 内部错误:', error)
      return { content: '', error: '视觉处理遇到内部错误' }
    }
  })

  ipcMain.handle('vision:analyze-image', async (_event, imageBase64: string, prompt: string, visionModel: string): Promise<{ content: string; error?: string }> => {
    try {
      return await callVisionAPI(imageBase64, prompt, visionModel, 'image/jpeg')
    } catch (error) {
      logger.error('vision:analyze-image 内部错误:', error)
      return { content: '', error: '视觉处理遇到内部错误' }
    }
  })

  ipcMain.handle('vision:get-desktop-description', async (_event, visionModel: string): Promise<{ content: string; error?: string }> => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      })

      if (sources.length === 0) {
        return { content: '', error: 'No screen sources available' }
      }

      const source = sources[0]
      const imageBuffer = source.thumbnail.toPNG()
      const base64 = imageBuffer.toString('base64')

      return await callVisionAPI(base64, '请描述屏幕上显示的内容，包括打开的窗口、应用、按钮等界面元素。', visionModel)
    } catch (error) {
      logger.error('vision:get-desktop-description 内部错误:', error)
      return { content: '', error: '视觉处理遇到内部错误' }
    }
  })
}
