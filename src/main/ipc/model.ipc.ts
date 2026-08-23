import { ipcMain, BrowserWindow } from 'electron'
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, createWriteStream, createReadStream, readFileSync, renameSync, copyFileSync, unlinkSync } from 'fs'
import { pipeline } from 'stream/promises'
import { createHash } from 'crypto'
import { createProxyAgent, getSystemProxy, testProxy, clearProxyCache } from '../utils/proxy-resolver'
import { POWERSHELL_EXE } from '../utils/powershell'
import { logger } from '../../shared/logger'

/* ============================================================
 * 下载管理器 v3 — 流式写入 / 直连优先 / 断点续传 / sha256流式校验
 * 修复：
 *   1. 代理自动注入导致直连失败 → 直连优先，代理仅 fallback
 *   2. 每次 chunk 重新打开文件 → 改为 createWriteStream + pipeline
 *   3. SHA256 校验读取整个文件 OOM → 改为流式 Hash
 *   4. 网络瞬断无重试 → 单源内 3 次重试 + 指数退避
 * ============================================================ */

interface DownloadTask {
  id: string
  modelName: string
  modelType: 'main' | 'vision' | 'embedding'
  url: string
  mirrors: string[]
  outputPath: string
  tempPath: string
  totalSize: number
  downloadedSize: number
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error'
  speed: number
  remainingTime: number
  progress: number
  error?: string
  sources: DownloadSource[]
  currentSourceIndex: number
}

interface DownloadSource {
  url: string
  priority: number
  active: boolean
}

class DownloadManager {
  private tasks: Map<string, DownloadTask> = new Map()
  private abortControllers: Map<string, AbortController> = new Map()
  private progressIntervals: Map<string, NodeJS.Timeout> = new Map()

