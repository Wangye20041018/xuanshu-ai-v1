﻿import { app } from 'electron'
import { dialog } from 'electron'
import {join, dirname} from 'path'
import {existsSync, mkdirSync, writeFileSync, createWriteStream, unlinkSync} from 'fs'
import {exec, spawn, SpawnOptions} from 'child_process'
import { promisify } from 'util'
import { pipeline } from 'stream/promises'
import AdmZip from 'adm-zip'
import { translateWindowsPathToWSL } from './wsl-utils'
import { logger } from '../../shared/logger'
import { resolveResource } from '../utils/resource-resolver'
import { createProxyAgent } from '../utils/proxy-resolver'

const execAsync = promisify(exec)

/**
 * spawnSafe — 中文路径安全的 spawn 封装
 *
 * Windows 上 exec/execAsync 底层走 cmd.exe shell，cmd.exe 默认 GBK (CP936) 编码，
 * 导致含中文的路径（如 E:\开发\...）被错误编码为乱码（如 E:\寮€鍙?\...）。
 *
 * spawn 不使用 shell 时直接调 CreateProcessW，参数以 UTF-16 传递，天然避免编码问题。
 * 本函数自动将简单 command+args 形式的字符串拆解后交给 spawn。
 */
function spawnSafe(
  command: string,
  args: string[],
  options?: { timeout?: number; cwd?: string; env?: Record<string, string> }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
    if (options?.cwd) spawnOpts.cwd = options.cwd
    if (options?.env) spawnOpts.env = { ...process.env, ...options.env }

    const child = spawn(command, args, spawnOpts)
    const timer = options?.timeout
      ? setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`spawnSafe 超时 (${options.timeout}ms)`)) }, options.timeout)
      : null

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString('utf-8') })
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString('utf-8') })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr || `Exit code: ${code}`))
    })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
  })
}

interface PythonEnv {
  pythonPath: string
  pipPath: string
  version: string
  ready: boolean
  packages: string[]
}

interface WSLInfo {
  available: boolean
  version?: '1' | '2'
  defaultDistro?: string
  pythonVersion?: string
  error?: string
}

class PythonRuntime {
  private env: PythonEnv | null = null
  private embeddedDir: string | null = null
  private pythonDir: string | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private restartCount: number = 0
  private maxRestarts: number = 5
  private restartCooldown: number = 30000 // 30秒冷却时间
  private lastRestartTime: number = 0
  private onHealthChange: ((healthy: boolean) => void) | null = null
  /** 上一次心跳的健康状态；null 表示尚未有过心跳结果（用于降噪，只在状态变化时记录） */
  private lastHeartbeatHealthy: boolean | null = null

  // ===== WSL 集成（SGLang on WSL2）=====
  private wslInfo: WSLInfo | null = null
  private wslDetected = false

  constructor() {
    // 延迟初始化，等待 app ready
  }

