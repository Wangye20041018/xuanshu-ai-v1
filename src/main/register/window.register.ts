/**
 * Window Register — 窗口创建与生命周期管理
 *
 * 从 index.ts 巨石拆分出 createWindow 及相关工具函数。
 * 负责主窗口创建、崩溃恢复、无响应处理等。
 *
 * @module register/window.register
 */

import { BrowserWindow, shell, nativeImage, screen } from 'electron'
import { join } from 'path'
import fs from 'fs'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { createLogger } from '../utils/logging'
import { registerWindow, unregisterWindow } from '../utils/ipc-guard'
import { writeLog } from './lifecycle.register'
import { setMainWindow } from '../index'

const logger = createLogger('Window')

/** 窗口状态持久化：上次退出时的 bounds / 最大化标记 */
interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

function getWindowStatePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

/** 恢复上次窗口状态；损坏或屏幕不可见时回退默认（1400x900 居中） */
function loadWindowState(): WindowState {
  const fallback: WindowState = { width: 1400, height: 900 }
  try {
    const raw = fs.readFileSync(getWindowStatePath(), 'utf-8')
    const parsed = JSON.parse(raw) as WindowState
    if (!parsed || typeof parsed.width !== 'number' || typeof parsed.height !== 'number') return fallback
    const w = Math.max(800, Math.min(parsed.width, 4000))
    const h = Math.max(600, Math.min(parsed.height, 3000))
    const state: WindowState = { width: w, height: h, maximized: !!parsed.maximized }
    // 位置校验：旧显示器分辨率可能更小或显示器已拔出，必须确保窗口落在当前可视区域内
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      const displays = screen.getAllDisplays()
      const visible = displays.some(d => {
        const a = d.workArea
        const margin = 80
        return parsed.x! < a.x + a.width - margin && parsed.x! + w > a.x + margin
          && parsed.y! < a.y + a.height - margin && parsed.y! + h > a.y + margin
      })
      if (visible) {
        state.x = parsed.x
        state.y = parsed.y
      }
    }
    return state
  } catch {
    return fallback
  }
}

/** 保存窗口状态（防抖 300ms，避免 close 前频繁写盘） */
function scheduleSaveWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null
  const save = (): void => {
    if (!win || win.isDestroyed()) return
    try {
      const maximized = win.isMaximized()
      const b = maximized ? win.getNormalBounds() : win.getBounds()
      const state: WindowState = {
        width: b.width,
        height: b.height,
        x: b.x,
        y: b.y,
        maximized,
      }
      fs.mkdirSync(app.getPath('userData'), { recursive: true })
      fs.writeFileSync(getWindowStatePath(), JSON.stringify(state), 'utf-8')
    } catch (e) {
      logger.error(`[Window] 保存窗口状态失败: ${e}`)
    }
  }
  const debounced = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 300)
  }
  win.on('resize', debounced)
  win.on('move', debounced)
  win.on('maximize', debounced)
  win.on('unmaximize', debounced)
  win.on('close', save)
}

export function getAppIcon() {
  try {
    let iconPath: string
    if (is.dev) {
      iconPath = join(__dirname, '../../resources/icons/icon-256.png')
    } else {
      iconPath = join(process.resourcesPath, 'icons/icon-256.png')
    }
    return nativeImage.createFromPath(iconPath)
  } catch (e) {
    logger.error(`Failed to load icon: ${e}`)
    return undefined
  }
}