  private getDownloadDir(): string {
    const dir = join(app.getPath('userData'), 'models', 'downloads')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  private getTempDir(): string {
    const dir = join(app.getPath('userData'), 'models', 'temp')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  private notifyProgress(task: DownloadTask): void {
    const windows = BrowserWindow.getAllWindows()
    windows.forEach(win => {
      try {
        if (win.isDestroyed()) return
        win.webContents.send('model:download:progress', {
        id: task.id,
        modelName: task.modelName,
        progress: task.progress,
        speed: task.speed,
        remainingTime: task.remainingTime,
        downloadedSize: task.downloadedSize,
        totalSize: task.totalSize,
        status: task.status,
        error: task.error
      })
      } catch (e) { /* window destroyed */ }
    })
  }

  async createTask(
    modelName: string,
    modelType: 'main' | 'vision' | 'embedding',
    url: string,
    mirrors: string[] = []
  ): Promise<DownloadTask> {
    const id = `download-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const outputPath = join(this.getDownloadDir(), `${modelName}.gguf`)
    const tempPath = join(this.getTempDir(), `${modelName}.part`)

    const sources: DownloadSource[] = [
      { url, priority: 1, active: true },
      ...mirrors.map((m, i) => ({ url: m, priority: i + 2, active: true }))
    ]

    const task: DownloadTask = {
      id,
      modelName,
      modelType,
      url,
      mirrors,
      outputPath,
      tempPath,
      totalSize: 0,
      downloadedSize: 0,
      status: 'pending',
      speed: 0,
      remainingTime: 0,
      progress: 0,
      sources,
      currentSourceIndex: 0
    }

    this.tasks.set(id, task)
    return task
  }

  async startDownload(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) return

    task.status = 'downloading'
    const abortController = new AbortController()
    this.abortControllers.set(taskId, abortController)

    try {
      await this.downloadWithFallback(task, abortController.signal)
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        task.status = 'error'
        logger.error('[DownloadManager] startDownload 内部错误:', error)
        task.error = '下载任务遇到内部错误'
      }
    }

    this.notifyProgress(task)
  }

  private async downloadWithFallback(task: DownloadTask, signal: AbortSignal): Promise<void> {
    // 切换源时，如果之前有断点数据且这个源和上个源不同，需要从头开始
    // 同源续传直接靠 HTTP Range
    for (let sourceIndex = task.currentSourceIndex; sourceIndex < task.sources.length; sourceIndex++) {
      if (signal.aborted) break

      const source = task.sources[sourceIndex]
      if (!source.active) continue

      task.currentSourceIndex = sourceIndex
      task.error = undefined
      this.notifyProgress(task)

      try {
        await this.downloadFromSource(task, source.url, signal)

        if (task.downloadedSize >= task.totalSize && task.totalSize > 0) {
          task.status = 'completed'
          await this.finalizeDownload(task)
          return
        }
      } catch (error: any) {
        if (error?.name === 'AbortError') throw error

        source.active = false
        logger.error('[DownloadManager] downloadWithFallback 内部错误:', error)
        const errMsg = '下载任务遇到内部错误'
        // 同源已尝试过续传但失败了 → 重置进度准备下一源
        task.downloadedSize = 0
        task.error = `源 ${sourceIndex + 1} 失败: ${errMsg.substring(0, 120)}`

        if (sourceIndex === task.sources.length - 1) {
          task.status = 'error'
          if (!task.error) task.error = '所有下载源均失败。请检查网络连接，或尝试在设置中配置代理。'
        }
      }
    }
    this.notifyProgress(task)
  }

  private async downloadFromSource(
    task: DownloadTask,
    url: string,
    signal: AbortSignal,
    retries: number = 0
  ): Promise<void> {
    const MAX_RETRIES = 3
    const startPos = task.downloadedSize
    let lastUpdateTime = Date.now()
    let lastBytes = startPos

    const speedWindow: number[] = []
    const SPEED_WINDOW_SIZE = 10

    // 1. 直连优先 —— 不注入代理，因为大部分环境 huggingface 直连是通的
    //    代理反而经常不可用导致连接失败
    const doFetch = async (offset: number): Promise<void> => {
      let response: Response
      try {
        const fetchOpts: any = {
          signal,
          redirect: 'follow',
        }
        if (offset > 0) {
          fetchOpts.headers = { 'Range': `bytes=${offset}-` }
        }
        response = await fetch(url, fetchOpts)
      } catch (fetchErr: any) {
        const msg = fetchErr?.cause?.code || fetchErr?.code || fetchErr?.message || String(fetchErr)
        if (msg === 'AbortError' || String(msg).includes('abort')) throw fetchErr

        // 直连失败 → 尝试系统代理
        const proxyAgent = createProxyAgent()
        if (proxyAgent && retries === 0) {
          logger.debug(`[Download] 直连失败，尝试系统代理...`)
          try {
            const fetchOpts2: any = {
              signal,
              dispatcher: proxyAgent,
              redirect: 'follow',
            }
            if (offset > 0) {
              fetchOpts2.headers = { 'Range': `bytes=${offset}-` }
            }
            response = await fetch(url, fetchOpts2)
          } catch (proxyErr: any) {
            const pMsg = proxyErr?.cause?.code || proxyErr?.code || proxyErr?.message || String(proxyErr)
            throw new Error(`直连和代理均失败: ${msg} / proxy: ${pMsg}`)
          }
        } else {
          throw new Error(`网络连接失败: ${msg}`)
        }
      }

      if (!response.ok && response.status !== 206) {
        const errorText = await response.text().catch(() => '')
        throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 200)}`)
      }

      // 获取文件总大小
      if (task.totalSize === 0) {
        const cl = response.headers.get('content-length')
        if (cl) {
          task.totalSize = parseInt(cl, 10) + startPos
        }
      }

      if (!response.body) {
        throw new Error('响应体为空')
      }

      // 2. 流式写入 —— 用 Readable.fromWeb + createWriteStream + pipeline
      //    替代每 chunk 一次 writeFileSync/appendFileSync（性能提升 100x+）
      const nodeStream = require('stream').Readable.fromWeb(response.body as any)
      const fileStream = createWriteStream(task.tempPath, {
        flags: offset > 0 ? 'a' : 'w',  // 续传用 append，新下载用覆盖
        highWaterMark: 1024 * 1024,     // 1MB 写入缓冲
      })

      let receivedBytes = offset

      // 用 Transform 来跟踪进度
      const { Transform } = require('stream')
      const progressTracker = new Transform({
        transform(chunk: Buffer, _encoding: string, callback: Function) {
          receivedBytes += chunk.length
          task.downloadedSize = receivedBytes
          callback(null, chunk)
        }
      })

      const speedInterval = setInterval(() => {
        const now = Date.now()
        const elapsed = (now - lastUpdateTime) / 1000
        if (elapsed > 0) {
          const currentSpeed = (receivedBytes - lastBytes) / elapsed
          speedWindow.push(currentSpeed)
          if (speedWindow.length > SPEED_WINDOW_SIZE) speedWindow.shift()
          task.speed = speedWindow.reduce((a, b) => a + b, 0) / speedWindow.length
          if (task.totalSize > 0 && task.speed > 0) {
            task.remainingTime = (task.totalSize - receivedBytes) / task.speed
          }
          lastUpdateTime = now
          lastBytes = receivedBytes
        }
        task.progress = task.totalSize > 0 ? (receivedBytes / task.totalSize) * 100 : 0
        this.notifyProgress(task)
      }, 500)

      try {
        await pipeline(nodeStream, progressTracker, fileStream)
      } catch (pipeErr: any) {
        if (pipeErr?.code === 'ABORT_ERR' || String(pipeErr).includes('abort')) {
          throw pipeErr
        }
        fileStream.close()
        throw new Error(`写入失败: ${pipeErr?.message || pipeErr}`)
      } finally {
        clearInterval(speedInterval)
        fileStream.close()
      }

      task.downloadedSize = receivedBytes
    }

