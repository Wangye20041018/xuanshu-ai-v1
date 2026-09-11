﻿/**
 * Lifecycle Register — 应用生命周期管理与工具函数
 *
 * 从 index.ts 巨石拆分出：崩溃处理、日志工具、Smart App Control 检测、
 * NSIS 临时目录清理、before-quit 清理等生命周期管理逻辑。
 *
 * @module register/lifecycle.register
 */

import { app, Notification } from 'electron'
import { existsSync, mkdirSync, appendFileSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { createLogger } from '../utils/logging'
import { sglangProcess, stopSGLang } from '../ipc/sglang.ipc'

const logger = createLogger('App')

/* ==================== 日志工具 ==================== */

let logPath: string | null = null
const LOG_MAX_SIZE = 5 * 1024 * 1024 // 5MB

/** CrashGuard 防递归门闩：处理未捕获异常期间再次触发时直接跳过，
 *  防止 handler 内部 console.error 写断管抛 EPIPE 导致的无限递归死循环 */
let crashHandling = false

export { logger }

export function initLogPath(): string {
  const userDataPath = app.getPath('userData')
  const logDir = join(userDataPath, 'logs')
  if (!existsSync(logDir)) {
    try {
      mkdirSync(logDir, { recursive: true })
    } catch {
      // 权限不足时降级到 userData
      logPath = null
      return userDataPath
    }
  }
  logPath = join(logDir, 'app.log')
  return logDir
}

export function writeLog(message: string) {
  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] ${message}\n`
  if (logPath) {
    try {
      appendFileSync(logPath, line)
      rotateLogs()
    } catch {
      // 写入失败静默忽略
    }
  }
  logger.debug(message)
}

initLogPath()

function rotateLogs() {
  if (!logPath) return
  try {
    const stats = statSync(logPath)
    if (stats.size > LOG_MAX_SIZE) {
      const bak = logPath.replace('.log', `.${Date.now()}.bak`)
      require('fs').renameSync(logPath, bak)
      // 只保留最近 5 份备份，防止 .bak 无限累积
      try {
        const logDir = require('path').dirname(logPath)
        const base = require('path').basename(logPath, '.log')
        const baks = readdirSync(logDir)
          .filter(f => f.startsWith(base + '.') && f.endsWith('.bak'))
          .sort()
        while (baks.length > 5) {
          unlinkSync(join(logDir, baks.shift()!))
        }
      } catch { /* 清理旧备份失败不影响主流程 */ }
    }
  } catch {
    // 轮转失败不影响主流程
  }
}

export function writeCrashLog(message: string) {
  try {
    // 注：app.getPath() 在 app ready 之前会抛错，必须放在 try 内 ——
    // 否则崩溃处理器自身会二次抛出未捕获异常。
    const crashPath = logPath
      ? logPath.replace('.log', '.crash.log')
      : join(app.getPath('userData'), 'crash.log')
    appendFileSync(crashPath, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // 写入失败静默：崩溃日志本身不能再抛错
  }
}

/* ==================== Smart App Control 检测 ==================== */

let sacCache: { enabled: boolean; mode: 'on' | 'evaluation' | 'off' | 'unknown' } | null = null

export function checkSmartAppControl(): { enabled: boolean; mode: 'on' | 'evaluation' | 'off' | 'unknown' } {
  if (sacCache) return sacCache

  try {
    const { execSync } = require('child_process')
    const result = execSync(
      'powershell -NoProfile -Command "try { $val = (Get-ItemProperty -Path \\"HKLM:\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy\\" -Name \\"VerifiedAndReputablePolicyState\\" -ErrorAction Stop).VerifiedAndReputablePolicyState; Write-Output $val } catch { Write-Output \\"unknown\\" }"',
      { timeout: 5000, encoding: 'utf-8' }
    ).trim()

    let mode: 'on' | 'evaluation' | 'off' | 'unknown' = 'unknown'
    if (result === '0') mode = 'off'
    else if (result === '1') mode = 'on'
    else if (result === '2') mode = 'evaluation'

    sacCache = { enabled: mode === 'on' || mode === 'evaluation', mode }
  } catch {
    sacCache = { enabled: false, mode: 'unknown' }
  }
  return sacCache
}

/* ==================== NSIS 临时目录 ==================== */

export function cleanupOldNsisTempDirs() {
  try {
    const tempRoot = process.env['TEMP'] || process.env['TMP'] || ''
    if (!tempRoot) return

    const items = readdirSync(tempRoot)
    const nsisPrefixes = ['nsu', 'nsx', 'nsh', 'nsz', 'nsr', 'nsv', 'nsw', 'nsp', 'nsd', 'nsg']

    let cleaned = 0
    for (const item of items) {
      const isNsis = nsisPrefixes.some(p => item.startsWith(p))
      if (isNsis) {
        const fullPath = join(tempRoot, item)
        try {
          const st = statSync(fullPath)
          const ageHours = (Date.now() - st.mtimeMs) / 3600000
          if (ageHours > 24) {
            if (st.isDirectory()) {
              require('fs').rmSync(fullPath, { recursive: true, force: true })
            } else {
              unlinkSync(fullPath)
            }
            cleaned++
          }
        } catch {
          // 跳过无法清理的
        }
      }
    }
    if (cleaned > 0) writeLog(`NSIS temp cleanup: removed ${cleaned} old dirs`)
  } catch (e) {
    logger.error(`NSIS temp cleanup failed: ${e}`)
  }
}

export function scheduleNsisTempCleanup() {
  try {
    const tempRoot = process.env['TEMP'] || process.env['TMP'] || ''
    if (!tempRoot) return
    const nsisPrefixes = ['nsu', 'nsx', 'nsh', 'nsz', 'nsr', 'nsv', 'nsw', 'nsp', 'nsd', 'nsg']
    const items = readdirSync(tempRoot)
    const now = Date.now()
    let cleaned = 0
    for (const item of items) {
      if (nsisPrefixes.some(p => item.startsWith(p))) {
        const fullPath = join(tempRoot, item)
        try {
          const st = statSync(fullPath)
          if (now - st.mtimeMs < 600000) {
            if (st.isDirectory()) {
              require('fs').rmSync(fullPath, { recursive: true, force: true })
            } else {
              unlinkSync(fullPath)
            }
            cleaned++
          }
        } catch { /* skip */ }
      }
    }
    if (cleaned > 0) writeLog(`Current NSIS temp cleanup: removed ${cleaned} items`)
  } catch (e) {
    logger.error(`Current NSIS temp cleanup failed: ${e}`)
  }
}

/* ==================== 通知辅助 ==================== */

export function sendCrashNotification(title: string, body: string) {
  try {
    // Electron 限制：app ready 前无法创建 Notification，延迟到 ready 后发送
    if (!app.isReady()) {
      app.whenReady().then(() => {
        try {
          new Notification({
            title,
            body: body.slice(0, 100),
            silent: true,
          }).show()
        } catch (e) {
          logger.error(`[CrashGuard] notification failed: ${e}`)
        }
      })
      return
    }
    new Notification({
      title,
      body: body.slice(0, 100),
      silent: true,
    }).show()
  } catch (e) {
    logger.error(`[CrashGuard] notification failed: ${e}`)
  }
}

/* ==================== 模块状态注册表 ==================== */

export interface ModuleStatusMap {
  [name: string]: 'idle' | 'initializing' | 'ready' | 'failed'
}

const moduleStatus: ModuleStatusMap = {}

export function setModuleStatus(name: string, status: 'idle' | 'initializing' | 'ready' | 'failed', error?: string) {
  moduleStatus[name] = status
  if (status === 'failed' && error) {
    writeLog(`Module ${name} failed: ${error}`)
  }
}

export function getModuleStatus() {
  return { ...moduleStatus }
}

export let _appReadySent = false

export function setAppReadySent(value: boolean) {
  _appReadySent = value
}

/* ==================== before-quit 清理 ==================== */

export function setupBeforeQuit(options: {
  pythonRuntime: { stopHeartbeat: () => void }
  processGuardian: { stopAll: () => Promise<void> }
  vectorStore: any
  deviceOptimizer: { stopMonitoring: () => void }
  modelManager: { shutdown: () => void }
  mobileChannelEngine: { stopServer: () => void }
  personalization: { shutdown: () => void }
  voiceEngine: { stopSpeaking: () => void }
  knowledgeGraph: any
  dynamicOperationEngine: any
  visionModel: any
}) {
  const {
    pythonRuntime, processGuardian, vectorStore, deviceOptimizer,
    modelManager, mobileChannelEngine, personalization,
    voiceEngine, knowledgeGraph, dynamicOperationEngine, visionModel,
  } = options

  // P1 修复：防重入。用户连点退出 / 系统关机重复派发 before-quit 时，
  // 避免整套清理被并发执行（重复 flush、重复 kill 子进程）。
  let isQuitting = false

  app.on('before-quit', async (event) => {
    if (isQuitting) {
      // 已在清理流程中：不再 preventDefault，让退出自然继续
      return
    }
    isQuitting = true
    event.preventDefault()
    writeLog('App before-quit: cleaning up resources')

    try { pythonRuntime.stopHeartbeat() } catch (e) { logger.error(`[Main] stopHeartbeat failed: ${e}`) }
    try { await processGuardian.stopAll() } catch (e) { logger.error(`[Main] processGuardian stopAll failed: ${e}`) }

    try {
      logger.debug('[Main] 正在 flush vector store...')
      await (vectorStore as any).flush?.()
      writeLog('[Main] vectorStore flush 完成')
    } catch (e) { logger.error(`[Main] vectorStore flush 失败: ${e}`) }

    try {
      const { abortAllStreamControllers } = require('../ipc/chat.ipc')
      abortAllStreamControllers()
      writeLog('[Main] AbortController Map 已清理（before-quit）')
    } catch (e) { logger.error(`[Main] AbortController 清理失败: ${e}`) }

    // P1 修复：原实现直接在数组字面量里调用各清理函数，任一函数「同步」抛错
    // 会让整个 before-quit 处理器中断 —— 而此时已 preventDefault()，导致应用卡死无法退出。
    // 改为逐个安全调用（同步/异步异常都被捕获），并带上名称便于定位失败项。
    const safeCleanup = (
      label: string,
      fn: () => unknown
    ): Promise<{ label: string; done: boolean }> => {
      try {
        return Promise.resolve(fn())
          .then(() => ({ label, done: true }))
          .catch((e) => {
            logger.error(`[Main] cleanup "${label}" 失败: ${e}`)
            return { label, done: false }
          })
      } catch (e) {
        logger.error(`[Main] cleanup "${label}" 同步抛错: ${e}`)
        return Promise.resolve({ label, done: false })
      }
    }

    const cleanupPromises = [
      safeCleanup('deviceOptimizer.stopMonitoring', () => deviceOptimizer.stopMonitoring()),
      safeCleanup('modelManager.shutdown', () => modelManager.shutdown()),
      safeCleanup('mobileChannelEngine.stopServer', () => mobileChannelEngine.stopServer()),
      safeCleanup('personalization.shutdown', () => personalization.shutdown()),
      safeCleanup('voiceEngine.stopSpeaking', () => voiceEngine.stopSpeaking()),
      safeCleanup('knowledgeGraph.shutdown', () => (knowledgeGraph as any).shutdown?.()),
      safeCleanup('dynamicOperationEngine.shutdown', () => (dynamicOperationEngine as any).shutdown?.()),
      safeCleanup('vectorStore.shutdown', () => (vectorStore as any).shutdown?.()),
      safeCleanup('visionModel.shutdown', () => (visionModel as any).shutdown?.()),
    ]

    try {
      if (typeof stopSGLang === 'function') {
        await Promise.race([stopSGLang(), new Promise(resolve => setTimeout(resolve, 5000))])
      } else if (sglangProcess) {
        sglangProcess.kill()
      }
    } catch (e) { logger.error(`Failed to stop sglang: ${e}`) }

    // 注：SGLang 健康监控的定时器由上面的 stopSGLang() 内部负责清理，
    // 此处无需（也无法）单独访问 —— sglang.ipc 并未导出该定时器。

    // P2-3 修复：提升清理超时到 15s 并记录未完成的任务，防止截断数据库 flush 等关键操作
    const SHUTDOWN_TIMEOUT_MS = 15000

    try {
      const completed = await Promise.race([
        Promise.all(cleanupPromises),
        new Promise<{ label: string; done: boolean }[]>(resolve =>
          setTimeout(resolve, SHUTDOWN_TIMEOUT_MS, [])
        ),
      ])

      if (completed.length === 0) {
        logger.warn('[Main] before-quit cleanup timeout, some tasks may be truncated')
      } else {
        const unfinished = completed.filter(c => !c.done)
        if (unfinished.length > 0) {
          logger.warn(
            `[Main] before-quit cleanup: ${unfinished.length} 个任务未完成 -> ${unfinished.map(u => u.label).join(', ')}`
          )
        }
      }
    } catch (e) { logger.error(`[Main] before-quit cleanup failed: ${e}`) }

    // P1 修复：无论清理阶段发生什么异常，都必须走到 app.exit()，
    // 否则前面的 preventDefault() 会让应用永久卡在「退不出去」的状态。
    try {
      writeLog('App before-quit: cleanup completed')
      scheduleNsisTempCleanup()
    } catch (e) {
      logger.error(`[Main] before-quit 收尾失败: ${e}`)
    } finally {
      app.exit(0)
    }
  })

  app.on('window-all-closed', () => {
    scheduleNsisTempCleanup()
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}

/* ==================== 全局错误处理 ==================== */

/**
 * 崩溃自愈：启动时检测上次运行是否发生异常退出（crash.log 有内容且为近 24h），
 * 记录自愈检查日志，供诊断与用户提示使用。
 */
export function checkPreviousCrash(): void {
  try {
    const crashPath = logPath
      ? logPath.replace('.log', '.crash.log')
      : join(app.getPath('userData'), 'crash.log')
    if (!existsSync(crashPath)) return
    const st = statSync(crashPath)
    if (st.size > 0) {
      const hours = (Date.now() - st.mtimeMs) / 3600000
      if (hours < 24) {
        writeLog(`[CrashSelfHeal] 检测到上次运行发生异常（crash.log ${Math.round(st.size / 1024)}KB，${new Date(st.mtimeMs).toLocaleString()}），本次启动执行自愈检查`)
        sendCrashNotification('玄枢已从上次异常中恢复', `检测到上次运行出现异常，本次已正常启动`)
      }
    }
  } catch {
    // 自愈检测失败不影响主流程
  }
}

export function setupGlobalErrorHandlers() {
  checkPreviousCrash()
  process.on('uncaughtException', (error: Error, origin: string) => {
    // 防递归门闩：handler 执行期间再次触发未捕获异常（如 console.error 写断管抛 EPIPE）直接跳过，
    // 避免无限递归死循环拖死初始化
    if (crashHandling) return
    crashHandling = true
    try {
      const moduleMatch = error.stack?.match(/at\s+\S+\s+\((.+?)[:\\/]src[\\/]main[\\/](.+?)\)/)
      const moduleName = moduleMatch ? moduleMatch[2].replace(/\\/g, '/') : origin || 'unknown'
      const errorMsg = [
        `=== 未捕获异常 ===`,
        `时间: ${new Date().toISOString()}`,
        `模块: ${moduleName}`,
        `错误: ${error.message}`,
        `堆栈:\n${error.stack || '(无堆栈)'}`,
        `================================`,
      ].join('\n')

      logger.error(`[CrashGuard] ${errorMsg}`)
      writeCrashLog(errorMsg)
      sendCrashNotification('玄枢遇到异常，正在尝试恢复', `${moduleName}: ${error.message.slice(0, 80)}`)
    } finally {
      crashHandling = false
    }
  })

  process.on('unhandledRejection', (reason: unknown, _promise: Promise<unknown>) => {
    const reasonStr = reason instanceof Error ? `${reason.message}\n${reason.stack || ''}` : String(reason)
    const moduleMatch = reason instanceof Error
      ? reason.stack?.match(/at\s+\S+\s+\((.+?)[:\\/]src[\\/]main[\\/](.+?)\)/)
      : null
    const moduleName = moduleMatch ? moduleMatch[2].replace(/\\/g, '/') : 'async'

    const errorMsg = [
      `=== 未处理的 Promise 拒绝 ===`,
      `时间: ${new Date().toISOString()}`,
      `模块: ${moduleName}`,
      `原因: ${reasonStr}`,
      `================================`,
    ].join('\n')

    logger.error(`[RejectionGuard] ${errorMsg}`)
    writeCrashLog(errorMsg)
    sendCrashNotification('玄枢遇到异步错误，正在尝试恢复', `${moduleName}: ${reasonStr.slice(0, 80)}`)
  })

  process.on('warning', (warning) => {
    if (warning.name === 'DeprecationWarning' || warning.name === 'ExperimentalWarning') {
      writeLog(`Warning: ${warning.name} - ${warning.message}`)
    }
  })
}
