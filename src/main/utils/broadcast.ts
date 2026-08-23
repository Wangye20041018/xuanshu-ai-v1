/**
 * broadcast — 安全的窗口广播工具
 *
 * 修复 P0 崩溃「Object has been destroyed」：
 * 在窗口销毁的竞态窗口内，BrowserWindow.getAllWindows() 返回的实例其
 * webContents 可能已被销毁，直接访问 win.webContents.send(...) 会抛出
 * "Object has been destroyed"，触发全局 CrashGuard 并中断主流程。
 *
 * 统一通过本工具发送 IPC，同时校验 win.isDestroyed() 与
 * win.webContents.isDestroyed()，并在 try/catch 内兜底。
 *
 * @module utils/broadcast
 */

import { BrowserWindow } from 'electron'

/** 判断窗口及其 webContents 是否仍可安全访问 */
export function isWindowAlive(win: BrowserWindow | null | undefined): win is BrowserWindow {
  if (!win) return false
  try {
    return !win.isDestroyed() && !win.webContents.isDestroyed()
  } catch {
    return false
  }
}

/** 向单个窗口安全发送 IPC；窗口销毁时静默跳过 */
export function sendToWindow(
  win: BrowserWindow | null | undefined,
  channel: string,
  ...args: unknown[]
): void {
  if (!isWindowAlive(win)) return
  try {
    win.webContents.send(channel, ...args)
  } catch {
    /* 发送竞态失败可安全忽略 */
  }
}

/** 向所有存活窗口安全广播 IPC */
export function sendToAllWindows(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToWindow(win, channel, ...args)
  }
}