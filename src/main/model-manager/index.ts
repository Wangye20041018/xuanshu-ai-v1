import { app, ipcMain, BrowserWindow } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'
import http from 'http'
import { POWERSHELL_EXE } from '../utils/powershell'
import { pythonRuntime } from '../runtime/python'
import { cpuInferenceEngine, CpuInferenceEngine, isGpuAvailable, CpuInferenceConfig } from '../inference/cpu-engine'
import { stopSGLang, startSGLangServer } from '../ipc/sglang.ipc'
import { getHardware, resolveModelRuntime, HardwareInfo } from '../runtime/hardware'

import { createLogger } from '../utils/logging'
import { getStore } from '../ipc/config.ipc'
import { analyzeModelFile, SUPPORTED_EXTENSIONS } from '../utils/model-analyzer'
const logger = createLogger('ModelManager')

const execAsync = promisify(exec)

/* ============================================================
 * 模型管理器（显存优化版）v10.3.0
 *
 * 关键约束：6GB 显存，同一时间只能加载一个模型。
 * 自动清理：空闲 15 分钟后自动卸载模型。
 *
 * v10.3.0 变更（本地模型文件智能分析）：
 *   - 新增 model:scan-local IPC handler，调用 model-analyzer 深度分析
 *   - 支持格式检测/参数量估算/量化检测/VRAM估算/设备适配
 *
 * v10.2.0 变更（llama.cpp Server 模式）：
 *   - 新增 isServerRunning() / serverHealth() 检测端口 8080
 *   - generateResponse() 优先通过 HTTP API 调用 server
 *   - 直调模式（cpuInferenceEngine / SGLang）作为 fallback
 * ============================================================ */

/** v11.0 GPU 显存状态枚举（单模型常驻，废弃双档） */
export type GpuModelType = 'main' | 'vision' | null

interface ModelInfo {
  id: string
  name: string
  type: 'main' | 'vision' | 'embedding'
  /** v11.0 分层档位，用于推导 gpuModelType */
  tier?: 'fast' | 'vision' | 'quality'
  /** GPU 部分卸载层数 */
  gpuLayers?: number
  /** 显式推理模式：cpu=纯 CPU（不参与 GPU 显存判定），gpu/缺省=自动 */
  mode?: 'gpu' | 'cpu'
  path: string
  /** 视觉模型专用：mmproj 投影文件路径 */
  mmprojPath?: string
  /** v12.2 是否多模态（主模型自带视觉能力时无需切换辅助视觉模型） */
  isMultimodal?: boolean
  size: number
  loaded: boolean
  lastUsed: number
  memoryUsage: number
  gpuUsage: number
}

interface MemoryStats {
  total: number
  used: number
  free: number
  modelMemory: number
  systemMemory: number
}

interface GPUStats {
  usage: number
  memoryUsed: number
  memoryTotal: number
}

interface PerformanceStats {
  cpu: number
  memory: MemoryStats
  gpu: GPUStats
  modelLatency: number
  throughput: number
}

interface CurrentModel {
  modelId: string
  modelName: string
  modelPath: string
  modelType: 'main' | 'vision' | 'embedding'
  loadedAt: number
}

class ModelManager {
  private models: Map<string, ModelInfo> = new Map()
  private currentModel: CurrentModel | null = null
  private modelPath: string | null = null
  private maxMemoryUsage: number = 0.8
  private cleanupInterval: ReturnType<typeof setInterval> | null = null
  private idleTimeout: ReturnType<typeof setTimeout> | null = null
  // IDLE_TIMEOUT 5min → 15min (优化#1)
  private readonly IDLE_TIMEOUT_MS = 15 * 60 * 1000
  // contextSize 2048 → 4096 (优化#2)
  private readonly DEFAULT_CONTEXT_SIZE = 4096
  // 防止在推理进行中卸载模型
  private isGenerating: boolean = false
  // v10.3 环境自适应：运行时硬件信息（懒加载，模块级缓存单例由 getHardware 保证）
  private hw: HardwareInfo | null = null
  // 加载互斥锁：串行化 loadModel 调用，防止并发冲突 (D3-1)
  private loadingLock: Promise<void> = Promise.resolve()

  // === llama.cpp Server 模式 v10.2.0 ===
  // v12.3 端口动态探测：TandemManager 的 llama-server 常驻 8082，8080 保留为备用
  private readonly SERVER_PORTS = [8082, 8080]
  private readonly SERVER_HOST = '127.0.0.1'
  private activeServerPort: number | null = null

  // 性能追踪：记录最近N次推理的延迟和token数
  private _latencyHistory: number[] = []  // 最近20次推理延迟(ms)
  // @ts-expect-error TS6133 - _tokenCountHistory reserved for future use
  private _tokenCountHistory: number[] = [] // 最近20次推理输出token数
  private readonly _MAX_HISTORY = 20

  // === 显存调度 v2 ===
  // 视觉模型在内存中的引用（loaded=false, inMemory=true）
  private visionModelInMemory: ModelInfo | null = null
  // v11.0 当前GPU状态：main=Qwen3.5-9B 常驻；vision=方案Y 兜底；null=空闲
  private gpuModelType: GpuModelType = null
  // v11.0 单模型常驻：Qwen3.5-9B 为主力模型
  private defaultMainModelId: string = 'qwen3.5-9b'   // Qwen3.5-9B Q4_K_M（~5.29GB）
  private visionModelId: string = 'qwen3.5-9b'         // 与底座同体
  // v12.1 双模型机制：轻量模型（如2B）常驻内存待命，独立 CPU 引擎，不参与主槽位换载
  private standbyModelId: string | null = null
  private standbyEngine: CpuInferenceEngine = new CpuInferenceEngine()

  constructor() {}

  /* ==========================================================
   * 初始化
   * ========================================================== */
  initialize(): void {
    try {
      if (this.modelPath) return
      this.modelPath = join(app.getPath('userData'), 'models')
      if (!existsSync(this.modelPath)) {
        mkdirSync(this.modelPath, { recursive: true })
      }
      try { this.scanResourceModels() } catch (e) { logger.error(`[ModelManager] 扫描资源模型失败: ${e}`) }
      this.startCleanup()
    } catch (error) {
      logger.error(`ModelManager initialize error: ${error}`)
    }
  }

  /* ==========================================================
   * 内部辅助
   * ========================================================== */
  // @ts-expect-error TS6133 - getModelPath reserved for future use
  private getModelPath(): string {
    try {
      if (!this.modelPath) {
        this.initialize()
      }
      return this.modelPath!
    } catch (error) {
      logger.error(`getModelPath error: ${error}`)
      return join(app.getPath('userData'), 'models')
    }
  }

  private startCleanup(): void {
    try {
      this.cleanupInterval = setInterval(() => {
        this.cleanupUnusedModels()
      }, 60000)
    } catch (error) {
      logger.error(`startCleanup error: ${error}`)
    }
  }

  // 使用 lastUsed 替代 loadedAt 判断空闲
  private cleanupUnusedModels(): void {
    try {
      if (!this.currentModel) return
      // 推理进行中，跳过卸载
      if (this.isGenerating) return

      const now = Date.now()
      const model = this.models.get(this.currentModel.modelId)
      // 用 model.lastUsed（上次使用），fallback 到 loadedAt
      const lastActivity = model?.lastUsed || this.currentModel.loadedAt
      const idleTime = now - lastActivity

      if (idleTime > this.IDLE_TIMEOUT_MS) {
        // v11.0 单模型常驻，无质量态释放逻辑；VL 常驻保持，跳过卸载
        logger.debug(`[ModelManager] 空闲 ${this.IDLE_TIMEOUT_MS / 60000} 分钟，单模型常驻保持，跳过卸载`)
      }
    } catch (error) {
      logger.error(`cleanupUnusedModels error: ${error}`)
    }
  }

