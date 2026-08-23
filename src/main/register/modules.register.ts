/**
 * Modules Register — 模块初始化与生命周期
 *
 * 从 index.ts 巨石中拆分出：
 * - 轻量模块同步初始化（批次 1）
 * - 重量模块异步初始化（批次 2）
 * - 模型注册与自动加载
 * - 后台异步初始化（Python运行时、SGLang守护、权限管理）
 * - 桌面宠物启动
 *
 * @module register/modules.register
 */

import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { createLogger } from '../utils/logging'
import { setModuleStatus, cleanupOldNsisTempDirs, setAppReadySent, getModuleStatus } from './lifecycle.register'
import { registerAllTools } from '../agent/tool-registry'
import { internetSearch } from '../search'
import { contextManager } from '../context-manager'
import { getStore } from '../ipc/config.ipc'
import { modelRegistry } from '../model-registry'

const logger = createLogger('Modules')

interface ModulesRegisterOptions {
  mainWindow: BrowserWindow | null
  personaLoader: any
  dynamicOperationEngine: any
  knowledgeGraph: any
  vectorStore: any
  voiceEngine: any
  externalAIClient: any
  voiceWakeService: any
  personalization: any
  mobileChannelEngine: any
  modelRegistry: any
  modelManager: any
  visionModel: any
  permissionManager: any
  pythonRuntime: any
  deviceOptimizer: any
  processGuardian: any
  performanceProfiler: any
  writeLog: (msg: string) => void
  checkSmartAppControl: () => { enabled: boolean; mode: string }
  createWindow: () => BrowserWindow
}

