import { ipcMain, app } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { pythonRuntime } from '../runtime/python'
import { translateWindowsPathToWSL } from '../runtime/wsl-utils'
import { logger } from '../../shared/logger'

/* ============================================================
 * SGLang IPC 处理器
 *
 * SGLang 特点：
 * - Python 包，通过 pip install sglang 安装
 * - 默认端口 30000
 * - 提供 OpenAI 兼容 API (/v1/chat/completions, /v1/models)
 * - 启动命令: python -m sglang.launch_server --model-path {model_path} --port 30000 --host 127.0.0.1
 * ============================================================ */

const SGLANG_PORT = 30000
const SGLANG_HOST = '127.0.0.1'
const SGLANG_BASE_URL = `http://${SGLANG_HOST}:${SGLANG_PORT}`

let sglangProcess: ChildProcess | null = null
let sglangReady = false
let sglangModelPath = ''

// 显存分配比例 — 可在运行时动态调整
// v10.2 WSL 集成：RTX 3060 Laptop 6GB，0.80 留 1.2GB 给系统/驱动（0.88 在 6GB 上过于激进）
let sglangMemFraction = '0.80'

/* ---------- 辅助函数 ---------- */

function getLogDir(): string {
  const dir = join(app.getPath('userData'), 'logs')
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  } catch { logger.error('[SGLang] 日志目录创建失败:', dir) }
  return dir
}

function writeSGLangLog(message: string): void {
  try {
    const fs = require('fs')
    const logFile = join(getLogDir(), 'sglang.log')
    const timestamp = new Date().toISOString()
    fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`)
  } catch { logger.error('[SGLang] 写入日志失败:', message) }
}

async function httpGet(path: string): Promise<{ ok: boolean; data?: unknown; status?: number }> {
  try {
    const url = `${SGLANG_BASE_URL}${path}`
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })
    if (response.ok) {
      const data = await response.json()
      return { ok: true, data }
    }
    return { ok: false, status: response.status }
  } catch (e) {
    logger.error('[SGLangIPC] HTTP GET 请求失败:', e)
    return { ok: false }
  }
}

async function httpPost(
  path: string,
  body: unknown,
  timeoutMs: number = 120000,
): Promise<{ ok: boolean; data?: unknown; status?: number; error?: string }> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    const url = `${SGLANG_BASE_URL}${path}`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (response.ok) {
      const data = await response.json()
      return { ok: true, data }
    }
    const errorText = await response.text()
    return { ok: false, status: response.status, error: errorText }
  } catch (error) {
    const message = (error as Error).name === 'AbortError'
      ? '请求超时'
      : 'HTTP 请求失败'
    logger.error('[SGLangIPC] httpPost 内部错误:', error)
    return { ok: false, error: message }
  }
}

// checkPort 改用 /health 端点 + 放宽到 < 500
async function checkPort(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${SGLANG_HOST}:${port}/health`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(3000),
    })
    return response.status < 500
  } catch (e) {
    logger.error('[SGLangIPC] 端口检查失败:', e)
    return false
  }
}

