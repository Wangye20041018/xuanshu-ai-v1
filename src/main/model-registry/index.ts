/**
 * ModelRegistry — 模型长效注册表 v1.0
 *
 * 核心能力：
 * - 接入的模型长效保存（config 持久化）
 * - 卡片式管理：增/删/列/设默认
 * - 随软件启动自动激活默认模型
 * - 删除卡片 = 注销模型 + 停止对应 llama-server
 */

import { ipcMain } from 'electron'
import { existsSync } from 'fs'
import { logger } from '../../shared/logger'
import { getStore } from '../ipc/config.ipc'
import { analyzeModelFile } from '../utils/model-analyzer'

/* ============================================================
 * 类型定义
 * ============================================================ */

export interface RegisteredModel {
  id: string
  name: string
  /** 模型文件绝对路径 */
  modelPath: string
  /** 模型类型 */
  type: 'main' | 'vision' | 'embedding'
  /** 视觉模型投影文件 */
  mmprojPath?: string
  /** GPU 层数（0 = 纯 CPU） */
  gpuLayers: number
  /** 运行模式：GPU 或 CPU */
  mode: 'gpu' | 'cpu'
  /** 上下文大小 */
  contextSize: number
  /** 推理参数 */
  temperature: number
  maxTokens: number
  /** 端口号（自动分配） */
  port: number
  /** 是否默认模型（单模型模式下自动激活） */
  isDefault: boolean
  /** 是否随软件启动自动激活 */
  isStartup: boolean
  /** v12.1 是否常驻内存待命（轻量模型常驻 RAM，随叫随用） */
  isStandby?: boolean
  /** v12.2 是否多模态（可处理图片/屏幕截图；主模型接入时据此决定是否需辅助视觉模型） */
  isMultimodal?: boolean
  /** 多模态检测置信度 0-1 */
  multimodalConfidence?: number
  /** 注册时间 */
  registeredAt: number
  /** 模型文件大小 (MB) */
  sizeMB?: number
  /** 参数量描述 */
  params?: string
  /** 量化等级 */
  quantization?: string
}

/* ============================================================
 * ModelRegistry 实现
 * ============================================================ */

const CONFIG_KEY = 'modelRegistry'

class ModelRegistry {
  private cache: RegisteredModel[] | null = null
  private cacheTimestamp: number = 0
  private readonly TTL_MS = 5000 // 5 秒 TTL，平衡一致性与 IPC 调用压力

  private getStore() {
    const store = getStore()
    if (!store) throw new Error('[ModelRegistry] config store 未初始化')
    return store
  }

  /** 获取所有注册模型（带内存缓存） */
  list(): RegisteredModel[] {
    try {
      const now = Date.now()
      if (this.cache !== null && (now - this.cacheTimestamp) < this.TTL_MS) {
        return this.cache
      }
      const store = this.getStore()
      const models = store.get(CONFIG_KEY, []) as RegisteredModel[]
      this.cache = models
      this.cacheTimestamp = now
      return models
    } catch (e) {
      logger.error('[ModelRegistry] list 失败:', e)
      return this.cache || []
    }
  }

  /** 保存模型列表（更新缓存） */
  private save(models: RegisteredModel[]): void {
    const store = this.getStore()
    store.set(CONFIG_KEY, models)
    this.cache = models
    this.cacheTimestamp = Date.now()
    logger.info(`[ModelRegistry] 已保存 ${models.length} 个模型`)
  }

