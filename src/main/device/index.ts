import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'

import { createLogger } from '../utils/logging'
import { POWERSHELL_EXE as POWERSHELL } from '../utils/powershell'
const logger = createLogger('Device')

interface DeviceProfile {
  name: string
  cpu: string
  ram: number
  gpu: string
  vram: number
  storage: string
  tier: 'entry' | 'mid' | 'high' | 'flagship'
}

interface PerformanceConfig {
  maxMemoryUsage: number
  maxVRAMUsage: number
  enableGPU: boolean
  modelQuantization: '4bit' | '5bit' | '8bit' | 'fp16'
  batchSize: number
  contextLength: number
  streamingEnabled: boolean
}

interface PerformanceStats {
  cpu: { usage: number; cores: number }
  memory: { total: number; used: number; free: number }
  gpu: { usage: number; memoryUsed: number; memoryTotal: number; name: string }
  temperature: { cpu: number; gpu: number }
}

class DeviceOptimizer {
  private deviceProfile: DeviceProfile
  private performanceConfig: PerformanceConfig
  private monitorInterval: ReturnType<typeof setInterval> | null = null
  private onThrottle?: (shouldThrottle: boolean) => void
  private detectionPromise: Promise<void> | null = null

  constructor() {
    this.deviceProfile = {
      name: 'Unknown Device',
      cpu: 'Unknown',
      ram: 16,
      gpu: 'Unknown',
      vram: 8,
      storage: 'SSD',
      tier: 'mid'
    }
    this.performanceConfig = this.getOptimalConfig()
    this.loadConfig()
    // 异步后台检测设备，不阻塞启动
    // 记录 Promise 供 waitForReady() 使用
    this.detectionPromise = new Promise(resolve => {
      setImmediate(() => {
        this.detectDevice().then(profile => {
          this.deviceProfile = profile
          this.performanceConfig = this.getOptimalConfig()
        }).catch((e) => { logger.error(`[Device] device detection failed: ${e}`) }).finally(() => resolve())
      })
    })
  }

  // 等待异步检测完成，IPC handler 调用此方法确保读到真实值
  async waitForReady(): Promise<void> {
    await this.detectionPromise
  }

  // 异步获取真实硬件信息，失败时回退到保守默认值
  private async detectDevice(): Promise<DeviceProfile> {
    const profile: DeviceProfile = {
      name: 'Unknown Device',
      cpu: 'Unknown',
      ram: 16,
      gpu: 'Unknown',
      vram: 8,
      storage: 'SSD',
      tier: 'mid'
    }

    try {
      const { execSync } = require('child_process')

      // 尝试获取CPU信息
      try {
        const cpuInfo = execSync(`"${POWERSHELL}" -Command "(Get-CimInstance Win32_Processor).Name"`, { encoding: 'utf-8', timeout: 5000 })
        const cpuName = cpuInfo.trim().split('\n')[0]?.trim()
        if (cpuName) profile.cpu = cpuName
      } catch (e) { logger.error(`[Device] CPU info detection failed: ${e}`) }

      // 尝试获取内存信息（MB转GB）
      try {
        const memInfo = execSync(`"${POWERSHELL}" -Command "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory"`, { encoding: 'utf-8', timeout: 5000 })
        const memBytes = parseInt(memInfo.trim() || '0')
        if (memBytes > 0) profile.ram = Math.round(memBytes / 1024 / 1024 / 1024)
      } catch (e) { logger.error(`[Device] memory info detection failed: ${e}`) }

      // 尝试获取GPU信息（名称 + 真实显存）
      try {
        const gpuNameOut = execSync(`"${POWERSHELL}" -Command "(Get-CimInstance Win32_VideoController).Name"`, { encoding: 'utf-8', timeout: 5000 })
        const gpuName = gpuNameOut.trim().split('\n')[0]?.trim()
        if (gpuName) profile.gpu = gpuName

        // 通过 PowerShell 查询真实显存（AdapterRAM 单位：字节）
        try {
          const vramOut = execSync(`"${POWERSHELL}" -Command "(Get-CimInstance Win32_VideoController).AdapterRAM"`, { encoding: 'utf-8', timeout: 5000 })
          const vramLines = vramOut.trim().split('\n').filter((l: string) => l.trim())
          // 取所有 GPU 显存中的最大值（优先独显）
          let maxVRAM = 0
          for (const line of vramLines) {
            const v = parseInt(line.trim())
            if (Number.isFinite(v) && v > maxVRAM) maxVRAM = v
          }
          if (maxVRAM > 0) {
            profile.vram = Math.round(maxVRAM / 1024 / 1024 / 1024) // bytes → GB
          }
        } catch (e) { logger.error(`[Device] VRAM detection via PowerShell failed: ${e}`) }
      } catch (e) { logger.error(`[Device] GPU info detection failed: ${e}`) }

      // 通用化 tier 分级：基于 vram+ram 组合，不依赖 GPU 名称
      if (profile.ram >= 32 && profile.vram >= 12) {
        profile.tier = 'flagship'
      } else if (profile.ram >= 16 && profile.vram >= 6) {
        profile.tier = 'high'
      } else if (profile.ram >= 8) {
        profile.tier = 'mid'
      } else {
        profile.tier = 'entry'
      }

      profile.name = `${profile.cpu} / ${profile.gpu}`
    } catch (e) {
      logger.error(`[Device] device detection failed: ${e}`)
      // 如果系统命令全部失败，保留保守默认值
    }

    return profile
  }

