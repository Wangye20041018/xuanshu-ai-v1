﻿/**
 * 悬浮球 + 字幕浮层
 * 3D 粒子球体（Three.js）+ 语音识别字幕
 */
import { app, BrowserWindow, screen, ipcMain } from 'electron'
import { join } from 'path'
import { POWERSHELL_EXE } from '../utils/powershell'
import { registerWindow, unregisterWindow } from '../utils/ipc-guard'

let floatingWindow: BrowserWindow | null = null
let subtitleWindow: BrowserWindow | null = null
let subtitleTimer: ReturnType<typeof setTimeout> | null = null
const SUBTITLE_FADE_MS = 5000

// ---- 贴边吸附状态 ----
const BALL_SIZE = 190
const SNAP_EDGE_VISIBLE = 20 // 吸附后露出的边缘宽度(px)
let snapped = false // 当前是否处于贴边半隐藏状态

/** 判定并执行贴边半隐藏（仅左右/上边缘，下边缘不吸附避免遮挡任务栏） */
function snapToEdge(): void {
  const ball = floatingWindow
  if (!ball || ball.isDestroyed()) return
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const b = ball.getBounds()
  const hidden = BALL_SIZE - SNAP_EDGE_VISIBLE
  if (b.x <= workArea.x + 4) {
    ball.setBounds({ x: workArea.x - hidden, y: b.y, width: b.width, height: b.height })
    snapped = true
  } else if (b.x + b.width >= workArea.x + workArea.width - 4) {
    ball.setBounds({ x: workArea.x + workArea.width - SNAP_EDGE_VISIBLE, y: b.y, width: b.width, height: b.height })
    snapped = true
  } else if (b.y <= workArea.y + 4) {
    ball.setBounds({ x: b.x, y: workArea.y - hidden, width: b.width, height: b.height })
    snapped = true
  } else {
    snapped = false
  }
}

/** 取消贴边半隐藏，恢复完整显示 */
function unsnap(): void {
  const ball = floatingWindow
  if (!ball || ball.isDestroyed() || !snapped) return
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const b = ball.getBounds()
  if (b.x <= workArea.x - BALL_SIZE / 2) {
    ball.setBounds({ x: workArea.x, y: b.y, width: b.width, height: b.height })
  } else if (b.x >= workArea.x + workArea.width - SNAP_EDGE_VISIBLE) {
    ball.setBounds({ x: workArea.x + workArea.width - BALL_SIZE, y: b.y, width: b.width, height: b.height })
  } else if (b.y <= workArea.y - BALL_SIZE / 2) {
    ball.setBounds({ x: b.x, y: workArea.y, width: b.width, height: b.height })
  }
  snapped = false
}

function createFloatingBall(): BrowserWindow {
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize
  const ballSize = 190
  const margin = 16

  floatingWindow = new BrowserWindow({
    width: ballSize,
    height: ballSize,
    x: sw - ballSize - margin,
    y: 200,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, '../preload/index.js')
    }
  })

  floatingWindow.setIgnoreMouseEvents(false)
  floatingWindow.setVisibleOnAllWorkspaces(true)
  registerWindow(floatingWindow.webContents)
  // M-14 对齐修复：closed 事件触发时 webContents 已被销毁，
  // 直接访问 floatingWindow.webContents 会抛 "Object has been destroyed"
  // 未捕获异常导致主进程崩溃（crash.log 中多次出现该堆栈模式）。
  // 与主窗口 window.register 保持一致：先判存活 + try/catch 兜底。
  floatingWindow.on('closed', () => {
    try {
      if (floatingWindow && !floatingWindow.isDestroyed() && !floatingWindow.webContents.isDestroyed()) {
        unregisterWindow(floatingWindow.webContents)
      }
    } catch (e) {
      logger.error(`[FloatingBall] closed 注销窗口失败: ${e}`)
    }
  })

  // 加载独立 HTML 文件（从 resources 目录），替代内联 HTML 便于维护
  const htmlPath = app.isPackaged
    ? join(process.resourcesPath, 'floating-ball.html')
    : join(__dirname, '../../resources/floating-ball.html')
  const { existsSync } = require('fs')
  if (existsSync(htmlPath)) {
    floatingWindow.loadFile(htmlPath)
  } else {
    // 回退：内联 HTML（生产环境中 resources 目录始终存在）
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{width:56px;height:56px;border-radius:50%;background:rgba(13,17,23,0.85);display:flex;align-items:center;justify-content:center;cursor:pointer;border:1.5px solid rgba(37,99,235,0.5);-webkit-app-region:drag;transition:all 0.3s}
    body:hover{background:rgba(37,99,235,0.2);border-color:rgba(37,99,235,0.8);box-shadow:0 0 20px rgba(37,99,235,0.3);transform:scale(1.08)}
    body:active{transform:scale(0.95)}
    svg{width:28px;height:28px;-webkit-app-region:no-drag}
  </style></head><body>
    <svg viewBox="0 0 24 24" fill="none" stroke="rgba(37,99,235,0.85)" stroke-width="2">
      <circle cx="12" cy="12" r="10"/>
      <path d="M12 2a10 10 0 0 1 0 20" stroke="rgba(255,255,255,0.35)"/>
      <circle cx="12" cy="5" r="1.8" fill="rgba(255,255,255,0.6)"/>
      <circle cx="12" cy="19" r="1.8" fill="rgba(37,99,235,0.6)"/>
    </svg>
    <script>
      let clickTimer = null

      document.body.addEventListener('click', (e) => {
        if (clickTimer) {
          clearTimeout(clickTimer)
          clickTimer = null
          window.api.invoke('floating-ball:show-panel')
        } else {
          clickTimer = setTimeout(() => {
            window.api.invoke('floating-ball:open-main')
            clickTimer = null
          }, 300)
        }
      })
    </script>
  </body></html>`
    floatingWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  }
  return floatingWindow
}

/**
 * 字幕浮层窗口
 * 半透明深色背景 + 白色文字，逐句显示语音识别结果
 */
function getSubtitleWindow(): BrowserWindow {
  if (!subtitleWindow || subtitleWindow.isDestroyed()) {
    if (!floatingWindow || floatingWindow.isDestroyed()) return null!

    const ballBounds = floatingWindow.getBounds()
    const sw = ballBounds.width
    const sh = 64

    subtitleWindow = new BrowserWindow({
      width: sw + 80,
      height: sh,
      x: ballBounds.x - 40,
      y: ballBounds.y + ballBounds.height + 12,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      hasShadow: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: join(__dirname, '../preload/index.js')
      }
    })

    // 初始空白内容
    subtitleWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(getSubtitleHTML(''))}`)
  }
  return subtitleWindow
}

