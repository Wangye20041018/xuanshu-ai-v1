/**
 * 玄枢AI 主进程入口
 *
 * 经模块化拆分后，仅保留启动引导，实际逻辑委托至 register/ 下的各注册模块：
 * - register/window.register.ts   — 窗口创建与崩溃恢复
 * - register/ipc.register.ts      — IPC handler 注册
 * - register/modules.register.ts  — 模块初始化与模型管理
 * - register/lifecycle.register.ts — 应用生命周期、日志、错误处理
 *
 * 入口文件从 1247 行巨石缩减至 < 100 行引导代码。
 *
 * @module index
 */

import { app, protocol } from 'electron'

// 生命周期与工具
import { writeLog, setupGlobalErrorHandlers, setupBeforeQuit, checkSmartAppControl } from './register/lifecycle.register'

// 窗口
import { createWindow } from './register/window.register'

// IPC
import { registerProtocols, setupAllIpcHandlers } from './register/ipc.register'

// 模块
import { initializeAllModules, registerModels, initializeBackground, autoLoadDefaultModel } from './register/modules.register'

// 所有模块实例（保持不变）
import { personaLoader } from './persona-loader'
import { dynamicOperationEngine } from './dynamic-operation'
import { knowledgeGraph } from './knowledge-graph'
import { vectorStore } from './rag/vector-store'
import { voiceEngine } from './voice-engine'
import { externalAIClient } from './external-ai'
import { personalization } from './personalization'
import { mobileChannelEngine } from './mobile-channel'
import { modelRegistry } from './model-registry'
import { modelManager } from './model-manager'
import { visionModel } from './vision'
import { permissionManager } from './permission'
import { pythonRuntime } from './runtime/python'
import { deviceOptimizer } from './device'
import { processGuardian } from './process-guardian'
import { performanceProfiler } from './performance-profiler'
import { container, DI_TOKENS } from './utils/di-container'
import { setupTray } from './tray'
import { getAppConfig } from './ipc/config.ipc'
import { createFloatingBall } from './floating-ball'

/* ==================== 全局错误处理 ==================== */
setupGlobalErrorHandlers()

/* ==================== 显存让渡 ==================== */
// 关闭 Electron GPU 硬件加速，把独显显存尽量让给本地大模型推理（llama.cpp）
app.disableHardwareAcceleration()

/* ==================== 单实例锁 ==================== */
// 防止多开实例同时读写同一份 store/配置/向量库导致数据竞态损坏
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  writeLog('检测到已存在运行实例，退出当前进程')
  app.quit()
} else {
  app.on('second-instance', () => {
    const { BrowserWindow } = require('electron')
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
}

/* ==================== 特权协议注册（必须在 app ready 之前） ==================== */
// local-file 需声明 stream/media 特权，否则 <audio>/<video> 无法播放自定义协议资源
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-file',
    privileges: { standard: false, secure: true, stream: true, supportFetchAPI: false, bypassCSP: false },
  },
])

/* ==================== 应用启动 ==================== */