  private getOptimalConfig(): PerformanceConfig {
    const { tier } = this.deviceProfile

    switch (tier) {
      case 'entry':
        return {
          maxMemoryUsage: 0.6,
          maxVRAMUsage: 0.5,
          enableGPU: true,
          modelQuantization: '4bit',
          batchSize: 1,
          contextLength: 2048,
          streamingEnabled: true
        }
      case 'mid':
        return {
          maxMemoryUsage: 0.7,
          maxVRAMUsage: 0.6,
          enableGPU: true,
          modelQuantization: '4bit',
          batchSize: 2,
          contextLength: 3072,
          streamingEnabled: true
        }
      case 'high':
        return {
          maxMemoryUsage: 0.8,
          maxVRAMUsage: 0.75,
          enableGPU: true,
          modelQuantization: '5bit',
          batchSize: 4,
          contextLength: 4096,
          streamingEnabled: true
        }
      case 'flagship':
        return {
          maxMemoryUsage: 0.9,
          maxVRAMUsage: 0.85,
          enableGPU: true,
          modelQuantization: '8bit',
          batchSize: 8,
          contextLength: 8192,
          streamingEnabled: true
        }
    }
  }

  getDeviceProfile(): DeviceProfile {
    return { ...this.deviceProfile }
  }

  getDeviceInfo() {
    return {
      gpuName: this.deviceProfile.gpu,
      vramGB: this.deviceProfile.vram,
      ramGB: this.deviceProfile.ram,
      cpuCores: this.deviceProfile.tier === 'flagship' ? 16 : this.deviceProfile.tier === 'high' ? 12 : 8,
      hasGPU: this.deviceProfile.vram > 0,
    }
  }

  getPerformanceConfig(): PerformanceConfig {
    return { ...this.performanceConfig }
  }

  updatePerformanceConfig(config: Partial<PerformanceConfig>): void {
    this.performanceConfig = { ...this.performanceConfig, ...config }
    this.saveConfig()
  }

  private saveConfig(): void {
    const configPath = join(app.getPath('userData'), 'device-config.json')
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(configPath, JSON.stringify({
      deviceProfile: this.deviceProfile,
      performanceConfig: this.performanceConfig
    }, null, 2))
  }