  /* ---- 心跳检测 ---- */
  startHeartbeat(intervalMs: number = 15000): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(async () => {
      try {
        const healthy = await this.checkHealth()
        if (!healthy && this.restartCount < this.maxRestarts) {
          const now = Date.now()
          if (now - this.lastRestartTime > this.restartCooldown) {
            logger.warn('[PythonRuntime] 心跳检测失败，尝试重启 Python 引擎...')
            this.lastRestartTime = now
            this.restartCount++
            await this.reinitialize()
            this.onHealthChange?.(true)
            this.lastHeartbeatHealthy = true
          }
        } else if (healthy) {
          this.restartCount = 0 // 重置计数
        }
        // 降噪修复：仅在健康状态「发生变化」时记录并通知，
        // 避免 Python 环境长期不可用时每 15s 刷一条日志 / 重复广播。
        if (this.lastHeartbeatHealthy !== healthy) {
          if (this.lastHeartbeatHealthy !== null) {
            logger.info(`[PythonRuntime] 健康状态变化: ${healthy ? '恢复正常' : '不可用'}`)
          }
          this.lastHeartbeatHealthy = healthy
          this.onHealthChange?.(healthy)
        }
      } catch (e) {
        logger.error('[PythonRuntime] 心跳检测异常:', e)
      }
    }, intervalMs)
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    // 重置状态跟踪，下次 startHeartbeat 时重新建立基线
    this.lastHeartbeatHealthy = null
  }

  async checkHealth(): Promise<boolean> {
    try {
      if (!this.env?.ready) return false
      const pythonPath = this.env.pythonPath
      // 使用 spawnSafe 避免中文路径在 cmd.exe 中被 GBK 编码乱码
      const { stdout } = await spawnSafe(pythonPath, ['-c', "print('ok')"], { timeout: 5000 })
      return stdout.trim() === 'ok'
    } catch (e) {
      // 降噪：由调用方（心跳）在状态变化时统一记录，此处仅留 debug 细节，
      // 避免 Python 长期不可用时每次探测都产生一条 error。
      logger.debug('[PythonRuntime] 健康检查失败:', e)
      return false
    }
  }

  setHealthListener(callback: (healthy: boolean) => void): void {
    this.onHealthChange = callback
  }

  getHealthStatus(): { healthy: boolean; restartCount: number; maxRestarts: number } {
    return {
      healthy: this.env?.ready ?? false,
      restartCount: this.restartCount,
      maxRestarts: this.maxRestarts,
    }
  }

  private getUserDataDir(): string {
    if (!this.embeddedDir) {
      this.embeddedDir = join(app.getPath('userData'), 'runtime')
      this.pythonDir = join(this.embeddedDir, 'python')
    }
    return this.embeddedDir
  }

  private getUserPythonDir(): string {
    if (!this.pythonDir) {
      this.getUserDataDir()
    }
    return this.pythonDir!
  }

  async initialize(): Promise<PythonEnv | null> {
    // 每次调用重新检测，支持进程崩溃后重新初始化
    this.env = null

    // 只检查 Python 环境，不自动安装 SGLang（由用户按需触发）
    if (await this.checkPackedPython()) {
      return this.env
    }

    // check user data dir (previous download)
    if (await this.checkEmbeddedPython()) {
      return this.env
    }

    if (await this.detectSystemPython()) {
      return this.env
    }

    await this.downloadPython()
    return this.env
  }

  // 心跳重启时强制重新初始化，避免 this.env 缓存导致的 no-op
  async reinitialize(): Promise<PythonEnv | null> {
    this.env = null
    return this.initialize()
  }

  // 检查打包资源目录中的Python（含便携版外部配套包回退）
  private async checkPackedPython(): Promise<boolean> {
    try {
      const packedPythonDir = resolveResource('python')
      const packedPythonExe = join(packedPythonDir, 'python.exe')

      if (existsSync(packedPythonExe)) {
        const { stdout } = await spawnSafe(packedPythonExe, ['--version'], { timeout: 5000 })
        const version = stdout.trim().replace('Python ', '')

        // 由于asar/打包目录通常是只读的，复制到用户数据目录以便写入
        const userPythonDir = this.getUserPythonDir()
        if (!existsSync(join(userPythonDir, 'python.exe'))) {
          // 如果用户目录没有Python，使用打包目录的（只读模式）
          // 或者执行一次复制（可选，取决于后续是否需要pip安装）
          this.env = {
            pythonPath: packedPythonExe,
            pipPath: join(packedPythonDir, 'Scripts', 'pip.exe'),
            version,
            ready: true,
            packages: await this.getInstalledPackages(packedPythonExe)
          }
        } else {
          this.env = {
            pythonPath: join(userPythonDir, 'python.exe'),
            pipPath: join(userPythonDir, 'Scripts', 'pip.exe'),
            version,
            ready: true,
            packages: await this.getInstalledPackages(join(userPythonDir, 'python.exe'))
          }
        }
        return true
      }
    } catch (e) {
      logger.error('[PythonRuntime] 检查打包Python失败:', e)
      // 打包目录没有Python，继续检查其他位置
    }
    return false
  }

  private async checkEmbeddedPython(): Promise<boolean> {
    const pythonDir = this.getUserPythonDir()
    const pythonExe = join(pythonDir, 'python.exe')

    if (existsSync(pythonExe)) {
      try {
        const { stdout } = await spawnSafe(pythonExe, ['--version'], { timeout: 5000 })
        const version = stdout.trim().replace('Python ', '')

        this.env = {
          pythonPath: pythonExe,
          pipPath: join(pythonDir, 'Scripts', 'pip.exe'),
          version,
          ready: true,
          packages: await this.getInstalledPackages(pythonExe)
        }
        return true
      } catch (e) {
        logger.error('[PythonRuntime] 检查嵌入式Python失败:', e)
        return false
      }
    }

    return false
  }

  private async detectSystemPython(): Promise<boolean> {
    // 优先检查 APP 内置 resources/python/ 目录
    const resourcesDir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
    const appPythonExe = join(resourcesDir, 'python', 'python.exe')
    if (existsSync(appPythonExe)) {
      try {
        // 使用 spawnSafe 避免 app.getAppPath() 中文路径被 cmd.exe GBK 编码乱码
        const { stdout } = await spawnSafe(appPythonExe, ['--version'], { timeout: 3000 })
        const version = stdout.trim().replace('Python ', '')
        const scriptsDir = join(dirname(appPythonExe), 'Scripts')
        const pipPath = existsSync(join(scriptsDir, 'pip.exe')) ? join(scriptsDir, 'pip.exe') : ''
        this.env = {
          pythonPath: appPythonExe,
          pipPath,
          version,
          ready: true,
          packages: await this.getInstalledPackages(appPythonExe)
        }
        return true
      } catch (e) {
        logger.error(`[PythonRuntime] 检查 APP 内置 Python 失败:`, e)
      }
    } else {
      // resources/python 不存在时创建占位 README
      const resourcesPythonDir = join(resourcesDir, 'python')
      if (!existsSync(resourcesPythonDir)) {
        try {
          mkdirSync(resourcesPythonDir, { recursive: true })
          writeFileSync(
            join(resourcesPythonDir, 'README.txt'),
            '此目录用于放置 Python 可发行版（嵌入式 Python）。\n' +
            '请将 Python embeddable 版本解压到此目录，确保 python.exe 位于此目录下。\n' +
            '下载地址：https://www.python.org/downloads/windows/ （选择 "Windows embeddable package"）\n',
            'utf-8'
          )
          logger.debug('[PythonRuntime] 已创建 resources/python 占位目录')
        } catch (e) {
          logger.error('[PythonRuntime] 创建 resources/python 目录失败:', e)
        }
      }
    }

    // 回退：检查系统 PATH 中的 Python
    const candidates = [
      'python',
      'python3',
      'py',
    ]

    for (const candidate of candidates) {
      try {
        const { stdout } = await execAsync(`${candidate} --version`, { timeout: 3000 })
        const version = stdout.trim().replace('Python ', '')

        // 将裸命令名解析为绝对路径，避免 dirname('python')='.' 导致
        //       后续 pipPath 拼出相对路径 Scripts\pip.exe → ENOENT（见 ensureSGLang）
        let resolvedPython = candidate
        if (!candidate.includes('\\') && !candidate.includes('/')) {
          try {
            const { stdout: whereOut } = await execAsync(`where ${candidate}`, { timeout: 3000 })
            const firstLine = whereOut.trim().split(/\r?\n/)[0]
            if (firstLine && firstLine.endsWith('.exe') && existsSync(firstLine)) {
              resolvedPython = firstLine
            }
          } catch { /* where 失败时保留原始 candidate */ }
        }

        // 从解析后的绝对路径推导 pipPath
        let pipPath = ''
        const scriptsDir = join(dirname(resolvedPython), 'Scripts')
        const candidatePip = join(scriptsDir, 'pip.exe')
        if (existsSync(candidatePip)) {
          pipPath = candidatePip
        }
        // 注意：pipPath 为空也没关系，ensureSGLang 会 fallback 到 "python -m pip"

        this.env = {
          pythonPath: resolvedPython,
          pipPath,
          version,
          ready: true,
          packages: await this.getInstalledPackages(resolvedPython)
        }
        return true
      } catch (e) {
        logger.error(`[PythonRuntime] 检测系统Python "${candidate}" 失败:`, e)
        continue
      }
    }

    return false
  }

  private async downloadPython(): Promise<void> {
    // 弹窗确认用户授权，不会自动下载
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Python 环境缺失',
      message: '未检测到 Python 运行环境，部分功能（SGLang推理、语音唤醒）将不可用。',
      detail: '是否下载嵌入式 Python 环境（约 60MB）？\n下载位置：%APPDATA%\\xuanshu\\runtime\\python\n不会污染系统环境，仅限本软件使用。',
      buttons: ['确认下载', '暂不下载'],
      defaultId: 0,
      cancelId: 1
    })

    if (response !== 0) {
      logger.debug('[PythonRuntime] 用户取消下载 Python 环境')
      return
    }

    const version = '3.12.0'
    const url = `https://www.python.org/ftp/python/${version}/python-${version}-embed-amd64.zip`
    const embeddedDir = this.getUserDataDir()
    const pythonDir = this.getUserPythonDir()

    mkdirSync(embeddedDir, { recursive: true })

    try {
      const zipPath = join(embeddedDir, `python-${version}.zip`)

      await this.downloadFile(url, zipPath)
      await this.extractZip(zipPath, pythonDir)

      const pythonExe = join(pythonDir, 'python.exe')

      if (existsSync(pythonExe)) {
        await this.preparePython()
      }
    } catch (error) {
      logger.error('Failed to download Python:', error)
    }
  }

  // 使用原生 fetch (Node 18+) 替代 node-fetch
  private async downloadFile(url: string, outputPath: string): Promise<void> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 30000) // 30秒下载超时
    const proxyAgent = createProxyAgent()

    try {
      const fetchOptions: any = { signal: controller.signal }
      if (proxyAgent) fetchOptions.dispatcher = proxyAgent
      const response = await fetch(url, fetchOptions)
      clearTimeout(timeoutId)

      if (!response.ok) {
        throw new Error(`Download failed: ${response.status} ${response.statusText}`)
      }

      const fileStream = createWriteStream(outputPath)
      if (!response.body) {
        throw new Error('Response body is null')
      }
      // Node 18 fetch 返回的 body 是 ReadableStream，需要转换为 Node stream
      const nodeStream = require('stream').Readable.fromWeb(response.body)
      await pipeline(nodeStream, fileStream)
    } catch (error) {
      clearTimeout(timeoutId)
      throw error
    }
  }

  // 使用 adm-zip 替代 yauzl（更简洁，同步解压）
  private async extractZip(zipPath: string, outputDir: string): Promise<void> {
    const zip = new AdmZip(zipPath)
    zip.extractAllTo(outputDir, true)
  }

  private async preparePython(): Promise<void> {
    const pythonDir = this.getUserPythonDir()
    const pythonExe = join(pythonDir, 'python.exe')

    try {
      const pipBootstrap = join(pythonDir, 'get-pip.py')

      await execAsync(`"${pythonExe}" "${pipBootstrap}"`, { timeout: 60000 })

      const packages = [
        'pyautogui',
        'pynput',
        'python-docx',
        'python-pptx',
        'Pillow',
        'requests',
        'beautifulsoup4',
        'selenium',
        'webdriver-manager',
        'openpyxl',
        'pandas'
      ]

      const pipExe = join(pythonDir, 'Scripts', 'pip.exe')

      for (const pkg of packages) {
        await execAsync(`"${pipExe}" install ${pkg}`, { timeout: 120000 })
      }

      this.env = {
        pythonPath: pythonExe,
        pipPath: pipExe,
        version: '',
        ready: true,
        packages
      }
    } catch (error) {
      logger.error('Failed to prepare Python:', error)
    }
  }

  private async getInstalledPackages(pythonPath: string): Promise<string[]> {
    try {
      const { stdout } = await spawnSafe(pythonPath, ['-m', 'pip', 'list'], { timeout: 5000 })
      return stdout.split('\n').slice(2).map(line => line.split(' ')[0].trim()).filter(Boolean)
    } catch (e) {
      logger.error('[PythonRuntime] 获取已安装包列表失败:', e)
      return []
    }
  }

  async runScript(
    script: string,
    args: string[] = [],
    options?: { env?: Record<string, string> }
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    if (!this.env?.ready) {
      return { success: false, error: 'Python not ready' }
    }

    let scriptPath: string | null = null
    try {
      const embeddedDir = this.getUserDataDir()
      scriptPath = join(embeddedDir, `script_${Date.now()}.py`)
      writeFileSync(scriptPath, script)

      const spawnEnv = options?.env ? { ...process.env, ...options.env } : undefined
      const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(this.env!.pythonPath, [scriptPath!, ...args], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          ...(spawnEnv ? { env: spawnEnv } : {}),
        })
        const timer = setTimeout(() => {
          child.kill('SIGTERM')
          reject(new Error('Script execution timed out after 60 seconds'))
        }, 60000)
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (data) => { stdout += data })
        child.stderr.on('data', (data) => { stderr += data })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (code === 0) {
            resolve({ stdout, stderr })
          } else {
            reject(new Error(stderr || `Process exited with code ${code}`))
          }
        })
        child.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
      })

      return {
        success: true,
        output: stdout || stderr
      }
    } catch (error) {
      return {
        success: false,
        error: String(error)
      }
    } finally {
      if (scriptPath) {
        try { unlinkSync(scriptPath) } catch (e) { logger.error('[PythonRuntime] 清理临时脚本失败:', e) }
      }
    }
  }

  async installPackage(packageName: string): Promise<boolean> {
    if (!this.env?.ready) return false

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.env!.pipPath, ['install', packageName], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        const timer = setTimeout(() => {
          child.kill('SIGTERM')
          reject(new Error('pip install 超时 (120秒)'))
        }, 120000)
        child.on('close', (code) => {
          clearTimeout(timer)
          if (code === 0) resolve()
          else reject(new Error(`pip install exited with code ${code}`))
        })
        child.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
      })
      return true
    } catch (e) {
      logger.error('[PythonRuntime] 安装Python包失败:', e)
      return false
    }
  }

  getEnv(): PythonEnv | null {
    return this.env
  }

  isReady(): boolean {
    return this.env?.ready ?? false
  }

  /* ------ 确保 SGLang 已安装（WSL2 离线模式，不再联网） ------ */
  async ensureSGLang(): Promise<boolean> {
    // WSL2 探测（幂等）
    await this.ensureWSLDetected()

    // 未启用 WSL2：SGLang 无法在原生 Windows 运行。SGLang 为可选 GPU 加速，
    // 非必需 —— 静默返回 false，由上层回退 node-llama-cpp CPU 模式（应用照常运行，不再弹窗打扰）
    if (!this.isWSLMode()) {
      logger.debug('[PythonRuntime] 未启用 WSL2，SGLang GPU 推理不可用，静默回退 CPU 模式（应用仍可正常运行）')
      return false
    }

    // WSL2 模式：直接委托离线安装（已安装则立即成功，marker 落在 userData）
    logger.debug('[PythonRuntime] WSL2 模式：SGLang 安装委托离线路径')
    return (await this.installSGLangOffline()).success
  }

  /* ------ SGLang 离线安装检测（WSL2 / 非 WSL 两种模式，不联网） ------ */
  async installSGLangOffline(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.ensureWSLDetected()
      const markerPath = this.getSGLangInstallMarkerPath()
      if (existsSync(markerPath)) {
        logger.debug('[PythonRuntime] SGLang 已安装（检测到 .installed 标记）')
        return { success: true }
      }

      const sglangDir = join(process.resourcesPath, 'sglang')
      const installScript = join(sglangDir, 'install_sglang_offline.py')
      if (!existsSync(installScript)) {
        return { success: false, error: 'install_sglang_offline.py 未找到' }
      }

      let stdout: string
      if (this.isWSLMode()) {
        const scriptWSL = translateWindowsPathToWSL(installScript)
        const markerWSL = translateWindowsPathToWSL(markerPath)
        mkdirSync(dirname(markerPath), { recursive: true })
        logger.debug('[PythonRuntime] 首次启动：经 WSL 执行 SGLang 离线安装...')
        const res = await spawnSafe('wsl.exe', ['-e', 'python3', scriptWSL, '--marker', markerWSL], { timeout: 600000 })
        stdout = res.stdout
      } else {
        const pythonPath = this.getPythonPath()
        if (!existsSync(pythonPath)) return { success: false, error: 'Python 解释器不可用' }
        logger.debug('[PythonRuntime] 首次启动：执行 SGLang 离线安装（非 WSL 模式）...')
        const res = await spawnSafe(pythonPath, [installScript], { timeout: 600000, cwd: sglangDir })
        stdout = res.stdout
      }

      try {
        const result = JSON.parse(stdout.trim().split('\n').pop() || '{}')
        if (result.status === 'ok') {
          logger.debug('[PythonRuntime] SGLang 离线安装成功')
          return { success: true }
        }
        logger.warn('[PythonRuntime] SGLang 离线安装失败:', result.msg)
        return { success: false, error: result.msg || '安装返回异常' }
      } catch (e) {
        logger.error('[PythonRuntime] 解析安装输出JSON失败:', e)
        return { success: false, error: `安装输出解析失败: ${stdout.slice(-200)}` }
      }
    } catch (e: any) {
      logger.error('[PythonRuntime] SGLang 离线安装异常:', e.message)
      return { success: false, error: e.message }
    }
  }

  /* ------ 获取 Python 可执行文件路径（供其他模块使用） ------ */
  getPythonPath(): string {
    if (this.env?.pythonPath) return this.env.pythonPath
    // 回退：检查打包资源目录（含便携版外部配套包回退）
    const packedPythonExe = join(resolveResource('python'), 'python.exe')
    if (existsSync(packedPythonExe)) return packedPythonExe
    // 回退：检查用户数据目录
    const userPythonExe = join(this.getUserPythonDir(), 'python.exe')
    if (existsSync(userPythonExe)) return userPythonExe
    // 最后回退：系统 PATH 中的 python
    return 'python'
  }

  /* ===== WSL 集成（SGLang on WSL2）===== */

  /**
   * 探测 WSL2 环境：
   * 1) wsl.exe 是否安装
   * 2) 默认发行版是否可用且为 Linux
   * 3) 默认发行版版本（需 2 才支持 localhost forwarding + GPU CUDA）
   * 4) WSL 内 python3 版本
   */
  async detectWSL(): Promise<WSLInfo> {
    // 1) wsl.exe 是否安装
    try {
      await execAsync('wsl.exe --version', { timeout: 5000 })
    } catch {
      return { available: false, error: 'WSL 未安装，请运行 wsl --install' }
    }
    // 2) 默认发行版可用？
    try {
      const { stdout } = await execAsync('wsl.exe -e uname -s', { timeout: 5000 })
      if (!/Linux/.test(stdout)) throw new Error('no linux')
    } catch {
      return { available: false, error: 'WSL 已装但无可用发行版，请 wsl --install' }
    }
    // 3) 解析默认发行版版本（需 VERSION 2 才支持 localhost forwarding + GPU CUDA）
    let version: '1' | '2' = '2'
    let defaultDistro: string | undefined
    try {
      const { stdout: list } = await execAsync('wsl.exe --list --verbose', { timeout: 5000 })
      for (const line of list.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed.startsWith('*')) {
          const parts = trimmed.replace(/^\*\s*/, '').split(/\s+/)
          defaultDistro = parts[0]
          const verStr = parts[parts.length - 1] || '2'
          version = verStr.startsWith('1') ? '1' : '2'
          break
        }
      }
    } catch (e) {
      logger.error('[PythonRuntime] 检测WSL失败:', e)
      /* 解析失败默认按 2 */
    }
    // 4) WSL 内 Python 版本
    let pythonVersion: string | undefined
    try {
      const { stdout: py } = await execAsync('wsl.exe -e python3 --version', { timeout: 5000 })
      pythonVersion = py.trim().split(' ')[1]
    } catch {
      /* 忽略 */
    }
    return { available: true, version, defaultDistro, pythonVersion }
  }

  /** 幂等探测：仅首次真正执行 detectWSL */
  async ensureWSLDetected(): Promise<void> {
    if (!this.wslDetected) {
      this.wslInfo = await this.detectWSL()
      this.wslDetected = true
    }
  }

  /** 是否处于 WSL2 模式（WSL 可用且为版本 2） */
  isWSLMode(): boolean {
    return this.wslInfo?.available === true && this.wslInfo?.version === '2'
  }

  /** 获取用于启动 SGLang 的 Python 命令前缀（WSL 模式为 wsl.exe -e python3） */
  getSGLangPythonCommand(): string[] {
    if (this.isWSLMode()) return ['wsl.exe', '-e', 'python3']
    return [this.getPythonPath()]
  }

  /** 获取 SGLang 离线安装标记路径（WSL 模式写 userData，非 WSL 模式写 resources） */
  private getSGLangInstallMarkerPath(): string {
    if (this.isWSLMode()) {
      return join(app.getPath('userData'), 'sglang', '.installed')
    }
    return join(process.resourcesPath, 'sglang', '.installed')
  }
}

