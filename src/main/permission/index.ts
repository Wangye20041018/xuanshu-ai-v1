﻿import { app, dialog, shell, BrowserWindow, systemPreferences } from 'electron'
import { exec, execSync } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'

import { createLogger } from '../utils/logging'
import { POWERSHELL_EXE, POWERSHELL_CMD } from '../utils/powershell'
import { createProxyAgent } from '../utils/proxy-resolver'
const logger = createLogger('Permission')

const execAsync = promisify(exec)

/** 安全执行命令，失败时返回空字符串 */
async function safeExec(cmd: string, timeout = 3000): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { timeout, windowsHide: true })
    return stdout || ''
  } catch {
    return ''
  }
}

/** 检查 powershell 是否可用 */
function isPowerShellAvailable(): boolean {
  try {
    // stdio:'ignore'：不建立 stdout 管道，避免管道被关闭时 execSync 写断管抛 EPIPE，
    // 进而触发 CrashGuard 递归死循环；返回值恒为 null 但退出码仍可反映成败
    execSync(`${POWERSHELL_CMD} -NoProfile -Command "Write-Host OK"`, { timeout: 3000, windowsHide: true, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// ============================================================
// 接口定义（保持向后兼容）
// ============================================================

export interface Permission {
  id: string
  name: string
  description: string
  type: 'system' | 'file' | 'network' | 'screen' | 'audio' | 'microphone' | 'camera' | 'registry'
  required: boolean
  granted: boolean
  canRequest: boolean
  /** 权限被拒绝时的影响范围 */
  impact?: string
  /** 修复该权限的方法说明 */
  fixMethod?: string
  /** 修复动作：Windows 设置 URI 或特殊命令 */
  fixAction?: string
  /** 最后一次检测的时间戳 */
  lastChecked?: number
}

export interface PermissionStatus {
  permissions: Permission[]
  allGranted: boolean
  requiredGranted: boolean
}

/** 单次修复结果 */
export interface PermissionFixResult {
  permissionId: string
  name: string
  success: boolean
  message: string
}

// ============================================================
// 权限定义
// ============================================================

const PERMISSIONS: Permission[] = [
  {
    id: 'admin',
    name: '管理员权限',
    description: '执行系统命令、修改系统设置',
    type: 'system',
    required: false,  // 管理员权限非必需，仅高级功能需要
    granted: false,
    canRequest: true,
    impact: '部分高级功能（注册表读写、系统服务管理）可能受限，不影响主要功能使用',
    fixMethod: '以管理员身份重新启动应用，或右键应用图标选择"以管理员身份运行"',
    fixAction: 'restart-admin'
  },
  {
    id: 'files',
    name: '文件系统访问',
    description: '读取/写入本地文件（配置、日志、数据、模型）',
    type: 'file',
    required: true,
    granted: false,
    canRequest: true,
    impact: '无法保存配置、日志和用户数据，模型下载和知识库功能将不可用',
    fixMethod: '确保用户数据目录具有读写权限，检查磁盘空间和文件夹权限',
    fixAction: 'open-userdata'
  },
  {
    id: 'network',
    name: '网络访问',
    description: '联网搜索、模型下载、在线服务调用',
    type: 'network',
    required: true,
    granted: false,
    canRequest: false,
    impact: '无法使用联网搜索、模型下载、在线AI服务等所有网络功能',
    fixMethod: '检查网络连接、防火墙设置，确保应用未被防火墙阻止',
    fixAction: 'ms-settings:network'
  },
  {
    id: 'screen',
    name: '屏幕捕获',
    description: '截取屏幕内容供AI视觉分析',
    type: 'screen',
    required: false,
    granted: false,
    canRequest: true,
    impact: '无法使用屏幕截图分析功能，视觉AI相关能力受限',
    fixMethod: '打开 Windows 设置 > 隐私和安全 > 屏幕截图和应用捕获，确保允许应用访问',
    fixAction: 'ms-settings:privacy'
  },
  {
    id: 'audio',
    name: '音频输出',
    description: '语音合成播放（TTS输出）',
    type: 'audio',
    required: false,
    granted: false,
    canRequest: true,
    impact: '无法播放AI语音合成内容，语音交互体验受限',
    fixMethod: '检查音频输出设备是否正常连接，确保音量未静音',
    fixAction: 'ms-settings:sound'
  },
  {
    id: 'microphone',
    name: '麦克风',
    description: '语音识别输入（ASR语音转文字）',
    type: 'microphone',
    required: false,
    granted: false,
    canRequest: true,
    impact: '无法使用语音输入功能，语音唤醒和语音命令不可用',
    fixMethod: '打开 Windows 设置 > 隐私和安全 > 麦克风，确保"允许应用访问你的麦克风"已开启',
    fixAction: 'ms-settings:privacy-microphone'
  },
  {
    id: 'camera',
    name: '摄像头',
    description: '视频输入（实时画面分析）',
    type: 'camera',
    required: false,
    granted: false,
    canRequest: true,
    impact: '无法使用摄像头进行实时画面分析和视频输入',
    fixMethod: '打开 Windows 设置 > 隐私和安全 > 摄像头，确保"允许应用访问你的摄像头"已开启',
    fixAction: 'ms-settings:privacy-webcam'
  },
  {
    id: 'registry',
    name: '注册表访问',
    description: '读取系统配置信息（硬件、软件环境）',
    type: 'registry',
    required: false,
    granted: false,
    canRequest: true,
    impact: '无法读取系统硬件配置和软件环境信息，部分设备优化功能受限',
    fixMethod: '需要管理员权限才能完整访问注册表，请以管理员身份运行应用',
    fixAction: 'restart-admin'
  }
]

// ============================================================
// 权限状态持久化
// ============================================================

interface PersistedState {
  [permissionId: string]: {
    granted: boolean
    lastChecked: number
  }
}

function getStatePath(): string {
  return path.join(app.getPath('userData'), 'permission-state.json')
}

function loadPersistedState(): PersistedState {
  try {
    const statePath = getStatePath()
    if (fs.existsSync(statePath)) {
      const raw = fs.readFileSync(statePath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as PersistedState
      }
    }
  } catch (e) {
    logger.error(`[Permission] 加载权限状态文件失败: ${e}`)
  }
  return {}
}

function savePersistedState(state: PersistedState): void {
  try {
    const statePath = getStatePath()
    const dir = path.dirname(statePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8')
  } catch (e) {
    logger.error(`[Permission] 保存权限状态文件失败: ${e}`)
  }
}

// ============================================================
// Windows 设置 URI 映射
// ============================================================

/** @future-use v12.0 — Windows 设置 URI 快捷映射表，供 fixAction 解析时做别名转换 */
// @ts-ignore TS6133 — reserved for future use
const _MS_SETTINGS_URI_MAP: Record<string, string> = {
  'ms-settings:privacy-microphone': 'ms-settings:privacy-microphone',
  'ms-settings:privacy-webcam': 'ms-settings:privacy-webcam',
  'ms-settings:privacy': 'ms-settings:privacy',
  'ms-settings:network': 'ms-settings:network',
  'ms-settings:sound': 'ms-settings:sound',
  'ms-settings:appsfeatures': 'ms-settings:appsfeatures',
  'restart-admin': '',
  'open-userdata': ''
}

// ============================================================
// 权限管理器
// ============================================================

class PermissionManager {
  private permissions: Permission[] = [...PERMISSIONS]
  private initialized = false

  // ==========================================================
  // 初始化
  // ==========================================================

  async initialize(): Promise<void> {
    // 先加载持久化状态作为初始值
    const persisted = loadPersistedState()
    for (const [id, state] of Object.entries(persisted)) {
      const perm = this.permissions.find(p => p.id === id)
      if (perm) {
        perm.granted = state.granted
        perm.lastChecked = state.lastChecked
      }
    }

    // 重新检测所有权限
    await this.checkAllPermissions()
    this.initialized = true
  }

  // ==========================================================
  // 状态查询
  // ==========================================================

  getStatus(): PermissionStatus {
    const requiredGranted = this.permissions
      .filter(p => p.required)
      .every(p => p.granted)

    return {
      permissions: this.permissions,
      allGranted: this.permissions.every(p => p.granted),
      requiredGranted
    }
  }

  getPermission(id: string): Permission | undefined {
    return this.permissions.find(p => p.id === id)
  }

  isInitialized(): boolean {
    return this.initialized
  }

  // ==========================================================
  // 检测所有权限（真实系统级检测）
  // ==========================================================

  async checkAllPermissions(): Promise<PermissionStatus> {
    const results = await Promise.allSettled([
      this.checkAdminPermission(),
      this.checkFilePermission(),
      this.checkNetworkPermission(),
      this.checkScreenPermission(),
      this.checkAudioPermission(),
      this.checkMicrophonePermission(),
      this.checkCameraPermission(),
      this.checkRegistryPermission()
    ])

    // 记录检测失败
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const permIds = ['admin', 'files', 'network', 'screen', 'audio', 'microphone', 'camera', 'registry']
        logger.error(`[Permission] 检测 ${permIds[index]} 失败: ${result.reason}`)
      }
    })

    // 持久化当前状态
    this.persistCurrentState()

    return this.getStatus()
  }

  // ----------------------------------------------------------
  // 管理员权限检测
  // ----------------------------------------------------------
  async checkAdminPermission(): Promise<boolean> {
    // 方法1：使用 Electron 原生 API 检测（Windows）
    if (process.platform === 'win32') {
      try {
        // 尝试写入 SystemRoot\Temp 来检测管理员权限
        const testPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'Temp', `.xuanshu-admin-test-${Date.now()}`)
        try {
          fs.writeFileSync(testPath, 'test', 'utf-8')
          fs.unlinkSync(testPath)
          this.updatePermission('admin', true)
          return true
        } catch {
          // 无法写入系统临时目录，非管理员
        }
      } catch { /* ignore */ }

      // 方法2：使用 whoami /groups 检测（最可靠）
      try {
        const whoami = await safeExec('whoami /groups 2>&1', 3000)
        // 管理员组 SID: S-1-5-32-544 或 Mandatory Label\High Mandatory Level
        if (whoami.includes('S-1-5-32-544') || whoami.includes('High Mandatory Level') || whoami.includes('Mandatory Label\\High')) {
          this.updatePermission('admin', true)
          return true
        }
        if (whoami.includes('Medium Mandatory Level') || whoami.includes('S-1-5-32-545')) {
          this.updatePermission('admin', false)
          return false
        }
      } catch { /* whoami not available */ }

      // 方法3：检查进程是否以管理员权限运行（通过 net session）
      try {
        const netOutput = await safeExec('net session 2>&1', 3000)
        if (netOutput.includes('Access is denied') || netOutput.includes('拒绝访问')) {
          this.updatePermission('admin', false)
          return false
        }
        if (netOutput && netOutput.length > 0 && !netOutput.includes('not started') && !netOutput.includes('not running')) {
          this.updatePermission('admin', true)
          return true
        }
      } catch { /* net session not available */ }
    }

    // 方法4：macOS/Linux 通过检查 uid
    if (process.platform !== 'win32') {
      try {
        const uid = typeof (process as any).getuid === 'function' ? (process as any).getuid() : -1
        const isAdmin = uid === 0
        this.updatePermission('admin', isAdmin)
        return isAdmin
      } catch { /* ignore */ }
    }

    // 方法5：通过检查系统目录写入权限（最终兜底）
    try {
      const adminTestPath = path.join(app.getPath('temp'), `.xuanshu-admin-${Date.now()}`)
      fs.writeFileSync(adminTestPath, 'admin-test', 'utf-8')
      fs.unlinkSync(adminTestPath)
    } catch { /* ignore */ }

    this.updatePermission('admin', false)
    return false
  }

  // ----------------------------------------------------------
  // 注册表访问权限检测
  // ----------------------------------------------------------
  async checkRegistryAccess(): Promise<boolean> {
    return await this.checkRegistryPermission()
  }

  // ----------------------------------------------------------
  // 麦克风权限检测（真实系统级：注册表 + PowerShell）
  // ----------------------------------------------------------
  async checkMicrophonePermission(): Promise<boolean> {
    try {
      // 方法1：使用 Electron systemPreferences 检查麦克风权限（macOS）
      if (process.platform === 'darwin') {
        const status = systemPreferences.getMediaAccessStatus('microphone')
        const granted = status === 'granted'
        this.updatePermission('microphone', granted)
        return granted
      }

      // 方法2：Windows - 通过 reg query 检查麦克风隐私设置
      if (process.platform === 'win32') {
        const regOutput = await safeExec(
          `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone" /v Value 2>&1`,
          5000
        )
        if (regOutput.includes('Allow')) {
          this.updatePermission('microphone', true)
          return true
        }
      }

      // 方法3：通过检查音频输入设备列表
      // 使用简单的 PowerShell 检查（仅在 PowerShell 可用时）
      if (isPowerShellAvailable()) {
        try {
          const { stdout } = await execAsync(
            `"${POWERSHELL_EXE}" -NoProfile -Command "Get-CimInstance Win32_SoundDevice | Where-Object {$_.Status -eq 'OK'} | Measure-Object | Select-Object -ExpandProperty Count"`,
            { timeout: 5000, windowsHide: true }
          )
          const count = parseInt(stdout.trim(), 10)
          if (count > 0) {
            this.updatePermission('microphone', true)
            return true
          }
        } catch { /* ignore */ }
      }

      this.updatePermission('microphone', false)
      return false
    } catch (e) {
      logger.error(`[Permission] 麦克风检测异常: ${e}`)
      this.updatePermission('microphone', false)
      return false
    }
  }

  // ----------------------------------------------------------
  // 屏幕录制/捕获权限检测（图形捕获能力）
  // ----------------------------------------------------------
  async checkScreenPermission(): Promise<boolean> {
    try {
      // 方法1：通过 Electron desktopCapturer 检测屏幕捕获能力
      const { desktopCapturer } = await import('electron')
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 }
      })

      if (sources.length > 0) {
        this.updatePermission('screen', true)
        return true
      }

      // 方法2：通过 reg query 检查图形捕获权限
      const regOutput = await safeExec(
        `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\graphicsCaptureWithoutBorder" /v Value 2>&1`,
        5000
      )
      if (regOutput.includes('Allow')) {
        this.updatePermission('screen', true)
        return true
      }

      // 有显示器但可能权限受限，保守乐观
      this.updatePermission('screen', true)
      return true
    } catch (e) {
      logger.error(`[Permission] 屏幕捕获检测异常: ${e}`)
      this.updatePermission('screen', true)
      return true
    }
  }

  // ----------------------------------------------------------
  // 文件系统权限检测（用户数据目录实际读写测试）
  // ----------------------------------------------------------
  async checkFilePermission(): Promise<boolean> {
    try {
      const userDataPath = app.getPath('userData')
      const testFile = path.join(userDataPath, `.perm-write-test-${Date.now()}.tmp`)
      const testContent = `xuanshu-permission-test-${Date.now()}`

      // 写入测试
      fs.writeFileSync(testFile, testContent, 'utf-8')

      // 读取测试
      const readBack = fs.readFileSync(testFile, 'utf-8')

      // 清理测试文件
      try {
        fs.unlinkSync(testFile)
      } catch {
        // 清理失败不影响判断
      }

      const success = readBack === testContent
      this.updatePermission('files', success)
      return success
    } catch (e) {
      logger.error(`[Permission] 文件系统权限检测异常: ${e}`)
      this.updatePermission('files', false)
      return false
    }
  }

  // ----------------------------------------------------------
  // 网络权限检测（实际 HTTP 请求）
  // ----------------------------------------------------------
  async checkNetworkPermission(): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 3000)
      const proxyAgent = createProxyAgent()
      const headOptions: any = { method: 'HEAD', signal: controller.signal }
      if (proxyAgent) headOptions.dispatcher = proxyAgent

      const response = await fetch('https://www.baidu.com', headOptions)

      clearTimeout(timeoutId)

      const hasNetwork = response.ok || (response.status >= 200 && response.status < 400)
      this.updatePermission('network', hasNetwork)
      return hasNetwork
    } catch {
      // 百度不通时尝试备用地址
      try {
        const controller2 = new AbortController()
        const timeoutId2 = setTimeout(() => controller2.abort(), 3000)
        const proxyAgent = createProxyAgent()
        const headOptions2: any = { method: 'HEAD', signal: controller2.signal }
        if (proxyAgent) headOptions2.dispatcher = proxyAgent

        const response2 = await fetch('https://www.bing.com', headOptions2)

        clearTimeout(timeoutId2)

        const hasNetwork = response2.ok || (response2.status >= 200 && response2.status < 400)
        this.updatePermission('network', hasNetwork)
        return hasNetwork
      } catch {
        this.updatePermission('network', false)
        return false
      }
    }
  }

  // ----------------------------------------------------------
  // 音频权限检测
  // ----------------------------------------------------------
  async checkAudioPermission(): Promise<boolean> {
    try {
      // 通过检查音频输出设备（优先使用 reg query，备选 PowerShell）
      if (process.platform === 'win32') {
        if (isPowerShellAvailable()) {
          try {
            const { stdout } = await execAsync(
              `"${POWERSHELL_EXE}" -NoProfile -Command "Get-CimInstance Win32_SoundDevice | Where-Object {$_.Status -eq 'OK'} | Measure-Object | Select-Object -ExpandProperty Count"`,
              { timeout: 5000, windowsHide: true }
            )
            const deviceCount = parseInt(stdout.trim(), 10)
            const hasAudio = deviceCount > 0
            this.updatePermission('audio', hasAudio)
            return hasAudio
          } catch { /* 降级到默认 */ }
        }
        // 无法检测时默认认为有音频设备
        this.updatePermission('audio', true)
        return true
      }
      // macOS/Linux 默认认为有音频
      this.updatePermission('audio', true)
      return true
    } catch (e) {
      logger.error(`[Permission] 音频检测异常: ${e}`)
      this.updatePermission('audio', true)
      return true
    }
  }

  // ----------------------------------------------------------
  // 摄像头权限检测
  // ----------------------------------------------------------
  async checkCameraPermission(): Promise<boolean> {
    try {
      // 方法1：macOS 使用 Electron systemPreferences
      if (process.platform === 'darwin') {
        const status = systemPreferences.getMediaAccessStatus('camera')
        const granted = status === 'granted'
        this.updatePermission('camera', granted)
        return granted
      }

      // 方法2：Windows - 通过 reg query 检查摄像头隐私设置
      if (process.platform === 'win32') {
        const regOutput = await safeExec(
          `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam" /v Value 2>&1`,
          5000
        )
        if (regOutput.includes('Allow')) {
          this.updatePermission('camera', true)
          return true
        }
      }

      // 无法检测时默认认为有摄像头（保守乐观）
      this.updatePermission('camera', true)
      return true
    } catch (e) {
      logger.error(`[Permission] 摄像头检测异常: ${e}`)
      this.updatePermission('camera', true)
      return true
    }
  }

  // ----------------------------------------------------------
  // 注册表访问权限检测
  // ----------------------------------------------------------
  async checkRegistryPermission(): Promise<boolean> {
    // 方法1：直接使用 reg query 命令（Windows 内置，不需要 PowerShell）
    try {
      const output = await safeExec(
        `reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" /v ProductName 2>&1`,
        5000
      )
      const accessible = output.includes('ProductName') && !output.includes('ERROR')
      if (accessible) {
        this.updatePermission('registry', true)
        return true
      }
    } catch { /* 继续尝试 HKCU */ }

    // 方法2：尝试读取 HKCU（用户注册表，通常总是可访问）
    try {
      const output = await safeExec(
        `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer" /v ShellState 2>&1`,
        5000
      )
      const hkcuAccessible = output.includes('ShellState') && !output.includes('ERROR')
      logger.info(`[Permission] HKCU 注册表检测结果: ${hkcuAccessible ? '可访问' : '不可访问'}`)
      this.updatePermission('registry', hkcuAccessible)
      return hkcuAccessible
    } catch (e) {
      logger.error(`[Permission] 注册表检测失败: ${e}`)
      this.updatePermission('registry', false)
      return false
    }
  }

  // ==========================================================
  // 权限请求
  // ==========================================================

  async requestPermission(permissionId: string): Promise<boolean> {
    const permission = this.permissions.find(p => p.id === permissionId)
    if (!permission || !permission.canRequest) {
      return false
    }

    switch (permissionId) {
      case 'admin':
        return await this.requestAdminPermission()
      case 'screen':
        return await this.checkScreenPermission()
      case 'microphone':
        return await this.checkMicrophonePermission()
      case 'camera':
        return await this.checkCameraPermission()
      case 'audio':
        return await this.checkAudioPermission()
      case 'files':
        return await this.checkFilePermission()
      case 'network':
        return await this.checkNetworkPermission()
      case 'registry':
        return await this.checkRegistryPermission()
      default:
        return false
    }
  }

  async requestAdminPermission(): Promise<boolean> {
    try {
      const { stdout } = await execAsync(
        'net session 2>&1',
        { timeout: 3000 }
      )

      if (stdout.includes('Success') || stdout.includes('success')) {
        this.updatePermission('admin', true)
        return true
      }

      // 不需要管理员权限时不自动重启，由 fixPermission 或用户手动操作
      this.updatePermission('admin', false)
      return false
    } catch {
      this.updatePermission('admin', false)
      return false
    }
  }

  async requestAllPermissions(): Promise<PermissionStatus> {
    const required = this.permissions.filter(p => p.required && !p.granted)

    for (const permission of required) {
      await this.requestPermission(permission.id)
    }

    return this.getStatus()
  }

  // ==========================================================
  // 权限修复（打开 Windows 设置页面）
  // ==========================================================

  async fixPermission(permissionId: string): Promise<PermissionFixResult> {
    const permission = this.permissions.find(p => p.id === permissionId)
    if (!permission) {
      return {
        permissionId,
        name: '未知',
        success: false,
        message: `未找到权限: ${permissionId}`
      }
    }

    const fixAction = permission.fixAction || ''

    try {
      switch (fixAction) {
        case 'restart-admin':
          // 以管理员身份重启
          return await this.fixAdminPermission(permission)

        case 'open-userdata':
          // 打开用户数据目录
          return await this.fixFilePermission(permission)

        case '':
          // 无特殊修复动作，仅重新检测
          await this.requestPermission(permissionId)
          const rechecked = this.permissions.find(p => p.id === permissionId)
          return {
            permissionId,
            name: permission.name,
            success: rechecked?.granted ?? false,
            message: rechecked?.granted
              ? '权限已就绪'
              : '无法自动修复此权限，请手动检查系统设置'
          }

        default:
          // 打开 Windows 设置页面
          if (fixAction.startsWith('ms-settings:')) {
            await shell.openExternal(fixAction)
            // 给用户足够时间在设置页面操作后重新检测
            await new Promise(resolve => setTimeout(resolve, 10000))
            await this.requestPermission(permissionId)
            const updated = this.permissions.find(p => p.id === permissionId)
            return {
              permissionId,
              name: permission.name,
              success: updated?.granted ?? false,
              message: updated?.granted
                ? '权限已修复'
                : `已打开 Windows 设置页面，请在设置中手动授权后重试`
            }
          }
          // 未知的 fixAction，仅重新检测
          await this.requestPermission(permissionId)
          const result = this.permissions.find(p => p.id === permissionId)
          return {
            permissionId,
            name: permission.name,
            success: result?.granted ?? false,
            message: result?.granted ? '权限已就绪' : '无法自动修复此权限'
          }
      }
    } catch (e) {
      logger.error(`[Permission] 修复 ${permissionId} 失败: ${e}`)
      return {
        permissionId,
        name: permission.name,
        success: false,
        message: `修复过程出错: ${(e as Error).message}`
      }
    }
  }

  private async fixAdminPermission(permission: Permission): Promise<PermissionFixResult> {
    try {
      // 提示用户需要以管理员身份重启
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: '需要管理员权限',
        message: '玄枢需要管理员权限才能执行系统级操作',
        detail: '点击"确定"将以管理员身份重新启动应用。\n\n注意：重启后需要重新打开应用窗口。',
        buttons: ['确定（重启）', '取消'],
        defaultId: 0,
        cancelId: 1
      })

      if (response === 0) {
        const appPath = process.execPath
        // 转义单引号，防止 execPath 含引号时破坏 Start-Process 命令
        const safePath = appPath.replace(/'/g, "''")
        // 使用 spawn 替代 exec，避免路径含空格时的 shell 注入风险
        const { spawn } = require('child_process')
        const child = spawn(POWERSHELL_EXE, [
          '-NoProfile',
          '-Command',
          `Start-Process -FilePath '${safePath}' -Verb RunAs`
        ], { detached: true, stdio: 'ignore' })
        child.unref()

        // 给新进程一点时间启动，然后退出当前进程
        setTimeout(() => {
          app.quit()
        }, 1000)

        return {
          permissionId: permission.id,
          name: permission.name,
          success: false, // 应用即将重启，结果未知
          message: '正在以管理员身份重启应用...'
        }
      }

      return {
        permissionId: permission.id,
        name: permission.name,
        success: false,
        message: '用户取消了管理员权限提升'
      }
    } catch (e) {
      return {
        permissionId: permission.id,
        name: permission.name,
        success: false,
        message: `管理员权限提升失败: ${(e as Error).message}`
      }
    }
  }

  private async fixFilePermission(permission: Permission): Promise<PermissionFixResult> {
    try {
      const userDataPath = app.getPath('userData')
      await shell.openPath(userDataPath)

      // 重新检测
      await this.checkFilePermission()
      const updated = this.permissions.find(p => p.id === permission.id)

      return {
        permissionId: permission.id,
        name: permission.name,
        success: updated?.granted ?? false,
        message: updated?.granted
          ? '文件系统权限正常'
          : `已打开数据目录: ${userDataPath}，请检查文件夹权限`
      }
    } catch (e) {
      return {
        permissionId: permission.id,
        name: permission.name,
        success: false,
        message: `打开目录失败: ${(e as Error).message}`
      }
    }
  }

  /** 一键修复所有未授权的权限 */
  async fixAllPermissions(): Promise<PermissionFixResult[]> {
    const deniedPermissions = this.permissions.filter(p => !p.granted)
    const results: PermissionFixResult[] = []

    for (const p of deniedPermissions) {
      const result = await this.fixPermission(p.id)
      results.push(result)
    }

    return results
  }

  // ==========================================================
  // 权限对话框
  // ==========================================================

  async showPermissionDialog(parentWindow?: BrowserWindow): Promise<void> {
    const status = this.getStatus()

    if (status.requiredGranted) {
      return
    }

    // 只显示必须的（required）且未授权的权限
    const deniedPermissions = status.permissions.filter(
      p => p.required && !p.granted
    )

    if (deniedPermissions.length === 0) {
      return
    }

    // 检查是否已被用户永久忽略
    const persisted = loadPersistedState()
    if ((persisted as any)._dismissed) {
      return
    }

    // 构建详细的权限状态信息
    const lines: string[] = []
    for (const p of deniedPermissions) {
      const statusIcon = p.granted ? '[已授权]' : '[未授权]'
      lines.push(`${statusIcon} ${p.name} ${p.required ? '(必需)' : '(可选)'}`)
      lines.push(`  说明: ${p.description}`)
      if (p.impact) {
        lines.push(`  影响: ${p.impact}`)
      }
      if (p.fixMethod) {
        lines.push(`  修复: ${p.fixMethod}`)
      }
      lines.push('')
    }

    const detail = lines.join('\n')

    const win = parentWindow || BrowserWindow.getAllWindows()[0]
    if (!win) {
      logger.warn('[Permission] 没有可用的窗口来显示权限对话框')
      return
    }

    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: '权限检测 - 玄枢AI',
      message: '以下权限需要您的授权才能正常运行:',
      detail: detail,
      buttons: ['一键修复', '稍后处理', '不再提醒'],
      defaultId: 0,
      cancelId: 1
    })

    if (response === 0) {
      // 一键修复：依次处理每个未授权的权限
      for (const p of deniedPermissions) {
        try {
          await this.fixPermission(p.id)
        } catch (e) {
          logger.error(`[Permission] 一键修复 ${p.id} 失败: ${e}`)
        }
      }

      // 修复完成后重新检测并显示结果
      await this.checkAllPermissions()
      const updatedStatus = this.getStatus()

      if (!updatedStatus.requiredGranted) {
        // 仍然有必需权限未授权，显示结果摘要
        const stillDenied = updatedStatus.permissions.filter(p => p.required && !p.granted)
        if (stillDenied.length > 0) {
          await dialog.showMessageBox(win, {
            type: 'warning',
            title: '部分权限仍需授权',
            message: '以下必需权限仍未获得授权:',
            detail: stillDenied.map(p => `- ${p.name}: ${p.fixMethod || '请手动检查'}`).join('\n'),
            buttons: ['知道了']
          })
        }
      }
    } else if (response === 2) {
      // 不再提醒：持久化标记
      const state = loadPersistedState()
      ;(state as any)._dismissed = true
      savePersistedState(state)
    }
  }

  // ==========================================================
  // 内部方法
  // ==========================================================

  private updatePermission(id: string, granted: boolean): void {
    const index = this.permissions.findIndex(p => p.id === id)
    if (index !== -1) {
      this.permissions[index].granted = granted
      this.permissions[index].lastChecked = Date.now()
    }
  }

  private persistCurrentState(): void {
    const state: PersistedState = {}
    for (const p of this.permissions) {
      state[p.id] = {
        granted: p.granted,
        lastChecked: p.lastChecked || Date.now()
      }
    }
    savePersistedState(state)
  }
}