// 合并后的公共 SGLang 启动函数
async function startSGLangWithModel(modelPath: string, mmprojPath?: string): Promise<{ success: boolean; error?: string }> {
  // 防止并发启动
  if (sglangProcess) {
    if (sglangReady) {
      return { success: true }  // 已经在运行
    }
    return { success: false, error: 'SGLang 正在启动中，请等待就绪' }
  }

  if (!modelPath || !existsSync(modelPath)) {
    return { success: false, error: `模型文件不存在: ${modelPath}` }
  }

  // WSL2 探测（幂等）：决定后续经 wsl.exe 拉起还是原生 Windows Python
  await pythonRuntime.ensureWSLDetected()

  writeSGLangLog(`启动 SGLang, 模型: ${modelPath}`)

  sglangModelPath = modelPath
  sglangReady = false

  // WSL2 模式：经 wsl.exe 拉起 WSL 内的 Linux Python 运行 sglang.launch_server
  const wslMode = pythonRuntime.isWSLMode()
  let spawnCmd: string
  let spawnArgs: string[]
  if (wslMode) {
    const wslModelPath = translateWindowsPathToWSL(modelPath)
    const wslMmprojPath = mmprojPath ? translateWindowsPathToWSL(mmprojPath) : undefined
    spawnCmd = 'wsl.exe'
    spawnArgs = ['-e', 'python3', '-m', 'sglang.launch_server',
      '--model-path', wslModelPath,
      '--port', String(SGLANG_PORT),
      '--host', '127.0.0.1',
      '--mem-fraction-static', sglangMemFraction]
    if (wslMmprojPath) {
      spawnArgs.push('--mmap-projector', wslMmprojPath)
    }
    writeSGLangLog(`[WSL] 启动 SGLang, 模型(WSL路径): ${wslModelPath}`)
  } else {
    const pythonPath = pythonRuntime.getPythonPath()
    spawnCmd = pythonPath
    spawnArgs = ['-m', 'sglang.launch_server',
      '--model-path', modelPath,
      '--port', String(SGLANG_PORT),
      '--host', '127.0.0.1',
      '--mem-fraction-static', sglangMemFraction]
    if (mmprojPath) {
      spawnArgs.push('--mmap-projector', mmprojPath)
    }
  }
  sglangProcess = spawn(spawnCmd, spawnArgs, {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
    windowsHide: true,
  })

  sglangProcess.unref()

  // stderr 环形缓冲
  const MAX_STDERR_LINES = 200
  const stderrBuffer: string[] = []

  if (sglangProcess.stderr) {
    sglangProcess.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderrBuffer.push(text)
      // 环形缓冲：超过限制删除最旧的
      while (stderrBuffer.length > MAX_STDERR_LINES) {
        stderrBuffer.shift()
      }
      writeSGLangLog(`[stderr] ${text.trim()}`)
    })
  }

  if (sglangProcess.stdout) {
    sglangProcess.stdout.on('data', (chunk: Buffer) => {
      writeSGLangLog(`[stdout] ${chunk.toString().trim()}`)
    })
  }

  sglangProcess.on('exit', (code, signal) => {
    writeSGLangLog(`SGLang 进程退出, code=${code}, signal=${signal}`)
    sglangProcess = null
    sglangReady = false
  })

  sglangProcess.on('error', (err) => {
    writeSGLangLog(`SGLang 进程错误: ${err.message}`)
    sglangProcess = null
    sglangReady = false
  })

  // 等待服务就绪（最多 120 秒）
  writeSGLangLog('等待 SGLang 服务就绪...')
  const maxWaitMs = 120000
  const startTime = Date.now()

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    const online = await checkPort(SGLANG_PORT)
    if (online) {
      sglangReady = true
      writeSGLangLog('SGLang 服务已就绪')
      return { success: true }
    }
  }

  // 超时
  const stderrSummary = stderrBuffer.join('').slice(-500)
  writeSGLangLog(`SGLang 启动超时 (${maxWaitMs}ms)`)
  return { success: false, error: `启动超时，请检查日志\n${stderrSummary}` }
}

/* ---------- 心跳检测与自动重启 ---------- */

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
const HEARTBEAT_INTERVAL_MS = 15000  // 每 15 秒检测一次
const MAX_RESTART_ATTEMPTS = 3
let restartAttempts = 0
let restartModelPath = ''

function startHeartbeat(): void {
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(async () => {
    if (!sglangModelPath) return

    const online = await checkPort(SGLANG_PORT)
    if (online) {
      restartAttempts = 0  // 健康时重置计数
      return
    }

    // 端口不可达：尝试重启
    if (sglangProcess) {
      writeSGLangLog(`[心跳] SGLang 端口 ${SGLANG_PORT} 无响应，进程仍在，等待恢复...`)
      return
    }

    // 进程已退出但路径仍存：自动重启
    if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
      writeSGLangLog(`[心跳] 已达最大重启次数 (${MAX_RESTART_ATTEMPTS})，停止自动恢复`)
      stopHeartbeat()
      return
    }

    restartAttempts++
    restartModelPath = sglangModelPath
    writeSGLangLog(`[心跳] SGLang 进程已退出，自动重启 (${restartAttempts}/${MAX_RESTART_ATTEMPTS})...`)
    const result = await startSGLangWithModel(restartModelPath)
    if (result.success) {
      writeSGLangLog(`[心跳] 自动重启成功`)
      restartAttempts = 0
    } else {
      writeSGLangLog(`[心跳] 自动重启失败: ${result.error}`)
    }
  }, HEARTBEAT_INTERVAL_MS)
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  restartAttempts = 0
  restartModelPath = ''
}