  private resetIdleTimer(): void {
    try {
      if (this.idleTimeout) {
        clearTimeout(this.idleTimeout)
      }
      this.idleTimeout = setTimeout(() => {
        // 推理进行中不卸载，等下次cleanup再处理
        if (this.isGenerating) return
        this.cleanupUnusedModels()
      }, this.IDLE_TIMEOUT_MS)
    } catch (error) {
      logger.error(`resetIdleTimer error: ${error}`)
    }
  }

  /* ---- CPU 推理回退 ---- */
  // 设置 memoryUsage 和 gpuUsage
  private async tryCpuLoad(model: ModelInfo): Promise<boolean> {
    try {
      if (!this.hw) this.hw = await getHardware()
      const rt = resolveModelRuntime(model, this.hw)
      if (!rt.available) {
        logger.warn(`[ModelManager] 模型 ${model.name} 当前不可用，已跳过加载：${rt.reason}`)
        return false
      }
      // A-2 修复：GPU 方案（rt.gpuLayers>0）失败后自动降级纯 CPU（1024 ctx），不再一次性失败
      const attempts: Array<{ gpuLayers: number; contextSize: number; label: string }> = [
        { gpuLayers: rt.gpuLayers, contextSize: rt.contextSize || this.DEFAULT_CONTEXT_SIZE, label: `gpuLayers=${rt.gpuLayers}` },
      ]
      if (rt.gpuLayers > 0) {
        attempts.push({ gpuLayers: 0, contextSize: 1024, label: '纯 CPU' })
      }
      for (const attempt of attempts) {
        logger.debug(`[ModelManager] 尝试加载: ${model.name}（${attempt.label}, contextSize=${attempt.contextSize}）`)
        const loadOpts: Record<string, any> = {
          modelPath: model.path,
          contextSize: attempt.contextSize,
          gpuLayers: attempt.gpuLayers,
        }
        if (model.mmprojPath) {
          loadOpts.mmprojPath = model.mmprojPath
        }
        const cpuLoaded = await cpuInferenceEngine.loadModel(loadOpts as CpuInferenceConfig)
        if (cpuLoaded) {
          this.currentModel = {
            modelId: model.id,
            modelName: model.name,
            modelPath: model.path,
            modelType: model.type,
            loadedAt: Date.now()
          }
          model.loaded = true
          model.lastUsed = Date.now()
          model.memoryUsage = model.size
          model.gpuUsage = 0
          this.resetIdleTimer()
          logger.debug(`[ModelManager] 加载成功: ${model.name}（${attempt.label}）`)
          return true
        }
        logger.warn(`[ModelManager] ${attempt.label} 方案加载失败，尝试下一方案`)
      }
    } catch (cpuErr) {
      logger.error(`[ModelManager] CPU 推理加载失败: ${cpuErr}`)
    }
    return false
  }

  /* ==========================================================
   * 模型注册
   * ========================================================== */
  registerModel(info: Omit<ModelInfo, 'loaded' | 'lastUsed' | 'memoryUsage' | 'gpuUsage'>): void {
    try {
      this.models.set(info.id, {
        ...info,
        loaded: false,
        lastUsed: 0,
        memoryUsage: 0,
        gpuUsage: 0,
      })
    } catch (error) {
      logger.error(`registerModel error: ${error}`)
    }
  }

  /* ==========================================================
   * 加载模型
   * ========================================================== */

  /**
   * 体验增强：向渲染层广播模型加载状态（用于「正在加载模型…」提示）。
   * 不参与业务逻辑，任何失败静默忽略。
   */
  private broadcastModelStatus(status: 'loading' | 'ready' | 'error', modelName?: string, detail?: string | null): void {
    try {
      const mw = BrowserWindow.getAllWindows()[0]
      if (mw && !mw.isDestroyed()) {
        mw.webContents.send('model:load-status', {
          status,
          modelName: modelName || null,
          detail: detail || null,
          ts: Date.now(),
        })
      }
    } catch { /* 非关键广播，失败忽略 */ }
  }

  /**
   * 加载模型（对外入口）— 包装真实实现，广播加载进度供 UI 提示
   */
  async loadModel(modelId: string): Promise<boolean> {
    const model = this.models.get(modelId)
    this.broadcastModelStatus('loading', model?.name || modelId)
    try {
      const ok = await this.loadModelInternal(modelId)
      this.broadcastModelStatus(ok ? 'ready' : 'error', model?.name || modelId)
      return ok
    } catch (e) {
      this.broadcastModelStatus('error', model?.name || modelId, e instanceof Error ? e.message : String(e))
      throw e
    }
  }

  /** 原 loadModel 实现（保留串行锁与内部逻辑不变） */
  private async loadModelInternal(modelId: string): Promise<boolean> {
    // 串行化加载，防止并发冲突 (D3-1)
    const prevLock = this.loadingLock
    let resolveLock: () => void
    this.loadingLock = new Promise<void>(r => { resolveLock = r })
    await prevLock
    try {
      const model = this.models.get(modelId)
      if (!model) {
        logger.error(`模型 ${modelId} 未注册`)
        return false
      }

      if (!existsSync(model.path)) {
        logger.error(`模型文件不存在: ${model.path}`)
        return false
      }

      if (this.currentModel && this.currentModel.modelId === modelId) {
        this.currentModel.loadedAt = Date.now()
        model.lastUsed = Date.now()
        this.resetIdleTimer()
        return true
      }

      // 确保显存可用 (D3-4)
      const estimatedModelMB = model.size > 0 ? Math.ceil(model.size / (1024 * 1024)) : 2000
      await this.ensureMemoryAvailable(estimatedModelMB)

      if (this.currentModel) {
        logger.debug(`卸载当前模型: ${this.currentModel.modelName}`)
        await this.unloadModel()
        await new Promise(resolve => setTimeout(resolve, 2000))
      }

      // GPU 优先
      const gpuStatus = await isGpuAvailable()
      if (gpuStatus.available) {
        logger.debug(`[ModelManager] GPU 可用 (${gpuStatus.vramMB}MB)，优先尝试 SGLang: ${model.name}`)

        // WSL2 探测（幂等）：决定 SGLang 经 WSL 内 Linux Python 启动还是回退 CPU
        await pythonRuntime.ensureWSLDetected()

        if (pythonRuntime.isWSLMode()) {
          // v11.0 WSL: SGLang 兼容性门控（6GB 显存约束）
          // >5GB 的模型在 RTX3060 6GB 上可能 OOM，超过阈值直走 node-llama-cpp CPU
          const MAX_SGLANG_MODEL_SIZE_MB = 5 * 1024 // 5GB 安全阈值
          const isTooLarge = model.size > MAX_SGLANG_MODEL_SIZE_MB * 1024 * 1024

          if (isTooLarge) {
            const reason = `模型过大(${(model.size / 1024 / 1024 / 1024).toFixed(1)}GB > ${MAX_SGLANG_MODEL_SIZE_MB / 1024}GB)`
            logger.debug(`[ModelManager] WSL 模式但模型不适合 SGLang GPU（${reason}），直走 CPU: ${model.name}`)
            const prevGpuType = this.gpuModelType
            try {
              const ok = await this.tryCpuLoad(model)
              this.gpuModelType = this.deriveGpuModelType(model)
              return ok
            } catch (err) {
              this.gpuModelType = prevGpuType
              throw err
            }
          }

          logger.debug(`[ModelManager] WSL 模式：SGLang 将经 WSL 内 Linux Python 启动: ${model.name}`)
          const sglangStarted = await startSGLangServer(model.path, model.mmprojPath)
          if (sglangStarted) {
            this.currentModel = {
              modelId: model.id, modelName: model.name, modelPath: model.path,
              modelType: model.type, loadedAt: Date.now(),
            }
            model.loaded = true
            model.lastUsed = Date.now()
            this.resetIdleTimer()
            this.gpuModelType = this.deriveGpuModelType(model)
            logger.debug(`[ModelManager] SGLang(WSL) GPU 加载成功: ${model.name}`)
            return true
          }
          logger.debug('[ModelManager] SGLang(WSL) 启动失败，回退 CPU')
        } else {
          // v10.2：无 WSL2 时静默回退 CPU，不再弹窗打扰（SGLang 为可选 GPU 加速，非必需）
          logger.debug('[ModelManager] 未启用 WSL2，SGLang GPU 推理不可用，静默回退 CPU 模式（应用仍可正常运行）')
        }

        // 统一回退：记录 GPU 模型类型并回退 CPU 推理
        const prevGpuType = this.gpuModelType
        try {
          const ok = await this.tryCpuLoad(model)
          this.gpuModelType = this.deriveGpuModelType(model)
          return ok
        } catch (err) {
          this.gpuModelType = prevGpuType
          throw err
        }
      }

      // 记录 GPU 模型类型（v10.2：由 tier 推导）
      const prevGpuType = this.gpuModelType
      try {
        const ok = await this.tryCpuLoad(model)
        this.gpuModelType = this.deriveGpuModelType(model)
        return ok
      } catch (err) {
        this.gpuModelType = prevGpuType
        throw err
      }
    } catch (error) {
      logger.error(`loadModel error: ${error}`)
      return false
    } finally {
      resolveLock!()
    }
  }

