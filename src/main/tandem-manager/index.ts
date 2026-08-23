/**
 * TandemManager — 多模型联动引擎 v1.0
 *
 * 核心能力：
 * - 管理多个 llama-server 实例（独立端口）
 * - 四种联动模式：双答案 / 搭档 / 师徒 / 辩论
 * - 6GB VRAM 感知：GPU 常驻一个模型，其余 CPU 运行
 * - 与 ModelManager 协作，复用已有 llama-server 路径
 */

import { ChildProcess, spawn } from 'child_process'
import { ipcMain, BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { logger } from '../../shared/logger'
import { sendToAllWindows } from '../utils/broadcast'

/* ============================================================
 * 类型定义
 * ============================================================ */

export interface TandemModelConfig {
  id: string
  name: string
  /** llama-server 端口 */
  port: number
  /** 模型文件绝对路径 */
  modelPath: string
  /** GPU 层数（0 = 纯 CPU） */
  gpuLayers: number
  /** 上下文大小 */
  contextSize: number
  /** 运行模式 */
  mode: 'gpu' | 'cpu'
  /** 推理参数 */
  temperature: number
  maxTokens: number
}

export interface TandemHardwareLimit {
  maxVRAM_MB: number
  maxThreads: number
}

export type TandemMode = 'dual' | 'partner' | 'mentor' | 'debate'

export interface TandemConfig {
  models: TandemModelConfig[]
  hardwareLimit: TandemHardwareLimit
  defaultMode: TandemMode
}

export interface TandemServerState {
  modelId: string
  port: number
  status: 'stopped' | 'starting' | 'running' | 'error'
  process: ChildProcess | null
  startedAt: number
  errorMessage?: string
  /** 运行中意外退出后的自动重启次数（P1 稳定性） */
  restartCount?: number
}

interface DualAnswer {
  modelId: string
  modelName: string
  content: string
  elapsedMs: number
  tokensPerSec: number
}

/* ============================================================
 * TandemManager 实现
 * ============================================================ */

class TandemManager {
  private servers = new Map<string, TandemServerState>()
  private config: TandemConfig | null = null
  private llamaServerPath: string = ''
  private basePort = 8080

  /** 初始化：探测 llama-server 路径 */
  async initialize(): Promise<void> {
    const candidates = [
      // 优先使用项目内置的 llama-server
      join(__dirname, '..', '..', '..', 'resources', 'llama-server.exe'),
      // 开发模式路径
      join(process.cwd(), 'resources', 'llama-server.exe'),
    ]

    for (const p of candidates) {
      if (existsSync(p)) {
        this.llamaServerPath = p
        logger.info(`[TandemManager] llama-server: ${p}`)
        return
      }
    }

    logger.warn('[TandemManager] llama-server.exe 未找到，将使用 API 模式')
  }

  /** 加载联动配置 */
  loadConfig(config: TandemConfig): void {
    this.config = config
    // 更新端口基准，避免冲突
    const maxPort = Math.max(...config.models.map(m => m.port), this.basePort - 1)
    this.basePort = maxPort + 1
    logger.info(`[TandemManager] 配置已加载: ${config.models.length} 个模型, 默认模式=${config.defaultMode}`)
  }

  getConfig(): TandemConfig | null {
    return this.config
  }

  /** 启动单个模型的 llama-server */
  async startServer(model: TandemModelConfig): Promise<{ success: boolean; port: number; error?: string }> {
    const existing = this.servers.get(model.id)
    if (existing?.status === 'running') {
      return { success: true, port: existing.port }
    }

    // 6GB VRAM 约束：如果已有 GPU 模型在运行，且新模型也需要 GPU，冲突
    if (model.mode === 'gpu') {
      for (const [, s] of this.servers) {
        if (s.status === 'running') {
          const cfg = this.config?.models.find(m => m.id === s.modelId)
          if (cfg?.mode === 'gpu') {
            return { success: false, port: 0, error: `GPU 已被 "${cfg.name}" 占用（6GB VRAM 只能同时跑一个 GPU 模型）` }
          }
        }
      }
    }

    const state: TandemServerState = {
      modelId: model.id,
      port: model.port,
      status: 'starting',
      process: null,
      startedAt: Date.now(),
    }
    this.servers.set(model.id, state)

    try {
      if (this.llamaServerPath && existsSync(this.llamaServerPath)) {
        await this.startLlamaServer(model, state)
      } else {
        // 没有 llama-server，回退到 HTTP API 模式
        logger.info(`[TandemManager] 回退到 API 模式: ${model.name}`)
        state.status = 'running'
      }

      this.servers.set(model.id, state)
      this.notifyStatusChange()
      return { success: true, port: model.port }
    } catch (err: any) {
      state.status = 'error'
      state.errorMessage = err.message
      this.servers.set(model.id, state)
      this.notifyStatusChange()
      return { success: false, port: 0, error: err.message }
    }
  }

  /** 启动 llama-server 进程 */
  private startLlamaServer(model: TandemModelConfig, state: TandemServerState): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '-m', model.modelPath,
        '--port', String(model.port),
        '--host', '127.0.0.1',
        '-ngl', String(model.gpuLayers),
        '-c', String(model.contextSize),
        '--parallel', '1',
        '--jinja',
        '--metrics',
      ]

      logger.info(`[TandemManager] 启动: ${model.name} 端口=${model.port} ngl=${model.gpuLayers} ctx=${model.contextSize}`)

      const proc = spawn(this.llamaServerPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let resolved = false
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          clearInterval(healthTimer)
          try { proc.kill() } catch { /* ignore */ }
          reject(new Error(`${model.name} 启动超时（180秒）`))
        }
      }, 180000)

      // health 轮询：llama-server 新版输出格式不一（listening on http），直接探测端口最可靠
      const checkHealth = (): void => {
        if (resolved) return
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const http = require('http')
          const req = http.get(`http://127.0.0.1:${model.port}/health`, { timeout: 2000 }, (res: any) => {
            if (res.statusCode === 200 && !resolved) {
              resolved = true
              clearTimeout(timeout)
              clearInterval(healthTimer)
              state.process = proc
              state.status = 'running'
              resolve()
            }
            if (res.resume) res.resume()
          })
          req.on('error', () => { /* 服务未就绪，继续等待 */ })
        } catch { /* ignore */ }
      }
      const healthTimer = setInterval(checkHealth, 1000)

      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString()
        if (!resolved && (text.includes('HTTP server listening') || text.includes('starting the main loop') || text.includes('listening on http'))) {
          resolved = true
          clearTimeout(timeout)
          clearInterval(healthTimer)
          state.process = proc
          state.status = 'running'
          resolve()
        }
      })

      proc.stderr?.on('data', (data: Buffer) => {
        // llama-server 的很多输出走 stderr，这是正常的
        const text = data.toString()
        if (!resolved && (text.includes('HTTP server listening') || text.includes('starting the main loop') || text.includes('listening on http'))) {
          resolved = true
          clearTimeout(timeout)
          clearInterval(healthTimer)
          state.process = proc
          state.status = 'running'
          resolve()
        }
        logger.debug(`[TandemManager:${model.name}] ${text.trim().substring(0, 200)}`)
      })

      proc.on('error', (err) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          clearInterval(healthTimer)
          reject(new Error(`启动 ${model.name} 失败: ${err.message}`))
        }
      })

      proc.on('exit', (code) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          clearInterval(healthTimer)
          reject(new Error(`${model.name} 异常退出，退出码=${code}`))
        }
        // 运行中意外退出 → 指数退避自动重启（P1 稳定性：模型引擎守护）
        const wasRunning = state.status === 'running'
        state.status = 'stopped'
        state.process = null
        this.servers.set(model.id, state)

        if (wasRunning && code !== 0) {
          const attempt = (state.restartCount ?? 0) + 1
          if (attempt <= 3) {
            state.restartCount = attempt
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000)
            logger.warn(`[TandemManager] ${model.name} 运行中退出(code=${code})，${delay}ms 后自动重启 (${attempt}/3)`)
            this.notifyStatusChange()
            setTimeout(() => {
              if (state.status === 'stopped') {
                state.status = 'starting'
                this.startLlamaServer(model, state)
                  .then(() => {
                    logger.info(`[TandemManager] ${model.name} 自动重启成功 (端口 ${model.port})`)
                  })
                  .catch((e: Error) => {
                    state.status = 'error'
                    state.errorMessage = e.message
                    logger.error(`[TandemManager] ${model.name} 自动重启失败: ${e.message}`)
                  })
                  .finally(() => { this.notifyStatusChange() })
              }
            }, delay)
            return
          }
          logger.warn(`[TandemManager] ${model.name} 已达到最大重启次数(3)，停止自动重启`)
        } else if (wasRunning) {
          logger.warn(`[TandemManager] ${model.name} 正常退出，code=${code}`)
        }
        this.notifyStatusChange()
      })
    })
  }

  /** 停止单个模型的服务器 */
  async stopServer(modelId: string): Promise<boolean> {
    const state = this.servers.get(modelId)
    if (!state) return true

    // 先置为停止态：proc.on('exit') 回调会依据状态判断是否自动重启，
    // 若在 kill 之后再改状态，进程退出的 1s 窗口内会误判"运行中退出"而拉起旧引擎。
    state.status = 'stopped'
    this.servers.set(modelId, state)

    if (state.process) {
      try {
        state.process.kill('SIGTERM')
        // 等待进程退出
        await new Promise(r => setTimeout(r, 1000))
        if (state.process.exitCode === null) {
          state.process.kill('SIGKILL')
        }
      } catch {
        // 进程可能已经退出
      }
    }

    state.process = null
    this.servers.set(modelId, state)
    this.notifyStatusChange()
    return true
  }

  /** 停止所有服务器 */
  async stopAll(): Promise<void> {
    const ids = Array.from(this.servers.keys())
    await Promise.all(ids.map(id => this.stopServer(id)))
  }

  /** 获取服务器状态列表 */
  getServerStates(): TandemServerState[] {
    return Array.from(this.servers.values()).map(s => ({
      ...s,
      process: null, // 不暴露 process 对象给渲染进程
    }))
  }

  /** 查询模型（HTTP API 调用） */
  async queryModel(
    modelId: string,
    prompt: string,
    options?: { temperature?: number; maxTokens?: number }
  ): Promise<{ content: string; elapsedMs: number; tokensPerSec: number }> {
    const state = this.servers.get(modelId)
    if (!state || state.status !== 'running') {
      throw new Error(`模型 "${modelId}" 未运行`)
    }

    const cfg = this.config?.models.find(m => m.id === modelId)
    const temp = options?.temperature ?? cfg?.temperature ?? 0.7
    const maxTokens = options?.maxTokens ?? cfg?.maxTokens ?? 2048

    const start = Date.now()
    const resp = await fetch(`http://127.0.0.1:${state.port}/v1/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        temperature: temp,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(120000),
    })

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`模型 "${modelId}" 推理失败: HTTP ${resp.status} ${errText.substring(0, 200)}`)
    }

    const data = await resp.json() as any
    const elapsed = Date.now() - start
    const content = data.choices?.[0]?.text || ''
    const tk = content.length / 4
    return {
      content,
      elapsedMs: elapsed,
      tokensPerSec: Math.round(tk / (elapsed / 1000)),
    }
  }

  /** 双答案模式 */
  async dualAnswer(
    prompt: string,
    modelAId: string,
    modelBId: string,
  ): Promise<DualAnswer[]> {
    // 并行查询两个模型
    const [resultA, resultB] = await Promise.all([
      this.queryModel(modelAId, prompt).catch(e => ({
        content: `[错误] ${e.message}`,
        elapsedMs: 0,
        tokensPerSec: 0,
      })),
      this.queryModel(modelBId, prompt).catch(e => ({
        content: `[错误] ${e.message}`,
        elapsedMs: 0,
        tokensPerSec: 0,
      })),
    ])

    const cfgA = this.config?.models.find(m => m.id === modelAId)
    const cfgB = this.config?.models.find(m => m.id === modelBId)

    return [
      { modelId: modelAId, modelName: cfgA?.name || modelAId, ...resultA },
      { modelId: modelBId, modelName: cfgB?.name || modelBId, ...resultB },
    ]
  }

  /** 搭档模式：按专长分工 */
  async partnerAnswer(
    prompt: string,
    modelAId: string, // 代码/逻辑
    modelBId: string, // 分析/文字
    strategy: 'expertise' | 'content' | 'dimension' = 'expertise'
  ): Promise<DualAnswer[]> {
    let taskA = prompt
    let taskB = prompt

    switch (strategy) {
      case 'expertise':
        taskA = `[代码与逻辑分析任务] ${prompt}`
        taskB = `[文字理解与分析任务] ${prompt}`
        break
      case 'content':
        // 按内容拆分：前半段给 A，后半段给 B
        const mid = Math.floor(prompt.length / 2)
        taskA = `[前半部分] ${prompt.substring(0, mid)}`
        taskB = `[后半部分] ${prompt.substring(mid)}`
        break
      case 'dimension':
        taskA = `[中文视角] ${prompt}`
        taskB = `[英文视角] ${prompt}`
        break
    }

    const [resultA, resultB] = await Promise.all([
      this.queryModel(modelAId, taskA).catch(e => ({
        content: `[错误] ${e.message}`,
        elapsedMs: 0,
        tokensPerSec: 0,
      })),
      this.queryModel(modelBId, taskB).catch(e => ({
        content: `[错误] ${e.message}`,
        elapsedMs: 0,
        tokensPerSec: 0,
      })),
    ])

    const cfgA = this.config?.models.find(m => m.id === modelAId)
    const cfgB = this.config?.models.find(m => m.id === modelBId)

    return [
      { modelId: modelAId, modelName: `${cfgA?.name || modelAId} (${strategy})`, ...resultA },
      { modelId: modelBId, modelName: `${cfgB?.name || modelBId} (${strategy})`, ...resultB },
    ]
  }

  /* ============================================================
   * 师徒模式：小模型起草 → 大模型校验修正
   * ============================================================ */
  async mentorAnswer(
    prompt: string,
    mentorAId: string,   // 大模型（导师/校验方）
    apprenticeBId: string, // 小模型（学徒/起草方）
    // @ts-expect-error TS6133 - roundCount reserved for future use
    roundCount: number = 1
  ): Promise<{
    draft: DualAnswer
    verified: DualAnswer
    finalContent: string
  }> {
    // 阶段1：学徒草稿
    const draftTask = `请快速给出一个简洁的初始答案（后续会被导师校验修正）：\n${prompt}`
    const draftResult = await this.queryModel(apprenticeBId, draftTask, { temperature: 0.8, maxTokens: 1024 })

    // 阶段2：导师校验 + 修正
    const verifyTask = `以下是一个初级模型对问题的回答草稿，请作为专家审阅者：\n1) 指出草稿中的错误或不足\n2) 给出修正后的完整最终答案\n\n【原始问题】\n${prompt}\n\n【草稿答案】\n${draftResult.content}\n\n请按以下格式输出：\n## 校验意见\n（指出错误/不足）\n\n## 最终答案\n（修正后的完整答案）`
    const verifiedResult = await this.queryModel(mentorAId, verifyTask, { temperature: 0.5, maxTokens: 2048 })

    const cfgA = this.config?.models.find(m => m.id === mentorAId)
    const cfgB = this.config?.models.find(m => m.id === apprenticeBId)

    return {
      draft: {
        modelId: apprenticeBId,
        modelName: `${cfgB?.name || apprenticeBId} (草稿)`,
        content: draftResult.content,
        elapsedMs: draftResult.elapsedMs,
        tokensPerSec: draftResult.tokensPerSec,
      },
      verified: {
        modelId: mentorAId,
        modelName: `${cfgA?.name || mentorAId} (导师)`,
        content: verifiedResult.content,
        elapsedMs: verifiedResult.elapsedMs,
        tokensPerSec: verifiedResult.tokensPerSec,
      },
      finalContent: verifiedResult.content,
    }
  }

  /* ============================================================
   * 辩论模式：两模型交替辩论（TandemManager 双服务器版）
   * ============================================================ */
  async debateAnswer(
    question: string,
    modelAId: string,  // 正方
    modelBId: string,  // 反方
    rounds: number = 2
  ): Promise<{
    question: string
    rounds: Array<{
      index: number
      sideA: { modelName: string; content: string; elapsedMs: number; tokensPerSec: number }
      sideB: { modelName: string; content: string; elapsedMs: number; tokensPerSec: number }
    }>
    history: string[]
  }> {
    const cfgA = this.config?.models.find(m => m.id === modelAId)
    const cfgB = this.config?.models.find(m => m.id === modelBId)
    const nameA = cfgA?.name || modelAId
    const nameB = cfgB?.name || modelBId

    const result: any = {
      question,
      rounds: [],
      history: [],
    }

    let contextA = `你正在参与一场辩论，你是正方辩手。\n辩题：${question}\n`
    let contextB = `你正在参与一场辩论，你是反方辩手。\n辩题：${question}\n`

    for (let i = 0; i < rounds; i++) {
      // A 发言
      const promptA = i === 0
        ? `${contextA}请发表你的开篇立论，阐述你的核心观点和主要论据。`
        : `${contextA}请针对反方刚才的观点进行反驳，并进一步强化你的论点。`
      const resultA = await this.queryModel(modelAId, promptA, { temperature: 0.85, maxTokens: 1024 })

      // B 发言
      const opponentAContent = resultA.content
      const promptB = i === 0
        ? `${contextB}正方刚刚发表了以下观点：\n"${opponentAContent.substring(0, 500)}"\n\n请发表你的开篇立论，批驳正方观点并阐述你的立场。`
        : `${contextB}正方反驳说：\n"${opponentAContent.substring(0, 500)}"\n\n请回击正方的反驳，维护你的立场。`
      const resultB = await this.queryModel(modelBId, promptB, { temperature: 0.85, maxTokens: 1024 })

      const roundData = {
        index: i + 1,
        sideA: {
          modelName: nameA,
          content: resultA.content,
          elapsedMs: resultA.elapsedMs,
          tokensPerSec: resultA.tokensPerSec,
        },
        sideB: {
          modelName: nameB,
          content: resultB.content,
          elapsedMs: resultB.elapsedMs,
          tokensPerSec: resultB.tokensPerSec,
        },
      }

      result.rounds.push(roundData)
      result.history.push(`[第${i + 1}轮] ${nameA}: ${resultA.content}`)
      result.history.push(`[第${i + 1}轮] ${nameB}: ${resultB.content}`)

      // 更新上下文
      contextA += `\n反方在第${i + 1}轮说：${resultB.content.substring(0, 500)}\n`
      contextB += `\n正方在第${i + 1}轮说：${resultA.content.substring(0, 500)}\n`
    }

    return result
  }

  /** 广播状态变更到所有渲染窗口 */
  private notifyStatusChange(): void {
    const states = this.getServerStates()
    sendToAllWindows('tandem:status-change', states)
  }

  /** 清理：停止所有进程 */
  async destroy(): Promise<void> {
    await this.stopAll()
    this.servers.clear()
  }
}