  /** 注册新模型（自动分配端口） */
  add(model: Omit<RegisteredModel, 'registeredAt' | 'port' | 'isDefault' | 'isStartup'> & { isDefault?: boolean; isStartup?: boolean; port?: number }): { success: boolean; model?: RegisteredModel; error?: string } {
    try {
      const models = this.list()

      // 检查重复（同路径视为同一模型）→ upsert：更新字段，避免旧配置（如 gpuLayers=0）残留
      const dup = models.find(m => m.modelPath === model.modelPath)
      if (dup) {
        const merged: RegisteredModel = { ...dup, ...model, port: dup.port, registeredAt: dup.registeredAt }
        if (merged.isDefault) {
          models.forEach(m => { if (m.id !== merged.id) m.isDefault = false })
        }
        if (merged.isStartup) {
          models.forEach(m => { if (m.id !== merged.id) m.isStartup = false })
        }
        const idx = models.indexOf(dup)
        models[idx] = merged
        this.save(models)
        logger.info(`[ModelRegistry] 更新模型: ${merged.name} (gpuLayers=${merged.gpuLayers}, mode=${merged.mode})`)
        return { success: true, model: merged }
      }

      // 自动分配端口（从 8082 开始，8080-8081 留给 tandem）
      const maxPort = models.length > 0
        ? Math.max(...models.map(m => m.port), 8081)
        : 8081
      const port = model.port || maxPort + 1

      // v12.2 自动多模态检测（仅当调用方未显式指定时）
      if (model.isMultimodal === undefined && model.modelPath && existsSync(model.modelPath)) {
        try {
          const analysis = analyzeModelFile(model.modelPath)
          ;(model as any).isMultimodal = analysis.isMultimodal
          ;(model as any).multimodalConfidence = analysis.multimodalConfidence
        } catch { /* 检测失败保持 undefined */ }
      }

      const entry: RegisteredModel = {
        ...model,
        port,
        isDefault: model.isDefault ?? false,
        isStartup: model.isStartup ?? false,
        registeredAt: Date.now(),
      }

      // 如果设为默认，取消其他模型的默认标记
      if (entry.isDefault) {
        models.forEach(m => { m.isDefault = false })
      }

      models.push(entry)
      this.save(models)
      logger.info(`[ModelRegistry] 注册模型: ${entry.name} (${entry.modelPath}) → 端口 ${entry.port}`)

      return { success: true, model: entry }
    } catch (e: any) {
      logger.error('[ModelRegistry] add 失败:', e)
      return { success: false, error: e.message }
    }
  }

  /**
   * 更新已注册模型的推理参数（A-4：UI 推理模式/gpuLayers/contextSize 回写注册表，重启后生效）
   * 仅更新推理相关字段，保留 id/modelPath/port/isDefault/isStartup 等基础字段。
   */
  updateRuntime(
    id: string,
    patch: Partial<Pick<RegisteredModel, 'gpuLayers' | 'contextSize' | 'mode' | 'temperature' | 'maxTokens'>>,
  ): { success: boolean; model?: RegisteredModel; error?: string } {
    try {
      const models = this.list()
      const idx = models.findIndex(m => m.id === id)
      if (idx < 0) {
        return { success: false, error: `模型 ${id} 未注册` }
      }
      const merged: RegisteredModel = { ...models[idx], ...patch }
      models[idx] = merged
      this.save(models)
      logger.info(`[ModelRegistry] 更新推理参数: ${merged.name} (mode=${merged.mode}, gpuLayers=${merged.gpuLayers}, contextSize=${merged.contextSize})`)
      return { success: true, model: merged }
    } catch (e: any) {
      logger.error('[ModelRegistry] updateRuntime 失败:', e)
      return { success: false, error: e.message }
    }
  }

  /** 删除模型（仅从注册表移除，不删模型文件） */
  remove(id: string): { success: boolean; error?: string } {
    try {
      const models = this.list()
      const idx = models.findIndex(m => m.id === id)
      if (idx === -1) {
        return { success: false, error: '模型未找到' }
      }

      const removed = models.splice(idx, 1)[0]
      this.save(models)
      logger.info(`[ModelRegistry] 已移除模型: ${removed.name}`)
      return { success: true }
    } catch (e: any) {
      logger.error('[ModelRegistry] remove 失败:', e)
      return { success: false, error: e.message }
    }
  }

  /** 设为默认模型 */
  setDefault(id: string): { success: boolean; error?: string } {
    try {
      const models = this.list()
      const target = models.find(m => m.id === id)
      if (!target) {
        return { success: false, error: '模型未找到' }
      }

      // 验证模型文件存在
      if (!existsSync(target.modelPath)) {
        return { success: false, error: `模型文件不存在: ${target.modelPath}` }
      }

      models.forEach(m => { m.isDefault = m.id === id; m.isStartup = m.id === id })
      this.save(models)
      logger.info(`[ModelRegistry] 默认模型已设为: ${target.name}`)
      return { success: true }
    } catch (e: any) {
      logger.error('[ModelRegistry] setDefault 失败:', e)
      return { success: false, error: e.message }
    }
  }

  /** 切换随软件启动 */
  toggleStartup(id: string): { success: boolean; isStartup: boolean; error?: string } {
    try {
      const models = this.list()
      const target = models.find(m => m.id === id)
      if (!target) {
        return { success: false, isStartup: false, error: '模型未找到' }
      }

      target.isStartup = !target.isStartup
      this.save(models)
      logger.info(`[ModelRegistry] ${target.name} 随软件启动: ${target.isStartup}`)
      return { success: true, isStartup: target.isStartup }
    } catch (e: any) {
      logger.error('[ModelRegistry] toggleStartup 失败:', e)
      return { success: false, isStartup: false, error: e.message }
    }
  }