export function setupSGLangHandlers(): void {
  /* ==========================================================
   * sglang:status - 检查 SGLang 服务状态
   * ========================================================== */
  ipcMain.handle('sglang:status', async (): Promise<{
    running: boolean
    ready: boolean
    port: number
    modelPath: string
    models: { id: string; object: string; created: number; owned_by: string }[]
  }> => {
    try {
      const online = await checkPort(SGLANG_PORT)
      if (!online) {
        return { running: false, ready: false, port: SGLANG_PORT, modelPath: '', models: [] }
      }

      const result = await httpGet('/v1/models')
      const models = (result.ok && result.data && typeof result.data === 'object' && 'data' in (result.data as Record<string, unknown>))
        ? ((result.data as Record<string, unknown>).data as Array<Record<string, unknown>>) || []
        : []

      return {
        running: true,
        ready: sglangReady && online,
        port: SGLANG_PORT,
        modelPath: sglangModelPath,
        models: models as { id: string; object: string; created: number; owned_by: string }[],
      }
    } catch (error) {
      writeSGLangLog(`sglang:status 错误: ${String(error)}`)
      return { running: false, ready: false, port: SGLANG_PORT, modelPath: '', models: [] }
    }
  })

  /* ==========================================================
   * sglang:start - 启动 SGLang 服务
   * ========================================================== */
  ipcMain.handle('sglang:start', async (_event, modelPath: string): Promise<{
    success: boolean
    error?: string
  }> => {
    try {
      if (sglangProcess && sglangReady) {
        const online = await checkPort(SGLANG_PORT)
        if (online && sglangModelPath === modelPath) {
          return { success: true }
        }
        if (online) {
          await stopSGLang()
        }
      }

      if (!modelPath || !existsSync(modelPath)) {
        return { success: false, error: `模型文件不存在: ${modelPath}` }
      }

      return await startSGLangWithModel(modelPath)
    } catch (error) {
      writeSGLangLog(`sglang:start 错误: ${String(error)}`)
      return { success: false, error: 'SGLang 引擎遇到内部错误' }
    }
  })

  /* ==========================================================
   * sglang:stop - 停止 SGLang 服务
   * ========================================================== */
  ipcMain.handle('sglang:stop', async (): Promise<{ success: boolean; error?: string }> => {
    try {
      await stopSGLang()
      return { success: true }
    } catch (error) {
      writeSGLangLog(`sglang:stop 错误: ${String(error)}`)
      return { success: false, error: 'SGLang 引擎遇到内部错误' }
    }
  })

  /* ==========================================================
   * sglang:list-models - 列出已加载模型
   * ========================================================== */
  ipcMain.handle('sglang:list-models', async (): Promise<{
    models: { id: string; object: string; created: number; owned_by: string }[]
    error?: string
  }> => {
    try {
      const online = await checkPort(SGLANG_PORT)
      if (!online) {
        return { models: [], error: 'SGLang 服务未运行' }
      }

      const result = await httpGet('/v1/models')
      if (!result.ok) {
        return { models: [], error: `HTTP ${result.status}` }
      }

      const models = (result.data && typeof result.data === 'object' && 'data' in (result.data as Record<string, unknown>))
        ? ((result.data as Record<string, unknown>).data as Array<Record<string, unknown>>) || []
        : []

      return { models: models as { id: string; object: string; created: number; owned_by: string }[] }
    } catch (error) {
      writeSGLangLog(`sglang:list-models 错误: ${String(error)}`)
      return { models: [], error: 'SGLang 引擎遇到内部错误' }
    }
  })

  /* ==========================================================
   * sglang:load-model - 加载模型到显存
   * ========================================================== */
  ipcMain.handle('sglang:load-model', async (_event, modelPath: string): Promise<{
    success: boolean
    error?: string
  }> => {
    try {
      if (sglangProcess) {
        writeSGLangLog('卸载当前模型以加载新模型...')
        await stopSGLang()
        await new Promise(resolve => setTimeout(resolve, 3000))
      }

      return await startSGLangWithModel(modelPath)
    } catch (error) {
      writeSGLangLog(`sglang:load-model 错误: ${String(error)}`)
      return { success: false, error: 'SGLang 引擎遇到内部错误' }
    }
  })

  /* ==========================================================
   * sglang:unload-model - 卸载模型释放显存
   * ========================================================== */
  ipcMain.handle('sglang:unload-model', async (): Promise<{
    success: boolean
    error?: string
  }> => {
    try {
      await stopSGLang()
      writeSGLangLog('模型已卸载，显存已释放')
      return { success: true }
    } catch (error) {
      writeSGLangLog(`sglang:unload-model 错误: ${String(error)}`)
      return { success: false, error: 'SGLang 引擎遇到内部错误' }
    }
  })

  /* ==========================================================
   * sglang:chat - 对话推理
   * ========================================================== */
  ipcMain.handle('sglang:chat', async (_event, messages: { role: string; content: string }[], options?: {
    temperature?: number
    max_tokens?: number
    top_p?: number
  }): Promise<{
    content: string
    error?: string
  }> => {
    try {
      const online = await checkPort(SGLANG_PORT)
      if (!online) {
        return { content: '', error: 'SGLang 服务未运行' }
      }

      const result = await httpPost('/v1/chat/completions', {
        model: sglangModelPath || 'default',
        messages,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.max_tokens ?? 2048,
        top_p: options?.top_p ?? 0.9,
        stream: false,
      }, 120000)

      if (!result.ok) {
        return { content: '', error: result.error || `HTTP ${result.status}` }
      }

      const data = result.data as Record<string, unknown> | undefined
      const choices = data?.choices as Array<{ message?: { content?: string } }> | undefined
      const content = choices?.[0]?.message?.content || ''

      return { content }
    } catch (error) {
      writeSGLangLog(`sglang:chat 错误: ${String(error)}`)
      return { content: '', error: 'SGLang 引擎遇到内部错误' }
    }
  })

  /* ==========================================================
   * sglang:vision - 视觉推理
   * ========================================================== */
  ipcMain.handle('sglang:vision', async (_event, imageBase64: string, prompt: string, options?: {
    temperature?: number
    max_tokens?: number
  }): Promise<{
    content: string
    error?: string
  }> => {
    try {
      const online = await checkPort(SGLANG_PORT)
      if (!online) {
        return { content: '', error: 'SGLang 服务未运行' }
      }

      const result = await httpPost('/v1/chat/completions', {
        model: sglangModelPath || 'default',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${imageBase64}`,
                },
              },
              {
                type: 'text',
                text: prompt,
              },
            ],
          },
        ],
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.max_tokens ?? 2048,
        stream: false,
      }, 180000)

      if (!result.ok) {
        return { content: '', error: result.error || `HTTP ${result.status}` }
      }

      const data = result.data as Record<string, unknown> | undefined
      const choices = data?.choices as Array<{ message?: { content?: string } }> | undefined
      const content = choices?.[0]?.message?.content || ''

      return { content }
    } catch (error) {
      writeSGLangLog(`sglang:vision 错误: ${String(error)}`)
      return { content: '', error: 'SGLang 引擎遇到内部错误' }
    }
  })

  /* ==========================================================
   * sglang:is-running - 检查服务是否运行中
   * ========================================================== */
  ipcMain.handle('sglang:is-running', async (): Promise<boolean> => {
    try {
      return await checkPort(SGLANG_PORT)
    } catch (error) {
      writeSGLangLog(`sglang:is-running 错误: ${String(error)}`)
      return false
    }
  })
}

/* ============================================================
 * 内部函数
 * ============================================================ */

async function stopSGLang(): Promise<void> {
  stopHeartbeat()
  const processToKill = sglangProcess
  if (!processToKill) return

  writeSGLangLog('正在停止 SGLang 服务...')

  try {
    processToKill.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        processToKill.kill('SIGKILL')
        resolve()
      }, 10000)
      processToKill.once('exit', () => { clearTimeout(timeout); resolve() })
    })
  } finally {
    sglangProcess = null
    sglangReady = false
  }

  writeSGLangLog('SGLang 服务已停止')

  sglangModelPath = ''

  // WSL2 模式：额外回收 WSL 内的 Linux 子进程（wsl.exe 仅转发，kill 不掉 Linux 进程）
  if (pythonRuntime.isWSLMode()) {
    try {
      spawn('wsl.exe', ['-e', 'pkill', '-f', 'sglang.launch_server'], { stdio: 'ignore' }).unref()
      writeSGLangLog('[WSL] 已发送 pkill 回收 Linux 子进程')
    } catch (e) { logger.error('[SGLangIPC] WSL pkill 回收子进程失败:', e) }
  }
}

/* ---- 供 model-manager 直接调用的启动函数 ---- */
export async function startSGLangServer(modelPath: string, mmprojPath?: string): Promise<boolean> {
  try {
    if (sglangProcess && sglangReady) {
      const online = await checkPort(SGLANG_PORT)
      if (online && sglangModelPath === modelPath) return true
      if (online) await stopSGLang()
    }
    const result = await startSGLangWithModel(modelPath, mmprojPath)
    if (result.success) startHeartbeat()
    return result.success
  } catch (e) {
    writeSGLangLog(`startSGLangServer 错误: ${String(e)}`)
    return false
  }
}

export function setSGLangMemFraction(fraction: string): void {
  sglangMemFraction = fraction
  logger.debug(`[SGLang] mem-fraction 已设置为 ${fraction}`)
}

export { sglangProcess, stopSGLang }