app.whenReady().then(async () => {
  writeLog('玄枢AI 主进程启动...')

  // 协议注册
  registerProtocols()

  // IPC Handler 注册
  setupAllIpcHandlers({
    modelManager, voiceEngine, externalAIClient,
    dynamicOperationEngine, knowledgeGraph, vectorStore,
    visionModel, personaLoader, mainWindow: null,
    performanceProfiler,
  })

  // 模型注册（必须在 initializeAllModules 之前，否则 startDefaultModels 无模型可用）
  registerModels({ modelManager, writeLog })

  // 系统托盘（悬浮球 / 粒子球开关入口）
  try {
    setupTray()
  } catch (e) {
    writeLog(`Tray setup failed: ${e}`)
  }

  // 模块初始化
  await initializeAllModules({
    mainWindow: null, personaLoader, dynamicOperationEngine, knowledgeGraph,
    vectorStore, voiceEngine, externalAIClient,
    personalization, mobileChannelEngine, modelRegistry, modelManager,
    visionModel, permissionManager, pythonRuntime,
    deviceOptimizer, processGuardian, performanceProfiler,
    writeLog, checkSmartAppControl, createWindow,
  })

  // DI 容器注册核心服务
  container.register(DI_TOKENS.MODEL_MANAGER, { useFactory: () => modelManager, singleton: true })
  container.register(DI_TOKENS.PYTHON_RUNTIME, { useFactory: () => pythonRuntime, singleton: true })
  container.register(DI_TOKENS.DEVICE_OPTIMIZER, { useFactory: () => deviceOptimizer, singleton: true })
  container.register(DI_TOKENS.PROCESS_GUARDIAN, { useFactory: () => processGuardian, singleton: true })
  container.register(DI_TOKENS.VECTOR_STORE, { useFactory: () => vectorStore, singleton: true })
  container.register(DI_TOKENS.VOICE_ENGINE, { useFactory: () => voiceEngine, singleton: true })
  container.register(DI_TOKENS.VISION_MODEL, { useFactory: () => visionModel, singleton: true })
  writeLog(`DI container: 8 services registered`)

  writeLog('Module initialization completed')

  // 后台异步初始化
  Promise.resolve().then(async () => {
    await initializeBackground({
      mainWindow: require('electron').BrowserWindow.getAllWindows()[0] || null,
      permissionManager, pythonRuntime, deviceOptimizer,
      processGuardian, modelManager, writeLog, checkSmartAppControl,
    })
  })

  // 自动加载默认模型
  autoLoadDefaultModel({ modelManager, writeLog })

  // 按配置启动悬浮球 / 粒子球（C 章：设置页开关 + 托盘入口）
  try {
    const cfg = getAppConfig()
    if (cfg?.floatingBallEnabled && cfg?.floatingBallAutoStart) {
      const ball = createFloatingBall()
      ball.show()
      writeLog('悬浮球已按配置启动（语音交互球就绪）')
    }
  } catch (e) {
    writeLog(`Auto-start floating ball failed: ${e}`)
  }

  // 语音唤醒服务已随 §6.1 移除（不做降级）

  // 生命周期
  app.on('activate', function () {
    const { BrowserWindow } = require('electron')
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((fatalError) => {
  const errMsg = fatalError instanceof Error ? fatalError.message : String(fatalError)
  writeLog(`FATAL startup error: ${errMsg}`)
  console.error(`FATAL startup error: ${fatalError}`)
  try {
    const { Notification } = require('electron')
    new Notification({
      title: '玄枢AI 启动异常',
      body: `初始化失败: ${errMsg.slice(0, 100)}`,
      silent: true,
    }).show()
  } catch (e) { console.error(`[Main] fatal notification failed: ${e}`) }
})

/* ==================== 退出清理 ==================== */
setupBeforeQuit({
  pythonRuntime, processGuardian, vectorStore, deviceOptimizer,
  modelManager, mobileChannelEngine, personalization,
  voiceEngine, knowledgeGraph, dynamicOperationEngine, visionModel,
})

/* ==================== 全局 process 监听（由 lifecycle.register.ts 统一注册，此处不再重复） ==================== */

/* ==================== 主窗口引用（M-13 修复：动态导出而非恒为 null） ==================== */

let _mainWindow: Electron.BrowserWindow | null = null

export function setMainWindow(win: Electron.BrowserWindow | null): void {
  _mainWindow = win
}

export function getMainWindow(): Electron.BrowserWindow | null {
  if (_mainWindow && !_mainWindow.isDestroyed()) return _mainWindow
  const { BrowserWindow } = require('electron')
  const wins = BrowserWindow.getAllWindows()
  const win = wins.find((w: Electron.BrowserWindow) => !w.isDestroyed())
  if (win) _mainWindow = win
  return win || null
}
