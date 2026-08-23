import { ipcMain, BrowserWindow } from 'electron'
import { logger } from '../../shared/logger'

export function setupWindowHandlers(): void {
  ipcMain.handle('window:minimize', () => {
    try {
      const win = BrowserWindow.getFocusedWindow()
      win?.minimize()
    } catch (error) {
      logger.error('window:minimize error:', error)
    }
  })

  ipcMain.handle('window:maximize', (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return false
      if (win.isMaximized()) {
        win.unmaximize()
        return false
      } else {
        win.maximize()
        return true
      }
    } catch (error) {
      logger.error('window:maximize error:', error)
      return false
    }
  })

  ipcMain.handle('window:close', () => {
    try {
      const win = BrowserWindow.getFocusedWindow()
      win?.close()
    } catch (error) {
      logger.error('window:close error:', error)
    }
  })

  ipcMain.handle('window:is-maximized', () => {
    try {
      const win = BrowserWindow.getFocusedWindow()
      return win?.isMaximized() ?? false
    } catch (error) {
      logger.error('window:is-maximized error:', error)
      return false
    }
  })
}