export async function initializeAllModules(options: ModulesRegisterOptions): Promise<void> {
  const {
    mainWindow: _mainWindow, personaLoader, dynamicOperationEngine, knowledgeGraph,
    vectorStore, voiceEngine, externalAIClient, voiceWakeService,
    personalization, mobileChannelEngine, modelRegistry, modelManager,
    visionModel, permissionManager: _permissionManager, pythonRuntime: _pythonRuntime,
    deviceOptimizer: _deviceOptimizer, processGuardian: _processGuardian, performanceProfiler,
    writeLog, checkSmartAppControl, createWindow,
  } = options

  // ===== 任务路由标记就绪 =====
  try { setModuleStatus('task-router', 'ready') } catch { /* ignore */ }

  // ===== 批次 1: 轻量模块（立即，窗口尚未显示前快速完成） =====
  try { personaLoader.initialize(); setModuleStatus('persona-loader', 'ready') } catch (e) { setModuleStatus('persona-loader', 'failed', String(e)) }
  try {
    registerAllTools({ dynamicOperationEngine, knowledgeGraph, vectorStore, voiceEngine, internetSearch })
    setModuleStatus('agent-tool-registry', 'ready')
  } catch (e) { setModuleStatus('agent-tool-registry', 'failed', String(e)) }
  try { voiceWakeService.initialize(); setModuleStatus('voice-wake', 'ready') } catch (e) { setModuleStatus('voice-wake', 'failed', String(e)) }
  try { externalAIClient.initialize(); setModuleStatus('external-ai', 'ready') } catch (e) { setModuleStatus('external-ai', 'failed', String(e)) }
  try { dynamicOperationEngine.initialize(); setModuleStatus('dynamic-operation', 'ready') } catch (e) { setModuleStatus('dynamic-operation', 'failed', String(e)) }
  try { personalization.initialize(); setModuleStatus('personalization', 'ready') } catch (e) { setModuleStatus('personalization', 'failed', String(e)) }
  try { mobileChannelEngine.initialize(); setModuleStatus('mobile-channel', 'ready') } catch (e) { setModuleStatus('mobile-channel', 'failed', String(e)) }

  // ===== 步骤 2: 创建窗口 =====
  writeLog('Creating window...')
  createWindow()
  writeLog('Window created, starting module initialization...')

  // ===== 自动更新检查 =====
  try {
    const { autoUpdater } = require('electron-updater')
    autoUpdater.checkForUpdates().catch((err: Error) => {
      logger.debug(`[Main] 自动更新检查失败: ${err.message}`)
    })
  } catch (e) { logger.debug(`[Main] 自动更新检查异常: ${e}`) }

  // ===== 系统代理预热（异步检测 Windows 注册表/WinHTTP，不阻塞主流程） =====
  try {
    const { getSystemProxyAsync } = await import('../utils/proxy-resolver')
    getSystemProxyAsync().then((proxyUrl) => {
      if (proxyUrl) logger.debug(`[Main] 系统代理预热完成: ${proxyUrl}`)
    }).catch((e) => logger.debug(`[Main] 系统代理预热失败: ${e}`))
  } catch (e) { logger.debug(`[Main] 系统代理预热异常: ${e}`) }

  // ===== NSIS 临时目录清理 =====
  setImmediate(() => { cleanupOldNsisTempDirs() })

  // ===== 性能 profiler =====
  performanceProfiler.start()

  // ===== 模型自动启动 =====
  async function startDefaultModels() {
    try {
      const models = modelRegistry.getStartupModels()
      if (models.length === 0) {
        writeLog('model-registry: 无默认启动模型，跳过自动激活')
        return
      }
      writeLog(`model-registry: 自动激活 ${models.length} 个模型`)
      const { tandemManager } = await import('../tandem-manager')
      // A-2 修复：按真实硬件探测结果缩放每个模型的 gpuLayers/contextSize，
      // 避免注册表固定 88 层在 6GB 显存下 OOM 回退 CPU
      const { getHardware, resolveModelRuntime } = await import('../runtime/hardware')
      const hw = await getHardware()
      const scaledModels = models.map((m: any) => {
        const rt = resolveModelRuntime(m, hw)
        const gpuLayers = rt.available && rt.targetDevice === 'gpu' ? rt.gpuLayers : 0
        const contextSize = rt.contextSize || m.contextSize || 2048
        writeLog(`model-registry: ${m.name} 运行时参数 gpuLayers=${gpuLayers} contextSize=${contextSize} device=${rt.targetDevice}${rt.reason ? `（${rt.reason}）` : ''}`)
        return { ...m, gpuLayers, contextSize }
      })
      const config = {
        models: scaledModels.map((m: any) => ({
          id: m.id, name: m.name, port: m.port, modelPath: m.modelPath,
          gpuLayers: m.gpuLayers, contextSize: m.contextSize, mode: m.mode,
          temperature: m.temperature, maxTokens: m.maxTokens,
        })),
        hardwareLimit: { maxVRAM_MB: 6144, maxThreads: 8 },
        defaultMode: 'dual' as const,
      }
      tandemManager.loadConfig(config)
      for (const model of scaledModels) {
        try {
          const result = await tandemManager.startServer(model)
          if (result.success) writeLog(`model-registry: ${model.name} 已自动启动 (端口 ${result.port})`)
          else writeLog(`model-registry: ${model.name} 启动失败: ${result.error}`)
        } catch (e: any) { writeLog(`model-registry: ${model.name} 启动异常: ${e.message}`) }
      }

      // v12.1 待命模型自动加载：注册表中 isStandby 的轻量模型常驻内存（不阻塞，失败不阻断）
      // 配置开关 enableStandbyModels 默认 true；为 false 时跳过待命模型加载
      try {
        const enableStandbyModels: unknown = getStore().get('enableStandbyModels', true)
        if (enableStandbyModels === false) {
          writeLog('model-registry: 待命模型已通过配置禁用')
        } else {
          const standbyList = (modelRegistry.list ? modelRegistry.list() : []).filter((m: any) => m.isStandby)
          if (standbyList.length > 0 && modelManager) {
            for (const sm of standbyList) {
              writeLog(`model-registry: 待命模型 ${sm.name} 加载到内存...`)
              const sr = await modelManager.loadStandbyModel(sm.id)
              writeLog(sr.success ? `model-registry: 待命模型 ${sm.name} 已就绪` : `model-registry: 待命模型 ${sm.name} 加载失败: ${sr.error}`)
            }
          }
        }
      } catch (e: any) { writeLog(`model-registry: 待命模型自动加载异常: ${e.message}`) }
    } catch (e: any) { writeLog(`model-registry: 自动启动失败: ${e.message}`) }
  }

  // ===== 批次 2: 重模块（延迟到窗口显示后，不阻塞首屏） =====
  const MAX_INIT_TIMEOUT_MS = 10000
  let initTimedOut = false

  function sendAppReady(reason: string) {
    if (initTimedOut) return
    initTimedOut = true
    try {
      const sacStatus = checkSmartAppControl()
      writeLog(`app:ready 发送 (${reason})`)
      const mw = BrowserWindow.getAllWindows()[0]
      if (mw && !mw.isDestroyed() && !mw.webContents.isDestroyed()) {
        mw.webContents.send('app:ready', { ready: true, modules: getModuleStatus(), sacStatus })
      }
      setAppReadySent(true)
      startDefaultModels()
    } catch (e) {
      logger.error(`sendAppReady failed: ${e}`)
    }
  }

  const forceReadyTimeout = setTimeout(() => sendAppReady('超时强制'), MAX_INIT_TIMEOUT_MS)

  // ===== 重模块异步初始化 =====
  setImmediate(async () => {
    writeLog('Deferred heavy module initialization starting...')

    try {
      // 语音引擎
      if (voiceEngine && typeof voiceEngine.initialize === 'function') {
        try { setModuleStatus('voice-engine', 'initializing'); voiceEngine.initialize(); setModuleStatus('voice-engine', 'ready') }
        catch (e) { setModuleStatus('voice-engine', 'failed', String(e)) }
      } else { setModuleStatus('voice-engine', 'failed', '模块未加载') }

      // 模型管理器
      if (modelManager && typeof modelManager.initialize === 'function') {
        try { setModuleStatus('model-manager', 'initializing'); modelManager.initialize(); setModuleStatus('model-manager', 'ready') }
        catch (e) { setModuleStatus('model-manager', 'failed', String(e)) }
      } else { setModuleStatus('model-manager', 'failed', '模块未加载') }

      // 上下文管理器（对话历史跨会话持久化）
      try { setModuleStatus('context-manager', 'initializing'); contextManager.initialize(); setModuleStatus('context-manager', 'ready') } catch (e) { setModuleStatus('context-manager', 'failed', String(e)) }
      // 向量存储 / RAG
      try { setModuleStatus('vector-store', 'initializing'); vectorStore.initialize(); setModuleStatus('vector-store', 'ready') } catch (e) { setModuleStatus('vector-store', 'failed', String(e)) }
      // 知识图谱
      try { setModuleStatus('knowledge-graph', 'initializing'); knowledgeGraph.initialize(); setModuleStatus('knowledge-graph', 'ready') } catch (e) { setModuleStatus('knowledge-graph', 'failed', String(e)) }
      // 视觉模型
      try { setModuleStatus('vision-model', 'initializing'); visionModel.initialize(); setModuleStatus('vision-model', 'ready') } catch (e) { setModuleStatus('vision-model', 'failed', String(e)) }

      // 自动初始化角色
    } finally {
      clearTimeout(forceReadyTimeout)
      // 竞态修复：即使超时已触发，仍推送最终模块状态给渲染端
      if (initTimedOut) {
        try {
          const mw = BrowserWindow.getAllWindows()[0]
          if (mw && !mw.isDestroyed() && !mw.webContents.isDestroyed()) {
            mw.webContents.send('app:modules-status', getModuleStatus())
          }
        } catch { /* ignore */ }
        return
      }
    }

    if (initTimedOut) return
    writeLog('Deferred heavy module initialization completed')
    sendAppReady('正常完成')
  })
}