  /* ==========================================================
   * 卸载模型
   * ========================================================== */
  async unloadModel(modelId?: string): Promise<boolean> {
    try {
      if (modelId && this.currentModel && this.currentModel.modelId !== modelId) {
        return true
      }

      if (!this.currentModel) {
        return true
      }

      logger.debug(`卸载模型: ${this.currentModel.modelName}`)

      try {
        await stopSGLang()
      } catch (sglangError) {
        logger.error(`停止 SGLang 时出错: ${sglangError}`)
      }

      // 释放 CPU 引擎模型（GPU 由 SGLang 管理，CPU 由 node-llama-cpp 管理）
      try {
        await cpuInferenceEngine.unload()
      } catch (cpuError) {
        logger.error(`释放 CPU 引擎时出错: ${cpuError}`)
      }

      const modelIdToUnload = this.currentModel.modelId
      const model = this.models.get(modelIdToUnload)
      if (model) {
        model.loaded = false
        model.memoryUsage = 0
        model.gpuUsage = 0
      }

      this.currentModel = null
      this.gpuModelType = null

      if (this.idleTimeout) {
        clearTimeout(this.idleTimeout)
        this.idleTimeout = null
      }

      logger.debug('模型已卸载，显存已释放')
      return true
    } catch (error) {
      logger.error(`unloadModel error: ${error}`)
      return false
    }
  }

  getLoadedModel(): CurrentModel | null {
    try {
      return this.currentModel
    } catch (error) {
      logger.error(`getLoadedModel error: ${error}`)
      return null
    }
  }

  isModelLoaded(modelId: string): boolean {
    try {
      if (!this.currentModel) return false
      return this.currentModel.modelId === modelId
    } catch (error) {
      logger.error(`isModelLoaded error: ${error}`)
      return false
    }
  }

  async switchModel(fromModelId: string, toModelId: string): Promise<boolean> {
    try {
      logger.debug(`切换模型: ${fromModelId} -> ${toModelId}`)

      if (this.currentModel && this.currentModel.modelId === fromModelId) {
        await this.unloadModel(fromModelId)
        await new Promise(resolve => setTimeout(resolve, 3000))
      }

      return await this.loadModel(toModelId)
    } catch (error) {
      logger.error(`switchModel error: ${error}`)
      return false
    }
  }

  /* ==========================================================
   * 获取内存使用情况
   * ========================================================== */
  async getMemoryUsage(): Promise<GPUStats> {
    try {
      return await this.getGPUStats()
    } catch (error) {
      logger.error(`getMemoryUsage error: ${error}`)
      return { usage: 0, memoryUsed: 0, memoryTotal: 0 }
    }
  }

  /* ==========================================================
   * 获取 GPU 统计信息
   * ========================================================== */
  private async getGPUStats(): Promise<GPUStats> {
    try {
      const { stdout } = await execAsync(
        'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits',
      )
      const parts = stdout.trim().split(',')

      if (parts.length >= 3) {
        return {
          usage: parseInt(parts[0].trim(), 10) || 0,
          memoryUsed: parseInt(parts[1].trim(), 10) || 0,
          memoryTotal: parseInt(parts[2].trim(), 10) || 0,
        }
      }
    } catch (e) {
      logger.error(`[ModelManager] nvidia-smi GPU 状态查询失败: ${e}`)
      // nvidia-smi 不可用
    }

    // 无GPU返回0，不返回假数据6144
    return { usage: 0, memoryUsed: 0, memoryTotal: 0 }
  }

  /* ==========================================================
   * 确保显存可用
   * ========================================================== */
  private async ensureMemoryAvailable(requiredSize: number): Promise<void> {
    try {
      const gpuStats = await this.getGPUStats()

      if (gpuStats.memoryTotal === 0) {
        return
      }

      const freeMemory = gpuStats.memoryTotal - gpuStats.memoryUsed

      if (freeMemory >= requiredSize) {
        return
      }

      logger.debug(`显存不足: 需要 ${requiredSize}MB, 可用 ${freeMemory}MB, 卸载当前模型`)

      if (this.currentModel) {
        await this.unloadModel()
      }
    } catch (error) {
      logger.error(`ensureMemoryAvailable error: ${error}`)
    }
  }

  /* ==========================================================
   * 获取内存统计
   * ========================================================== */
  async getMemoryStats(): Promise<MemoryStats> {
    try {
      const totalMem = await this.getTotalMemory()
      const usedMem = await this.getUsedMemory()
      const modelMem = this.getModelMemoryUsage()

      return {
        total: totalMem,
        used: usedMem,
        free: totalMem - usedMem,
        modelMemory: modelMem,
        systemMemory: usedMem - modelMem,
      }
    } catch (error) {
      logger.error(`getMemoryStats error: ${error}`)
      return { total: 8192, used: 4096, free: 4096, modelMemory: 0, systemMemory: 4096 }
    }
  }

  private async getTotalMemory(): Promise<number> {
    try {
      const { stdout } = await execAsync(
        `"${POWERSHELL_EXE}" -Command "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory"`,
      )
      const value = parseInt(stdout.trim(), 10)
      return value ? value / 1024 / 1024 : 8192
    } catch (e) {
      logger.error(`[ModelManager] 获取系统总内存失败: ${e}`)
      return 8192
    }
  }

  // 双重除法修复
  // FreePhysicalMemory 返回 KB, 已转 MB
  // 原: total - free / 1024 (又除一次) → 改为: total - free
  private async getUsedMemory(): Promise<number> {
    try {
      const { stdout } = await execAsync(
        `"${POWERSHELL_EXE}" -Command "(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory"`,
      )
      const free = parseInt(stdout.trim(), 10) / 1024
      const total = await this.getTotalMemory()
      return free ? total - free : total * 0.5
    } catch (e) {
      logger.error(`[ModelManager] 获取系统已用内存失败: ${e}`)
      return 4096
    }
  }

  private getModelMemoryUsage(): number {
    try {
      let total = 0
      this.models.forEach((model) => {
        if (model.loaded) {
          total += model.size
        }
      })
      return total
    } catch (error) {
      logger.error(`getModelMemoryUsage error: ${error}`)
      return 0
    }
  }

  /* ==========================================================
   * 性能统计
   * ========================================================== */
  async getPerformanceStats(): Promise<PerformanceStats> {
    try {
      const memoryStats = await this.getMemoryStats()
      return {
        cpu: await this.getCPUUsage(),
        memory: memoryStats,
        gpu: await this.getGPUStats(),
        modelLatency: this.getAverageLatency(),
        throughput: this.getThroughput(),
      }
    } catch (error) {
      logger.error(`getPerformanceStats error: ${error}`)
      return {
        cpu: 0,
        memory: { total: 8192, used: 4096, free: 4096, modelMemory: 0, systemMemory: 4096 },
        gpu: { usage: 0, memoryUsed: 0, memoryTotal: 0 },
        modelLatency: 0,
        throughput: 0,
      }
    }
  }

