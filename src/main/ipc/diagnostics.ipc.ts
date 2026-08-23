import { ipcMain, app } from 'electron'
import { join } from 'path'
import { existsSync, readdirSync, mkdirSync } from 'fs'
import AdmZip from 'adm-zip'
import { createLogger } from '../utils/logging'
import { getModuleStatus } from '../register/lifecycle.register'

const logger = createLogger('Diagnostics')

/* ============================================================
 * 诊断导出 IPC — 一键打包日志 + 配置 + 模块/模型状态 + 系统摘要
 * 产物：userData/diagnostics/diagnostic-YYYYMMDD-HHmmss.zip
 * ============================================================ */

export function setupDiagnosticsHandlers(): void {
  ipcMain.handle('diagnostics:export', async (): Promise<{ success: boolean; path?: string; error?: string }> => {
    try {
      const userData = app.getPath('userData')
      const zip = new AdmZip()

      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`

      // 1. 日志目录（logs/）
      const logDir = join(userData, 'logs')
      if (existsSync(logDir)) {
        for (const f of readdirSync(logDir)) {
          try {
            zip.addLocalFile(join(logDir, f), 'logs')
          } catch { /* 单个文件打包失败跳过 */ }
        }
      }

      // 2. 配置（config.json）
      const configPath = join(userData, 'config.json')
      if (existsSync(configPath)) {
        try { zip.addLocalFile(configPath, 'config') } catch { /* ignore */ }
      }

      // 3. 模块状态快照
      let snapshot = '=== module-status ===\n' + JSON.stringify(getModuleStatus(), null, 2) + '\n\n'
      try {
        const { modelRegistry } = require('../model-registry')
        snapshot += '=== model-registry ===\n' + JSON.stringify(modelRegistry.list?.() ?? [], null, 2) + '\n\n'
      } catch { /* ignore */ }
      try {
        const { getStore } = require('./config.ipc')
        const store = getStore()
        if (store) {
          const cfg: Record<string, unknown> = {}
          for (const key of ['defaultModelId', 'startupModelId', 'voiceId', 'voiceEnabled', 'wakeWord', 'theme', 'autoLaunch']) {
            try { cfg[key] = store.get(key) } catch { /* ignore */ }
          }
          snapshot += '=== config-keys ===\n' + JSON.stringify(cfg, null, 2) + '\n\n'
        }
      } catch { /* ignore */ }
      zip.addFile('snapshot/status.txt', Buffer.from(snapshot, 'utf-8'))

      // 4. 系统摘要
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const os = require('os')
        const sysInfo = [
          `hostname: ${os.hostname()}`,
          `platform: ${os.platform()} ${os.release()}`,
          `arch: ${os.arch()}`,
          `cpus: ${os.cpus().length} (${os.cpus()[0]?.model || 'unknown'})`,
          `totalMemGB: ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)}`,
          `freeMemGB: ${(os.freemem() / 1024 / 1024 / 1024).toFixed(1)}`,
          `uptimeSec: ${Math.round(os.uptime())}`,
          `electron: ${process.versions.electron || 'unknown'}`,
          `node: ${process.versions.node || 'unknown'}`,
          `appVersion: ${app.getVersion?.() || 'unknown'}`,
        ].join('\n')
        zip.addFile('snapshot/system.txt', Buffer.from(sysInfo, 'utf-8'))
      } catch { /* ignore */ }

      // 输出
      const outDir = join(userData, 'diagnostics')
      mkdirSync(outDir, { recursive: true })
      const outPath = join(outDir, `diagnostic-${stamp}.zip`)
      zip.writeZip(outPath)
      logger.info(`[Diagnostics] 诊断包已导出: ${outPath}`)
      return { success: true, path: outPath }
    } catch (e: any) {
      logger.error(`[Diagnostics] 导出失败: ${e.message}`)
      return { success: false, error: e.message }
    }
  })
}
