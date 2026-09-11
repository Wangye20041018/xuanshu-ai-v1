﻿/**
 * LocalInferenceEngine — 本地模型推理引擎（原 TandemManager，已去「联动」概念）
 *
 * 职责（单一本地推理引擎，不再承担多模型联动）：
 * - 管理 llama-server 实例（spawn / 健康探测 / 守护重启 / 停止）
 * - 提供 queryModel 本地推理（HTTP /v1/completions）
 * - 6GB VRAM 感知：GPU 常驻一个模型，其余 CPU 运行
 * - 与 ModelManager / ModelRegistry / Scheduler 协作，复用 llama-server 路径
 *
 * 注：历史上此模块承担「超算/双模型联动（dual/partner/mentor/debate）」，按产品拍板
 * 方案 A 已删除全部联动模式，仅保留本地推理引擎能力，作为模型加载/卸载重构的载体。
 */

import { ChildProcess, spawn } from 'child_process'
import { ipcMain } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { logger } from '../../shared/logger'
import { sendToAllWindows } from '../utils/broadcast'
import { modelManager } from '../model-manager'
import { getHardware, resolveModelRuntime } from '../runtime/hardware'

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
  /** v13.x 多模态主模型：mmproj 视觉头路径（llama-server --mmproj，视觉推理直接走主模型） */
  mmprojPath?: string
}

export interface TandemHardwareLimit {
  maxVRAM_MB: number
  maxThreads: number
}

export interface TandemConfig {
  models: TandemModelConfig[]
  hardwareLimit: TandemHardwareLimit
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
  /** 实际启动模式/GPU 层数：与 llama-server 真实启动参数一致（前端展示 GPU/CPU 以此为准） */
  mode?: 'gpu' | 'cpu'
  gpuLayers?: number
  /** M-1 修复：MTP 状态（enabled=启动带 --spec-type draft-mtp；degraded=降级为非 MTP） */
  mtp?: { enabled: boolean; degraded: boolean }
}

/* ============================================================
 * LocalInferenceEngine 实现（原 TandemManager）
 * ============================================================ */

class TandemManager {
  private servers = new Map<string, TandemServerState>()
  private config: TandemConfig | null = null
  private llamaServerPath: string = ''
  private basePort = 8080
  /** MTP 自动识别开关（可回退）：true 时对「架构支持 MTP + 型号含 MTP」的模型自动启用 MTP 参数 */
  private mtpAutoEnabled = true

  /** 配置 MTP 自动识别开关（可回退开关，不影响手动模式下对模型的逐模型控制） */
  setMtpAutoEnabled(enabled: boolean): void {
    this.mtpAutoEnabled = enabled !== false
    logger.info(`[TandemManager] MTP 自动识别开关: ${this.mtpAutoEnabled ? 'ON' : 'OFF'}`)
  }

  isMtpAutoEnabled(): boolean {
    return this.mtpAutoEnabled
  }

  /**
   * MTP 模型识别：架构支持 MTP（Qwen3.5-9B / qwen35 底座）且型号带 MTP 后缀。
   * 当前内置两位 MTP 模型（均由 Qwen3.5-9B 底座改造）：
   *   - Qwopus3.5-9B-Coder-MTP      （name 含 "opus3.5-9b"）
   *   - DeepSeek-V4-Pro-Qwen3.5-9B-MTP（name 含 "qwen3.5-9b"）
   * 判定用 name/id/modelPath 任一命中即视为 MTP 模型：要求 ①型号含 "mtp" 后缀
   * 且 ②底座命中 qwen3.5/qwen35/opus3.5-9b/3.5-9b 之一（覆盖两位模型命名变体，避免漏识别）。
   */
  private isMtpModel(model: TandemModelConfig): boolean {
    const hay = `${model.name || ''} ${model.id || ''} ${model.modelPath || ''}`.toLowerCase()
    const qwen35Base =
      hay.includes('qwen3.5') ||
      hay.includes('qwen35') ||
      hay.includes('opus3.5-9b') ||
      hay.includes('3.5-9b')
    const hasMtp = hay.includes('mtp')
    return qwen35Base && hasMtp
  }

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

  /** 加载推理引擎配置 */
  loadConfig(config: TandemConfig): void {
    this.config = config
    // 更新端口基准，避免冲突
    const maxPort = Math.max(...config.models.map(m => m.port), this.basePort - 1)
    this.basePort = maxPort + 1
    logger.info(`[TandemManager] 配置已加载: ${config.models.length} 个模型`)
  }

  getConfig(): TandemConfig | null {
    return this.config
  }