  private loadConfig(): void {
    const configPath = join(app.getPath('userData'), 'device-config.json')
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'))
        // 校验配置文件是否匹配当前硬件（跨设备迁移保护）
        const savedProfile = config.deviceProfile as DeviceProfile | undefined
        if (savedProfile) {
          const cpuMatch = savedProfile.cpu === this.deviceProfile.cpu
          const gpuMatch = savedProfile.gpu === this.deviceProfile.gpu
          if (cpuMatch && gpuMatch) {
            this.deviceProfile = savedProfile
          } else {
            logger.warn(`[Device] 配置来自其他设备（CPU: ${savedProfile.cpu} vs ${this.deviceProfile.cpu}, GPU: ${savedProfile.gpu} vs ${this.deviceProfile.gpu}），已清除旧配置`)
            // 删除不匹配的旧配置文件，防止跨设备迁移污染
            try { require('fs').unlinkSync(configPath) } catch (_) { /* ignore */ }
          }
        }
        if (config.performanceConfig) this.performanceConfig = config.performanceConfig
      } catch (e) { logger.error(`[Device] config load failed: ${e}`) }
    }
  }

  async getPerformanceStats(): Promise<PerformanceStats> {
    const stats: PerformanceStats = {
      cpu: { usage: 0, cores: 8 },
      memory: { total: 32, used: 16, free: 16 },
      gpu: { usage: 0, memoryUsed: 0, memoryTotal: 6144, name: 'RTX 3060' },
      temperature: { cpu: 45, gpu: 40 }
    }

    try {
      const { exec } = require('child_process')
      const { promisify } = require('util')
      const execAsync = promisify(exec)

      try {
        const { stdout: cpuOut } = await execAsync(`"${POWERSHELL}" -Command "(Get-Counter \'\\Processor(_Total)\\% Processor Time\').CounterSamples.CookedValue | ForEach-Object { [math]::Round($_) }"`)
        const cpuParts = cpuOut.trim().split('\n')
        stats.cpu.usage = parseInt(cpuParts[0]) || 0
      } catch (e) { logger.error(`[Device] CPU stats fetch failed: ${e}`) }

      try {
        const { stdout: memOut } = await execAsync(`"${POWERSHELL}" -Command "& {$os = Get-CimInstance Win32_OperatingSystem; Write-Output (\"TotalVisibleMemorySize=\" + [math]::Round($os.TotalVisibleMemorySize/1024)); Write-Output (\"FreePhysicalMemory=\" + [math]::Round($os.FreePhysicalMemory/1024))}"`)
        const lines = memOut.split('\n')
        lines.forEach((line: string) => {
          if (line.includes('TotalVisibleMemorySize')) {
            const val = parseInt(line.split('=')[1])
            stats.memory.total = val ? Math.round(val / 1024) : 32
          }
          if (line.includes('FreePhysicalMemory')) {
            const val = parseInt(line.split('=')[1])
            stats.memory.free = val ? Math.round(val / 1024) : 16
          }
        })
        stats.memory.used = stats.memory.total - stats.memory.free
      } catch (e) { logger.error(`[Device] memory stats fetch failed: ${e}`) }

      try {
        const { stdout: gpuOut } = await execAsync('nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits')
        const [usage, memUsed, memTotal] = gpuOut.trim().split(',').map((s: string) => parseInt(s.trim()))
        stats.gpu.usage = usage || 0
        stats.gpu.memoryUsed = memUsed || 0
        stats.gpu.memoryTotal = memTotal || 6144
      } catch (e) { logger.error(`[Device] GPU stats fetch failed: ${e}`) }

      try {
        const { stdout: tempOut } = await execAsync(`"${POWERSHELL}" -Command "$t = Get-CimInstance -Namespace root/wmi MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue; if($t){($t.CurrentTemperature | Select-Object -First 1)-2732}else{450}"`)
        const tempParts = tempOut.trim().split('\n')
        if (tempParts[0]) {
          const temp = parseInt(tempParts[0])
          stats.temperature.cpu = temp ? Math.round(temp / 10) : 45
        }
      } catch (e) { logger.error(`[Device] temperature stats fetch failed: ${e}`) }

    } catch (e) { logger.error(`[Device] performance stats fetch failed: ${e}`) }

    return stats
  }

  async shouldThrottle(): Promise<boolean> {
    const stats = await this.getPerformanceStats()

    const cpuHigh = stats.cpu.usage > 90
    const memHigh = stats.memory.total > 0 && (stats.memory.used / stats.memory.total) > this.performanceConfig.maxMemoryUsage
    const gpuHigh = stats.gpu.usage > 95
    const tempHigh = stats.temperature.cpu > 85 || stats.temperature.gpu > 80

    return cpuHigh || memHigh || gpuHigh || tempHigh
  }

  getRecommendedModels(): Array<{ name: string; size: number; vram: number; quantization: string; tier: string }> {
    const models = [
      { name: 'Qwen2-0.5B', size: 0.4, vram: 0.6, quantization: 'Q4_K_M', tier: 'entry' },
      { name: 'Qwen2-1.5B', size: 1.2, vram: 1.8, quantization: 'Q4_K_M', tier: 'entry' },
      { name: 'Qwen2-1.5B', size: 1.5, vram: 2.2, quantization: 'Q5_K_M', tier: 'mid' },
      { name: 'Qwen2-4B', size: 3.2, vram: 4.8, quantization: 'Q4_K_M', tier: 'mid' },
      { name: 'Qwen2-4B', size: 4.0, vram: 6.0, quantization: 'Q5_K_M', tier: 'high' },
      { name: 'Qwen2-7B', size: 5.6, vram: 8.4, quantization: 'Q4_K_M', tier: 'high' },
      { name: 'Qwen2-7B', size: 6.8, vram: 10.2, quantization: 'Q5_K_M', tier: 'flagship' },
    ]

    const { tier } = this.deviceProfile
    const tierOrder = ['entry', 'mid', 'high', 'flagship']
    const maxTierIndex = tierOrder.indexOf(tier)

    return models.filter(m => tierOrder.indexOf(m.tier) <= maxTierIndex)
  }

  startMonitoring(intervalMs: number = 5000, callback?: (stats: PerformanceStats) => void): void {
    if (this.monitorInterval) {
      clearTimeout(this.monitorInterval)
      this.monitorInterval = null
    }

    const runMonitor = async () => {
      if (!this.monitorInterval) return
      try {
        const stats = await this.getPerformanceStats()
        callback?.(stats)

        const shouldThrottle = await this.shouldThrottle()
        this.onThrottle?.(shouldThrottle)
      } catch (e) {
        logger.error(`Monitoring error: ${e}`)
      }
      if (this.monitorInterval) {
        this.monitorInterval = setTimeout(runMonitor, intervalMs)
      }
    }

    this.monitorInterval = setTimeout(runMonitor, intervalMs)
  }

  stopMonitoring(): void {
    if (this.monitorInterval) {
      clearTimeout(this.monitorInterval)
      this.monitorInterval = null
    }
  }

  setThrottleCallback(callback: (shouldThrottle: boolean) => void): void {
    this.onThrottle = callback
  }

  getMemoryEstimate(requiredVRAM: number): { feasible: boolean; suggestion: string } {
    const { maxVRAMUsage } = this.performanceConfig
    this.getPerformanceStats().then(s => s).catch(() => null)

    const availableVRAM = (this.deviceProfile.vram * maxVRAMUsage)

    if (requiredVRAM <= availableVRAM) {
      return { feasible: true, suggestion: '可以在当前配置下运行' }
    }

    const suggestions = []
    if (this.performanceConfig.modelQuantization !== '4bit') {
      suggestions.push('降低量化等级到4-bit')
    }
    suggestions.push('减少批处理大小')
    suggestions.push('关闭其他占用GPU的程序')

    return {
      feasible: false,
      suggestion: suggestions.join('; ')
    }
  }

  optimizeForPower(mode: 'performance' | 'balanced' | 'saving'): void {
    switch (mode) {
      case 'performance':
        this.performanceConfig.maxMemoryUsage = 0.85
        this.performanceConfig.maxVRAMUsage = 0.8
        break
      case 'balanced':
        this.performanceConfig.maxMemoryUsage = 0.7
        this.performanceConfig.maxVRAMUsage = 0.65
        break
      case 'saving':
        this.performanceConfig.maxMemoryUsage = 0.5
        this.performanceConfig.maxVRAMUsage = 0.4
        break
    }
    this.saveConfig()
  }
}