  private async getCPUUsage(): Promise<number> {
    try {
      const { stdout } = await execAsync(
        `"${POWERSHELL_EXE}" -Command "[math]::Round((Get-Counter '\\\\Processor(_Total)\\\\% Processor Time').CounterSamples.CookedValue)"`,
      )
      const value = parseInt(stdout.trim(), 10)
      return value || 0
    } catch (e) {
      logger.error(`[ModelManager] 获取 CPU 使用率失败: ${e}`)
      return 0
    }
  }

  private getAverageLatency(): number {
    if (this._latencyHistory.length === 0) return 0
    const sum = this._latencyHistory.reduce((a, b) => a + b, 0)
    return Math.round(sum / this._latencyHistory.length)
  }

  private getThroughput(): number {
    // 吞吐量 = 最近N次推理平均每秒处理token数（基于输出长度估算）
    if (this._latencyHistory.length === 0) return 0
    const avgLatencyMs = this._latencyHistory.reduce((a, b) => a + b, 0) / this._latencyHistory.length
    // 假设平均输出 200 tokens，计算 tokens/s
    const avgTokensPerCall = 200
    return Math.round(avgTokensPerCall / (avgLatencyMs / 1000))
  }

  /* ==========================================================
   * 查询方法
   * ========================================================== */
  getModel(modelId: string): ModelInfo | undefined {
    try {
      return this.models.get(modelId)
    } catch (error) {
      logger.error(`getModel error: ${error}`)
      return undefined
    }
  }

  getLoadedModels(): ModelInfo[] {
    try {
      return Array.from(this.models.values()).filter((m) => m.loaded)
    } catch (error) {
      logger.error(`getLoadedModels error: ${error}`)
      return []
    }
  }

  getAllModels(): ModelInfo[] {
    try {
      return Array.from(this.models.values())
    } catch (error) {
      logger.error(`getAllModels error: ${error}`)
      return []
    }
  }

  updateModelUsage(modelId: string): void {
    try {
      const model = this.models.get(modelId)
      if (model) {
        model.lastUsed = Date.now()
      }
      if (this.currentModel && this.currentModel.modelId === modelId) {
        this.currentModel.loadedAt = Date.now()
        this.resetIdleTimer()
      }
    } catch (error) {
      logger.error(`updateModelUsage error: ${error}`)
    }
  }

  setModelMemoryUsage(modelId: string, usage: number): void {
    try {
      const model = this.models.get(modelId)
      if (model) {
        model.memoryUsage = usage
      }
    } catch (error) {
      logger.error(`setModelMemoryUsage error: ${error}`)
    }
  }

  setMaxMemoryUsage(percentage: number): void {
    try {
      this.maxMemoryUsage = Math.max(0.1, Math.min(0.95, percentage))
    } catch (error) {
      logger.error(`setMaxMemoryUsage error: ${error}`)
    }
  }

  getMaxMemoryUsage(): number {
    return this.maxMemoryUsage
  }