// ============================================================
// 单例导出
// ============================================================

export const permissionManager = new PermissionManager()

// ============================================================
// IPC 处理器注册
// ============================================================

export function setupPermissionHandlers(): void {
  const { ipcMain, BrowserWindow: _BrowserWindow } = require('electron')

  // 获取当前权限状态
  ipcMain.handle('permission:get-status', () => { try { return permissionManager.getStatus() } catch(e) { logger.error(`[Permission] get-status error: ${e}`); return { granted: 0, total: 8 } } })

  // 获取当前权限状态（别名）
  ipcMain.handle('permission:status', () => { try { return permissionManager.getStatus() } catch(e) { logger.error(`[Permission] status error: ${e}`); return { granted: 0, total: 8 } } })

  // 检测所有权限（重新检测）
  ipcMain.handle('permission:check-all', async () => { try { await permissionManager.checkAllPermissions(); return permissionManager.getStatus() } catch(e) { logger.error(`[Permission] check-all error: ${e}`); return { granted: 0, total: 8 } } })

  // 请求单个权限
  ipcMain.handle('permission:request', async (_event: any, permissionId: string) => { try { return await permissionManager.requestPermission(permissionId) } catch(e) { logger.error(`[Permission] request error: ${e}`); return false } })

  // 请求所有必需权限
  ipcMain.handle('permission:request-all', async () => { try { return await permissionManager.requestAllPermissions() } catch(e) { logger.error(`[Permission] request-all error: ${e}`); return { granted: 0, total: 8 } } })

  // 显示权限对话框
  ipcMain.handle('permission:show-dialog', async (event: any) => { try { const win = _BrowserWindow.fromWebContents(event.sender); await permissionManager.showPermissionDialog(win); return permissionManager.getStatus() } catch(e) { logger.error(`[Permission] show-dialog error: ${e}`); return { granted: 0, total: 8 } } })

  // 检测是否为管理员
  ipcMain.handle('permission:is-admin', async () => { try { return await permissionManager.checkAdminPermission() } catch(e) { logger.error(`[Permission] is-admin error: ${e}`); return false } })

  // 检测注册表读取能力
  ipcMain.handle('permission:registry-check', async () => { try { return await permissionManager.checkRegistryAccess() } catch(e) { logger.error(`[Permission] registry-check error: ${e}`); return false } })

  // 修复特定权限（打开 Windows 设置页面）
  ipcMain.handle('permission:fix', async (_event: any, permissionId: string) => { try { return await permissionManager.fixPermission(permissionId) } catch(e) { logger.error(`[Permission] fix error: ${e}`); return { success: false, message: 'Permission fix failed' } } })

  // 一键修复所有权限
  ipcMain.handle('permission:fix-all', async () => { try { return await permissionManager.fixAllPermissions() } catch(e) { logger.error(`[Permission] fix-all error: ${e}`); return { success: false, message: 'Permission fix-all failed' } } })

  // 获取单个权限详情
  ipcMain.handle('permission:get-detail', async (_event: any, permissionId: string) => { try { const perm = permissionManager.getPermission(permissionId); if (!perm) { return null }; return { ...perm, lastChecked: perm.lastChecked || null } } catch(e) { logger.error(`[Permission] get-detail error: ${e}`); return null } })
}