    // 3. 带重试的下载
    let lastErr: Error | null = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await doFetch(startPos)
        return
      } catch (err: any) {
        lastErr = err
        if (err?.name === 'AbortError') throw err
        if (attempt < retries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000) // 1s / 2s / 4s / 8s (max 10s)
          logger.debug(`[Download] 重试 ${attempt + 1}/${retries}, ${delay}ms 后...`)
          await new Promise(r => setTimeout(r, delay))
        }
      }
    }

    // 如果重试也失败了，尝试直接重试一次（用于源切换场景）
    if (retries < MAX_RETRIES) {
      logger.debug(`[Download] 同源重试耗尽，尝试重新连接...`)
      return this.downloadFromSource(task, url, signal, retries + 1)
    }
    throw lastErr || new Error('下载失败')
  }

  private async finalizeDownload(task: DownloadTask): Promise<void> {
    try {
      if (existsSync(task.outputPath)) {
        unlinkSync(task.outputPath)
      }
      renameSync(task.tempPath, task.outputPath)

      logger.debug(`[Download] 下载完成: ${task.modelName} (${(task.totalSize / 1024 / 1024 / 1024).toFixed(1)}GB)`)

      await this.verifyChecksum(task)

      // 自动注册模型
      this.autoRegisterModel(task)

      // 通知所有窗口刷新模型列表
      const { BrowserWindow } = require('electron')
      const windows = BrowserWindow.getAllWindows()
      windows.forEach((w: any) => {
        try { w.webContents.send('model:list-refresh') } catch (e) { logger.error('[ModelIPC] 发送 model:list-refresh 事件失败:', e) }
      })
    } catch (err) {
      if (existsSync(task.tempPath)) {
        copyFileSync(task.tempPath, task.outputPath)
        try { unlinkSync(task.tempPath) } catch (e) { logger.error('[ModelIPC] 清理临时文件失败:', e) }
      }
      logger.error('[Download] finalize error:', err)
    }
  }

  /**
   * 流式 SHA256 校验 —— 避免 readFileSync 把 5GB 文件读进内存导致 OOM
   */
  private async verifyChecksum(task: DownloadTask): Promise<void> {
    try {
      if (!existsSync(task.outputPath)) {
        task.error = '下载完成但文件不存在'
        task.status = 'error'
        return
      }

      const expectedHash = this.getExpectedChecksum(task.modelName)
      if (!expectedHash) {
        // 没有预期 hash → 跳过校验（下载源本身可信）
        logger.debug(`[Download] 无校验值，跳过 sha256 验证`)
        return
      }

      logger.debug(`[Download] 流式 SHA256 校验中...`)
      const hash = createHash('sha256')
      const readStream = createReadStream(task.outputPath, { highWaterMark: 1024 * 1024 })

      await new Promise<void>((resolve, reject) => {
        readStream.on('data', (chunk: string | Buffer) => hash.update(chunk))
        readStream.on('end', () => resolve())
        readStream.on('error', reject)
      })

      const actualHash = hash.digest('hex')
      if (actualHash !== expectedHash) {
        task.error = `SHA256 校验失败，文件可能损坏。请重新下载。`
        task.status = 'error'
        logger.error(`[Download] Checksum mismatch: expected ${expectedHash}, got ${actualHash}`)
        return
      }
      logger.debug(`[Download] SHA256 OK: ${actualHash.substring(0, 16)}...`)
    } catch (error) {
      logger.error('[Download] Checksum verification error:', error)
    }
  }

  /**
   * 获取预期SHA256（从模型元数据）
   */
  private getExpectedChecksum(modelName: string): string | null {
    try {
      const checksumsPath = join(app.getPath('userData'), 'models', 'checksums.json')
      if (existsSync(checksumsPath)) {
        const checksums = JSON.parse(readFileSync(checksumsPath, 'utf-8'))
        return checksums[modelName] || null
      }
    } catch (e) {
      logger.error('[ModelIPC] 读取校验和文件失败:', e)
    }
    return null
  }

  /**
   * 下载完成后自动注册 + 发送事件通知渲染进程
   */
  private autoRegisterModel(task: DownloadTask): void {
    try {
      const { modelManager } = require('../model-manager')
      if (modelManager && task.status === 'completed') {
        // v10.2：从 DEFAULT_MODELS 元数据补全 tier / gpuLayers，确保质量档模型
        // 下载注册后带正确档位（deriveGpuModelType → 'quality'，swapToQuality 可识别）
        const def = DEFAULT_MODELS.find((m: any) => m.name === task.modelName)
        const modelInfo = {
          id: task.modelName.toLowerCase().replace(/\s+/g, '-'),
          name: task.modelName,
          type: task.modelType,
          path: task.outputPath,
          size: task.totalSize / 1024 / 1024,
          tier: def?.tier,
          gpuLayers: def?.gpuLayers
        }
        modelManager.registerModel(modelInfo)
        logger.debug(`Auto-registered model: ${task.modelName}`)

        // 发送 model:downloaded 事件通知渲染进程自动注册完成
        const { BrowserWindow } = require('electron')
        const windows = BrowserWindow.getAllWindows()
        windows.forEach((w: any) => {
          try {
            w.webContents.send('model:downloaded', modelInfo)
          } catch (e) { logger.error('[ModelIPC] 发送 model:downloaded 事件失败:', e) }
        })
      }
    } catch (error) {
      logger.error('Auto-register model error:', error)
    }
  }

  pauseDownload(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return

    const abortController = this.abortControllers.get(taskId)
    if (abortController) {
      abortController.abort()
    }

    task.status = 'paused'
    this.notifyProgress(task)
  }

  resumeDownload(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'paused') return

    this.startDownload(taskId)
  }

  cancelDownload(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return

    const abortController = this.abortControllers.get(taskId)
    if (abortController) {
      abortController.abort()
    }

    const interval = this.progressIntervals.get(taskId)
    if (interval) {
      clearInterval(interval)
    }

    this.tasks.delete(taskId)
  }

  /**
   * 磁盘空间检查（下载前）
   */
  checkDiskSpace(requiredBytes: number): { sufficient: boolean; freeBytes: number; message: string } {
    try {
      const downloadDir = this.getDownloadDir()
      const { execSync } = require('child_process')
      const drive = downloadDir.substring(0, 2)
      const result = execSync(`"${POWERSHELL_EXE}" -Command "(Get-PSDrive ${drive}).Free"`, { encoding: 'utf-8', timeout: 5000 })
      const freeBytes = parseInt(result.trim()) || 0
      const freeGB = (freeBytes / 1024 / 1024 / 1024).toFixed(1)
      const requiredGB = (requiredBytes / 1024 / 1024 / 1024).toFixed(1)

      if (freeBytes < requiredBytes) {
        return {
          sufficient: false,
          freeBytes,
          message: `磁盘空间不足: 需要 ${requiredGB}GB, 可用 ${freeGB}GB`
        }
      }
      return {
        sufficient: true,
        freeBytes,
        message: `磁盘空间充足: 可用 ${freeGB}GB`
      }
    } catch (e) {
      logger.error('[ModelIPC] 检查磁盘空间失败:', e)
      return { sufficient: true, freeBytes: 0, message: '无法检测磁盘空间' }
    }
  }

  /**
   * 网络连通性检测
   */
  async checkNetwork(): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 5000)
      const response = await fetch('https://hf-mirror.com', { method: 'HEAD', signal: controller.signal })
      clearTimeout(timeoutId)
      return response.ok
    } catch (e) {
      logger.error('[ModelIPC] 检查网络连通性失败(hf-mirror):', e)
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 5000)
        const response = await fetch('https://huggingface.co', { method: 'HEAD', signal: controller.signal })
        clearTimeout(timeoutId)
        return response.ok
      } catch (e) {
        logger.error('[ModelIPC] 检查网络连通性失败(huggingface):', e)
        return false
      }
    }
  }

  getTasks(): DownloadTask[] {
    return Array.from(this.tasks.values())
  }

  getTask(taskId: string): DownloadTask | undefined {
    return this.tasks.get(taskId)
  }
}