function getSubtitleHTML(text: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{
      display:flex;align-items:center;justify-content:center;
      width:100%;height:100%;
      background:transparent;
      font-family:"PingFang SC","Microsoft YaHei",sans-serif;
      -webkit-app-region:drag;
    }
    .subtitle{
      max-width:90%;padding:8px 18px;
      background:rgba(13,17,23,0.82);
      border:1px solid rgba(99,102,241,0.25);
      border-radius:14px;
      color:#e4e6ed;
      font-size:14px;
      line-height:1.5;
      text-align:center;
      backdrop-filter:blur(10px);
      transition:opacity 0.4s;
      opacity:${text ? '1' : '0'};
    }
  </style></head><body>
    <div class="subtitle">${escapeHtml(text)}</div>
  </body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function showSubtitle(text: string): void {
  if (!text || text.trim().length === 0) return

  const sw = getSubtitleWindow()
  if (!sw) return

  // 更新位置（跟随悬浮球）
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    const ballBounds = floatingWindow.getBounds()
    sw.setBounds({
      x: ballBounds.x - 40,
      y: ballBounds.y + ballBounds.height + 12,
      width: sw.getBounds().width,
      height: sw.getBounds().height
    })
  }

  sw.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(getSubtitleHTML(text))}`)
  sw.showInactive()

  // 5 秒无新文本后渐隐
  if (subtitleTimer) clearTimeout(subtitleTimer)
  subtitleTimer = setTimeout(() => {
    hideSubtitle()
  }, SUBTITLE_FADE_MS)
}

function hideSubtitle(): void {
  if (subtitleTimer) {
    clearTimeout(subtitleTimer)
    subtitleTimer = null
  }
  if (subtitleWindow && !subtitleWindow.isDestroyed()) {
    // 先加载空内容触发 opacity 过渡，再隐藏
    subtitleWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(getSubtitleHTML(''))}`)
    setTimeout(() => {
      if (subtitleWindow && !subtitleWindow.isDestroyed()) {
        subtitleWindow.hide()
      }
    }, 400)
  }
}

