/**
 * 数据备份 / 导出 / 导入服务
 *
 * 备份范围（仅用户数据 + 配置，不含模型/插件等大体积二进制）：
 *   - config.json（electron-store，含用户配置）
 *   - data/memories.db（SQLite，打包前 wal_checkpoint(TRUNCATE) 使其自包含）
 *   - vector-store.json（向量库）
 *   - knowledge-graph/{entities,relations}.json（知识图谱）
 *   - localStorage.json（渲染进程 chatStore 序列化，经 IPC 传入）
 *   - manifest.json（版本 + 时间戳 + 校验和）
 *
 * 数据流：
 *   导出：renderer flushChatStore → getItem → api.invoke('backup:export', { chatStore })
 *         → 主进程 checkpoint + 收集文件 + 写 manifest → showSaveDialog → adm-zip 打包
 *   导入：api.invoke('backup:import') → showOpenDialog → 解压校验 → 先备份现状
 *         → 关闭 db → 覆盖文件 → webContents.send('backup:restore-localstorage') 触发 rehydrate
 *
 * @module backup
 */

import { ipcMain, app, dialog, BrowserWindow } from 'electron'
import { join } from 'path'
import { existsSync, statSync, mkdirSync, readFileSync, rmSync, copyFileSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import AdmZip from 'adm-zip'
import { logger } from '../../shared/logger'
import { checkpointMemoryDb, closeMemoryDb } from '../ipc/memory.ipc'

/* ==================== 类型 ==================== */

export interface Manifest {
  /** 备份格式版本 */
  version: 1
  /** 导出时间戳 */
  exportedAt: number
  /** 应用版本 */
  appVersion: string
  /** 包含的文件（zip 内相对路径） */
  files: string[]
  /** 文件 sha256 校验和 */
  checksums: Record<string, string>
}

export interface BackupResult {
  success: boolean
  path?: string
  sizeBytes?: number
  error?: string
}

export interface ImportResult {
  success: boolean
  restoredFiles?: string[]
  error?: string
}

export interface BackupInfoFile {
  name: string
  sizeBytes: number
  exists: boolean
}

export interface BackupInfo {
  files: BackupInfoFile[]
  totalSizeBytes: number
}

/* ==================== 常量 ==================== */

/** 数据文件清单：name 为 zip 内相对路径，source 为 userData 下的相对路径 */
const DATA_FILES: Array<{ name: string; source: string }> = [
  { name: 'config.json', source: 'config.json' },
  { name: 'memories.db', source: join('data', 'memories.db') },
  { name: 'vector-store.json', source: 'vector-store.json' },
  { name: join('knowledge-graph', 'entities.json'), source: join('knowledge-graph', 'entities.json') },
  { name: join('knowledge-graph', 'relations.json'), source: join('knowledge-graph', 'relations.json') },
]

const LOCALSTORAGE_ENTRY = 'localStorage.json'
const MANIFEST_ENTRY = 'manifest.json'
const MANIFEST_VERSION = 1 as const

/* ==================== 工具函数 ==================== */

function userDataDir(): string {
  return app.getPath('userData')
}

/** 解析 config.json 实际路径（electron-store 在非 ASCII 用户路径下会回退到 home/.xuanshu-config） */
function resolveConfigPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getStore } = require('../ipc/config.ipc')
    const store = getStore()
    const p = (store && (store as any).path) as string | undefined
    if (p && existsSync(p)) return p
  } catch { /* ignore */ }
  return join(userDataDir(), 'config.json')
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function timestamp(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** 收集某个数据文件在 userData 下的绝对路径（不存在返回 null） */
function resolveDataFile(source: string): string | null {
  if (source === 'config.json') {
    const p = resolveConfigPath()
    return existsSync(p) ? p : null
  }
  const p = join(userDataDir(), source)
  return existsSync(p) ? p : null
}

/** 广播事件给所有存活窗口 */
function broadcast(channel: string, payload: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      try {
        win.webContents.send(channel, payload)
      } catch { /* pipe broken */ }
    }
  })
}

/* ==================== 备份服务 ==================== */

class BackupService {
  /** 导出备份：返回结果（含保存路径与大小） */
  async exportData(chatStoreJson: string): Promise<BackupResult> {
    try {
      // 1. SQLite WAL checkpoint，保证 .db 自包含
      checkpointMemoryDb()

      // 2. 收集文件
      const zip = new AdmZip()
      const manifest: Manifest = {
        version: MANIFEST_VERSION,
        exportedAt: Date.now(),
        appVersion: app.getVersion?.() || 'unknown',
        files: [],
        checksums: {},
      }

      for (const { name, source } of DATA_FILES) {
        const abs = resolveDataFile(source)
        if (!abs) continue
        const buf = readFileSync(abs)
        zip.addFile(name, buf)
        manifest.files.push(name)
        manifest.checksums[name] = sha256(buf)
      }

      // 3. localStorage 内容（renderer 传入）
      if (chatStoreJson) {
        const buf = Buffer.from(chatStoreJson, 'utf-8')
        zip.addFile(LOCALSTORAGE_ENTRY, buf)
        manifest.files.push(LOCALSTORAGE_ENTRY)
        manifest.checksums[LOCALSTORAGE_ENTRY] = sha256(buf)
      }

      // 4. manifest
      const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8')
      zip.addFile(MANIFEST_ENTRY, manifestBuf)
      manifest.files.push(MANIFEST_ENTRY)

      // 5. 选择保存位置
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      const saveOptions = {
        title: '导出玄枢AI数据备份',
        defaultPath: `xuanshu-backup-${timestamp()}.zip`,
        filters: [{ name: 'ZIP 备份包', extensions: ['zip'] }],
      }
      const { canceled, filePath } = win
        ? await dialog.showSaveDialog(win, saveOptions)
        : await dialog.showSaveDialog(saveOptions)
      if (canceled || !filePath) {
        return { success: false, error: '用户取消导出' }
      }

      zip.writeZip(filePath)
      const sizeBytes = sizeOf(filePath)
      logger.info(`[Backup] 已导出 ${manifest.files.length} 个文件到 ${filePath} (${sizeBytes} bytes)`)
      return { success: true, path: filePath, sizeBytes }
    } catch (e: any) {
      logger.error('[Backup] 导出失败:', e)
      return { success: false, error: e.message || String(e) }
    }
  }