export const downloadManager = new DownloadManager()

/* ------ 模型下载 URL：美国源优先直连（能通），国内镜像兜底 + URL key 后缀回退 ------ */
const DEFAULT_MODELS: {
  id: string
  name: string
  type: 'main' | 'vision' | 'embedding'
  /** v10.2 分层档位：fast=快档(VL-7B) / quality=质量档(14B) / vision=视觉（方案Y 兜底） */
  tier: 'fast' | 'quality' | 'vision'
  description: string
  recommended: boolean
  size: string
  sizeBytes: number
  url: string
  mirrors: string[]
  ollamaName: string
  /** v10.2 质量档部分卸载层数（仅 tier==='quality' 生效，默认 22） */
  gpuLayers?: number
}[] = [
  {
    id: 'qwen2-vl-7b',
    name: 'Qwen2-VL-7B-Instruct',
    type: 'vision',
    tier: 'fast',
    description: '视觉模型 — 图像理解、屏幕分析（v10.2 默认常驻：快档+视觉档统一底座，方案X）',
    recommended: true,
    size: '4.5GB',
    sizeBytes: 4.5 * 1024 * 1024 * 1024,
    url: 'https://huggingface.co/bartowski/Qwen2-VL-7B-Instruct-GGUF/resolve/main/Qwen2-VL-7B-Instruct-Q3_K_M.gguf',
    mirrors: [
      'https://hf-mirror.com/bartowski/Qwen2-VL-7B-Instruct-GGUF/resolve/main/Qwen2-VL-7B-Instruct-Q3_K_M.gguf',
    ],
    ollamaName: 'qwen2-vl:7b'
  },
  {
    id: 'qwen2-vl-3b',
    name: 'Qwen2-VL-3B-Instruct',
    type: 'vision',
    tier: 'fast',
    description: '轻量视觉模型 — UI定位、OCR、快速分析',
    recommended: false,
    size: '2.1GB',
    sizeBytes: 2.1 * 1024 * 1024 * 1024,
    url: 'https://huggingface.co/bartowski/Qwen2-VL-3B-Instruct-GGUF/resolve/main/Qwen2-VL-3B-Instruct-Q4_K_M.gguf',
    mirrors: [
      'https://hf-mirror.com/bartowski/Qwen2-VL-3B-Instruct-GGUF/resolve/main/Qwen2-VL-3B-Instruct-Q4_K_M.gguf',
    ],
    ollamaName: 'qwen2-vl:3b'
  },
  {
    id: 'minicpm-2b',
    name: 'MiniCPM-2B',
    type: 'main',
    tier: 'fast',
    description: '极轻量主模型 — 低内存设备、快速响应',
    recommended: false,
    size: '1.2GB',
    sizeBytes: 1.2 * 1024 * 1024 * 1024,
    url: 'https://huggingface.co/openbmb/MiniCPM-V-2_6-GGUF/resolve/main/ggml-model-Q4_K_M.gguf',
    mirrors: [
      'https://hf-mirror.com/openbmb/MiniCPM-V-2_6-GGUF/resolve/main/ggml-model-Q4_K_M.gguf',
    ],
    ollamaName: 'minicpm'
  },
  {
    id: 'nomic-embed',
    name: 'nomic-embed-text-v1.5',
    type: 'embedding',
    tier: 'fast',
    description: '文本向量化、RAG检索、语义搜索',
    recommended: true,
    size: '0.3GB',
    sizeBytes: 0.3 * 1024 * 1024 * 1024,
    url: 'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5-Q4_K_M.gguf',
    mirrors: [
      'https://hf-mirror.com/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5-Q4_K_M.gguf',
    ],
    ollamaName: 'nomic-embed-text'
  },
  {
    id: 'qwen2-vl-2b',
    name: 'Qwen2-VL-2B',
    type: 'main',
    tier: 'quality',
    description: '质量档多模态小模型 (2B) — 复杂推理/长文档/代码/数学，自带视觉塔。按需换入，任务结束释放回 VL-7B',
    recommended: false,
    size: '2.2GB',
    sizeBytes: 2.2 * 1024 * 1024 * 1024,
    gpuLayers: 99,
    url: 'https://huggingface.co/Qwen/Qwen2-VL-2B-Instruct-GGUF/resolve/main/Qwen2-VL-2B-Instruct-Q4_K_M.gguf',
    mirrors: [
      'https://hf-mirror.com/Qwen/Qwen2-VL-2B-Instruct-GGUF/resolve/main/Qwen2-VL-2B-Instruct-Q4_K_M.gguf'
    ],
    ollamaName: 'qwen2-vl:2b'
  }
]

