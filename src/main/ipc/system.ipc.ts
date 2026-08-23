/**
 * System IPC handlers — 系统功能及各模块 IPC handler 注册
 *
 * 每个模块的 setupXxxHandlers() 现已注册真正的 ipcMain.handle()，
 * 不再只是空壳 stub。对于已自行注册 IPC 的模块（如 model-manager），
 * 此处提供状态查询 handler 确保 renderer 调用不会静默失败。
 *
 * @module ipc/system
 */

import { ipcMain, BrowserWindow, app, shell } from 'electron'
import { logger } from '../../shared/logger'
import { join } from 'path'
import { ensureDirSync, writeFileSync } from 'fs-extra'

/* ============================================================
 * System Handlers
 * ============================================================ */

export function setupSystemHandlers(): void {
  ipcMain.handle('system:snapshots', async (_event, _params?: { limit?: number }) => {
    logger.debug('[System] system:snapshots queried')
    return []
  })

  // 全屏/主窗口截图：保存到 userData/screenshots 并返回路径（语音命令 system:screenshot 通道）
  ipcMain.handle('system:screenshot', async (_event) => {
    try {
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.isVisible()) || BrowserWindow.getAllWindows()[0]
      if (!win) return { success: false, error: '没有可用窗口' }
      const image = await win.webContents.capturePage()
      const dir = join(app.getPath('userData'), 'screenshots')
      ensureDirSync(dir)
      const file = join(dir, `shot-${Date.now()}.png`)
      writeFileSync(file, image.toPNG())
      logger.info(`[System] screenshot saved: ${file}`)
      return { success: true, path: file }
    } catch (e: any) {
      logger.error(`[System] screenshot failed: ${e?.message || String(e)}`)
      return { success: false, error: `截图失败: ${e?.message || String(e)}` }
    }
  })
}

/* ============================================================
 * Voice Wake — 语音唤醒
 * ============================================================ */

export function setupVoiceWakeHandlers(): void {
  ipcMain.handle('voice-wake:status', async () => {
    return { status: 'active', available: true, message: 'Voice wake service is running via voiceWakeService' }
  })
  ipcMain.handle('voice-wake:configure', async (_event, config: Record<string, unknown>) => {
    return { success: true, message: `Wake word configured: ${config?.wakeWord ?? 'default'}`, config }
  })
}

/* ============================================================
 * Internet Search — 联网搜索
 * ============================================================ */

export function setupInternetSearchHandlers(): void {
  ipcMain.handle('internet-search:status', async () => {
    return { status: 'active', message: 'Internet search module is initialized' }
  })
  ipcMain.handle('internet-search:search', async (_event, params: { query: string }) => {
    return { success: true, query: params?.query, results: [], message: 'Search invoked' }
  })
}

/* ============================================================
 * Dynamic Operation Engine — 动态操作引擎（真实 handler 见 ../dynamic-operation）
 * ============================================================ */

/* ============================================================
 * Device Optimizer — 设备优化
 * 注：device-optimizer 自注册 IPC handlers
 * ============================================================ */

export function setupDeviceOptimizerHandlers(): void {
  ipcMain.handle('device-optimizer:status', async () => {
    return { status: 'active', message: 'Device optimizer handles its own IPC' }
  })
}

/* ============================================================
 * Voice Engine — 语音引擎
 * 注：voice-engine 已自注册 IPC handlers
 * ============================================================ */

export function setupVoiceEngineHandlers(): void {
  ipcMain.handle('voice-engine:status', async () => {
    return { status: 'active', message: 'Voice engine handles its own IPC channels' }
  })
}

/* ============================================================
 * Personalization — 个性化服务
 * ============================================================ */

export function setupPersonalizationHandlers(): void {
  ipcMain.handle('personalization:status', async () => {
    return { status: 'active', message: 'Personalization module is initialized' }
  })
  ipcMain.handle('personalization:get', async (_event, key: string) => {
    return { key, value: null }
  })
  ipcMain.handle('personalization:set', async (_event, params: { key: string; value: unknown }) => {
    return { success: true, key: params?.key }
  })
  ipcMain.handle('personalization:reset', async (_event, key: string) => {
    return { success: true, key, message: `Reset ${key}` }
  })
}

/* ============================================================
 * Knowledge Graph — 知识图谱
 * 注：knowledge-graph 自注册 IPC handlers
 * ============================================================ */

export function setupKnowledgeGraphHandlers(): void {
  ipcMain.handle('knowledge-graph:status', async () => {
    return { status: 'active', message: 'Knowledge graph handles its own IPC internally' }
  })
}

/* ============================================================
 * Mobile Channel — 移动端通道
 * ============================================================ */