export function setupFloatingBallHandlers(): void {
  ipcMain.handle('floating-ball:open', () => {
    try {
      if (!floatingWindow || floatingWindow.isDestroyed()) {
        floatingWindow = createFloatingBall()
      }
      floatingWindow?.show()
      return true
    } catch (e) { logger.error('[FloatingBall] 悬浮球操作失败:', e); return false }
  })

  ipcMain.handle('floating-ball:hide', () => {
    try {
      floatingWindow?.hide()
      return true
    } catch (e) { logger.error('[FloatingBall] 悬浮球操作失败:', e); return false }
  })

  ipcMain.handle('floating-ball:toggle', () => {
    try {
      if (!floatingWindow || floatingWindow.isDestroyed()) {
        floatingWindow = createFloatingBall()
      }
      if (floatingWindow.isVisible()) {
        floatingWindow.hide()
      } else {
        floatingWindow.show()
      }
      return true
    } catch (e) { logger.error('[FloatingBall] 悬浮球操作失败:', e); return false }
  })

  ipcMain.handle('floating-ball:show-panel', () => {
    try {
      // 展开快捷操作面板
      const ball = floatingWindow
      if (!ball || ball.isDestroyed()) return false

      const quickWin = new BrowserWindow({
        width: 240,
        height: 360,
        x: ball.getBounds().x - 240 + 80,
        y: ball.getBounds().y - 360,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, preload: join(__dirname, '../preload/index.js') }
      })

    const panelHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      *{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI','Microsoft YaHei',sans-serif}
      body{width:240px;background:rgba(20,22,30,0.95);border-radius:16px;border:1px solid rgba(255,255,255,0.1);padding:10px;color:#e4e6ed}
      .item{padding:10px 12px;border-radius:10px;cursor:pointer;display:flex;align-items:center;gap:10px;font-size:13px;transition:background 0.2s}
      .item:hover{background:rgba(255,255,255,0.08)}
      .item:active{background:rgba(255,255,255,0.12)}
      .icon{width:20px;text-align:center;font-size:15px}
    </style></head><body>
      <div class="item" onclick="window.api.invoke('floating-ball:action','screenshot-question')"><span class="icon">📸</span>截图问AI</div>
      <div class="item" onclick="window.api.invoke('floating-ball:action','clipboard-history')"><span class="icon">📋</span>剪贴板历史</div>
      <div class="item" onclick="window.api.invoke('floating-ball:action','voice-note')"><span class="icon">🎤</span>语音速记</div>
      <div class="item" onclick="window.api.invoke('floating-ball:action','quick-note')"><span class="icon">📝</span>闪念笔记</div>
      <div class="item" onclick="window.api.invoke('floating-ball:action','ocr')"><span class="icon">🔤</span>OCR取字</div>
      <div class="item" onclick="window.api.invoke('floating-ball:action','translate')"><span class="icon">🌐</span>翻译选中文字</div>
      <div class="item" onclick="window.api.invoke('floating-ball:action','add-reminder')"><span class="icon">📅</span>添加提醒</div>
      <hr style="border:0.5px solid rgba(255,255,255,0.08);margin:6px 0">
      <div class="item" onclick="window.api.invoke('floating-ball:open-main').then(()=>window.close())"><span class="icon">🖥️</span>打开主窗口</div>
    </body></html>`

    quickWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(panelHtml)}`)
    let closeTimer: ReturnType<typeof setTimeout> | null = null
    closeTimer = setTimeout(() => { quickWin.close(); closeTimer = null }, 30000) // 30秒自动关闭
    quickWin.on('focus', () => { if(closeTimer) { clearTimeout(closeTimer); closeTimer = null } }) // 聚焦取消
    quickWin.on('blur', () => { closeTimer = setTimeout(() => { quickWin.close(); closeTimer = null }, 30000) }) // 失焦重启倒计时
    quickWin.on('closed', () => { if(closeTimer) { clearTimeout(closeTimer); closeTimer = null } })
    return true
    } catch (e) { logger.error('[FloatingBall] 悬浮球操作失败:', e); return false }
  })

  ipcMain.handle('floating-ball:open-main', () => {
    try {
      const wins = BrowserWindow.getAllWindows()
      const mainWin = wins.find((w: any) => !w.isDestroyed() && w.getTitle().includes('玄枢'))
      if (mainWin) { mainWin.show(); mainWin.focus() }
      return true
    } catch (e) { logger.error('[FloatingBall] 悬浮球操作失败:', e); return false }
  })

  // 快捷操作真实实现
  ipcMain.handle('floating-ball:action', async (_e, action: string) => {
    try {
      switch (action) {
      case 'screenshot-question': {
        // 截图后发送到视觉模型分析
        const shot = await screenObserver.captureFullScreen()
        if (shot) {
          const wins = BrowserWindow.getAllWindows()
          const mainWin = wins.find((w: any) => !w.isDestroyed() && w.getTitle().includes('玄枢'))
          if (mainWin) try { mainWin.webContents.send('floating-ball:screenshot-ready', shot.base64) } catch { /* pipe broken */ }
        }
        return true
      }
      case 'clipboard-history': {
        try {
          // M-23 修复：execSync 阻塞主进程事件循环，改用 promisify(exec) 异步执行
          const { exec } = require('child_process')
          const { promisify } = require('util')
          const execAsync = promisify(exec)
          const { stdout } = await execAsync(`"${POWERSHELL_EXE}" -Command "Get-Clipboard"`, { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 })
          return stdout.trim()
        } catch (e) { logger.error('[FloatingBall] 读取剪贴板失败:', e); return '' }
      }
      case 'voice-note': {
        // 触发主窗口进入语音速记模式
        const wins = BrowserWindow.getAllWindows()
        const mainWin = wins.find((w: any) => !w.isDestroyed() && w.getTitle().includes('玄枢'))
        if (mainWin) try { mainWin.webContents.send('floating-ball:start-voice-note') } catch { /* pipe broken */ }
        return true
      }
      case 'quick-note': {
        const wins = BrowserWindow.getAllWindows()
        const mainWin = wins.find((w: any) => !w.isDestroyed() && w.getTitle().includes('玄枢'))
        if (mainWin) try { mainWin.webContents.send('floating-ball:start-quick-note') } catch { /* pipe broken */ }
        return true
      }
      case 'ocr': {
        const shot = await screenObserver.captureFullScreen()
        if (shot) {
          const wins = BrowserWindow.getAllWindows()
          const mainWin = wins.find((w: any) => !w.isDestroyed() && w.getTitle().includes('玄枢'))
          if (mainWin) try { mainWin.webContents.send('floating-ball:ocr-result', shot.base64) } catch { /* pipe broken */ }
        }
        return true
      }
      case 'translate': {
        try {
          const { execSync } = require('child_process')
          const text = execSync(`"${POWERSHELL_EXE}" -Command "Get-Clipboard"`, { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 }).trim()
          if (text) {
            const wins = BrowserWindow.getAllWindows()
            const mainWin = wins.find((w: any) => !w.isDestroyed() && w.getTitle().includes('玄枢'))
            if (mainWin) try { mainWin.webContents.send('floating-ball:translate', text) } catch { /* pipe broken */ }
          }
        } catch (e) { logger.error('[FloatingBall] 翻译操作失败:', e) }
        return true
      }
      case 'add-reminder': {
        const wins = BrowserWindow.getAllWindows()
        const mainWin = wins.find((w: any) => !w.isDestroyed() && w.getTitle().includes('玄枢'))
        if (mainWin) try { mainWin.webContents.send('floating-ball:add-reminder') } catch { /* pipe broken */ }
        return true
      }
      default: return false
      }
    } catch (e) { logger.error('[FloatingBall] 悬浮球操作失败:', e); return false }
  })

  // ---- 字幕浮层 IPC ----
  ipcMain.on('floating-ball:show-subtitle', (_event, text: string) => {
    try {
      showSubtitle(text)
    } catch (e) { logger.error('[FloatingBall] 字幕显示失败:', e) }
  })

  ipcMain.on('floating-ball:hide-subtitle', () => {
    try {
      hideSubtitle()
    } catch (e) { logger.error('[FloatingBall] 字幕隐藏失败:', e) }
  })

  // ---- 唤醒状态通知（来自 wake 服务） ----
  // 注意：此 IPC 由 wake/index.ts 通过 BrowserWindow.webContents.send 发出，
  // 需要 preload 暴露对应的 on 监听，此处仅记录状态
  ipcMain.handle('floating-ball:get-state', () => {
    try {
      // 返回当前字幕是否可见
      return {
        subtitleVisible: subtitleWindow !== null && !subtitleWindow.isDestroyed() && subtitleWindow.isVisible()
      }
    } catch (e) { return { subtitleVisible: false } }
  })

  // ---- 贴边吸附（拖动结束调用；贴近屏幕边缘则半隐藏） ----
  ipcMain.handle('floating-ball:snap-check', () => {
    try { snapToEdge(); return { snapped } } catch (e) { return { snapped: false } }
  })

  // ---- 取消吸附（鼠标悬停/悬停交互时恢复完整显示） ----
  ipcMain.handle('floating-ball:unhide', () => {
    try { unsnap(); return { snapped: false } } catch (e) { return { snapped: false } }
  })
}

export { createFloatingBall }

/** 获取悬浮球窗口实例（供语音面板模块做状态联动） */
export function getFloatingWindow(): BrowserWindow | null {
  return floatingWindow && !floatingWindow.isDestroyed() ? floatingWindow : null
}

/**
 * 驱动悬浮球状态（idle/listening/speaking/thinking）
 */
export function setFloatingBallState(state: 'idle' | 'listening' | 'speaking' | 'thinking'): void {
  if (floatingWindow && !floatingWindow.isDestroyed() && !floatingWindow.webContents.isDestroyed()) {
    try { floatingWindow.webContents.send('floating-ball:set-state', state) } catch { /* 非关键 */ }
  }
}
import { logger } from '../../shared/logger'
import { screenObserver } from '../visual-agent'
