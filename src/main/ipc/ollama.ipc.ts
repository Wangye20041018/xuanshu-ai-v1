import { ipcMain } from 'electron'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import path from 'path'
import { logger } from '../../shared/logger'

const execAsync = promisify(exec)

/** Ollama 本地请求超时（毫秒） */
const OLLAMA_TIMEOUT = 5_000

/** 带超时的本地 fetch（localhost，不注入代理） */
async function ollamaFetch(url: string, options: RequestInit = {}, timeoutMs: number = OLLAMA_TIMEOUT): Promise<Response> {
  return fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(timeoutMs) })
}

/** 网络错误分类为可读中文 */
function ollamaError(e: unknown, context: string): string {
  const err = e as NodeJS.ErrnoException & { name?: string }
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return `${context}请求超时（${OLLAMA_TIMEOUT / 1000}s），请确认 Ollama 服务已启动`
  }
  if (err?.code === 'ECONNREFUSED') return `${context}连接被拒绝，请确认 Ollama 服务已启动`
  if (err?.code === 'ECONNRESET') return `${context}连接被重置，请检查 Ollama 服务状态`
  return `${context}请求失败: ${err?.message || '未知错误'}`
}

interface OllamaModel {
  name: string
  size: number
  modified_at: string
}

interface OllamaStatus {
  running: boolean
  version: string
  models: OllamaModel[]
}

let ollamaProcess: ReturnType<typeof spawn> | null = null

export function setupOllamaHandlers(): void {
  ipcMain.handle('ollama:status', async (): Promise<OllamaStatus> => {
    try {
      const response = await ollamaFetch('http://localhost:11434/api/tags')
      if (response.ok) {
        const data = await response.json()
        return {
          running: true,
          version: '0.1.x',
          models: data.models || []
        }
      }
      return { running: false, version: '', models: [] }
    } catch (error) {
      logger.warn('[Ollama] status check failed:', (error as Error)?.message)
      return { running: false, version: '', models: [] }
    }
  })

  ipcMain.handle('ollama:start', async (): Promise<{ success: boolean; error?: string }> => {
    try {
      if (ollamaProcess) {
        return { success: true }
      }

      ollamaProcess = spawn('ollama', ['serve'], {
        detached: true,
        stdio: 'ignore'
      })

      ollamaProcess.unref()

      await new Promise(resolve => setTimeout(resolve, 2000))

      return { success: true }
    } catch (error) {
      logger.error('ollama:start 内部错误:', error)
      return { success: false, error: 'Ollama 引擎遇到内部错误' }
    }
  })

  ipcMain.handle('ollama:list-models', async (): Promise<string[]> => {
    try {
      const response = await ollamaFetch('http://localhost:11434/api/tags')
      if (!response.ok) return []

      const data = await response.json()
      return (data.models || []).map((m: OllamaModel) => m.name)
    } catch (error) {
      logger.warn('[Ollama] list-models failed:', (error as Error)?.message)
      return []
    }
  })

  ipcMain.handle('ollama:pull-model', async (_event, modelName: string) => {
    try {
      const response = await ollamaFetch('http://localhost:11434/api/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName, stream: false })
      }, 120_000)

      if (response.ok) {
        return { success: true }
      }
      return { success: false, error: `HTTP ${response.status}` }
    } catch (error) {
      logger.error('ollama:pull-model 内部错误:', error)
      return { success: false, error: ollamaError(error, '拉取模型') }
    }
  })

  ipcMain.handle('ollama:create-model', async (_event, name: string, ggufPath: string): Promise<{ success: boolean; error?: string }> => {
    // 命令注入防护：校验 name
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_:.-]{1,64}$/.test(name)) {
      return { success: false, error: '无效的模型名称，仅允许字母、数字、下划线、冒号、点和连字符，最长64字符' }
    }
    try {
      if (!existsSync(ggufPath)) {
        return { success: false, error: 'GGUF file not found' }
      }

      const Modelfile = `
FROM "${ggufPath}"
PARAMETER temperature 0.7
PARAMETER top_p 0.9
`

      const modelfilePath = path.join(path.dirname(ggufPath), 'Modelfile')
      const { writeFileSync } = await import('fs')
      writeFileSync(modelfilePath, Modelfile)

      await execAsync(`ollama create ${name} -f "${modelfilePath}"`)

      return { success: true }
    } catch (error) {
      logger.error('ollama:create-model 内部错误:', error)
      return { success: false, error: 'Ollama 引擎遇到内部错误' }
    }
  })

  ipcMain.handle('ollama:delete-model', async (_event, modelName: string): Promise<{ success: boolean; error?: string }> => {
    if (typeof modelName !== 'string' || !/^[a-zA-Z0-9_:.-]{1,64}$/.test(modelName)) {
      return { success: false, error: '无效的模型名称' }
    }
    try {
      await execAsync(`ollama rm ${modelName}`)
      return { success: true }
    } catch (error) {
      logger.error('ollama:delete-model 内部错误:', error)
      return { success: false, error: 'Ollama 引擎遇到内部错误' }
    }
  })

  ipcMain.handle('ollama:chat', async (_event, model: string, messages: { role: string; content: string }[]): Promise<{ content: string; error?: string }> => {
    try {
      const response = await ollamaFetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: false
        })
      }, 30_000)

      if (!response.ok) {
        return { content: '', error: `HTTP ${response.status}` }
      }

      const data = await response.json()
      return { content: data.message?.content || '' }
    } catch (error) {
      logger.error('ollama:chat 内部错误:', error)
      return { content: '', error: ollamaError(error, '对话请求') }
    }
  })

  ipcMain.handle('ollama:vision', async (_event, model: string, imageBase64: string, prompt: string): Promise<{ content: string; error?: string }> => {
    try {
      const response = await ollamaFetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
                { type: 'text', text: prompt }
              ]
            }
          ],
          stream: false
        })
      }, 60_000)

      if (!response.ok) {
        return { content: '', error: `HTTP ${response.status}` }
      }

      const data = await response.json()
      return { content: data.message?.content || '' }
    } catch (error) {
      logger.error('ollama:vision 内部错误:', error)
      return { content: '', error: ollamaError(error, '视觉请求') }
    }
  })
}

export { ollamaProcess }
