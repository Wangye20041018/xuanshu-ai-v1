/**
 * S4 修复：IPC 调用来源鉴权
 * ===================================
 * 验证 IPC 消息是否来自合法的渲染进程窗口，
 * 防止恶意 WebView / iframe / 第三方脚本利用 IPC 通道。
 */

import { IpcMainInvokeEvent, WebContents } from 'electron'
import { logger } from '../../shared/logger'

/** 已知的主窗口 WebContents ID 集合 */
const knownWindows = new Set<number>()

/**
 * 注册一个合法的窗口。应在 BrowserWindow 创建后调用。
 */
export function registerWindow(wc: WebContents): void {
  knownWindows.add(wc.id)
  logger.debug(`[IPCAuth] 注册窗口: id=${wc.id}`)
}

/**
 * 注销窗口（窗口关闭时调用）
 * M-14 修复：调用方可能在 'closed' 事件中传入已销毁的 WebContents，
 * 访问其 id 会抛 "Object has been destroyed"，这里统一做存活保护。
 */
export function unregisterWindow(wc: WebContents): void {
  try {
    if (!wc || wc.isDestroyed()) return
    knownWindows.delete(wc.id)
    logger.debug(`[IPCAuth] 注销窗口: id=${wc.id}`)
  } catch {
    // 窗口已销毁，忽略（注销失败不影响功能）
  }
}

/**
 * 校验单个 sender 是否属于已注册的合法窗口且未被销毁。
 * 供 validateSender（invoke）与 validateSenderEvent（on）共用。
 */
export function isTrustedSender(sender: WebContents | null | undefined): boolean {
  if (!sender || sender.isDestroyed()) {
    logger.warn(`[IPCAuth] 拒绝：sender 无效或已销毁`)
    return false
  }
  if (!knownWindows.has(sender.id)) {
    logger.warn(
      `[IPCAuth] 拒绝：未知窗口 id=${sender.id} url=${sender.getURL()?.substring(0, 80)}`
    )
    return false
  }
  return true
}

/**
 * 验证 IPC invoke 事件的发送者是否来自已知的合法窗口。
 * 同时验证 event.sender 不为空且未被销毁。
 *
 * @param event IPC 事件对象
 * @returns true 表示合法来源，false 表示非法
 */
export function validateSender(event: IpcMainInvokeEvent): boolean {
  if (!isTrustedSender(event.sender)) {
    return false
  }

  // WebView / iframe 中的子 frame 不应直接 invoke
  if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) {
    // 允许非主 frame（如 iframe 来自同源），但记录日志
    const frameUrl = event.senderFrame?.url || 'unknown'
    if (!frameUrl.startsWith('file://') && !frameUrl.startsWith('app://')) {
      logger.warn(
        `[IPCAuth] 拒绝：非本地来源的子 frame url=${frameUrl.substring(0, 80)} channel=${(event as any).channel}`
      )
      return false
    }
  }

  return true
}

/**
 * 验证 IPC on（send/once）事件的发送者是否来自已知的合法窗口。
 * 用于包装 ipcMain.on，拦截通过 ipcRenderer.send 发起的未授权调用
 * （如 app:relaunch / window:close 等具备副作用的通道）。
 */
export function validateSenderEvent(event: Electron.IpcMainEvent): boolean {
  return isTrustedSender(event.sender)
}