export const tandemManager = new TandemManager()

/* ============================================================
 * IPC 处理器注册
 * ============================================================ */

export function setupTandemHandlers(): void {
  tandemManager.initialize()

  /* ---------- 配置 ---------- */
  ipcMain.handle('tandem:load-config', async (_e, config: TandemConfig) => {
    try {
      tandemManager.loadConfig(config)
      return { success: true }
    } catch (e: any) {
      logger.error('[Tandem] load-config 失败:', e)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('tandem:get-config', async () => {
    try {
      return tandemManager.getConfig()
    } catch (e: any) {
      logger.error('[Tandem] get-config 失败:', e)
      return null
    }
  })

  /* ---------- 服务器管理 ---------- */
  ipcMain.handle('tandem:start-server', async (_e, model: TandemModelConfig) => {
    try {
      return await tandemManager.startServer(model)
    } catch (e: any) {
      logger.error('[Tandem] start-server 失败:', e)
      return { success: false, port: 0, error: e.message }
    }
  })

  ipcMain.handle('tandem:stop-server', async (_e, modelId: string) => {
    try {
      return await tandemManager.stopServer(modelId)
    } catch (e: any) {
      logger.error('[Tandem] stop-server 失败:', e)
      return false
    }
  })

  ipcMain.handle('tandem:stop-all', async () => {
    try {
      await tandemManager.stopAll()
      return true
    } catch (e: any) {
      logger.error('[Tandem] stop-all 失败:', e)
      return false
    }
  })

  /* ---------- 切换当前推理模型（停旧引擎 → 起新引擎） ---------- */
  ipcMain.handle('tandem:switch-model', async (_e, modelId: string) => {
    try {
      if (!modelId) return { success: false, error: '缺少模型 ID' }
      const { modelRegistry } = await import('../model-registry')
      const { modelManager } = await import('../model-manager')

      // 1. 构造目标模型配置：优先注册表（完整配置），回退 modelManager 扫描模型（资源目录 GGUF）
      const registered = modelRegistry.list().find((m: any) => m.id === modelId)
      let cfg: TandemModelConfig | null = null
      if (registered) {
        cfg = {
          id: registered.id,
          name: registered.name,
          port: 0, // 下面统一分配
          modelPath: registered.modelPath,
          gpuLayers: registered.mode === 'cpu' ? 0 : (registered.gpuLayers || 0),
          contextSize: registered.contextSize || 2048,
          mode: registered.mode === 'cpu' ? 'cpu' : 'gpu',
          temperature: registered.temperature ?? 0.7,
          maxTokens: registered.maxTokens ?? 2048,
        }
      } else {
        const scanned = (modelManager.getAllModels() || []).find((m: any) => m.id === modelId)
        if (scanned) {
          cfg = {
            id: scanned.id,
            name: scanned.name || scanned.id,
            port: 0,
            modelPath: scanned.path,
            gpuLayers: scanned.mode === 'cpu' ? 0 : (scanned.gpuLayers || 0),
            contextSize: 2048,
            mode: scanned.mode === 'cpu' ? 'cpu' : 'gpu',
            temperature: 0.7,
            maxTokens: 2048,
          }
        }
      }
      if (!cfg) return { success: false, error: `模型 ${modelId} 未找到（未注册且未扫描到模型文件）` }

      // 2. 分配端口：避开已占用端口（registry + 运行中 servers + 系统保留）
      const usedPorts = new Set<number>([8080, 8081])
      for (const s of tandemManager.getServerStates()) usedPorts.add(s.port)
      for (const m of modelRegistry.list()) if (m.port) usedPorts.add(m.port)
      let port = 8082
      while (usedPorts.has(port)) port++
      cfg.port = port

      // 3. 停掉当前所有运行/启动中的引擎（避免 GPU 冲突与端口占用）
      const running = tandemManager.getServerStates().filter(
        (s: any) => (s.status === 'running' || s.status === 'starting') && s.modelId !== cfg!.id
      )
      for (const s of running) {
        try { await tandemManager.stopServer(s.modelId) } catch (e: any) {
          logger.error(`[Tandem] 停止 ${s.modelId} 失败: ${e?.message || e}`)
        }
      }

      // 4. 启动目标模型
      const result = await tandemManager.startServer(cfg)
      if (!result.success) return { success: false, error: result.error || '启动失败' }

      logger.info(`[Tandem] 已切换当前推理模型: ${cfg.name} (端口 ${result.port})`)
      return { success: true, modelId: cfg.id, name: cfg.name, port: result.port }
    } catch (e: any) {
      logger.error('[Tandem] switch-model 失败:', e)
      return { success: false, error: e?.message || String(e) }
    }
  })

  ipcMain.handle('tandem:status', async () => {
    try {
      return tandemManager.getServerStates()
    } catch (e: any) {
      logger.error('[Tandem] status 失败:', e)
      return []
    }
  })

  /* ---------- 推理 ---------- */
  ipcMain.handle('tandem:query', async (_e, modelId: string, prompt: string, options?: { temperature?: number; maxTokens?: number }) => {
    try {
      return await tandemManager.queryModel(modelId, prompt, options)
    } catch (e: any) {
      return { content: `[错误] ${e.message}`, elapsedMs: 0, tokensPerSec: 0 }
    }
  })

  /* ---------- 双答案 ---------- */
  ipcMain.handle('tandem:dual-answer', async (_e, prompt: string, modelAId: string, modelBId: string) => {
    try {
      return await tandemManager.dualAnswer(prompt, modelAId, modelBId)
    } catch (e: any) {
      return [{ modelId: 'error', modelName: '错误', content: e.message, elapsedMs: 0, tokensPerSec: 0 }]
    }
  })

  /* ---------- 搭档 ---------- */
  ipcMain.handle('tandem:partner-answer', async (_e, prompt: string, modelAId: string, modelBId: string, strategy: 'expertise' | 'content' | 'dimension') => {
    try {
      return await tandemManager.partnerAnswer(prompt, modelAId, modelBId, strategy)
    } catch (e: any) {
      return [{ modelId: 'error', modelName: '错误', content: e.message, elapsedMs: 0, tokensPerSec: 0 }]
    }
  })

  /* ---------- 师徒 ---------- */
  ipcMain.handle('tandem:mentor-answer', async (_e, prompt: string, mentorAId: string, apprenticeBId: string) => {
    try {
      return await tandemManager.mentorAnswer(prompt, mentorAId, apprenticeBId)
    } catch (e: any) {
      return { error: e.message, draft: null, verified: null, finalContent: '' }
    }
  })

  /* ---------- 辩论 ---------- */
  ipcMain.handle('tandem:debate-answer', async (_e, question: string, modelAId: string, modelBId: string, rounds?: number) => {
    try {
      return await tandemManager.debateAnswer(question, modelAId, modelBId, rounds ?? 2)
    } catch (e: any) {
      return { error: e.message, question, rounds: [], history: [] }
    }
  })

  /* ---------- 流式聊天（串联首页） ---------- */
  ipcMain.handle('tandem:chat', async (_e, mode: string, prompt: string, modelAId: string, modelBId: string, strategy?: string) => {
    try {
      const windows = BrowserWindow.getAllWindows()
      // @ts-expect-error TS6133 - win reserved for future use
      const win = windows.length > 0 ? windows[0] : null

      switch (mode) {
        case 'dual': {
          const results = await tandemManager.dualAnswer(prompt, modelAId, modelBId)
          return { success: true, mode, results }
        }
        case 'partner': {
          const results = await tandemManager.partnerAnswer(prompt, modelAId, modelBId, (strategy as any) || 'expertise')
          return { success: true, mode, results }
        }
        case 'mentor': {
          const result = await tandemManager.mentorAnswer(prompt, modelAId, modelBId)
          return { success: true, mode, result }
        }
        case 'debate': {
          const result = await tandemManager.debateAnswer(prompt, modelAId, modelBId, 2)
          return { success: true, mode, result }
        }
        default:
          return { success: false, error: `未知模式: ${mode}` }
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })
}