export function setupModelHandlers(): void {

  ipcMain.handle('model:list', async () => {
    try {
      const downloads = downloadManager.getTasks()
      // 扫描已下载的模型文件，标记已安装状态
      const modelsDir = join(app.getPath('userData'), 'models')
      const installedModels = new Set<string>()
      if (existsSync(modelsDir)) {
        try {
          const { readdirSync } = require('fs')
          const files = readdirSync(modelsDir)
          for (const file of files) {
            if (file.endsWith('.gguf')) {
              installedModels.add(file.replace('.gguf', ''))
            }
          }
        } catch (e) {
          logger.error('[ModelIPC] 扫描已安装模型文件失败:', e)
        }
      }

      const recommended = DEFAULT_MODELS.map(m => ({
        ...m,
        installed: installedModels.has(m.name) || installedModels.has(m.id)
      }))
      return { recommended, downloads }
    } catch (error) {
      logger.error('model:list error:', error)
      // 即使出错也返回默认模型列表，确保下载卡片始终可见
      return { recommended: DEFAULT_MODELS.map(m => ({ ...m, installed: false })), downloads: [] }
    }
  })

  ipcMain.handle('model:download', async (_event, modelId: string) => {
    try {
      const model = DEFAULT_MODELS.find(m => m.id === modelId)
      if (!model) {
        return { error: 'Model not found' }
      }

      const task = await downloadManager.createTask(
        model.name,
        model.type,
        model.url,
        model.mirrors
      )

      downloadManager.startDownload(task.id)

      return { taskId: task.id }
    } catch (error) {
      logger.error('model:download 内部错误:', error)
      return { error: '模型操作遇到内部错误' }
    }
  })

  ipcMain.handle('model:pause-download', (_event, taskId: string) => {
    try {
      downloadManager.pauseDownload(taskId)
      return { success: true }
    } catch (error) {
      logger.error('model:pause-download 内部错误:', error)
      return { success: false, error: '模型操作遇到内部错误' }
    }
  })

  ipcMain.handle('model:resume-download', (_event, taskId: string) => {
    try {
      downloadManager.resumeDownload(taskId)
      return { success: true }
    } catch (error) {
      logger.error('model:resume-download 内部错误:', error)
      return { success: false, error: '模型操作遇到内部错误' }
    }
  })

  ipcMain.handle('model:cancel-download', (_event, taskId: string) => {
    try {
      downloadManager.cancelDownload(taskId)
      return { success: true }
    } catch (error) {
      logger.error('model:cancel-download 内部错误:', error)
      return { success: false, error: '模型操作遇到内部错误' }
    }
  })

  ipcMain.handle('model:get-download-tasks', () => {
    try {
      return downloadManager.getTasks()
    } catch (error) {
      logger.error('model:get-download-tasks error:', error)
      return []
    }
  })

  ipcMain.handle('model:import-gguf', async (_event, filePath: string, mmprojPath?: string) => {
    try {
      // 命令注入防护 — 验证文件路径和白名单
      if (!filePath || typeof filePath !== 'string') {
        return { error: 'Invalid file path' }
      }
      if (!existsSync(filePath)) {
        return { error: 'File not found' }
      }
      // 仅允许 .gguf 扩展名
      if (!/\.gguf$/i.test(filePath)) {
        return { error: 'Only .gguf files are supported' }
      }
      // 验证 mmprojPath（若提供）
      if (mmprojPath) {
        if (typeof mmprojPath !== 'string' || !existsSync(mmprojPath) || !/\.gguf$/i.test(mmprojPath)) {
          logger.warn(`[ModelIPC] mmprojPath 无效，将忽略: ${mmprojPath}`)
          mmprojPath = undefined
        }
      }

      const { basename } = require('path')
      const { statSync } = require('fs')
      const fileName = basename(filePath)
      const modelName = fileName.replace(/\.gguf$/i, '').replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]/g, '-').substring(0, 64)

      if (!modelName || modelName === '-') {
        return { error: 'Invalid model name derived from file' }
      }

      // 获取文件大小
      let fileSize = 0
      try { fileSize = statSync(filePath).size } catch { /* ignore */ }

      // 直接注册到 model-manager（不依赖 ollama）
      try {
        const { modelManager } = require('../model-manager')
        if (modelManager) {
          // 根据文件名推断模型类型
          let modelType: 'main' | 'vision' | 'embedding' = 'main'
          const lowerName = modelName.toLowerCase()
          if (lowerName.includes('vl') || lowerName.includes('visual') || lowerName.includes('vision')) {
            modelType = 'vision'
          } else if (lowerName.includes('embed') || lowerName.includes('nomic')) {
            modelType = 'embedding'
          }

          const regInfo: any = {
            id: modelName,
            name: modelName,
            type: modelType,
            path: filePath,
            size: fileSize,
            // 默认不设 gpuLayers，让运行时硬件探测决定
          }
          if (mmprojPath) {
            regInfo.mmprojPath = mmprojPath
          }

          modelManager.registerModel(regInfo)
        }
      } catch (regErr) {
        logger.warn('[ModelIPC] model-manager register failed (non-blocking):', regErr)
      }

      // 同时尝试 ollama 导入（兼容旧流程，非阻塞）
      try {
        // C-06 修复：spawnSync + 数组参数 + shell:false，避免 Windows shell 元字符注入
        const { spawnSync } = require('child_process')
        const ollamaResult = spawnSync('ollama', ['create', modelName, '-f', filePath], {
          stdio: 'pipe',
          timeout: 300000,
          shell: false,
          windowsHide: true,
          encoding: 'utf-8',
        })
        if (ollamaResult.error) throw ollamaResult.error
        if (ollamaResult.status !== 0) {
          logger.warn('[ModelIPC] ollama import exit code:', ollamaResult.status, String(ollamaResult.stderr || '').substring(0, 120))
        }
      } catch (ollamaErr) {
        logger.warn('[ModelIPC] ollama import failed (optional, model-manager fallback used):', String(ollamaErr).substring(0, 120))
      }

      return { success: true, modelName, modelPath: filePath, sizeBytes: fileSize }
    } catch (error) {
      logger.error('model:import-gguf error:', error)
      return { success: false, error: '模型导入失败', note: '请检查文件格式是否为 .gguf，是否已损坏' }
    }
  })

  /* ---------- 磁盘空间检查 ---------- */
  ipcMain.handle('model:check-disk', (_event, requiredBytes: number) => {
    try {
      return downloadManager.checkDiskSpace(requiredBytes || 0)
    } catch (error) {
      logger.error('model:check-disk error:', error)
      return { sufficient: false, freeBytes: 0, message: '磁盘检查失败' }
    }
  })

  /* ---------- 网络连通性检测 ---------- */
  ipcMain.handle('model:check-network', async () => {
    try {
      const online = await downloadManager.checkNetwork()
      return { online }
    } catch (error) {
      logger.error('model:check-network error:', error)
      return { online: false }
    }
  })

  /* ------ 代理检测 ------ */
  ipcMain.handle('proxy:detect', () => {
    try {
      const proxyUrl = getSystemProxy()
      return { detected: !!proxyUrl, proxyUrl }
    } catch (error) {
      logger.error('proxy:detect 内部错误:', error)
      return { detected: false, proxyUrl: null, error: '模型操作遇到内部错误' }
    }
  })

  ipcMain.handle('proxy:test', async () => {
    try {
      return await testProxy()
    } catch (error) {
      logger.error('proxy:test 内部错误:', error)
      return { available: false, proxyUrl: null, latency: 0, error: '模型操作遇到内部错误' }
    }
  })

  ipcMain.handle('proxy:refresh', () => {
    try {
      clearProxyCache()
      const proxyUrl = getSystemProxy()
      return { detected: !!proxyUrl, proxyUrl }
    } catch (error) {
      logger.error('proxy:refresh 内部错误:', error)
      return { detected: false, proxyUrl: null, error: '模型操作遇到内部错误' }
    }
  })

  /* ---------- 模型文件分析 ---------- */
  ipcMain.handle('model:analyze-file', async (_event, filePath: string) => {
    try {
      const { analyzeModelFile } = await import('../utils/model-analyzer')
      const { deviceOptimizer } = await import('../device')
      const deviceInfo = deviceOptimizer?.getDeviceInfo?.() || null
      return analyzeModelFile(filePath, deviceInfo)
    } catch (error) {
      logger.error('model:analyze-file error:', error)
      return { error: String(error) }
    }
  })
}
