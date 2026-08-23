/**
 * vitest 全局 Mock 配置
 * 模拟 Electron 模块，避免测试环境导入失败
 */
import { vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/userData'),
    getAppPath: vi.fn(() => '/mock/app'),
    isPackaged: false,
    isReady: vi.fn(() => true),
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    emit: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  shell: {
    openPath: vi.fn(() => Promise.resolve('')),
  },
  Notification: class {
    show() {}
  },
  Menu: {
    buildFromTemplate: vi.fn(),
    setApplicationMenu: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: true },
}))

vi.mock('electron-store', () => ({
  default: class {
    get = vi.fn()
    set = vi.fn()
    delete = vi.fn()
  },
}))