  /** 导入备份（破坏性：先自动备份现状再覆盖） */
  async importData(): Promise<ImportResult> {
    let tempDir: string | null = null
    try {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      const openOptions = {
        title: '选择玄枢AI数据备份包',
        filters: [{ name: 'ZIP 备份包', extensions: ['zip'] }],
        properties: ['openFile'] as ('openFile')[],
      }
      const { canceled, filePaths } = win
        ? await dialog.showOpenDialog(win, openOptions)
        : await dialog.showOpenDialog(openOptions)
      if (canceled || !filePaths || filePaths.length === 0) {
        return { success: false, error: '用户取消导入' }
      }
      const zipPath = filePaths[0]

      // 1. 解压到临时目录
      tempDir = join(tmpdir(), `xuanshu-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
      mkdirSync(tempDir, { recursive: true })
      const zip = new AdmZip(zipPath)
      zip.extractAllTo(tempDir, true)

      // 2. 校验 manifest
      const manifest = this.validateManifest(tempDir)
      if (!manifest) {
        return { success: false, error: '备份包校验失败：manifest 缺失或版本不兼容' }
      }

      // 3. 先自动备份现状（防误操作）
      const preBackupPath = await this.backupCurrentState()
      if (!preBackupPath) {
        logger.warn('[Backup] 导入前自动备份失败，仍继续导入')
      } else {
        logger.info(`[Backup] 导入前已备份现状: ${preBackupPath}`)
      }

      // 4. 关闭 db 并逐项覆盖
      closeMemoryDb()
      const restoredFiles: string[] = []
      for (const { name, source } of DATA_FILES) {
        const entryPath = join(tempDir, name)
        if (!existsSync(entryPath)) continue
        const targetPath = source === 'config.json' ? resolveConfigPath() : join(userDataDir(), source)
        mkdirSync(join(targetPath, '..'), { recursive: true })
        copyFileSync(entryPath, targetPath)
        restoredFiles.push(name)
      }

      // 5. 读取备份中的 localStorage 并广播给渲染层 rehydrate
      const lsPath = join(tempDir, LOCALSTORAGE_ENTRY)
      if (existsSync(lsPath)) {
        const chatStoreJson = readFileSync(lsPath, 'utf-8')
        broadcast('backup:restore-localstorage', chatStoreJson)
      }

      logger.info(`[Backup] 导入完成，恢复 ${restoredFiles.length} 个文件`)
      return { success: true, restoredFiles }
    } catch (e: any) {
      logger.error('[Backup] 导入失败:', e)
      return { success: false, error: e.message || String(e) }
    } finally {
      if (tempDir) {
        try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    }
  }

  /** 获取数据信息（用于设置页展示备份大小） */
  getInfo(): BackupInfo {
    const files: BackupInfoFile[] = DATA_FILES.map(({ name, source }) => {
      const abs = resolveDataFile(source)
      return { name, sizeBytes: abs ? sizeOf(abs) : 0, exists: !!abs }
    })
    return { files, totalSizeBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0) }
  }

  /** 校验 manifest；合法则返回 Manifest 对象，否则返回 null */
  private validateManifest(dir: string): Manifest | null {
    try {
      const manifestPath = join(dir, MANIFEST_ENTRY)
      if (!existsSync(manifestPath)) return null
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest
      if (manifest.version !== MANIFEST_VERSION || !Array.isArray(manifest.files)) return null
      // 校验关键文件均存在于解压目录
      for (const f of manifest.files) {
        if (f !== MANIFEST_ENTRY && !existsSync(join(dir, f))) return null
      }
      return manifest
    } catch {
      return null
    }
  }

  /** 将当前用户数据打包为 pre-import 备份，返回路径（失败返回 null） */
  private async backupCurrentState(): Promise<string | null> {
    try {
      checkpointMemoryDb()
      const zip = new AdmZip()
      for (const { name, source } of DATA_FILES) {
        const abs = resolveDataFile(source)
        if (!abs) continue
        zip.addLocalFile(abs, name.includes('/') || name.includes('\\') ? name.split(/[\\/]/).slice(0, -1).join('/') : '')
        // addLocalFile 保留文件名；若在子目录则置于对应目录
      }
      // localStorage 现状无法由主进程读取（renderer 专属），跳过；由 renderer 侧负责
      const outDir = join(userDataDir(), 'backups')
      mkdirSync(outDir, { recursive: true })
      const outPath = join(outDir, `backup-pre-import-${timestamp()}.zip`)
      zip.writeZip(outPath)
      return outPath
    } catch (e) {
      logger.error('[Backup] 现状备份失败:', e)
      return null
    }
  }
}

export const backupService = new BackupService()

/* ==================== IPC ==================== */

export function setupBackupHandlers(): void {
  ipcMain.handle('backup:export', async (_event, payload?: { chatStore?: string }) => {
    const chatStore = (payload && typeof payload.chatStore === 'string') ? payload.chatStore : ''
    return await backupService.exportData(chatStore)
  })

  ipcMain.handle('backup:import', async () => {
    return await backupService.importData()
  })

  ipcMain.handle('backup:get-info', () => {
    return backupService.getInfo()
  })
}