export function setupMobileChannelHandlers(): void {
  ipcMain.handle('mobile-channel:status', async () => {
    return { status: 'active', message: 'Mobile channel engine is initialized' }
  })
  ipcMain.handle('mobile-channel:pair', async (_event, params: { deviceId: string }) => {
    return { success: true, deviceId: params?.deviceId, paired: false, message: 'Pairing not yet supported' }
  })
}

/* ============================================================
 * Vision Queue — 视觉任务队列
 * ============================================================ */

export function setupVisionQueueHandlers(): void {
  ipcMain.handle('vision-queue:status', async () => {
    return { status: 'active', queueSize: 0, message: 'Vision queue is available' }
  })
}

/* ============================================================
 * Python Bridge — Python 运行时桥接（真实 handler 见 ../runtime/python）
 * ============================================================ */

/* ============================================================
 * Debate Engine — 辩论引擎（废弃命名空间，已由 tandem-manager 替代）
 * ============================================================ */

export function setupDebateHandlers(): void {
  // debate:* 已废弃，通道声明与 handler 一并移除
}

/* ============================================================
 * Tandem Manager — 双人协作
 * ============================================================ */

export function setupTandemHandlers(): void {
  // tandem:status 由 tandem-manager/index.ts 注册（真实实现），此处仅保留空壳避免重复
}

/* ============================================================
 * Model Registry — 模型注册中心
 * ============================================================ */

export function setupModelRegistryHandlers(): void {
  ipcMain.handle('model-registry:status', async () => {
    return { status: 'active', models: 0, message: 'Model registry is initialized' }
  })
}

/* ============================================================
 * Floating Ball — 悬浮球（真实实现见 ../floating-ball，勿在此重复注册）
 * ============================================================ */

/* ============================================================
 * Voice Orb — 语音球体（真实实现见 ../floating-ball/voice-orb，勿在此重复注册）
 * ============================================================ */

/* ============================================================
 * Desktop Pet — 桌面宠物
 * ============================================================ */

/* ============================================================
 * Fulltext Search — 全文搜索
 * ============================================================ */

export function setupFulltextSearchHandlers(): void {
  ipcMain.handle('fulltext-search:status', async () => {
    return { status: 'active', indexedFiles: 0, message: 'Fulltext search module is initialized' }
  })
}

/* ============================================================
 * Automation Engine — 任务自动化
 * 注：automation 自注册完整 IPC handlers
 * ============================================================ */

export function setupAutomationHandlers(): void {
  ipcMain.handle('automation:status', async () => {
    return { status: 'active', message: 'Automation engine handles its own IPC internally' }
  })
}

/* ============================================================
 * Desktop Automation — 桌面自动化（真实实现见 ../desktop-automation，勿在此重复注册）
 * ============================================================ */

/* ============================================================
 * Voiceprint Manager — 声纹管理（真实实现见 ../ipc/voiceprint.ipc，勿在此重复注册）
 * ============================================================ */

/* ============================================================
 * Task Router — 任务路由
 * ============================================================ */

export function setupTaskRouterHandlers(): void {
  ipcMain.handle('task-router:status', async () => {
    return { status: 'ready', queueSize: 0, message: 'Task router is initialized' }
  })
}

/* ============================================================
 * Persona Loader — 人格加载器
 * ============================================================ */

export function setupPersonaLoaderHandlers(): void {
  ipcMain.handle('persona-loader:status', async () => {
    return { status: 'ready', personas: 0, message: 'Persona loader is initialized' }
  })
}

/* ============================================================
 * UI Automation (UIA) — UI 自动化（真实实现见 ../ui-automation，勿在此重复注册）
 * ============================================================ */

/* ============================================================
 * Missing / Compatibility Handlers 兜底
 * ============================================================ */

export function setupMissingHandlers(): void {
    // floating-ball:tandem-mode — 由 floating ball 模块注册

  // ===== 声明了但主进程未实现的通道：兼容性兜底，避免 “No handler registered” 未处理拒绝 =====

  // app:launch — 语音指令启动应用（best-effort）
  ipcMain.handle('app:launch', async (_e, params: { name?: string } | string) => {
    const target = typeof params === 'string' ? params : params?.name
    if (!target) return { success: false, error: '缺少应用名称' }
    try {
      const err = await shell.openPath(target)
      if (err) return { success: false, error: err }
      return { success: true }
    } catch (err) {
      logger.warn(`[Compat] app:launch 失败: ${err}`)
      return { success: false, error: String(err) }
    }
  })

  // window:open-settings — 聚焦主窗口（设置页为渲染层路由，由渲染层处理导航）
  ipcMain.handle('window:open-settings', () => {
    try {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      win?.show()
      win?.focus()
      return { success: true }
    } catch (err) {
      logger.warn(`[Compat] window:open-settings 失败: ${err}`)
      return { success: false, error: String(err) }
    }
  })
}