  /* ==========================================================
   * 删除模型
   * ========================================================== */
  async deleteModel(modelId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const model = this.models.get(modelId)
      if (!model) {
        return { success: false, error: `模型 ${modelId} 未注册` }
      }

      if (model.loaded || (this.currentModel && this.currentModel.modelId === modelId)) {
        logger.debug(`删除前卸载模型: ${model.name}`)
        await this.unloadModel(modelId)
        await new Promise(resolve => setTimeout(resolve, 2000))
      }

      // 顶部已静态 import fs，无需 require
      if (existsSync(model.path)) {
        try {
          const { unlinkSync } = await import('fs')
          unlinkSync(model.path)
          logger.debug(`已删除模型文件: ${model.path}`)
        } catch (fileError) {
          logger.error(`删除模型文件失败: ${fileError}`)
          return { success: false, error: `删除文件失败: ${fileError}` }
        }
      }

      const tempPath = model.path + '.part'
      if (existsSync(tempPath)) {
        try {
          const { unlinkSync } = await import('fs')
          unlinkSync(tempPath)
        } catch (e) { logger.error(`[ModelManager] 删除临时文件失败: ${e}`) }
      }

      this.models.delete(modelId)

      logger.debug(`模型 ${model.name} 已删除`)
      return { success: true }
    } catch (error) {
      logger.error(`deleteModel error: ${error}`)
      return { success: false, error: String(error) }
    }
  }

  /* ==========================================================
   * v12.1 待命模型（轻量模型常驻内存，随叫随用）
   * ========================================================== */

  /** 获取当前待命模型 ID */
  getStandbyModelId(): string | null {
    return this.standbyModelId
  }

  /** 加载待命模型到运行内存（独立 CPU 引擎，不占用主槽位） */
  async loadStandbyModel(modelId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const model = this.models.get(modelId)
      if (!model) {
        return { success: false, error: `模型 ${modelId} 未注册` }
      }

      // 先卸载旧待命模型，再加载新待命模型
      if (this.standbyModelId && this.standbyModelId !== modelId) {
        await this.unloadStandbyModel()
      }

      // 若已是当前待命模型且引擎已加载，直接返回
      if (this.standbyModelId === modelId && this.standbyEngine.isLoaded()) {
        return { success: true }
      }

      logger.info(`[ModelManager] 加载待命模型到内存: ${model.name}`)
      const ok = await this.standbyEngine.loadModel({
        modelPath: model.path,
        gpuLayers: 0,                // 待命模型固定纯 CPU，常驻 RAM
        contextSize: 2048,           // 轻量待命，小上下文省内存
        threads: 4,
      })
      if (!ok) {
        return { success: false, error: '待命模型加载失败' }
      }

      this.standbyModelId = modelId
      logger.info(`[ModelManager] 待命模型已就绪: ${model.name}（内存待命）`)
      return { success: true }
    } catch (error) {
      logger.error(`loadStandbyModel error: ${error}`)
      return { success: false, error: String(error) }
    }
  }

  /** 卸载待命模型（释放内存） */
  async unloadStandbyModel(): Promise<{ success: boolean; error?: string }> {
    try {
      if (this.standbyEngine.isLoaded()) {
        await this.standbyEngine.unload()
      }
      if (this.standbyModelId) {
        logger.info(`[ModelManager] 待命模型已卸载: ${this.standbyModelId}`)
      }
      this.standbyModelId = null
      return { success: true }
    } catch (error) {
      logger.error(`unloadStandbyModel error: ${error}`)
      return { success: false, error: String(error) }
    }
  }

  /** 待命模型状态查询 */
  getStandbyStatus(): { id: string | null; loaded: boolean; name?: string } {
    const loaded = this.standbyEngine.isLoaded()
    const model = this.standbyModelId ? this.models.get(this.standbyModelId) : undefined
    return {
      id: this.standbyModelId,
      loaded,
      name: model?.name,
    }
  }

  /** 待命模型生成（随叫随用：轻量模型在 RAM 中直接推理） */
  async generateWithStandby(prompt: string, opts?: { temperature?: number; maxTokens?: number }): Promise<string> {
    if (!this.standbyEngine.isLoaded() || !this.standbyModelId) {
      throw new Error('待命模型未加载')
    }
    return this.standbyEngine.generate(prompt, {
      temperature: opts?.temperature ?? 0.3,
      maxTokens: opts?.maxTokens ?? 256,
    })
  }

  /* ==========================================================
   * 关闭
   * ========================================================== */
  // unloadModel 加 await
  async shutdown(): Promise<void> {
    try {
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval)
        this.cleanupInterval = null
      }
      if (this.idleTimeout) {
        clearTimeout(this.idleTimeout)
        this.idleTimeout = null
      }
      if (this.currentModel) {
        await this.unloadModel()
      }
      // v12.1 关闭时一并卸载待命模型
      if (this.standbyEngine.isLoaded()) {
        await this.unloadStandbyModel()
      }
    } catch (error) {
      logger.error(`shutdown error: ${error}`)
    }
  }

  /* ==========================================================
   * 辩论引擎专用：generateResponse / VRAM调度
   * 判断当前模式 — SGLang→HTTP, CPU→直接调用
   * ========================================================== */
  async generateResponse(prompt: string, opts?: { temperature?: number; maxTokens?: number; topP?: number; topK?: number; repeatPenalty?: number }): Promise<string> {
    this.isGenerating = true
    const startTime = performance.now()

    // 从 modelConfig 读取默认参数，优先级：opts 传入值 > modelConfig > 硬编码默认值
    let modelConfig: any = {}
    try {
      modelConfig = getStore().get('modelConfig') || {}
    } catch { /* ignore */ }

    const mergedOpts = {
      maxTokens: opts?.maxTokens ?? modelConfig.maxTokens ?? 1024,
      temperature: opts?.temperature ?? modelConfig.temperature ?? 0.7,
      topP: opts?.topP ?? modelConfig.topP ?? 0.9,
      topK: opts?.topK ?? modelConfig.topK ?? 40,
      repeatPenalty: opts?.repeatPenalty ?? modelConfig.repeatPenalty ?? 1.1,
    }

    try {
      // === v10.2.0: 优先尝试 llama.cpp Server HTTP API ===
      const serverRunning = await this.isServerRunning()
      if (serverRunning) {
        const serverResult = await this.generateViaServer(prompt, mergedOpts)
        if (serverResult !== null) {
          logger.debug(`[ModelManager] Server 模式推理成功 (${serverResult.length} 字符)`)
          return serverResult
        }
        logger.debug('[ModelManager] Server 推理失败，回退直调模式')
      }

      const loaded = this.getLoadedModel()
      if (!loaded) throw new Error('No model loaded')

      // 更新最后使用时间
      const model = this.models.get(loaded.modelId)
      if (model) model.lastUsed = Date.now()

      // CPU 模式直接调 cpuInferenceEngine
      // 判断是否是 SGLang 模式（尝试检测端口）
      let isSGLangMode = false
      try {
        const resp = await fetch('http://127.0.0.1:30000/health', {
          signal: AbortSignal.timeout(2000),
        })
        isSGLangMode = resp.status < 500
      } catch (e) {
        logger.error(`[ModelManager] SGLang 健康检查失败: ${e}`)
        isSGLangMode = false
      }

      if (!isSGLangMode) {
        // CPU 模式：直接调用 cpuInferenceEngine
        logger.debug('[ModelManager] CPU 模式 generateResponse')
        return await cpuInferenceEngine.generate(prompt, {
          maxTokens: mergedOpts.maxTokens,
          temperature: mergedOpts.temperature,
          topP: mergedOpts.topP,
          topK: mergedOpts.topK,
          repeatPenalty: mergedOpts.repeatPenalty,
        })
      }

      // SGLang 模式：HTTP 调用
      const result = await new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Timeout')), 60000)
        try {
          const data = JSON.stringify({
            prompt,
            temperature: mergedOpts.temperature,
            max_tokens: mergedOpts.maxTokens,
            top_p: mergedOpts.topP,
            top_k: mergedOpts.topK,
            repeat_penalty: mergedOpts.repeatPenalty,
            stream: false
          })
          const req = http.request({
            hostname: '127.0.0.1', port: 30000, path: '/v1/completions',
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
            timeout: 50000
          }, (res: any) => {
            let body = ''
            res.on('data', (chunk: Buffer) => { body += chunk.toString() })
            res.on('end', () => {
              clearTimeout(t)
              try {
                const j = JSON.parse(body)
                resolve(j.choices?.[0]?.text || j.text || body.slice(0, 2000))
              } catch (e) { logger.error(`[ModelManager] SGLang 响应 JSON 解析失败: ${e}`); resolve(body.slice(0, 2000)) }
            })
          })
          req.on('error', (e: Error) => { clearTimeout(t); reject(e) })
          req.write(data)
          req.end()
        } catch (e) { clearTimeout(t); reject(e) }
      })
      return result
    } catch (e) {
      logger.error(`[ModelManager] generateResponse 推理失败: ${e}`)
      return `[推理失败：模型未就绪，请先在模型页面加载模型]`
    } finally {
      // 记录推理性能指标
      const elapsed = performance.now() - startTime
      this._latencyHistory.push(elapsed)
      if (this._latencyHistory.length > this._MAX_HISTORY) this._latencyHistory.shift()
      this.isGenerating = false
      this.resetIdleTimer()
    }
  }

  async preloadToRAM(modelId: string): Promise<boolean> {
    const model = this.models.get(modelId)
    if (!model || !existsSync(model.path)) return false
    if (this.currentModel && this.currentModel.modelId === modelId) return true
    try {
      const { openSync, readSync, closeSync } = await import('fs')
      const fd = openSync(model.path, 'r')
      const buf = Buffer.alloc(1024 * 1024)
      let total = 0; const limit = Math.min(1073741824, model.size * 1024 * 1024)
      while (total < limit) { const r = readSync(fd, buf, 0, buf.length, total); if (r <= 0) break; total += r }
      closeSync(fd)
      return true
    } catch (e) { logger.error(`[ModelManager] 预加载模型到 RAM 失败: ${e}`); return false }
  }

  /**
   * 加载模型到运行内存（不占显存），视觉模型专用
   * GGUF 文件打开并映射到内存页，SGLang 从 RAM 直接加载到显存
   */
  async loadModelToMemory(modelId: string): Promise<boolean> {
    try {
      const model = this.models.get(modelId)
      if (!model || !existsSync(model.path)) return false
      
      // 已在内存中
      if (this.visionModelInMemory?.id === modelId) return true
      
      // 如果之前有别的模型在内存，释放
      if (this.visionModelInMemory) {
        this.visionModelInMemory = null
      }
      
      // 缓存文件路径，SGLang 加载时直接从磁盘而非重新扫描
      this.visionModelInMemory = { ...model, loaded: false }
      
      // 预热：强制触发文件系统缓存（Windows 大文件自动缓存）
      const { openSync, readSync, closeSync } = await import('fs')
      const fd = openSync(model.path, 'r')
      const buf = Buffer.alloc(1024 * 1024)
      let total = 0
      const limit = Math.min(104857600, model.size * 1024 * 1024) // max 100MB warmup
      while (total < limit) { const r = readSync(fd, buf, 0, buf.length, total); if (r <= 0) break; total += r }
      closeSync(fd)
      
      logger.debug(`[MemoryModel] ${model.name} 已加载到内存 (warmed ${(total/1048576).toFixed(1)}MB)`)
      return true
    } catch (error) {
      logger.error(`loadModelToMemory error: ${error}`)
      return false
    }
  }

  /**
   * 从主模型切换到视觉模型
   * 主模型→卸载显存（保留内存引用）→视觉模型→加载到显存
   * v12.2：主模型自带多模态视觉能力时，直接用主模型，不切换
   */
  async swapToVision(): Promise<boolean> {
    try {
      // v12.2 主模型多模态 → 无需辅助视觉模型
      if (this.isMainMultimodal()) {
        logger.debug('[Swap] 主模型为多模态，直接使用主模型处理视觉任务')
        this.gpuModelType = 'main'
        return true
      }

      if (this.gpuModelType === 'vision' && this.currentModel?.modelId === this.visionModelId) {
        logger.debug('[Swap] 视觉模型已在显存')
        return true
      }
      
      // 确保视觉模型在内存中
      const visionModel = this.visionModelInMemory ||
        Array.from(this.models.values()).find(m => m.id === this.visionModelId) || this.models.get(this.visionModelId)
      if (!visionModel) {
        logger.error('[Swap] 视觉模型未注册')
        return false
      }
      
      // 卸载主模型（释放显存）
      if (this.currentModel) {
        logger.debug(`[Swap] 卸载主模型: ${this.currentModel.modelName}`)
        await this.unloadModel()
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
      
      // 用高 mem-fraction 加载视觉模型
      logger.debug(`[Swap] 加载视觉模型到显存: ${visionModel.name}`)
      const success = await this.loadModel(visionModel.id)
      if (success) {
        this.gpuModelType = 'vision'
      }
      return success
    } catch (error) {
      logger.error(`[Swap] swapToVision error: ${error}`)
      return false
    }
  }
  
  /**
   * 从视觉模型切回主模型（v12.2 完善：真正执行切换）。
   * 视觉任务完成后调用，保证"用完切回"；主模型多模态时无操作。
   */
  async swapToMain(): Promise<boolean> {
    try {
      // v12.2 主模型多模态 → 本就未切换，无操作
      if (this.isMainMultimodal()) {
        return true
      }
      if (this.gpuModelType !== 'vision') {
        return true // 已在主模型态
      }
      const mainModel = this.models.get(this.defaultMainModelId)
      if (!mainModel) {
        logger.error('[Swap] 主模型未注册，无法切回')
        return false
      }
      logger.debug(`[Swap] 卸载视觉模型，切回主模型: ${mainModel.name}`)
      await this.unloadModel()
      await new Promise(resolve => setTimeout(resolve, 1000))
      const success = await this.loadModel(mainModel.id)
      if (success) {
        this.gpuModelType = 'main'
      }
      return success
    } catch (error) {
      logger.error(`[Swap] swapToMain error: ${error}`)
      return false
    }
  }

  /**
   * v12.2 主模型是否自带多模态视觉能力。
   * 接入主模型时识别：是 → 无需再接辅助视觉模型；否 → 建议接入但不强制。
   */
  isMainMultimodal(): boolean {
    try {
      const mainId = this.currentModel?.modelId || this.defaultMainModelId
      const model = this.models.get(mainId)
      return !!model?.isMultimodal
    } catch {
      return false
    }
  }

  /**
   * v12.2 解析当前应使用的视觉推理模型 id。
   * 主模型多模态 → 返回主模型 id；否则返回已注册的视觉模型 id（无则 null）。
   */
  resolveVisionModelId(): string | null {
    if (this.isMainMultimodal()) {
      return this.currentModel?.modelId || this.defaultMainModelId
    }
    return this.models.has(this.visionModelId) ? this.visionModelId : null
  }

  /* ---- v11.0 单模型常驻：参数化默认模型 id ---- */

  /**
   * 设置默认主模型 id 与视觉模型 id
   */
  setDefaultModelIds(mainId: string, visionId: string): void {
    if (mainId) this.defaultMainModelId = mainId
    if (visionId) this.visionModelId = visionId
    logger.debug(`[ModelManager] 默认模型 id 已更新: main=${this.defaultMainModelId}, vision=${this.visionModelId}`)
  }

  /** 暴露默认主模型 id（供 task-router 在 null 态加载） */
  getDefaultMainModelId(): string {
    return this.defaultMainModelId
  }

  /** 暴露当前 GPU 状态（供 chat.ipc / task-router / 渲染端读取） */
  getGpuModelType(): GpuModelType {
    return this.gpuModelType
  }

  /** 由模型 tier 推导 GPU 状态（vision→vision；其余→main） */
  private deriveGpuModelType(model: ModelInfo): GpuModelType {
    if (model.tier === 'vision') return 'vision'
    return 'main'
  }

  /* ---- llama.cpp Server 模式 v10.2.0 ---- */

  /**
   * 当前可用 server 基础 URL（基于探测到的活动端口）
   */
  private getServerBaseUrl(): string | null {
    return this.activeServerPort ? `http://${this.SERVER_HOST}:${this.activeServerPort}` : null
  }

  /**
   * 检测 llama.cpp server 是否运行（依次探测 8082 / 8080）
   */
  async isServerRunning(): Promise<boolean> {
    // 已有活动端口先快速复检
    if (this.activeServerPort) {
      try {
        const resp = await fetch(`${this.getServerBaseUrl()}/health`, {
          signal: AbortSignal.timeout(2000),
        })
        if (resp.status < 500) return true
      } catch { /* fallthrough */ }
      this.activeServerPort = null
    }
    for (const port of this.SERVER_PORTS) {
      try {
        const resp = await fetch(`http://${this.SERVER_HOST}:${port}/health`, {
          signal: AbortSignal.timeout(2000),
        })
        if (resp.status < 500) {
          this.activeServerPort = port
          return true
        }
      } catch { /* 继续探测下一个端口 */ }
    }
    return false
  }

  /**
   * 获取 server 健康信息
   */
  async serverHealth(): Promise<{ running: boolean; models?: string[] }> {
    try {
      const baseUrl = this.getServerBaseUrl() || (await this.isServerRunning() ? this.getServerBaseUrl() : null)
      if (!baseUrl) return { running: false }
      const resp = await fetch(`${baseUrl}/v1/models`, {
        signal: AbortSignal.timeout(3000),
      })
      if (!resp.ok) return { running: false }
      const data = await resp.json() as any
      const models = data?.data?.map((m: any) => m.id) || []
      return { running: true, models }
    } catch {
      return { running: false }
    }
  }

  /**
   * 通过 llama.cpp server HTTP API 推理（首选路径）
   */
  private async generateViaServer(
    prompt: string,
    opts?: { temperature?: number; maxTokens?: number; topP?: number; topK?: number; repeatPenalty?: number }
  ): Promise<string | null> {
    try {
      const baseUrl = this.getServerBaseUrl() || (await this.isServerRunning() ? this.getServerBaseUrl() : null)
      if (!baseUrl) return null
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 120000)

      const resp = await fetch(`${baseUrl}/v1/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          temperature: opts?.temperature ?? 0.7,
          max_tokens: opts?.maxTokens ?? 1024,
          top_p: opts?.topP ?? 0.9,
          top_k: opts?.topK ?? 40,
          repeat_penalty: opts?.repeatPenalty ?? 1.1,
          stream: false,
        }),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!resp.ok) {
        logger.warn(`[ModelManager] Server 返回 ${resp.status}，回退直调模式`)
        return null
      }

      const data = await resp.json() as any
      const text = data?.choices?.[0]?.text || data?.content || ''
      return text
    } catch (error) {
      logger.warn(`[ModelManager] Server HTTP 调用失败，回退直调模式: ${error}`)
      return null
    }
  }

  /**
   * 通过 llama.cpp server HTTP API 进行 Chat Completion（用于带历史上下文的推理）
   */
  async generateChatViaServer(
    messages: Array<{ role: string; content: string }>,
    opts?: { temperature?: number; maxTokens?: number }
  ): Promise<string | null> {
    try {
      const baseUrl = this.getServerBaseUrl() || (await this.isServerRunning() ? this.getServerBaseUrl() : null)
      if (!baseUrl) return null
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 120000)

      const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages,
          temperature: opts?.temperature ?? 0.7,
          max_tokens: opts?.maxTokens ?? 1024,
          stream: false,
        }),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!resp.ok) return null

      const data = await resp.json() as any
      return data?.choices?.[0]?.message?.content || null
    } catch {
      return null
    }
  }

  /**
   * 环境自适应运行时信息汇总：返回当前硬件 + 各模型推导出的运行时参数。
   * 供渲染端 Model 页面展示「硬件条 / 模型可用性 / 禁用原因」。
   * 对不可用模型自动检测同家族更小变体，提供降级建议。
   */
  async getModelRuntimeInfo(): Promise<{ hardware: HardwareInfo | null; models: Array<{
    id: string; name: string; available: boolean; reason: string;
    gpuLayers: number; contextSize: number; targetDevice: 'gpu' | 'cpu'
    downgradeSuggestion?: { modelId: string; modelName: string; reason: string }
  }> }> {
    try {
      if (!this.hw) this.hw = await getHardware()
      const hardware = this.hw
      const allModels = Array.from(this.models.values())

      // 构建可用模型索引，供降级建议查询
      const availableModelIds = new Set<string>()
      for (const m of allModels) {
        const rt = resolveModelRuntime(m, hardware)
        if (rt.available) availableModelIds.add(m.id)
      }

      // 模型家族映射（按参数量从大到小排列）
      const FAMILY_PATTERNS: Array<{ family: string; patterns: RegExp[] }> = [
        { family: 'Qwen2-VL', patterns: [/qwen2-vl/i] },
        { family: 'Qwen3', patterns: [/qwen3[^.]*$/i] },
        { family: 'Qwen2', patterns: [/qwen2(?!-vl)/i] },
        { family: 'Qwen2.5', patterns: [/qwen2\.5/i] },
        { family: 'InternVL', patterns: [/internvl/i] },
        { family: 'Llama-3', patterns: [/llama-?3/i] },
        { family: 'Llama', patterns: [/llama/i] },
        { family: 'DeepSeek', patterns: [/deepseek/i] },
      ]

      const B_SIZE_ORDER = ['14b', '13b', '9b', '8b', '7b', '4b', '3b', '2b', '1.5b', '1b', '0.5b']

      const findDowngrade = (modelId: string): { modelId: string; modelName: string; reason: string } | undefined => {
        // 确定模型所属家族
        let family: string | null = null
        for (const f of FAMILY_PATTERNS) {
          if (f.patterns.some(p => p.test(modelId))) {
            family = f.family
            break
          }
        }
        if (!family) return undefined

        // 提取当前模型参数量
        const currentSize = B_SIZE_ORDER.find(s => modelId.toLowerCase().includes(s))
        if (!currentSize) return undefined
        const currentIdx = B_SIZE_ORDER.indexOf(currentSize)

        // 在同家族中找更小的可用变体
        for (let i = currentIdx + 1; i < B_SIZE_ORDER.length; i++) {
          const smallerSize = B_SIZE_ORDER[i]
          const candidates = allModels.filter(m => {
            const lower = m.id.toLowerCase()
            return lower.includes(smallerSize) &&
              FAMILY_PATTERNS.find(f => f.family === family)!.patterns.some(p => p.test(m.id))
          })
          for (const c of candidates) {
            if (availableModelIds.has(c.id)) {
              return {
                modelId: c.id,
                modelName: c.name,
                reason: `当前模型过大，建议使用同家族 ${c.name}`,
              }
            }
          }
        }
        return undefined
      }

      const models = allModels.map((m) => {
        const rt = resolveModelRuntime(m, hardware)
        const result: any = {
          id: m.id,
          name: m.name,
          available: rt.available,
          reason: rt.reason,
          gpuLayers: rt.gpuLayers,
          contextSize: rt.contextSize,
          targetDevice: rt.targetDevice,
        }
        if (!rt.available) {
          const suggestion = findDowngrade(m.id)
          if (suggestion) result.downgradeSuggestion = suggestion
        }
        return result
      })
      return { hardware, models }
    } catch (error) {
      logger.error(`getModelRuntimeInfo error: ${error}`)
      return { hardware: null, models: [] }
    }
  }

  async swapToVRAM(modelId: string): Promise<boolean> {
    const loaded = this.getLoadedModel()
    if (loaded && loaded.modelId === modelId) return true
    if (loaded) await this.unloadModel(loaded.modelId)
    return await this.loadModel(modelId)
  }

  async unloadFromVRAM(): Promise<boolean> {
    return await this.unloadModel()
  }

  /* ==========================================================
   * 扫描 resources/models 目录下的 GGUF 文件并自动注册
   * ========================================================== */
  private scanResourceModels(): void {
    try {
      const { readdirSync } = require('fs')
      const { is } = require('@electron-toolkit/utils')
      const modelsDir = is.dev
        ? require('path').join(__dirname, '../../resources/models')
        : require('path').join(process.resourcesPath, 'models')
      if (!require('fs').existsSync(modelsDir)) return

      const allFiles = readdirSync(modelsDir)
      const ggufFiles = allFiles.filter((f: string) => f.endsWith('.gguf'))

      // 收集所有 mmproj-*.gguf 投影文件
      const mmprojFiles: string[] = allFiles.filter((f: string) =>
        f.startsWith('mmproj-') && f.endsWith('.gguf')
      )

      // 为视觉模型配对 mmproj 辅助函数
      const findMmproj = (modelId: string): string | undefined => {
        if (mmprojFiles.length === 0) return undefined
        const lowerId = modelId.toLowerCase()
        // 第一轮：精确匹配型号（如 internvl3-2b <-> mmproj-InternVL3-2B；qwen2-vl-7b <-> mmproj-Qwen2.5-VL-7B）
        for (const mp of mmprojFiles) {
          const mpLower = mp.toLowerCase()
          // 从 modelId 提取型号标识（如 internvl3-2b → internvl3-2b）
          const modelIdCore = lowerId.replace(/[_\.]/g, '-').replace(/^mmproj-/, '')
          const mpCore = mpLower.replace(/^mmproj-/, '').replace(/[_\.]/g, '-').replace(/-f16$/i, '').replace(/-gguf$/i, '')
          if (mpCore.includes(modelIdCore) || modelIdCore.includes(mpCore)) {
            return require('path').join(modelsDir, mp)
          }
        }
        // 第二轮：系列级模糊配对
        for (const mp of mmprojFiles) {
          const mpLower = mp.toLowerCase()
          if (lowerId.includes('internvl') && mpLower.includes('internvl')) {
            return require('path').join(modelsDir, mp)
          }
          if (lowerId.includes('qwen') && lowerId.includes('vl') && mpLower.includes('qwen') && mpLower.includes('vl')) {
            return require('path').join(modelsDir, mp)
          }
        }
        // 通用兜底：第一个 mmproj
        return require('path').join(modelsDir, mmprojFiles[0])
      }

      for (const file of ggufFiles) {
        const id = file.replace(/\.gguf$/, '')
        if (this.models.has(id)) continue
        const name = id
          .replace(/-/g, ' ')
          .replace(/\b\w/g, (c: string) => c.toUpperCase())
        const type = (/[-_]vl\b|^vl\b|vision|internvl|qwen.*vl/i.test(id)) ? 'vision' as const
          : id.includes('embed') ? 'embedding' as const
          : 'main' as const

        const modelPath = require('path').join(modelsDir, file)
        const mmprojPath = type === 'vision' ? findMmproj(id) : undefined

        this.registerModel({ id, name, type, path: modelPath, size: 0, mmprojPath })
      }
    } catch (e) { logger.error(`scanResourceModels error: ${e}`) }
  }
}

/* ============================================================
 * 单例导出
 * ============================================================ */
export const modelManager = new ModelManager()

/* ============================================================
 * IPC 处理器注册
 * ============================================================ */
export function setupModelManagerHandlers(): void {
  try {
    ipcMain.handle('model:manager:register', (_event, info: Omit<ModelInfo, 'loaded' | 'lastUsed' | 'memoryUsage' | 'gpuUsage'>) => {
      try {
        modelManager.registerModel(info)
        return { success: true }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    })

    ipcMain.handle('model:manager:load', async (_event, modelId: string) => {
      try {
        const result = await modelManager.loadModel(modelId)
        return result
      } catch (error) {
        logger.error(`model:manager:load error: ${error}`)
        return false
      }
    })

    ipcMain.handle('model:manager:unload', async (_event, modelId: string) => {
      try {
        const result = await modelManager.unloadModel(modelId)
        return result
      } catch (error) {
        logger.error(`model:manager:unload error: ${error}`)
        return false
      }
    })

    ipcMain.handle('model:manager:list', () => {
      try {
        return modelManager.getAllModels()
      } catch (error) {
        logger.error(`model:manager:list error: ${error}`)
        return []
      }
    })

    ipcMain.handle('model:manager:loaded', () => {
      try {
        return modelManager.getLoadedModels()
      } catch (error) {
        logger.error(`model:manager:loaded error: ${error}`)
        return []
      }
    })

    ipcMain.handle('model:manager:current', () => {
      try {
        return modelManager.getLoadedModel()
      } catch (error) {
        logger.error(`model:manager:current error: ${error}`)
        return null
      }
    })

    // v12.1 待命模型：加载到内存 / 卸载 / 状态查询
    ipcMain.handle('model:standby:load', async (_event, modelId: string) => {
      try {
        return await modelManager.loadStandbyModel(modelId)
      } catch (error) {
        logger.error(`model:standby:load error: ${error}`)
        return { success: false, error: String(error) }
      }
    })

    ipcMain.handle('model:standby:unload', async () => {
      try {
        return await modelManager.unloadStandbyModel()
      } catch (error) {
        logger.error(`model:standby:unload error: ${error}`)
        return { success: false, error: String(error) }
      }
    })

    ipcMain.handle('model:standby:status', () => {
      try {
        return modelManager.getStandbyStatus()
      } catch (error) {
        logger.error(`model:standby:status error: ${error}`)
        return { id: null, loaded: false }
      }
    })

    ipcMain.handle('model:standby:generate', async (_event, prompt: string, opts?: { temperature?: number; maxTokens?: number }) => {
      try {
        return await modelManager.generateWithStandby(prompt, opts)
      } catch (error) {
        logger.error(`model:standby:generate error: ${error}`)
        return { error: String(error) }
      }
    })

    ipcMain.handle('model:manager:is-loaded', (_event, modelId: string) => {
      try {
        return modelManager.isModelLoaded(modelId)
      } catch (error) {
        logger.error(`model:manager:is-loaded error: ${error}`)
        return false
      }
    })

    ipcMain.handle('model:manager:switch', async (_event, fromModelId: string, toModelId: string) => {
      try {
        const result = await modelManager.switchModel(fromModelId, toModelId)
        return result
      } catch (error) {
        logger.error(`model:manager:switch error: ${error}`)
        return false
      }
    })

    ipcMain.handle('model:manager:stats', async () => {
      try {
        return await modelManager.getPerformanceStats()
      } catch (error) {
        logger.error(`model:manager:stats error: ${error}`)
        return null
      }
    })

    ipcMain.handle('model:manager:memory', async () => {
      try {
        return await modelManager.getMemoryStats()
      } catch (error) {
        logger.error(`model:manager:memory error: ${error}`)
        return null
      }
    })

    // model:set-default / model:set-startup / model:get-startup 已在 config.ipc.ts 注册，此处不再重复

    ipcMain.handle('model:manager:gpu', async () => {
      try {
        return await modelManager.getMemoryUsage()
      } catch (error) {
        logger.error(`model:manager:gpu error: ${error}`)
        return { usage: 0, memoryUsed: 0, memoryTotal: 0 }
      }
    })

    ipcMain.handle('model:manager:update-usage', (_event, modelId: string) => {
      try {
        modelManager.updateModelUsage(modelId)
        return { success: true }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    })

    ipcMain.handle('model:manager:set-max-memory', (_event, percentage: number) => {
      try {
        modelManager.setMaxMemoryUsage(percentage)
        return { success: true, maxUsage: modelManager.getMaxMemoryUsage() }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    })

    ipcMain.handle('model:manager:delete', async (_event, modelId: string) => {
      try {
        const result = await modelManager.deleteModel(modelId)
        return result
      } catch (error) {
        logger.error(`model:manager:delete error: ${error}`)
        return { success: false, error: String(error) }
      }
    })

    ipcMain.handle('model:manager:runtime', () => {
      try {
        return modelManager.getModelRuntimeInfo()
      } catch (error) {
        logger.error(`model:manager:runtime error: ${error}`)
        return { hardware: null, models: [] }
      }
    })

    // model:config — 读取模型配置
    ipcMain.handle('model:config', () => {
      try {
        const store = getStore()
        return store.get('modelConfig') || null
      } catch (error) {
        logger.error(`model:config error: ${error}`)
        return null
      }
    })

    // model:save-config — 保存模型配置
    ipcMain.handle('model:save-config', (_event, config: any) => {
      try {
        const store = getStore()
        store.set('modelConfig', config)
        return true
      } catch (error) {
        logger.error(`model:save-config error: ${error}`)
        return false
      }
    })

    // model:delete — 删除模型
    ipcMain.handle('model:delete', async (_event, modelId: string) => {
      try {
        const result = await modelManager.deleteModel(modelId)
        return result
      } catch (error) {
        logger.error(`model:delete error: ${error}`)
        return { success: false, error: String(error) }
      }
    })

    // model:activate — 激活模型
    ipcMain.handle('model:activate', async (_event, modelId: string) => {
      try {
        const result = await modelManager.loadModel(modelId)
        return { success: result }
      } catch (error) {
        logger.error(`model:activate error: ${error}`)
        return { success: false, error: String(error) }
      }
    })

    // model:active — 获取当前激活的模型ID
    ipcMain.handle('model:active', () => {
      try {
        const current = modelManager.getLoadedModel()
        return current?.modelId || null
      } catch (error) {
        logger.error(`model:active error: ${error}`)
        return null
      }
    })

    // === 本地模型文件扫描 + 智能分析 ===
    ipcMain.handle('model:scan-local', async (_event, dirPath: string) => {
      try {
        const { readdirSync, statSync } = require('fs')
        const { join } = require('path')

        if (!existsSync(dirPath)) {
          return { files: [], error: '目录不存在' }
        }

        // 扫描目录下所有支持的模型文件
        const modelFiles: string[] = []
        function scanDir(dir: string) {
          try {
            const entries = readdirSync(dir)
            for (const entry of entries) {
              const fullPath = join(dir, entry)
              try {
                const st = statSync(fullPath)
                if (st.isDirectory()) {
                  scanDir(fullPath)
                } else if (st.isFile()) {
                  const ext = require('path').extname(entry).toLowerCase()
                  if (SUPPORTED_EXTENSIONS.includes(ext)) {
                    modelFiles.push(fullPath)
                  }
                }
              } catch (_) { /* skip inaccessible */ }
            }
          } catch (_) { /* skip */ }
        }
        scanDir(dirPath)

        // 获取硬件信息用于设备适配
        let device: any = undefined
        try {
          const hw = await import('../runtime/hardware').then(m => m.getHardware())
          device = {
            gpuName: hw?.gpuName || '无 GPU',
            vramGB: (hw?.vramMB || 0) / 1024,
            ramGB: (await modelManager.getMemoryStats()).total / 1024,
            cpuCores: hw?.cpuCores || 4,
            hasGPU: (hw?.vramMB || 0) > 0,
          }
        } catch (_) { /* 无硬件信息，使用默认 */ }

        // 分析每个模型文件
        const analyses = modelFiles.map(p => {
          try {
            return analyzeModelFile(p, device)
          } catch (e) {
            return { fileName: require('path').basename(p), filePath: p, error: String(e) }
          }
        })

        return {
          files: analyses,
          count: analyses.length,
          dirPath,
        }
      } catch (error) {
        logger.error(`model:scan-local error: ${error}`)
        return { files: [], error: String(error) }
      }
    })

    // === llama.cpp Server 模式 IPC ===
    ipcMain.handle('server:status', async () => {
      try {
        const health = await modelManager.serverHealth()
        return { ...health }
      } catch (e) {
        logger.error(`server:status error: ${e}`)
        return { running: false }
      }
    })
  } catch (error) {
    logger.error(`setupModelManagerHandlers error: ${error}`)
  }
}
