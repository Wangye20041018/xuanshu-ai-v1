/**
 * IPC Register — IPC Handler 注册中心
 *
 * 从 index.ts 巨石中拆分出所有 IPC handler 的 setup 函数调用、
 * 内联 handler 注册以及应用级 IPC（app:ready/sac-status/relaunch）。
 *
 * @module register/ipc.register
 */

import { ipcMain, app, BrowserWindow, protocol, net } from 'electron'
import path from 'path'
import { electronApp } from '@electron-toolkit/utils'
import { createLogger } from '../utils/logging'
import {
  setModuleStatus,
  checkSmartAppControl,
  writeLog,
  _appReadySent,
  getModuleStatus,
} from './lifecycle.register'

const logger = createLogger('IPC')

// 从各 IPC 模块导入 handler setup 函数
import { setupWindowHandlers } from '../ipc/window.ipc'
import { setupChatHandlers } from '../ipc/chat.ipc'
import { setupConfigHandlers } from '../ipc/config.ipc'
import { setupLLMHandlers } from '../ipc/llm.ipc'
import { setupModelHandlers } from '../ipc/model.ipc'
import { setupPluginHandlers } from '../ipc/plugin.ipc'
import { setupMemoryHandlers } from '../ipc/memory.ipc'
import { setupKnowledgeHandlers } from '../ipc/knowledge.ipc'
import { setupSyncHandlers } from '../ipc/sync.ipc'
import { setupRAGHandlers } from '../rag/index'
import { setupSGLangHandlers } from '../ipc/sglang.ipc'
import { setupVisionHandlers } from '../ipc/vision.ipc'
import { setupSystemControlHandlers } from '../ipc/system-control.ipc'
import { setupPermissionHandlers } from '../permission'
import { setupVoiceWakeHandlers } from '../wake'
import { setupExternalAIHandlers } from '../external-ai'
import { setupSearchHandlers as setupInternetSearchHandlers } from '../search'
import { setupModelManagerHandlers } from '../model-manager/index'
import { setupSystemMonitorHandlers } from '../ipc/system-monitor.ipc'
import { setupDiagnosticsHandlers } from '../ipc/diagnostics.ipc'
import { setupDynamicOperationHandlers } from '../dynamic-operation'
import { setupDeviceOptimizerHandlers } from '../device'
import { setupInferenceHandlers } from '../ipc/inference.ipc'
import { setupVoiceEngineHandlers } from '../ipc/system.ipc'
import { setupPersonalizationHandlers } from '../personalization'
import { setupKnowledgeGraphHandlers } from '../knowledge-graph'
import { setupMobileChannelHandlers } from '../mobile-channel'
import { setupOllamaHandlers } from '../ipc/ollama.ipc'
import { setupVisionHandlers as setupVisionQueueHandlers } from '../vision/vision-queue'
import { setupPythonHandlers } from '../runtime/python'
import { setupDebateHandlers } from '../ipc/system.ipc'
import { setupTandemHandlers } from '../tandem-manager'
import { setupModelRegistryHandlers } from '../model-registry'
import { setupFloatingBallHandlers } from '../floating-ball'
import { setupFulltextSearchHandlers } from '../fulltext-search'
import { setupVoiceCloneHandlers } from '../voice-engine/voice-clone'
import { setupHealthCheckHandlers } from '../health-check'
import { setupCloudQuotaHandlers } from '../cloud-quota'
import { setupLocalAiHandlers } from '../local-ai-scanner'
import { setupSystemHandlers } from '../ipc/system.ipc'
import { setupVoiceprintHandlers } from '../ipc/voiceprint.ipc'
import { setupAutomationHandlers as setupSystemAutomationHandlers } from '../ipc/system.ipc'
import { setupAutomationHandlers as setupAutomationEngineHandlers } from '../automation'
import { setupDesktopAutomationHandlers } from '../desktop-automation'
import { setupTaskRouterHandlers } from '../task-router'
import { setupPersonaLoaderHandlers } from '../persona-loader'
import { setupTTSHandlers } from '../ipc/tts.ipc'
import { setupMissingHandlers } from '../ipc/system.ipc'
import { setupUIAutomationIPC } from '../ui-automation'
import { setupVisualAgentHandlers, setupAgentHandlers } from '../agent'
import { setupSkillPackHandlers, loadLearnedSkillPacks } from '../skill-pack'
import { setupPptFlowHandlers } from '../ppt-flow'
import { setupEmotionHandlers } from '../persona/emotion-engine'
import { setupBackupHandlers } from '../backup'
import { setupSelfModifyHandlers } from '../self-modify/self-modify.ipc'
import { validateSender, validateSenderEvent } from '../utils/ipc-guard'