  /** v12.1 切换常驻内存待命（轻量模型随叫随用；同一时间仅一个待命模型） */
  toggleStandby(id: string): { success: boolean; isStandby: boolean; error?: string } {
    try {
      const models = this.list()
      const target = models.find(m => m.id === id)
      if (!target) {
        return { success: false, isStandby: false, error: '模型未找到' }
      }

      const next = !target.isStandby
      // 开启待命时，取消其它模型的待命标记（单待命槽位）
      models.forEach(m => { if (m.id !== id) m.isStandby = false })
      target.isStandby = next
      this.save(models)
      logger.info(`[ModelRegistry] ${target.name} 内存待命: ${next}`)
      return { success: true, isStandby: next }
    } catch (e: any) {
      logger.error('[ModelRegistry] toggleStandby 失败:', e)
      return { success: false, isStandby: false, error: e.message }
    }
  }

  /** 过滤掉模型文件已不存在（旧打包验证目录残留等）的失效注册项 */
  private filterAlive(models: RegisteredModel[]): RegisteredModel[] {
    return models.filter(m => {
      if (!m.modelPath) return false
      try { return existsSync(m.modelPath) } catch { return false }
    })
  }

  /** 清理失效注册项（模型文件已删除/路径失效），返回清理数量 */
  pruneDead(): number {
    const models = this.list()
    const alive = this.filterAlive(models)
    if (alive.length === models.length) return 0
    this.save(alive)
    logger.info('[ModelRegistry] 清理失效注册项: ' + (models.length - alive.length) + ' 个')
    return models.length - alive.length
  }

  /** 获取默认模型（用于自动启动） */
  getDefault(): RegisteredModel | null {
    const models = this.filterAlive(this.list())
    return models.find(m => m.isDefault && m.isStartup) || models.find(m => m.isStartup) || models.find(m => m.isDefault) || null
  }

  /** 获取应随软件启动的模型列表 */
  getStartupModels(): RegisteredModel[] {
    const models = this.filterAlive(this.list())
    const startup = models.filter(m => m.isStartup && m.isDefault)
    // 如果没有明确标记 startup 的，取第一个默认模型
    if (startup.length === 0) {
      const def = models.find(m => m.isDefault)
      if (def) return [def]
    }
    return startup
  }
}

/* ============================================================
 * 单例导出 + IPC 注册
 * ============================================================ */

export const modelRegistry = new ModelRegistry()