/* ==================== 模型注册 ==================== */

export function registerModels(options: {
  modelManager: any
  writeLog: (msg: string) => void
}) {
  const { modelManager, writeLog } = options

  try {
    const userModelsPath = (name: string) => join(app.getPath('userData'), 'models', name)
    const resourceModelsPath = (name: string) => is.dev
      ? join(__dirname, '../../resources/models', name)
      : join(process.resourcesPath, 'models', name)

    const modelsToRegister: Array<{
      id: string; name: string; type: 'vision' | 'embedding' | 'main'
      file: string; size: number; gpuLayers?: number; tier?: 'fast' | 'vision'; mode?: 'cpu'; isStandby?: boolean; contextSize?: number
    }> = [
      // v11.0+ 默认主模型：Qwen3.5-9B。已关闭 Electron 硬件加速让出显存，9B 直接上 GPU 推理
      // 显存适配：RTX3060 6GB，Q4_K_M 权重 ~5.2GB，全量 offload + 4096 ctx 会占满显存导致推理死锁，
      // 故 gpuLayers 88（留部分层 CPU 缓冲）+ contextSize 2048，保证 GPU 推理稳定
      { id: 'qwen3.5-9b', name: 'Qwen3.5-9B-Instruct (主模型)', type: 'main', file: 'qwen3.5-9b.gguf', size: 5417, gpuLayers: 88, tier: 'fast', contextSize: 2048 },
      { id: 'qwen2-vl-7b', name: 'Qwen2-VL-7B-Instruct', type: 'vision', file: 'qwen2-vl-7b.gguf', size: 4608, gpuLayers: 99, tier: 'fast' },
      { id: 'nomic-embed', name: 'nomic-embed-text-v1.5', type: 'embedding', file: 'nomic-embed.gguf', size: 256 },
      // v12.2 视觉待命模型：2B 无需 quality 档（8GB 门槛），走 vision 档，6GB 显存可加载
      { id: 'qwen2-vl-2b', name: 'Qwen2-VL-2B (视觉待命)', type: 'vision', file: 'Qwen2-VL-2B-Instruct-Q4_K_M.gguf', size: 940, gpuLayers: 99, tier: 'vision', isStandby: true },
      { id: 'qwen3.5-0.8b-behavior', name: 'Qwen3.5-0.8B-Instruct (角色行为)', type: 'main', file: 'qwen3.5-0.8b-instruct-Q4_K_M.gguf', size: 505, gpuLayers: 0, mode: 'cpu', isStandby: true },
    ]

    for (const m of modelsToRegister) {
      let p = userModelsPath(m.file)
      if (!existsSync(p)) {
        p = resourceModelsPath(m.file)
      }
      if (existsSync(p)) {
        modelManager.registerModel({
          id: m.id, name: m.name, type: m.type, path: p, size: m.size,
          gpuLayers: m.gpuLayers, tier: m.tier, mode: m.mode,
        })
        // 同步注册到 modelRegistry（前端依赖它获取模型列表和默认模型）
        try {
          modelRegistry.add({
            id: m.id, name: m.name, type: m.type, modelPath: p,
            gpuLayers: m.gpuLayers ?? 0,
            mode: m.mode === 'cpu' ? 'cpu' : 'gpu',
            contextSize: m.contextSize ?? 4096,
            temperature: 0.7,
            maxTokens: 2048,
            isDefault: m.id === 'qwen3.5-9b',
            isStartup: m.id === 'qwen3.5-9b',
          })
        } catch { /* modelRegistry may fail if config store not ready yet */ }
        writeLog(`Registered model: ${m.name} (${p})`)
      }
    }
  } catch (e) { logger.error(`Model registration failed: ${e}`) }
}