/* ==================== 协议注册 ==================== */

/**
 * local-file 协议路径安全校验（第三轮产品级加固）
 * 渲染进程仅通过 FileCard/ImageCard 展示本地附件，禁止读取系统关键目录与敏感文件。
 */
function isLocalFileAllowed(rawPath: string): boolean {
  try {
    // 去掉可能的 file:// 前缀与查询串
    let filePath = rawPath.replace(/^file:\/\/\//i, '').split(/[?#]/)[0]
    const resolved = path.resolve(filePath)
    const normalized = resolved.toLowerCase()

    // 系统关键目录黑名单
    const systemRoot = (process.env.SystemRoot || 'C:\\Windows').toLowerCase()
    const forbiddenPrefixes = [
      systemRoot,
      'c:\\windows\\',
      'c:\\program files\\',
      'c:\\program files (x86)\\',
      'c:\\programdata\\',
      'c:\\users\\default\\',
      'c:\\$recycle.bin\\',
    ]
    if (forbiddenPrefixes.some(p => normalized.startsWith(p))) {
      logger.warn(`[protocol] local-file 拒绝：系统关键目录 ${resolved}`)
      return false
    }

    // 敏感配置/凭据文件黑名单
    const segments = normalized.split(/[\\/]/)
    const forbiddenSegments = [
      '.ssh', '.gnupg', '.aws', '.kube', '.azure', '.npmrc', '.env',
      'id_rsa', 'id_ed25519', 'config.json', 'credentials',
    ]
    if (segments.some(seg => forbiddenSegments.some(f => seg.includes(f)))) {
      logger.warn(`[protocol] local-file 拒绝：敏感配置文件 ${resolved}`)
      return false
    }

    return true
  } catch {
    return false
  }
}

export function registerProtocols() {
  electronApp.setAppUserModelId('com.xuanshu.app')

  protocol.handle('local-file', (request: Request) => {
    const rawPath = decodeURIComponent(request.url.replace('local-file://', ''))
    if (!isLocalFileAllowed(rawPath)) {
      logger.error(`[protocol] local-file 已拦截非法路径: ${rawPath}`)
      return new Response('Forbidden', { status: 403 })
    }
    try {
      return net.fetch('file:///' + rawPath)
    } catch {
      logger.error(`[protocol] local-file 协议处理失败: ${rawPath}`)
      return new Response('File not found', { status: 404 })
    }
  })
}

/* ==================== IPC Handler 批量注册 ==================== */

export function setupAllIpcHandlers(options: {
  modelManager: any
  voiceEngine: any
  voiceWakeService: any
  externalAIClient: any
  dynamicOperationEngine: any
  knowledgeGraph: any
  vectorStore: any
  visionModel?: any
  personaLoader: any
  mainWindow: BrowserWindow | null
  performanceProfiler: any
}): void {
  // ===== IPC 来源鉴权包装（全量覆盖） =====
  // 在任何 handler 注册前包装 ipcMain.handle：所有 renderer invoke 必须来自
  // 已注册的合法窗口（ipc-guard.registerWindow），拦截 WebView/iframe/恶意注入来源。
  const originalHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel: string, listener: (...args: any[]) => any) => {
    return originalHandle(channel, (event: Electron.IpcMainInvokeEvent, ...args: any[]) => {
      if (!validateSender(event)) {
        logger.warn(`[IPCAuth] 已拦截未授权 IPC 调用: ${channel}`)
        return { success: false, error: '未授权的 IPC 调用' }
      }
      return listener(event, ...args)
    })
  }) as typeof ipcMain.handle

  // ===== IPC 事件（send/on）来源鉴权 =====
  // 与 handle 一致：所有 ipcMain.on 注册前包装，拦截通过 ipcRenderer.send
  // 发起且具备副作用的未授权调用（app:relaunch / window:close 等）。
  const originalOn = ipcMain.on.bind(ipcMain)
  ipcMain.on = ((channel: string, listener: (event: Electron.IpcMainEvent, ...args: any[]) => void) => {
    return originalOn(channel, (event: Electron.IpcMainEvent, ...args: any[]) => {
      if (!validateSenderEvent(event)) {
        logger.warn(`[IPCAuth] 已拦截未授权 IPC 事件: ${channel}`)
        return
      }
      return listener(event, ...args)
    })
  }) as typeof ipcMain.on

  // ===== 主体 IPC Handler 注册（41 个模块，含级联失败隔离） =====
  const handlerSetups: [string, () => void][] = [
    ['Window', setupWindowHandlers],
    ['Chat', setupChatHandlers],
    ['Emotion', setupEmotionHandlers],
    ['Config', setupConfigHandlers],
    ['LLM', setupLLMHandlers],
    ['Model', setupModelHandlers],
    ['Plugin', setupPluginHandlers],
    ['Memory', setupMemoryHandlers],
    ['Knowledge', setupKnowledgeHandlers],
    ['Sync', setupSyncHandlers],
    ['RAG', setupRAGHandlers],
    ['SGLang', setupSGLangHandlers],
    ['Vision', setupVisionHandlers],
    ['SystemControl', setupSystemControlHandlers],
    ['Permission', setupPermissionHandlers],
    ['VoiceWake', setupVoiceWakeHandlers],
    ['ExternalAI', setupExternalAIHandlers],
    ['InternetSearch', setupInternetSearchHandlers],
    ['ModelManager', setupModelManagerHandlers],
    ['SystemMonitor', setupSystemMonitorHandlers],
    ['Diagnostics', setupDiagnosticsHandlers],
    ['DynamicOperation', setupDynamicOperationHandlers],
    ['DeviceOptimizer', setupDeviceOptimizerHandlers],
    ['Inference', setupInferenceHandlers],
    ['VoiceEngine', setupVoiceEngineHandlers],
    ['Personalization', setupPersonalizationHandlers],
    ['KnowledgeGraph', setupKnowledgeGraphHandlers],
    ['MobileChannel', setupMobileChannelHandlers],
    ['Ollama', setupOllamaHandlers],
    ['VisionQueue', setupVisionQueueHandlers],
    ['Python', setupPythonHandlers],
    ['Debate', setupDebateHandlers],
    ['Tandem', setupTandemHandlers],
    ['ModelRegistry', setupModelRegistryHandlers],
    ['FloatingBall', setupFloatingBallHandlers],
    ['FulltextSearch', setupFulltextSearchHandlers],
    ['VoiceClone', setupVoiceCloneHandlers],
    ['System', setupSystemHandlers],
    ['Voiceprint', setupVoiceprintHandlers],
    ['TTS', setupTTSHandlers],
    ['CloudQuota', setupCloudQuotaHandlers],
    ['LocalAiScanner', setupLocalAiHandlers],
    ['Backup', setupBackupHandlers],
    ['SelfModify', setupSelfModifyHandlers],
  ]

  for (const [name, setup] of handlerSetups) {
    try {
      setModuleStatus(name, 'initializing')
      setup()
      setModuleStatus(name, 'ready')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setModuleStatus(name, 'failed', msg)
      logger.error(`[Init] ${name} 初始化失败: ${msg}`)
    }
  }


  // ===== 声纹录入与降噪 IPC =====
  ipcMain.handle('voice:enroll-start', async () => {
    const { openvoiceBridge } = await import('../voice-engine/openvoice-bridge')
    const health = await openvoiceBridge.healthCheck()
    if (!health.pythonAvailable) {
      return { success: false, status: 'unavailable', error: 'Python 运行时未就绪，无法启动声纹录入' }
    }
    await openvoiceBridge.initialize()
    const modelReady = await openvoiceBridge.checkModels()
    return {
      success: true,
      sessionId: `enroll-${Date.now()}`,
      status: modelReady ? 'ready' : 'preparing',
      message: modelReady ? '声纹引擎就绪，可开始录制' : '正在准备声纹模型，请稍候...',
      modelAvailable: modelReady,
    }
  })

  ipcMain.handle('voice:enroll-status', async () => {
    const { openvoiceBridge } = await import('../voice-engine/openvoice-bridge')
    const health = await openvoiceBridge.healthCheck()
    return {
      ready: health.ready,
      pythonAvailable: health.pythonAvailable,
      modelAvailable: health.modelAvailable,
      status: health.ready ? 'idle' : health.pythonAvailable ? 'preparing' : 'unavailable',
      progress: health.ready ? 100 : health.pythonAvailable ? 50 : 0,
      error: health.error || null,
    }
  })

  ipcMain.handle('voice:noise-filter-toggle', async (_event, _config) => {
    const { join } = require('path')
    const { existsSync, readFileSync, writeFileSync } = require('fs')
    const configPath = join(app.getPath('userData'), 'voice-settings.json')
    let settings: Record<string, any> = {}
    if (existsSync(configPath)) {
      try { settings = JSON.parse(readFileSync(configPath, 'utf-8')) } catch { /* ignore */ }
    }
    const enabled: boolean = _config?.enabled ?? !settings.noiseFilterEnabled
    settings.noiseFilterEnabled = enabled
    writeFileSync(configPath, JSON.stringify(settings, null, 2))
    return { enabled }
  })

  ipcMain.handle('voice:noise-level', async () => {
    try {
      const { spawn } = require('child_process')
      const POWERSHELL_EXE = `${process.env['SystemRoot'] || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
      const psCommand = `$devs = @(Get-CimInstance Win32_SoundDevice | Where-Object { $_.Name -match 'Microphone|麦克风|麦克|话筒|mic|input|录制|输入' }); Write-Output ($devs.Count)`
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(POWERSHELL_EXE, ['-NoProfile', '-Command', psCommand], {
          windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        })
        let out = ''
        child.stdout.on('data', (d: Buffer) => { out += d.toString() })
        child.stderr.on('data', () => { /* 忽略 stderr */ })
        child.on('error', reject)
        child.on('close', () => resolve(out))
      })
      const micCount = parseInt(stdout.trim(), 10) || 0
      if (micCount === 0) return { level: 5, db: -48, label: 'quiet', micCount: 0 }
      return { level: 25, db: -32, label: 'normal', micCount }
    } catch {
      return { level: 15, db: -40, label: 'quiet', micCount: 0 }
    }
  })

  // ===== 摄像头追踪 IPC =====
  ipcMain.handle('camera:start', async () => {
    try {
      const { cameraTracker } = await import('../vision/camera-tracker')
      return await cameraTracker.start()
    } catch (e: any) {
      logger.error(`[camera:start] ${e.message}`)
      return false
    }
  })

  ipcMain.handle('camera:stop', async () => {
    try {
      const { cameraTracker } = await import('../vision/camera-tracker')
      await cameraTracker.stop()
      return true
    } catch (e: any) {
      logger.error(`[camera:stop] ${e.message}`)
      return false
    }
  })

  ipcMain.handle('camera:state', async () => {
    try {
      const { cameraTracker } = await import('../vision/camera-tracker')
      return cameraTracker.getState()
    } catch {
      return { status: 'idle', currentGesture: 'idle', gestureConfidence: 0, fps: 0 }
    }
  })

  // ===== 听觉环境感知 IPC（M3 听觉情境） =====
  ipcMain.handle('audio:start', async () => {
    try {
      const { audioSense } = await import('../context/audio-sense')
      return await audioSense.start()
    } catch (e: any) {
      logger.error(`[audio:start] ${e.message}`)
      return false
    }
  })

  ipcMain.handle('audio:stop', async () => {
    try {
      const { audioSense } = await import('../context/audio-sense')
      await audioSense.stop()
      return true
    } catch (e: any) {
      logger.error(`[audio:stop] ${e.message}`)
      return false
    }
  })

  ipcMain.handle('audio:state', async () => {
    try {
      const { audioSense } = await import('../context/audio-sense')
      return audioSense.getState()
    } catch {
      return { status: 'idle', db: -70, level: 'silence', speech: false, music: false, transient: false }
    }
  })

  // ===== 情境感知层 IPC（M 章：感官总线 / 状态推理 / 情境引擎 / 情境融合） =====
  ipcMain.handle('context:start', async () => {
    try {
      const { sensoryBus } = await import('../context/sensory-bus')
      const { stateInference } = await import('../context/state-inference')
      const { contextEngine } = await import('../context/context-engine')
      const { contextFusion } = await import('../context/context-fusion')
      // 启动状态推理（内部订阅感官总线）
      stateInference.start()
      // 启动情境融合（前台窗口 → 技能包联动，P3）
      contextFusion.start()
      // 启动情境引擎（回调：主动提醒交由渲染层展示）
      contextEngine.start((decision) => {
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) {
            try { win.webContents.send('context:attention', decision) } catch { /* pipe broken */ }
          }
        })
      })
      // 注入环境时间信号（零成本常开通道）
      const feedTime = () => {
        const now = new Date()
        sensoryBus.emit({
          channel: 'environment', type: 'time', ts: Date.now(), confidence: 1,
          payload: { hour: now.getHours(), minute: now.getMinutes() },
        })
      }
      feedTime()
      setInterval(feedTime, 60_000)
      return true
    } catch (e: any) {
      logger.error(`[context:start] ${e.message}`)
      return false
    }
  })

  ipcMain.handle('context:snapshot', async () => {
    try {
      const { contextEngine } = await import('../context/context-engine')
      const { stateInference } = await import('../context/state-inference')
      return { contexts: contextEngine.getSnapshot(), states: stateInference.getSnapshot() }
    } catch (e: any) {
      logger.error(`[context:snapshot] ${e.message}`)
      return { contexts: {}, states: {} }
    }
  })

  ipcMain.handle('context:dominant', async () => {
    try {
      const { contextEngine } = await import('../context/context-engine')
      return contextEngine.dominantContext()
    } catch {
      return null
    }
  })

  // 情境融合：当前前台窗口对应的技能包上下文（P3）
  ipcMain.handle('context:fusion', async () => {
    try {
      const { contextFusion } = await import('../context/context-fusion')
      return {
        state: contextFusion.getState(),
        packContext: contextFusion.getCurrentPackContext(),
      }
    } catch (e: any) {
      logger.error(`[context:fusion] ${e.message}`)
      return { state: {}, packContext: '' }
    }
  })

  ipcMain.handle('context:set-proactivity', async (_e, level: string) => {
    try {
      const { contextEngine } = await import('../context/context-engine')
      contextEngine.setProactivity(level as 'quiet' | 'balanced' | 'active')
      return true
    } catch { return false }
  })

  ipcMain.handle('context:set-privacy', async (_e, mode: string) => {
    try {
      const { sensoryBus } = await import('../context/sensory-bus')
      sensoryBus.setPrivacy(mode as 'off' | 'on')
      return true
    } catch { return false }
  })

  ipcMain.handle('context:profile', async () => {
    try {
      const { contextEngine } = await import('../context/context-engine')
      return contextEngine.getProfile()
    } catch { return null }
  })

  // M4 数字健康周报
  ipcMain.handle('context:weekly-report', async () => {
    try {
      const { contextEngine } = await import('../context/context-engine')
      return contextEngine.getWeeklyReport()
    } catch { return null }
  })

  // 应用图标路径（供设置页"关于"展示品牌标识）
  ipcMain.handle('app:get-icon-path', async () => {
    try {
      const iconPath = app.isPackaged
        ? path.join(process.resourcesPath, 'icons', 'icon-256.png')
        : path.join(app.getAppPath(), 'resources', 'icons', 'icon-256.png')
      return iconPath
    } catch (e: any) {
      logger.error(`[app:get-icon-path] ${e.message}`)
      return null
    }
  })

  // M5 指哪问哪：指向感知开关、状态、最近结果（screen semantic anchoring layer）
  ipcMain.handle('context:point-at:set', async (_evt, enabled: boolean) => {
    try {
      const { pointAtEngine } = await import('../context/point-at')
      if (enabled) pointAtEngine.start()
      else pointAtEngine.stop()
      return { ok: true, enabled: pointAtEngine.isRunning() }
    } catch (e: any) {
      logger.error(`[context:point-at:set] ${e.message}`)
      return { ok: false, error: e.message }
    }
  })
  ipcMain.handle('context:point-at:state', async () => {
    try {
      const { pointAtEngine } = await import('../context/point-at')
      return { enabled: pointAtEngine.isRunning(), last: pointAtEngine.getLastResult() }
    } catch { return { enabled: false, last: null } }
  })
  ipcMain.handle('context:point-at:trigger', async () => {
    try {
      const { pointAtEngine } = await import('../context/point-at')
      if (!pointAtEngine.isRunning()) pointAtEngine.start()
      return await pointAtEngine.trigger()
    } catch (e: any) {
      logger.error(`[context:point-at:trigger] ${e.message}`)
      return null
    }
  })

  // ===== 其他模块 IPC 注册 =====
  try { setupVisualAgentHandlers() } catch (e) { logger.warn(`[IPC] visualAgent handlers init: ${e}`) }
  try { setupSkillPackHandlers() } catch (e) { logger.warn(`[IPC] skillPack handlers init: ${e}`) }
  try { loadLearnedSkillPacks() } catch (e) { logger.warn(`[IPC] learned skillPacks load: ${e}`) }
  try { setupPptFlowHandlers() } catch (e) { logger.warn(`[IPC] pptFlow handlers init: ${e}`) }
  try { setupSystemAutomationHandlers() } catch (e) { logger.warn(`[IPC] automation status handlers: ${e}`) }
  try { setupAutomationEngineHandlers() } catch (e) { logger.warn(`[IPC] automation engine handlers: ${e}`) }
  try { setupDesktopAutomationHandlers() } catch (e) { logger.warn(`[IPC] desktopAutomation handlers: ${e}`) }
  try { setupTaskRouterHandlers() } catch (e) { logger.warn(`[IPC] taskRouter handlers: ${e}`) }
  try { setupPersonaLoaderHandlers() } catch (e) { logger.warn(`[IPC] personaLoader handlers: ${e}`) }
  try { setupUIAutomationIPC() } catch (e) { logger.warn(`[IPC] uiAutomation handlers: ${e}`) }
  try { setupAgentHandlers() } catch (e) { logger.warn(`[IPC] agent handlers: ${e}`) }
  try { setupHealthCheckHandlers() } catch (e) { logger.warn(`[IPC] healthCheck handlers: ${e}`) }
  try { options.performanceProfiler?.setupPerfHandlers?.() } catch (e) { logger.warn(`[IPC] perf handlers: ${e}`) }
  try { setupMissingHandlers() } catch (e) { logger.warn(`[IPC] missing handlers: ${e}`) }

  // ===== App 级 IPC =====
  ipcMain.handle('app:ready', () => {
    return {
      ready: _appReadySent,
      modules: getModuleStatus(),
      sacStatus: checkSmartAppControl(),
    }
  })

  ipcMain.handle('app:sac-status', () => {
    return checkSmartAppControl()
  })

  ipcMain.on('app:relaunch', () => {
    writeLog('User requested app relaunch from diagnostic panel')
    app.relaunch()
    app.exit(0)
  })

  // 窗口关闭 IPC
  ipcMain.on('window:close', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (win) win.close()
  })
}
