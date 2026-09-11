﻿﻿/**
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
import { setupOpenExternalHandlers } from '../utils/open-external'
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
import { setupMemoryHandlers } from '../ipc/memory.ipc'
import { setupKnowledgeHandlers } from '../ipc/knowledge.ipc'
import { setupSyncHandlers } from '../ipc/sync.ipc'
import { setupRAGHandlers } from '../rag/index'
import { setupSGLangHandlers } from '../ipc/sglang.ipc'
import { setupVisionHandlers } from '../ipc/vision.ipc'
import { setupSystemControlHandlers } from '../ipc/system-control.ipc'
import { setupPermissionHandlers } from '../permission'
import { setupExternalAIHandlers } from '../external-ai'
import { setupSearchHandlers as setupInternetSearchHandlers } from '../search'
import { setupModelManagerHandlers } from '../model-manager/index'
import { setupSystemMonitorHandlers } from '../ipc/system-monitor.ipc'
import { setupDiagnosticsHandlers } from '../ipc/diagnostics.ipc'
import { setupDynamicOperationHandlers } from '../dynamic-operation'
import { setupDeviceOptimizerHandlers } from '../device'
import { setupInferenceHandlers } from '../ipc/inference.ipc'
import { setupPersonalizationHandlers } from '../personalization'
import { setupKnowledgeGraphHandlers } from '../knowledge-graph'
import { setupMobileChannelHandlers } from '../mobile-channel'
import { setupOllamaHandlers } from '../ipc/ollama.ipc'
import { setupSchedulerHandlers } from '../scheduler/ipc'
import { setupVisionHandlers as setupVisionQueueHandlers } from '../vision/vision-queue'
import { setupPythonHandlers } from '../runtime/python'
import { setupDebateHandlers } from '../ipc/system.ipc'
import { setupTandemHandlers } from '../tandem-manager'
import { setupModelRegistryHandlers } from '../model-registry'
import { setupCloudModelHandlers } from '../cloud-model-manager'
import { setupFloatingBallHandlers } from '../floating-ball'
import { setupFulltextSearchHandlers } from '../fulltext-search'
import { setupHealthCheckHandlers } from '../health-check'
import { setupCloudQuotaHandlers } from '../cloud-quota'
import { setupLocalAiHandlers } from '../local-ai-scanner'
import { setupSystemHandlers } from '../ipc/system.ipc'
import { setupAutomationHandlers as setupSystemAutomationHandlers } from '../ipc/system.ipc'
import { setupAutomationHandlers as setupAutomationEngineHandlers } from '../automation'
import { setupDesktopAutomationHandlers } from '../desktop-automation'
import { setupTaskRouterHandlers } from '../task-router'
import { setupPersonaLoaderHandlers } from '../persona-loader'
import { setupTTSHandlers } from '../ipc/tts.ipc'
import { setupMissingHandlers } from '../ipc/system.ipc'
import { setupUIAutomationIPC } from '../ui-automation'
import { setupUIAHandlers } from '../uia'
import { setupVisualAgentHandlers, setupAgentHandlers } from '../agent'
import { setupPanicHandlers } from '../agent/panic-stop'
import { setupSwarmHandlers } from '../agent/orchestrator'
import { ensurePresetAgents, ensureManifestAgents } from '../agent/preset-agents'
import { setupSkillPackHandlers, loadLearnedSkillPacks } from '../skill-pack'
import { setupAuthorizationHandlers } from '../permission/authorization'
import { setupCommandPolicyHandlers } from '../permission/command-policy'
import { setupSoftwareLibraryHandlers } from '../software-library'
import { setupPptFlowHandlers } from '../ppt-flow'
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
    ['Config', setupConfigHandlers],
    ['LLM', setupLLMHandlers],
    ['Model', setupModelHandlers],
    ['Memory', setupMemoryHandlers],
    ['Knowledge', setupKnowledgeHandlers],
    ['Sync', setupSyncHandlers],
    ['RAG', setupRAGHandlers],
    ['SGLang', setupSGLangHandlers],
    ['Vision', setupVisionHandlers],
    ['SystemControl', setupSystemControlHandlers],
    ['Permission', setupPermissionHandlers],
    ['ExternalAI', setupExternalAIHandlers],
    ['InternetSearch', setupInternetSearchHandlers],
    ['ModelManager', setupModelManagerHandlers],
    ['SystemMonitor', setupSystemMonitorHandlers],
    ['Diagnostics', setupDiagnosticsHandlers],
    ['DynamicOperation', setupDynamicOperationHandlers],
    ['DeviceOptimizer', setupDeviceOptimizerHandlers],
    ['Inference', setupInferenceHandlers],
    ['Personalization', setupPersonalizationHandlers],
    ['KnowledgeGraph', setupKnowledgeGraphHandlers],
    ['MobileChannel', setupMobileChannelHandlers],
    ['Ollama', setupOllamaHandlers],
    ['VisionQueue', setupVisionQueueHandlers],
    ['Python', setupPythonHandlers],
    ['Debate', setupDebateHandlers],
    ['Tandem', setupTandemHandlers],
    ['ModelRegistry', setupModelRegistryHandlers],
    ['CloudModel', setupCloudModelHandlers],
    ['Scheduler', setupSchedulerHandlers],
    ['FloatingBall', setupFloatingBallHandlers],
    ['FulltextSearch', setupFulltextSearchHandlers],
    ['System', setupSystemHandlers],
    ['TTS', setupTTSHandlers],
    ['CloudQuota', setupCloudQuotaHandlers],
    ['LocalAiScanner', setupLocalAiHandlers],
    ['Backup', setupBackupHandlers],
    ['SelfModify', setupSelfModifyHandlers],
    ['Authorization', setupAuthorizationHandlers],
    ['CommandPolicy', setupCommandPolicyHandlers],
    ['SoftwareLibrary', setupSoftwareLibraryHandlers],
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


  // ===== 声纹录入与降噪 IPC 已随 §6.1 移除（语音唤醒/声纹/ASR 不做降级） =====

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
  try { setupUIAHandlers() } catch (e) { logger.warn(`[IPC] uia handlers: ${e}`) }
  try { setupAgentHandlers() } catch (e) { logger.warn(`[IPC] agent handlers: ${e}`) }
  try { setupPanicHandlers() } catch (e) { logger.warn(`[IPC] panic handlers: ${e}`) }
  try { setupSwarmHandlers() } catch (e) { logger.warn(`[IPC] swarm handlers: ${e}`) }
  try { ensurePresetAgents() } catch (e) { logger.warn(`[IPC] preset agents seed: ${e}`) }
  try { ensureManifestAgents() } catch (e) { logger.warn(`[IPC] manifest agents seed: ${e}`) }
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

  // ===== 外部浏览器打开（内置浏览器移除后的联网入口） =====
  try { setupOpenExternalHandlers() } catch (e) { logger.warn(`[IPC] open-external handlers: ${e}`) }
}