  /** 采纳外部已运行端口（如注册表常驻引擎），不重复 spawn */
  adoptRunningServer(model: TandemModelConfig): boolean {
    const existing = this.servers.get(model.id)
    if (existing?.status === 'running') return true
    const state: TandemServerState = {
      modelId: model.id,
      port: model.port,
      status: 'running',
      process: null,
      startedAt: Date.now(),
      mode: model.mode,
      gpuLayers: model.gpuLayers,
    }
    this.servers.set(model.id, state)
    this.notifyStatusChange()
    logger.info(`[TandemManager] 已采纳常驻端口: ${model.name} 端口=${model.port}`)
    return true
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
      mode: model.mode,
      gpuLayers: model.gpuLayers,
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

  /** 启动 llama-server 进程（M-1 修复：GPU 模式追加 MTP 参数并支持失败降级） */
  private startLlamaServer(model: TandemModelConfig, state: TandemServerState): Promise<void> {
    return new Promise((resolve, reject) => {
      // M-1 接线：GPU 模式开启原生 MTP（多路预测）加速。
      // RTX3060 6GB 显存紧张，n_max=3（llama.cpp 官方建议 GPU 2~3）；CPU 模式不开（验证开销抵消收益）。
      const buildArgs = (useMtp: boolean): string[] => {
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
        // P0-4 上下文全开：GPU 模式把 KV cache 放到系统内存（--no-kv-offload）+ q8 量化，
        // 显存只装权重 → 上下文长度不再被显存余量卡死，由系统内存承载（实测生成速度几乎不降）。
        // 6G 卡显存余量归零也能撑起远超 4K 的大窗口。
        if (model.mode === 'gpu' && model.gpuLayers > 0) {
          args.push('--no-kv-offload', '-ctk', 'q8_0', '-ctv', 'q8_0', '-fa')
        }
        // v13.x 多模态主模型：挂载 mmproj 视觉头（Qwopus 发图直接走主模型，无需换载 2B）
        if (model.mmprojPath && existsSync(model.mmprojPath)) {
          args.push('--mmproj', model.mmprojPath)
        }
        if (useMtp && model.mode === 'gpu') {
          args.push('--spec-type', 'draft-mtp', '--spec-draft-n-max', '3', '--spec-draft-n-min', '1')
        }
        return args
      }

      // 单次尝试：useMtp=true 首次尝试，若启动失败（MTP 参数不被支持）则降级为非 MTP 重试
      const attempt = (useMtp: boolean): void => {
        const args = buildArgs(useMtp)
        logger.info(`[TandemManager] 启动: ${model.name} 端口=${model.port} ngl=${model.gpuLayers} ctx=${model.contextSize} MTP=${useMtp ? 'on' : 'off'}`)
        state.mtp = useMtp ? { enabled: true, degraded: false } : { enabled: false, degraded: true }

        const proc = spawn(this.llamaServerPath, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        let resolved = false
        let timedOut = false
        let healthTimer: NodeJS.Timeout | null = null

        const cleanup = (): void => {
          if (healthTimer) clearInterval(healthTimer)
          clearTimeout(timeout)
        }

        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true
            timedOut = true
            cleanup()
            try { proc.kill() } catch { /* ignore */ }
            reject(new Error(`${model.name} 启动超时（180秒）`))
          }
        }, 180000)

        // health 轮询：直接探测端口最可靠
        const checkHealth = (): void => {
          if (resolved) return
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const http = require('http')
            const req = http.get(`http://127.0.0.1:${model.port}/health`, { timeout: 2000 }, (res: any) => {
              if (res.statusCode === 200 && !resolved) {
                resolved = true
                cleanup()
                state.process = proc
                state.status = 'running'
                resolve()
              }
              if (res.resume) res.resume()
            })
            req.on('error', () => { /* 服务未就绪，继续等待 */ })
          } catch { /* ignore */ }
        }
        healthTimer = setInterval(checkHealth, 1000)

        const onServerReady = (text: string): void => {
          if (!resolved && (text.includes('HTTP server listening') || text.includes('starting the main loop') || text.includes('listening on http'))) {
            resolved = true
            cleanup()
            state.process = proc
            state.status = 'running'
            resolve()
          }
        }

        proc.stdout?.on('data', (data: Buffer) => onServerReady(data.toString()))
        proc.stderr?.on('data', (data: Buffer) => {
          const text = data.toString()
          onServerReady(text)
          logger.debug(`[TandemManager:${model.name}] ${text.trim().substring(0, 200)}`)
        })

        proc.on('error', (err) => {
          if (resolved) return
          // M-1 降级：MTP 参数不被当前 llama-server 支持 → 非 MTP 重试一次
          if (useMtp) {
            resolved = true
            cleanup()
            logger.warn(`[TandemManager] ${model.name} MTP 启动失败(${err.message})，降级为非 MTP 重启`)
            attempt(false)
            return
          }
          resolved = true
          cleanup()
          reject(new Error(`启动 ${model.name} 失败: ${err.message}`))
        })

        proc.on('exit', (code) => {
          if (!resolved && !timedOut) {
            // 启动阶段退出：若是 MTP 尝试，也降级重试（参数不被支持时可能直接退出）
            if (useMtp) {
              resolved = true
              cleanup()
              logger.warn(`[TandemManager] ${model.name} MTP 启动退出(code=${code})，降级为非 MTP 重启`)
              attempt(false)
              return
            }
            resolved = true
            cleanup()
            reject(new Error(`${model.name} 异常退出，退出码=${code}`))
          }
          // 运行中意外退出 → 指数退避自动重启（P1 稳定性：模型引擎守护）
          const wasRunning = state.status === 'running'
          state.status = 'stopped'
          state.process = null
          this.servers.set(model.id, state)

          if (wasRunning && code !== 0) {
            const attemptCount = (state.restartCount ?? 0) + 1
            if (attemptCount <= 3) {
              state.restartCount = attemptCount
              const delay = Math.min(1000 * Math.pow(2, attemptCount - 1), 8000)
              logger.warn(`[TandemManager] ${model.name} 运行中退出(code=${code})，${delay}ms 后自动重启 (${attemptCount}/3)`)
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
      }

      // MTP 自动识别（M-1 升级）：仅当「开关开启 + GPU 模式 + 识别为 MTP 模型（qwen3.5/qwen35 底座且型号含 MTP）」
      // 时才在首启带 MTP 参数；不满足条件的模型直接非 MTP 启动（不再对全量模型无脑开 MTP）。
      // 可回退：开关由 tandem:set-mtp-auto / 配置键 mtpAutoEnable 控制，置 OFF 则任何模型都不启用 MTP。
      const wantMtp =
        this.mtpAutoEnabled &&
        model.mode === 'gpu' &&
        model.gpuLayers > 0 &&
        this.isMtpModel(model)
      logger.info(
        `[TandemManager] ${model.name} MTP 自动识别: 开关=${this.mtpAutoEnabled} 识别为MTP=${this.isMtpModel(model)} 模式=${model.mode} → ${wantMtp ? '带MTP启动' : '非MTP启动'}`
      )

      // 首次以对应模式启动；MTP 首启失败/退出时 attempt(false) 自动降级
      attempt(wantMtp)
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
    // F-2 修复：tok/s 取自服务端 usage.completion_tokens（真实计数），不再用 content.length/4 估算
    const completionTokens = data.usage?.completion_tokens ?? data.usage?.total_tokens ?? 0
    const tokensPerSec = completionTokens > 0 && elapsed > 0 ? Math.round((completionTokens / (elapsed / 1000)) * 10) / 10 : 0
    return {
      content,
      elapsedMs: elapsed,
      tokensPerSec,
    }
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

      // 1. 构造目标模型配置：优先注册表（完整配置），回退 modelManager 扫描模型（资源目录 GGUF）
      const registered = modelRegistry.list().find((m: any) => m.id === modelId)
      let cfg: TandemModelConfig | null = null
      if (registered) {
        // 运行位置直通：按 RegisteredModel.runLocation 经 resolveModelRuntime 计算最终
        // gpuLayers/mode（显式指定不被显存自动缩放覆盖），再启动 llama-server
        const hw = await getHardware()
        const rt = resolveModelRuntime(
          { ...registered, runLocation: registered.runLocation, contextSize: registered.contextSize },
          hw,
        )
        cfg = {
          id: registered.id,
          name: registered.name,
          port: 0, // 下面统一分配
          modelPath: registered.modelPath,
          gpuLayers: rt.gpuLayers,
          contextSize: rt.contextSize || registered.contextSize || 2048,
          mode: rt.targetDevice === 'gpu' ? 'gpu' : 'cpu',
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

  /* ---------- MTP 自动识别开关（可回退） ---------- */
  ipcMain.handle('tandem:set-mtp-auto', async (_e, enabled: boolean) => {
    tandemManager.setMtpAutoEnabled(enabled !== false)
    return { success: true, mtpAutoEnabled: tandemManager.isMtpAutoEnabled() }
  })

  /* ---------- 端口健康探测（用于复用常驻模型引擎，如注册表 isStartup 模型） ---------- */
  ipcMain.handle('tandem:check-port', async (_e, port: number) => {
    try {
      const p = Number(port)
      if (!Number.isInteger(p) || p <= 0 || p > 65535) return { healthy: false }
      const healthy = await new Promise<boolean>((resolve) => {
        const req = require('http').get(`http://127.0.0.1:${p}/health`, { timeout: 2000 }, (res: any) => {
          const ok = res.statusCode === 200
          if (res.resume) res.resume()
          resolve(ok)
        })
        req.on('error', () => resolve(false))
      })
      return { healthy, port: p }
    } catch (e: any) {
      logger.error('[Tandem] check-port 失败:', e)
      return { healthy: false }
    }
  })

  /* ---------- 采纳常驻端口（注册表常驻引擎复用，不重复启动） ---------- */
  ipcMain.handle('tandem:adopt-port', async (_e, model: TandemModelConfig) => {
    try {
      const ok = tandemManager.adoptRunningServer(model)
      return { success: ok, port: model.port }
    } catch (e: any) {
      logger.error('[Tandem] adopt-port 失败:', e)
      return { success: false, error: e.message }
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
}