export function createWindow(): BrowserWindow {
  logger.debug('Creating main window...')

  const state = loadWindowState()

  const mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: 1100,
    minHeight: 700,
    title: '玄枢AI',
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    icon: getAppIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // M-07 修复：启用 Chromium 渲染进程沙箱；preload 仅使用 contextBridge/ipcRenderer，沙箱下可用
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webgl: true,
      experimentalFeatures: true,
    },
  })

  // 上次退出时最大化则恢复最大化
  if (state.maximized) {
    mainWindow.maximize()
  }

  // 窗口位置/大小持久化（resize/move/maximize 防抖 + close 兜底保存）
  scheduleSaveWindowState(mainWindow)

  const timeout = setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible() && !mainWindow.isDestroyed()) {
      writeLog('Force showing window after timeout')
      mainWindow.show()
    }
  }, 1500)

  registerWindow(mainWindow.webContents)
  // M-13 修复：创建窗口后同步主窗口引用，供 voice-engine 等模块发事件
  setMainWindow(mainWindow)
  // M-14 修复：窗口关闭前（webContents 仍存活）注销 IPC 鉴权，
  // 避免在 'closed' 回调中访问已销毁的 webContents 抛
  // "Object has been destroyed" 未捕获异常导致应用崩溃
  mainWindow.on('close', () => {
    try {
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        unregisterWindow(mainWindow.webContents)
      }
    } catch (e) {
      logger.error(`[Window] close 注销失败: ${e}`)
    }
  })
  mainWindow.on('closed', () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        unregisterWindow(mainWindow.webContents)
      }
    } catch (e) {
      logger.error(`[Window] closed 注销失败: ${e}`)
    }
    setMainWindow(null)
  })

  mainWindow.on('ready-to-show', () => {
    logger.debug('Window ready-to-show, displaying window...')
    clearTimeout(timeout)
    mainWindow?.show()
    mainWindow?.focus()
  })

  mainWindow.on('show', () => {
    logger.debug('Window shown')
  })

  const win = mainWindow
  win.webContents.once('did-finish-load', () => {
    logger.debug('Renderer finished loading')
    if (mainWindow && !mainWindow.isVisible()) {
      logger.debug('Window not visible yet, showing now...')
      mainWindow.show()
      mainWindow.focus()
    }
  })

  win.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
    logger.error(`Renderer failed to load: ${errorCode} ${errorDescription}`)
    // 窗口可能在加载失败前已被销毁（如并发退出），直接调用 show() 会抛
    // "Object has been destroyed" 未捕获异常
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
  })

  // 渲染进程崩溃恢复机制（最多 3 次自动重载）
  let crashReloadCount = 0
  const MAX_CRASH_RELOADS = 3

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  win.webContents.on('crashed' as any, (_event: any, _killed: any) => {
    logger.error('Renderer crashed')
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    const reason = details.reason
    writeLog(`Render process gone: reason=${reason}, exitCode=${details.exitCode}`)
    logger.error(`[Window] Render process gone: ${reason}`)

    // 动态导入以避免循环依赖
    try {
      const { abortAllStreamControllers } = require('../ipc/chat.ipc')
      abortAllStreamControllers()
      writeLog('[Window] AbortController Map 已清理（render-process-gone）')
    } catch (e) {
      logger.error(`[Window] AbortController 清理失败: ${e}`)
    }

    if ((reason === 'crashed' || reason === 'oom') && crashReloadCount < MAX_CRASH_RELOADS) {
      crashReloadCount++
      writeLog(`[Window] Reloading renderer (attempt ${crashReloadCount}/${MAX_CRASH_RELOADS})`)
      logger.debug(`[Window] Auto-reloading renderer (${crashReloadCount}/${MAX_CRASH_RELOADS})...`)
      setTimeout(() => {
        if (win && !win.isDestroyed()) {
          if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
            win.loadURL(process.env['ELECTRON_RENDERER_URL'])
          } else {
            const rendererPath = join(__dirname, '../renderer/index.html')
            win.loadFile(rendererPath).catch(err => {
              writeLog(`Reload failed: ${err.message}`)
            })
          }
        }
      }, 1000)
    } else if (crashReloadCount >= MAX_CRASH_RELOADS) {
      writeLog('[Window] Max crash reloads reached, not reloading')
      try {
        const { Notification } = require('electron')
        new Notification({
          title: '玄枢',
          body: '应用界面多次崩溃，请重启应用。',
          silent: false,
        }).show()
      } catch (e) {
        logger.error(`[Window] crash notification failed: ${e}`)
      }
    }
  })

  win.on('unresponsive', () => {
    writeLog('Window unresponsive detected')
    logger.warn('[Window] Window is unresponsive')
    try {
      if (!win.isDestroyed()) {
        win.webContents.executeJavaScript(`document.body.style.cursor = 'wait';`).catch(() => {})
      }
    } catch (e) {
      logger.error(`[Window] unresponsive handler failed: ${e}`)
    }
  })

  win.on('responsive', () => {
    writeLog('Window responsive again')
    logger.debug('[Window] Window is responsive again')
    try {
      if (!win.isDestroyed()) {
        win.webContents.executeJavaScript(`document.body.style.cursor = '';`).catch(() => {})
      }
    } catch (e) {
      logger.error(`[Window] responsive handler failed: ${e}`)
    }
  })

  win.on('closed', () => {
    try {
      win.webContents.removeAllListeners('crashed')
    } catch (e) {
      logger.error(`[Window] removeListener failed: ${e}`)
    }
    crashReloadCount = 0
  })

  mainWindow.webContents.setWindowOpenHandler(details => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    logger.debug(`Loading renderer URL: ${process.env['ELECTRON_RENDERER_URL']}`)
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    const rendererPath = join(__dirname, '../renderer/index.html')
    logger.debug(`Loading renderer file: ${rendererPath}`)
    mainWindow.loadFile(rendererPath).catch(err => {
      logger.error(`Failed to load renderer: ${err}`)
      writeLog(`Failed to load renderer: ${err.message}`)
    })
  }

  return mainWindow
}