export const pythonRuntime = new PythonRuntime()

export function setupPythonHandlers(): void {
  const { ipcMain } = require('electron')

  ipcMain.handle('python:initialize', async () => {
    try {
      return await pythonRuntime.initialize()
    } catch (e) {
      logger.error('python:initialize error:', e)
      return null
    }
  })

  ipcMain.handle('python:status', () => {
    try {
      return pythonRuntime.getEnv()
    } catch (e) {
      logger.error('python:status error:', e)
      return null
    }
  })

  ipcMain.handle('python:run', async (_event: any, script: string, args?: string[]) => {
    try {
      return await pythonRuntime.runScript(script, args || [])
    } catch (e) {
      logger.error('python:run error:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('python:install', async (_event: any, packageName: string) => {
    try {
      return await pythonRuntime.installPackage(packageName)
    } catch (e) {
      logger.error('python:install error:', e)
      return false
    }
  })

  ipcMain.handle('python:is-ready', () => {
    try {
      return pythonRuntime.isReady()
    } catch (e) {
      logger.error('python:is-ready error:', e)
      return false
    }
  })

  ipcMain.handle('python:health:check', () => {
    try {
      return pythonRuntime.getHealthStatus()
    } catch (e) {
      logger.error('python:health:check error:', e)
      return { healthy: false, restartCount: 0, maxRestarts: 5 }
    }
  })
}