export function setupModelRegistryHandlers(): void {
  /* ---- 列表 ---- */
  ipcMain.handle('model-registry:list', async () => {
    return modelRegistry.list()
  })

  /* ---- 注册 ---- */
  ipcMain.handle('model-registry:add', async (_e, model: any) => {
    return modelRegistry.add(model)
  })

  /* ---- 删除 ---- */
  ipcMain.handle('model-registry:remove', async (_e, id: string) => {
    try {
      // 联动清理运行引擎（体验闭环：删除已接入模型时，同步卸载当前加载/运行中的服务与进程）
      let wasInUse = false
      try {
        const { tandemManager } = await import('../tandem-manager')
        const states = tandemManager.getServerStates() || []
        if (states.some((s: any) => s.modelId === id)) {
          wasInUse = true
          await tandemManager.stopServer(id)
        }
      } catch (e) {
        logger.warn(`[ModelRegistry] remove 联动停止 tandem 服务失败: ${(e as Error)?.message ?? String(e)}`)
      }
      try {
        const { modelManager } = await import('../model-manager')
        const loaded = modelManager.getLoadedModel?.()
        if (loaded?.modelId === id) {
          wasInUse = true
          await modelManager.unloadModel(id)
        }
      } catch (e) {
        logger.warn(`[ModelRegistry] remove 联动卸载 model-manager 失败: ${(e as Error)?.message ?? String(e)}`)
      }
      const result = modelRegistry.remove(id)
      return { ...result, wasInUse }
    } catch (e: any) {
      logger.error('[ModelRegistry] remove IPC 失败:', e)
      return { success: false, error: e?.message ?? String(e), wasInUse: false }
    }
  })

  /* ---- 设为默认 ---- */
  ipcMain.handle('model-registry:set-default', async (_e, id: string) => {
    return modelRegistry.setDefault(id)
  })

  /* ---- 切换随软件启动 ---- */
  ipcMain.handle('model-registry:toggle-startup', async (_e, id: string) => {
    return modelRegistry.toggleStartup(id)
  })

  /* ---- v12.1 切换常驻内存待命 ---- */
  ipcMain.handle('model-registry:toggle-standby', async (_e, id: string) => {
    return modelRegistry.toggleStandby(id)
  })

  /* ---- 获取默认模型 ---- */
  ipcMain.handle('model-registry:get-default', async () => {
    return modelRegistry.getDefault()
  })

  /* ---- 获取应启动的模型 ---- */
  ipcMain.handle('model-registry:get-startup-models', async () => {
    return modelRegistry.getStartupModels()
  })

  /* ---- A-4: 更新已注册模型的推理参数（UI 回写） ---- */
  ipcMain.handle('model-registry:update-runtime', async (_e, id: string, patch: any) => {
    return modelRegistry.updateRuntime(id, patch)
  })

  /* ---- A-4: 重启指定模型使新推理参数生效 ---- */
  ipcMain.handle('model-registry:restart-model', async (_e, id: string) => {
    try {
      const model = modelRegistry.list().find(m => m.id === id)
      if (!model) {
        return { success: false, error: `模型 ${id} 未注册` }
      }
      const { tandemManager } = await import('../tandem-manager')
      await tandemManager.stopServer(id)
      await tandemManager.startServer(model as any)
      const states = tandemManager.getServerStates()
      const state = states.find(s => s.modelId === id)
      return { success: true, port: state?.port, status: state?.status ?? 'started' }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  /* ---- A-4: 综合运行状态（模型详情 + tandem 状态 + GPU 显存） ---- */
  ipcMain.handle('model-registry:runtime-status', async () => {
    try {
      const registryModels = modelRegistry.list()
      const { tandemManager } = await import('../tandem-manager')
      const states = tandemManager.getServerStates()
      const { modelManager } = await import('../model-manager')
      let gpu: any = null
      try {
        gpu = await modelManager.getMemoryUsage?.() ?? null
      } catch { gpu = null }
      return {
        models: registryModels,
        servers: states,
        loaded: modelManager.getLoadedModels ? modelManager.getLoadedModels() : [],
        gpu,
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  /* ---- P0-3: 模型引擎健康检查 — 检查注册中心 + 实际加载状态 ---- */
  ipcMain.handle('model:health', async () => {
    // 1) API Provider 已配置可用时视为就绪（对话走云端 API，无需本地模型）
    try {
      const { getStore } = await import('../ipc/config.ipc')
      const store = getStore()
      const providers: any[] = store.get('providers') || []
      const activeProviderId: string = store.get('activeProvider') || ''
      const isApiProvider = activeProviderId && activeProviderId !== '__local_cpu__' && activeProviderId !== '__local_sglang__'
      if (isApiProvider) {
        const activeProvider = providers.find((p: any) => p.id === activeProviderId)
        if (activeProvider && activeProvider.apiKey) {
          return {
            healthy: true,
            reason: 'api_provider_ready',
            modelId: activeProvider.id,
            modelName: activeProvider.name || activeProvider.id,
          }
        }
        return {
          healthy: false,
          reason: 'api_provider_missing_key',
          modelId: activeProvider?.id || activeProviderId,
          modelName: activeProvider?.name || activeProviderId,
        }
      }
    } catch { /* fall through to local model check */ }

    const defaultModel = modelRegistry.getDefault()
    if (!defaultModel) {
      return { healthy: false, reason: 'no_default_model', modelName: null, modelId: null }
    }
    // 动态导入 modelManager 避免循环依赖
    try {
      // 优先检查 tandem 引擎（v12 双模型调度下主模型由 tandem 拉起，modelManager 未记录）
      try {
        const { tandemManager } = await import('../tandem-manager')
        const states = tandemManager.getServerStates()
        const tandemModel = states.find((s: any) => s.modelId === defaultModel.id && s.status === 'running')
        if (tandemModel) {
          return {
            healthy: true,
            reason: 'tandem_ready',
            modelId: defaultModel.id,
            modelName: defaultModel.name,
            port: tandemModel.port,
          }
        }
      } catch { /* tandem 不可用则回退 modelManager 检查 */ }

      const { modelManager } = await import('../model-manager')
      const isLoaded = modelManager.isModelLoaded(defaultModel.id)
      return {
        healthy: isLoaded,
        reason: isLoaded ? 'ready' : 'model_not_loaded',
        modelId: defaultModel.id,
        modelName: defaultModel.name,
      }
    } catch {
      return { healthy: false, reason: 'engine_unavailable', modelId: defaultModel.id, modelName: defaultModel.name }
    }
  })

  logger.info('[ModelRegistry] IPC handlers 已注册')
}
