import { app, Menu, Tray, BrowserWindow, nativeImage } from 'electron'
import * as path from 'path'
import * as fs from 'fs'

import { createLogger } from './utils/logging'
import { createFloatingBall, setupFloatingBallHandlers } from './floating-ball'
const logger = createLogger('Tray')

let tray: Tray | null = null

function resolveIconPath(): string {
  // 开发模式：src/../resources/icons/icon-32.png
  const devPath = path.join(__dirname, '../../resources/icons/icon-32.png')
  // 生产模式：process.resourcesPath/icons/icon-32.png
  const prodPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icons', 'icon-32.png')
    : devPath

  const candidates = [prodPath, devPath, path.join(__dirname, '../resources/icons/icon-32.png')]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch { /* ignore */ }
  }
  return ''
}

/** 创建系统托盘（悬浮球 / 粒子球开关入口） */
export function setupTray(): void {
  if (tray) return

  const iconPath = resolveIconPath()
  let icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  if (!icon.isEmpty() && iconPath.endsWith('.png')) {
    icon = icon.resize({ width: 16, height: 16 })
  }

  try {
    tray = new Tray(icon)
  } catch (e) {
    logger.error(`[Tray] 创建托盘失败: ${e}`)
    return
  }

  tray.setToolTip('玄枢AI')

  const buildMenu = (): Menu => {
    return Menu.buildFromTemplate([
      {
        label: '打开主窗口',
        click: () => {
          const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && !w.getBounds().width) || BrowserWindow.getAllWindows()[0]
          if (win) {
            if (win.isMinimized()) win.restore()
            win.show()
            win.focus()
          }
        },
      },
      { type: 'separator' },
      {
        label: '显示悬浮球',
        click: () => {
          ensureBallHandlers()
          const win = createFloatingBall()
          win.show()
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.quit()
        },
      },
    ])
  }

  tray.setContextMenu(buildMenu())
  tray.on('click', () => {
    // 左键单击打开主窗口
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  logger.info('[Tray] 系统托盘已创建')
}

/** 幂等注册悬浮球/粒子球 IPC handler（避免重复 ipcMain.handle 抛错） */
let ballHandlersRegistered = false
function ensureBallHandlers(): void {
  if (ballHandlersRegistered) return
  try {
    setupFloatingBallHandlers()
    ballHandlersRegistered = true
  } catch (e) {
    logger.error(`[Tray] 注册悬浮球 handler 失败: ${e}`)
  }
}

export { ensureBallHandlers }