/* ==================== 后台异步初始化 ==================== */

export async function initializeBackground(options: {
  mainWindow: BrowserWindow | null
  permissionManager: any
  pythonRuntime: any
  deviceOptimizer: any
  processGuardian: any
  modelManager: any
  writeLog: (msg: string) => void
  checkSmartAppControl: () => { enabled: boolean; mode: string }
}) {
  const {
    mainWindow, permissionManager, pythonRuntime, deviceOptimizer,
    processGuardian, modelManager, writeLog, checkSmartAppControl,
  } = options

  try {
    setModuleStatus('permission-manager', 'initializing')
    await permissionManager.initialize()
    setModuleStatus('permission-manager', 'ready')
  } catch (e) {
    logger.error(`Permission manager init failed: ${e}`)
    setModuleStatus('permission-manager', 'failed', String(e))
  }

  // Python Runtime
  try {
    setModuleStatus('python-runtime', 'initializing')
    await pythonRuntime.initialize()
    setModuleStatus('python-runtime', 'ready')
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    logger.error(`Python runtime init failed: ${e}`)
    setModuleStatus('python-runtime', 'failed', errMsg)
    if (/access denied|unsigned|blocked by|policy|0x/i.test(errMsg)) {
      const sac = checkSmartAppControl()
      if (sac.enabled) {
        writeLog(`[SAC] Python 运行时初始化失败，SAC 状态: ${sac.mode}，疑似拦截`)
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('app:sac-warning', {
            module: 'python-runtime', error: errMsg, sacMode: sac.mode,
            guidance: '请关闭 Windows 智能应用控制 (Smart App Control) 或使用安装版应用。\n路径：Windows 安全中心 → 应用和浏览器控制 → 智能应用控制 → 关闭',
          })
        }
      }
    }
  }

  // Python 心跳
  try {
    pythonRuntime.startHeartbeat(15000)
    pythonRuntime.setHealthListener((healthy: boolean) => {
      if (!healthy) {
        logger.warn('[Main] Python 引擎健康状态异常')
        setModuleStatus('python-runtime', 'failed', '心跳检测失败')
      }
    })
  } catch (e) { logger.error(`Python heartbeat start failed: ${e}`) }

  // SGLang 离线安装检测
  try {
    await pythonRuntime.installSGLangOffline()
  } catch (e) { logger.error(`SGLang offline install check failed: ${e}`) }

  // 设备优化器
  try {
    setModuleStatus('device-optimizer', 'initializing')
    deviceOptimizer.startMonitoring(10000)
    setModuleStatus('device-optimizer', 'ready')
  } catch (e) {
    logger.error(`Device optimizer start failed: ${e}`)
    setModuleStatus('device-optimizer', 'failed', String(e))
  }

  // ProcessGuardian: SGLang 守护
  try {
    setModuleStatus('sglang-server', 'initializing')
    const sglangModule = await import('../ipc/sglang.ipc')
    const sp = sglangModule.sglangProcess
    if (sp != null && !sp.killed) {
      processGuardian.register({
        id: 'sglang-server',
        command: 'node',
        args: [],
        options: { stdio: 'pipe' },
        heartbeat: async () => {
          try {
            const http = await import('http')
            return new Promise<boolean>((resolve) => {
              const req = http.get('http://127.0.0.1:30000/health', { timeout: 5000 }, (res: any) => {
                resolve(res.statusCode === 200)
              })
              req.on('error', () => resolve(false))
              req.end()
            })
          } catch { return false }
        },
        maxRestarts: 3,
      })
      setModuleStatus('sglang-server', 'ready')
      writeLog('[ProcessGuardian] SGLang server 已注册守护')
    } else {
      setModuleStatus('sglang-server', 'idle')
      writeLog('[ProcessGuardian] SGLang server 未运行，跳过守护注册')
    }
  } catch (e) {
    logger.error(`ProcessGuardian SGLang setup failed: ${e}`)
    setModuleStatus('sglang-server', 'failed', String(e))
  }

  // SGLang 健康监控
  let sglangRestartCount = 0
  const maxSglangRestarts = 3
  void setInterval(async () => {
    // 未启用（进程未运行）时不监控，避免每 30s 重复报错、重复触发模型重载
    if (getModuleStatus()['sglang-server'] !== 'ready') return
    try {
      const { default: http } = require('http')
      const req = http.get('http://127.0.0.1:30000/health', { timeout: 5000 }, (res: any) => {
        if (res.statusCode === 200) sglangRestartCount = 0
      })
      req.on('error', async () => {
        if (sglangRestartCount < maxSglangRestarts) {
          sglangRestartCount++
          logger.warn(`[SGLang] 健康检查失败，尝试重启 (${sglangRestartCount}/${maxSglangRestarts})`)
          try {
            const { stopSGLang } = await import('../ipc/sglang.ipc')
            await stopSGLang?.()
            const currentModel = modelManager.getLoadedModel()
            if (currentModel) await modelManager.loadModel(currentModel.modelId)
          } catch (e) { logger.error(`[SGLang] 重启失败: ${e}`) }
        }
      })
      req.end()
    } catch { logger.error('[SGLang] 健康检查HTTP请求失败') }
  }, 30000)

  // 权限弹窗
  try {
    const status = permissionManager.getStatus()
    if (!status.requiredGranted) {
      if (mainWindow) await permissionManager.showPermissionDialog(mainWindow)
    }
  } catch (e) { logger.error(`Permission dialog error: ${e}`) }

  writeLog('Background initialization completed')
}