export const deviceOptimizer = new DeviceOptimizer()

export function setupDeviceOptimizerHandlers(): void {
  const { ipcMain } = require('electron')

  ipcMain.handle('device:profile', () => {
    try {
      return deviceOptimizer.getDeviceProfile()
    } catch (e) {
      logger.error(`device:profile error: ${e}`)
      return null
    }
  })

  ipcMain.handle('device:config', () => {
    try {
      return deviceOptimizer.getPerformanceConfig()
    } catch (e) {
      logger.error(`device:config error: ${e}`)
      return null
    }
  })

  ipcMain.handle('device:update-config', (_event: Electron.IpcMainInvokeEvent, config: Partial<PerformanceConfig>) => {
    try {
      deviceOptimizer.updatePerformanceConfig(config)
      return deviceOptimizer.getPerformanceConfig()
    } catch (e) {
      logger.error(`device:update-config error: ${e}`)
      return null
    }
  })

  ipcMain.handle('device:stats', async () => {
    try {
      return await deviceOptimizer.getPerformanceStats()
    } catch (e) {
      logger.error(`device:stats error: ${e}`)
      return null
    }
  })

  ipcMain.handle('device:should-throttle', async () => {
    try {
      return await deviceOptimizer.shouldThrottle()
    } catch (e) {
      logger.error(`device:should-throttle error: ${e}`)
      return false
    }
  })

  ipcMain.handle('device:recommended-models', () => {
    try {
      return deviceOptimizer.getRecommendedModels()
    } catch (e) {
      logger.error(`device:recommended-models error: ${e}`)
      return []
    }
  })

  ipcMain.handle('device:start-monitoring', (_event: Electron.IpcMainInvokeEvent, intervalMs: number) => {
    try {
      if (typeof intervalMs !== 'number' || intervalMs < 1000) {
        return { success: false, error: 'intervalMs must be >= 1000' }
      }
      deviceOptimizer.startMonitoring(intervalMs)
      return { success: true }
    } catch (e) {
      logger.error(`device:start-monitoring error: ${e}`)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('device:stop-monitoring', () => {
    try {
      deviceOptimizer.stopMonitoring()
      return { success: true }
    } catch (e) {
      logger.error(`device:stop-monitoring error: ${e}`)
      return { success: false }
    }
  })

  ipcMain.handle('device:optimize-power', (_event: Electron.IpcMainInvokeEvent, mode: 'performance' | 'balanced' | 'saving') => {
    try {
      deviceOptimizer.optimizeForPower(mode)
      return { success: true }
    } catch (e) {
      logger.error(`device:optimize-power error: ${e}`)
      return { success: false }
    }
  })

  ipcMain.handle('device:memory-estimate', (_event: Electron.IpcMainInvokeEvent, requiredVRAM: number) => {
    try {
      return deviceOptimizer.getMemoryEstimate(requiredVRAM)
    } catch (e) {
      logger.error(`device:memory-estimate error: ${e}`)
      return { feasible: false, suggestion: '估算失败' }
    }
  })
}
