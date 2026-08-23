/**
 * 性能性能分析器 — v1.0
 * 监控：FPS（渲染进程上报）、主线程空闲率、内存（OS + GPU）
 *
 * IPC 通道：
 *   perf:fps-report     — 渲染进程上报 FPS 数据
 *   perf:get-stats      — 拉取完整性能快照
 *   perf:idle-snapshot  — 主线程空闲率快照
 */

import {ipcMain} from 'electron'

interface FpsSample {
  fps: number
  timestamp: number
}

interface PerfStats {
  fps: { current: number; avg: number; min: number; max: number; samples: number }
  mainThread: { idlePercent: number; busyMs: number; idleMs: number }
  memory: {
    os: { rssMB: number; heapTotalMB: number; heapUsedMB: number; externalMB: number }
    gpu: { deviceName: string; usedMB: number; totalMB: number; usagePercent: number } | null
  }
  timestamp: number
}

class PerformanceProfiler {
  private fpsSamples: FpsSample[] = []
  private readonly MAX_FPS_SAMPLES = 60
  private collecting = false
  private lastCpuUsage: NodeJS.CpuUsage | null = null
  private lastCpuTime: number = 0
  private idlePercent = 100
  private cpuIdleTimer: NodeJS.Timeout | null = null

  /** 启动 FPS 收集（由渲染进程通过 perf:fps-report 上报） */
  start(): void {
    if (this.collecting) return
    this.collecting = true

    // 主线程空闲率：每 2s 采样一次
    this.lastCpuUsage = process.cpuUsage()
    this.lastCpuTime = Date.now()
    this.cpuIdleTimer = setInterval(() => this.sampleCpuIdle(), 2000)
  }

  /** 停止采样并释放定时器 */
  stop(): void {
    if (this.cpuIdleTimer) {
      clearInterval(this.cpuIdleTimer)
      this.cpuIdleTimer = null
    }
    this.collecting = false
  }

  /** 渲染进程上报 FPS */
  recordFps(fps: number): void {
    this.fpsSamples.push({ fps, timestamp: Date.now() })
    if (this.fpsSamples.length > this.MAX_FPS_SAMPLES) {
      this.fpsSamples.shift()
    }
  }

  /** 计算 FPS 统计 */
  private getFpsStats() {
    const samples = this.fpsSamples.slice(-30) // 最近 30 帧
    if (samples.length === 0) return { current: 0, avg: 0, min: 0, max: 0, samples: 0 }

    const values = samples.map(s => s.fps)
    return {
      current: values[values.length - 1],
      avg: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
      min: Math.min(...values),
      max: Math.max(...values),
      samples: values.length
    }
  }

  /** 采样 CPU 空闲率 */
  private sampleCpuIdle(): void {
    if (!this.lastCpuUsage) return
    const now = Date.now()
    const elapsed = now - this.lastCpuTime
    const usage = process.cpuUsage(this.lastCpuUsage)
    const totalCpuMicros = usage.user + usage.system
    const cpuPercent = (totalCpuMicros / 1000) / elapsed * 100 // 单线程占比
    this.idlePercent = Math.max(0, Math.min(100, 100 - cpuPercent))
    this.lastCpuUsage = process.cpuUsage()
    this.lastCpuTime = now
  }

  /** 获取 OS 内存 */
  private getOsMemory() {
    const mem = process.memoryUsage()
    return {
      rssMB: Math.round(mem.rss / 1048576),
      heapTotalMB: Math.round(mem.heapTotal / 1048576),
      heapUsedMB: Math.round(mem.heapUsed / 1048576),
      externalMB: Math.round(mem.external / 1048576)
    }
  }

  /** 获取 GPU 显存（nvidia-smi 或 SGLang API） */
  private async getGpuMemory(): Promise<PerfStats['memory']['gpu']> {
    // 方法1：nvidia-smi
    try {
      const { execSync } = await import('child_process')
      const result = execSync(
        'nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits',
        { timeout: 5000, encoding: 'utf-8' }
      )
      const parts = result.trim().split(',').map(p => p.trim())
      if (parts.length >= 4) {
        return {
          deviceName: parts[0],
          usedMB: parseInt(parts[1], 10) || 0,
          totalMB: parseInt(parts[2], 10) || 0,
          usagePercent: parseInt(parts[3], 10) || 0
        }
      }
    } catch {
      // nvidia-smi 不可用
    }

    // 方法2：SGLang API
    try {
      const resp = await fetch('http://127.0.0.1:30000/health', { signal: AbortSignal.timeout(3000) })
      if (resp.ok) {
        return { deviceName: 'SGLang GPU', usedMB: 0, totalMB: 0, usagePercent: 0 }
      }
    } catch {
      // SGLang 未运行
    }

    return null
  }

  /** 生成完整统计快照 */
  async getStats(): Promise<PerfStats> {
    const [gpu] = await Promise.all([this.getGpuMemory()])
    return {
      fps: this.getFpsStats(),
      mainThread: {
        idlePercent: Math.round(this.idlePercent),
        busyMs: Math.round((100 - this.idlePercent) * 10),
        idleMs: Math.round(this.idlePercent * 10)
      },
      memory: {
        os: this.getOsMemory(),
        gpu
      },
      timestamp: Date.now()
    }
  }
}

export const performanceProfiler = new PerformanceProfiler()

/** 注册性能相关的 IPC handlers（在 setupWindowHandlers 附近调用） */
export function setupPerfHandlers(): void {
  // 渲染进程上报 FPS
  ipcMain.handle('perf:fps-report', (_event, fps: number) => {
    performanceProfiler.recordFps(fps)
    return true
  })

  // 拉取完整性能快照
  ipcMain.handle('perf:get-stats', async () => {
    return performanceProfiler.getStats()
  })
}