/* ==================== 默认模型自动加载 ==================== */

export function autoLoadDefaultModel(options: {
  modelManager: any
  writeLog: (msg: string) => void
}) {
  const { modelManager, writeLog } = options
  setTimeout(async () => {
    try {
      const installedModels = modelManager.getAllModels()
      if (installedModels.length === 0) {
        writeLog('Auto-load: 没有已安装的模型，跳过')
        return
      }
      let defaultModelId: string | null = null
      let startupModelId: string | null = null
      try {
        const store = getStore()
        if (store) {
          defaultModelId = store.get('defaultModelId') || null
          startupModelId = store.get('startupModelId') || null
        }
      } catch (e) { writeLog(`config read failed: ${e}, using default priority`) }

      const priorityOrder = modelRegistry.getStartupModels().map((m: any) => m.id)
      // 双路径防冲突：存在启动模型时由 startDefaultModels（tandem 引擎）负责加载，
      // 此处仅作为无启动模型时的兜底，避免同一模型被 SGLang/CPUEngine 二次加载失败报错
      if (priorityOrder.length > 0) {
        writeLog('Auto-load: 已存在启动模型，跳过重复加载（由 tandem 引擎负责）')
        return
      }
      if (priorityOrder.length === 0) {
        // 若注册表为空，回退到已知默认模型
        priorityOrder.push('qwen2-vl-2b', 'qwen3.5-0.8b-behavior')
      }
      let targetModel = null
      if (startupModelId) {
        targetModel = installedModels.find((m: any) => m.id === startupModelId)
        writeLog(`Auto-load: 随软件启动模型 ID = ${startupModelId}`)
      }
      if (!targetModel && defaultModelId) { targetModel = installedModels.find((m: any) => m.id === defaultModelId) }
      if (!targetModel) {
        for (const id of priorityOrder) {
          targetModel = installedModels.find((m: any) => m.id === id)
          if (targetModel) break
        }
      }
      if (!targetModel) { targetModel = installedModels[0] }
      if (targetModel) {
        writeLog(`Auto-load: 正在加载默认模型 ${targetModel.name} (${targetModel.id})`)
        const result = await modelManager.loadModel(targetModel.id)
        writeLog(`Auto-load: 模型 ${targetModel.name} ${result ? '加载成功' : '加载失败'}`)
      }
    } catch (e) { writeLog(`Auto-load: 加载失败 - ${e}`) }
  }, 3000)
}
