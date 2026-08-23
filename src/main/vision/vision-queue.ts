import { desktopCapturer, BrowserWindow } from 'electron'

interface VisionTask {
  id: string
  type: 'screen' | 'window' | 'image' | 'desktop-description'
  priority: 'high' | 'normal' | 'low'
  data: string
  prompt?: string
  status: 'pending' | 'processing' | 'completed' | 'error'
  result?: string
  error?: string
  createdAt: number
  completedAt?: number
  processingTime?: number
}

interface VisionConfig {
  enabled: boolean
  model: string
  autoSee: boolean
  interval: number
  quality: 'high' | 'medium' | 'low'
  batchMode: boolean
  batchSize: number
}

class VisionTaskQueue {
  private queue: VisionTask[] = []
  private processing: boolean = false
  // @ts-expect-error TS6133 - processingTask reserved for future use
  private processingTask: VisionTask | null = null
  private abortController: AbortController | null = null
  private config: VisionConfig = {
    enabled: true,
    model: 'qwen2-vl',
    autoSee: false,
    interval: 5000,
    quality: 'high',
    batchMode: false,
    batchSize: 3
  }

  private listeners: Map<string, (task: VisionTask) => void> = new Map()

  constructor() {}

  setConfig(config: Partial<VisionConfig>): void {
    this.config = { ...this.config, ...config }
  }

  getConfig(): VisionConfig {
    return { ...this.config }
  }

  addTask(task: Omit<VisionTask, 'id' | 'status' | 'createdAt'>): VisionTask {
    const fullTask: VisionTask = {
      ...task,
      id: `vision-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      status: 'pending',
      createdAt: Date.now()
    }

    this.queue.push(fullTask)
    this.sortQueue()
    this.notifyListeners(fullTask)

    if (!this.processing && this.config.enabled) {
      this.processNext()
    }

    return fullTask
  }

  addBatch(tasks: Omit<VisionTask, 'id' | 'status' | 'createdAt'>[]): VisionTask[] {
    return tasks.map(task => this.addTask(task))
  }

  getTask(id: string): VisionTask | undefined {
    return this.queue.find(t => t.id === id)
  }

  getAllTasks(): VisionTask[] {
    return [...this.queue]
  }

  getPendingTasks(): VisionTask[] {
    return this.queue.filter(t => t.status === 'pending')
  }

  getCompletedTasks(): VisionTask[] {
    return this.queue.filter(t => t.status === 'completed')
  }

  cancelTask(id: string): boolean {
    const index = this.queue.findIndex(t => t.id === id)
    if (index === -1) return false

    const task = this.queue[index]
    if (task.status === 'processing') {
      if (this.abortController) {
        this.abortController.abort()
        this.abortController = null
      }
      task.status = 'error'
      task.error = 'Cancelled'
    }

    this.queue.splice(index, 1)
    return true
  }

  clearCompleted(): void {
    this.queue = this.queue.filter(t => t.status !== 'completed')
  }

  clearAll(): void {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
    this.queue = []
    this.processing = false
    this.processingTask = null
  }

  private sortQueue(): void {
    const priorityOrder = { high: 0, normal: 1, low: 2 }
    this.queue.sort((a, b) => {
      if (a.status === 'processing') return -1
      if (b.status === 'processing') return 1
      if (a.status === 'pending' && b.status !== 'pending') return -1
      if (b.status === 'pending' && a.status !== 'pending') return 1
      if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
        return priorityOrder[a.priority] - priorityOrder[b.priority]
      }
      return a.createdAt - b.createdAt
    })
  }

  private async processNext(): Promise<void> {
    if (this.processing || !this.config.enabled) return

    const pendingTasks = this.queue.filter(t => t.status === 'pending')
    if (pendingTasks.length === 0) return

    this.processing = true
    const task = pendingTasks[0]
    task.status = 'processing'

    this.abortController = new AbortController()
    const startTime = Date.now()

    this.notifyListeners(task)

    try {
      let result: string

      switch (task.type) {
        case 'screen':
          result = await this.captureAndAnalyzeScreen(task.data, task.prompt || '描述屏幕内容')
          break
        case 'window':
          result = await this.captureAndAnalyzeWindow(task.data, task.prompt || '描述窗口内容')
          break
        case 'image':
          result = await this.analyzeImage(task.data, task.prompt || '描述图片内容')
          break
        case 'desktop-description':
          result = await this.getDesktopDescription(task.prompt)
          break
        default:
          throw new Error(`Unknown task type: ${task.type}`)
      }

      task.status = 'completed'
      task.result = result
      task.completedAt = Date.now()
      task.processingTime = Date.now() - startTime
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        task.status = 'error'
        task.error = 'Task cancelled'
      } else {
        task.status = 'error'
        task.error = String(error)
      }
    }

    this.abortController = null
    this.processing = false
    this.notifyListeners(task)

    if (this.config.batchMode && task.status === 'completed') {
      const batch = this.queue
        .filter(t => t.status === 'pending' && t.type === task.type)
        .slice(0, this.config.batchSize - 1)

      for (const batchTask of batch) {
        batchTask.status = 'processing'
        this.notifyListeners(batchTask)

        try {
          const result = await this.processBatchTask(batchTask)
          batchTask.status = 'completed'
          batchTask.result = result
          batchTask.completedAt = Date.now()
          batchTask.processingTime = Date.now() - startTime
        } catch (error) {
          batchTask.status = 'error'
          batchTask.error = String(error)
        }

        this.notifyListeners(batchTask)
      }
    }

    this.processNext()
  }

  private async captureAndAnalyzeScreen(sourceId: string, prompt: string): Promise<string> {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: this.getThumbnailSize()
    })

    const source = sources.find(s => s.id === sourceId) || sources[0]
    if (!source) {
      throw new Error('No screen source available')
    }

    const imageBuffer = source.thumbnail.toPNG()
    const base64 = imageBuffer.toString('base64')

    return this.callVisionModel(base64, prompt)
  }

  private async captureAndAnalyzeWindow(sourceId: string, prompt: string): Promise<string> {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: this.getThumbnailSize()
    })

    const source = sources.find(s => s.id === sourceId)
    if (!source) {
      throw new Error('Window not found')
    }

    const imageBuffer = source.thumbnail.toPNG()
    const base64 = imageBuffer.toString('base64')

    return this.callVisionModel(base64, prompt)
  }

  private async analyzeImage(imageBase64: string, prompt: string): Promise<string> {
    return this.callVisionModel(imageBase64, prompt)
  }

  private async getDesktopDescription(prompt?: string): Promise<string> {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: this.getThumbnailSize()
    })

    if (sources.length === 0) {
      throw new Error('No screen source available')
    }

    const source = sources[0]
    const imageBuffer = source.thumbnail.toPNG()
    const base64 = imageBuffer.toString('base64')

    const defaultPrompt = prompt || '请详细描述屏幕上显示的内容，包括所有窗口、应用、按钮、输入框等 UI 元素，以及当前用户可能正在进行什么操作。'
    return this.callVisionModel(base64, defaultPrompt)
  }

  private async processBatchTask(task: VisionTask): Promise<string> {
    switch (task.type) {
      case 'screen':
        return this.captureAndAnalyzeScreen(task.data, task.prompt || '描述')
      case 'window':
        return this.captureAndAnalyzeWindow(task.data, task.prompt || '描述')
      case 'image':
        return this.analyzeImage(task.data, task.prompt || '描述')
      default:
        throw new Error(`Unsupported batch task type: ${task.type}`)
    }
  }

  private async callVisionModel(imageBase64: string, prompt: string): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 60_000)
    const cancel = this.abortController?.signal
    if (cancel) cancel.addEventListener('abort', () => controller.abort(), { once: true })

    try {
      const response = await fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
                { type: 'text', text: prompt }
              ]
            }
          ],
          stream: false
        })
      })

      if (!response.ok) {
        throw new Error(`Vision API error: ${response.status}`)
      }

      const data = await response.json()
      return data.message?.content || ''
    } finally {
      clearTimeout(timeout)
    }
  }

  private getThumbnailSize(): { width: number; height: number } {
    switch (this.config.quality) {
      case 'high':
        return { width: 1920, height: 1080 }
      case 'medium':
        return { width: 1280, height: 720 }
      case 'low':
        return { width: 854, height: 480 }
    }
  }

  onUpdate(taskId: string, callback: (task: VisionTask) => void): () => void {
    this.listeners.set(taskId, callback)
    return () => {
      this.listeners.delete(taskId)
    }
  }

  onAnyUpdate(callback: (task: VisionTask) => void): () => void {
    const id = `global-${Date.now()}`
    this.listeners.set(id, callback)
    return () => {
      this.listeners.delete(id)
    }
  }

  private notifyListeners(task: VisionTask): void {
    const windows = BrowserWindow.getAllWindows()
    windows.forEach(win => {
      try {
        if (win.isDestroyed()) return
        win.webContents.send('vision:task-update', task)
      } catch (e) { /* window pipe broken */ }
    })

    const callback = this.listeners.get(task.id) || this.listeners.get('global-any')
    if (callback) {
      callback(task)
    }
  }
}

export const visionTaskQueue = new VisionTaskQueue()

export function setupVisionHandlers(): void {
  const { ipcMain } = require('electron')

  ipcMain.handle('vision:set-config', (_event: any, config: Partial<VisionConfig>) => {
    visionTaskQueue.setConfig(config)
    return visionTaskQueue.getConfig()
  })

  ipcMain.handle('vision:get-config', () => {
    return visionTaskQueue.getConfig()
  })

  ipcMain.handle('vision:add-task', (_event: any, task: Omit<VisionTask, 'id' | 'status' | 'createdAt'>) => {
    return visionTaskQueue.addTask(task)
  })

  ipcMain.handle('vision:add-batch', (_event: any, tasks: Omit<VisionTask, 'id' | 'status' | 'createdAt'>[]) => {
    return visionTaskQueue.addBatch(tasks)
  })

  ipcMain.handle('vision:get-task', (_event: any, taskId: string) => {
    return visionTaskQueue.getTask(taskId)
  })

  ipcMain.handle('vision:get-all-tasks', () => {
    return visionTaskQueue.getAllTasks()
  })

  ipcMain.handle('vision:get-pending-tasks', () => {
    return visionTaskQueue.getPendingTasks()
  })

  ipcMain.handle('vision:get-completed-tasks', () => {
    return visionTaskQueue.getCompletedTasks()
  })

  ipcMain.handle('vision:cancel-task', (_event: any, taskId: string) => {
    return visionTaskQueue.cancelTask(taskId)
  })

  ipcMain.handle('vision:clear-completed', () => {
    visionTaskQueue.clearCompleted()
    return true
  })

  ipcMain.handle('vision:clear-all', () => {
    visionTaskQueue.clearAll()
    return true
  })
}

export type { VisionTask, VisionConfig }
