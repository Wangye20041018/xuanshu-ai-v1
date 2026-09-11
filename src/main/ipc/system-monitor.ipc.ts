import { ipcMain } from 'electron'
import { exec } from 'child_process'
import { promisify } from 'util'
import { POWERSHELL_EXE } from '../utils/powershell'

const execAsync = promisify(exec)

/* ============================================================
 * 系统监控 IPC — 实时采集 GPU / CPU / 内存 / 磁盘 / Token 统计
 * 通过 PowerShell + nvidia-smi 获取 Windows 原生指标
 * ============================================================ */

export interface GpuStats {
  name: string
  usage: number           // GPU 使用率 0-100
  temperature: number     // 摄氏度
  memoryUsedMB: number    // 已用显存 MB
  memoryTotalMB: number   // 总显存 MB
  powerWatts: number      // 功耗 W
}

export interface CpuStats {
  usage: number           // 总 CPU 使用率 0-100
  cores: number           // 逻辑核心数
}

export interface MemoryStats {
  totalMB: number
  usedMB: number
  freeMB: number
  usagePct: number
}

export interface DiskStats {
  readMBps: number
  writeMBps: number
}

export interface TokenStats {
  inputTokens: number
  outputTokens: number
  tokensPerSec: number          // 最近一次推理
  tokPerSecAvg10: number        // 最近 10 次平均
}

export interface SystemSnapshot {
  timestamp: number
  gpu: GpuStats | null
  cpu: CpuStats
  memory: MemoryStats
  disk: DiskStats
  tokens: TokenStats
}

/* ------------------------------------------------------------------
 * 低开销 PowerShell 采集
 * ------------------------------------------------------------------ */
async function getGpuStats(): Promise<GpuStats | null> {
  try {
    // M-23 修复：execSync 阻塞主进程事件循环，改用异步 exec
    const { stdout } = await execAsync(
      `"${POWERSHELL_EXE}" -NoProfile -Command "& { $g = Get-CimInstance Win32_VideoController | Select-Object -First 1; Write-Host \"name=$($g.Name)\"; }; $n = & 'nvidia-smi' --query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw --format=csv,noheader,nounits 2>$null; if ($n) { Write-Host $n }"`,
      { encoding: 'utf-8', timeout: 8000, maxBuffer: 4 * 1024 * 1024 }
    )
    const out = stdout

    const lines = out.trim().split('\n').map(l => l.trim()).filter(Boolean)
    let name = ''
    let nvidiaLine = ''

    for (const line of lines) {
      if (line.startsWith('name=')) {
        name = line.replace('name=', '').trim()
      } else if (line.includes(',')) {
        nvidiaLine = line
      }
    }

    if (!nvidiaLine) return null

    const parts = nvidiaLine.split(',').map(s => s.trim())
    return {
      name: name || 'NVIDIA GPU',
      usage: parseFloat(parts[0]) || 0,
      temperature: parseFloat(parts[1]) || 0,
      memoryUsedMB: parseFloat(parts[2]) || 0,
      memoryTotalMB: parseFloat(parts[3]) || 0,
      powerWatts: parseFloat(parts[4]) || 0,
    }
  } catch {
    return null
  }
}

async function getCpuStats(): Promise<CpuStats> {
  try {
    // M-23 修复：execSync 阻塞主进程事件循环，改用异步 exec
    const { stdout } = await execAsync(
      `"${POWERSHELL_EXE}" -NoProfile -Command "(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average"`,
      { encoding: 'utf-8', timeout: 5000 }
    )
    const usage = parseFloat(stdout.trim()) || 0
    const cores = require('os').cpus().length
    return { usage, cores }
  } catch {
    return { usage: 0, cores: require('os').cpus().length }
  }
}

function getMemoryStats(): MemoryStats {
  try {
    const os = require('os')
    const totalMB = Math.round(os.totalmem() / 1048576)
    const freeMB = Math.round(os.freemem() / 1048576)
    const usedMB = totalMB - freeMB
    const usagePct = totalMB > 0 ? Math.round((usedMB / totalMB) * 1000) / 10 : 0
    return { totalMB, usedMB, freeMB, usagePct }
  } catch {
    return { totalMB: 0, usedMB: 0, freeMB: 0, usagePct: 0 }
  }
}

async function getDiskStats(): Promise<DiskStats> {
  try {
    // M-23 修复：execSync 阻塞主进程事件循环，改用异步 exec
    const { stdout } = await execAsync(
      `"${POWERSHELL_EXE}" -NoProfile -Command "$d = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Where-Object { $_.Name -eq '_Total' } | Select-Object DiskReadBytesPersec, DiskWriteBytesPersec; Write-Host \"$($d.DiskReadBytesPersec),$($d.DiskWriteBytesPersec)\""`,
      { encoding: 'utf-8', timeout: 5000 }
    )
    const parts = stdout.trim().split(',')
    const readBps = parseFloat(parts[0]) || 0
    const writeBps = parseFloat(parts[1]) || 0
    return {
      readMBps: Math.round((readBps / 1048576) * 10) / 10,
      writeMBps: Math.round((writeBps / 1048576) * 10) / 10,
    }
  } catch {
    return { readMBps: 0, writeMBps: 0 }
  }
}

/* ------------------------------------------------------------------
 * Token 统计（内存中累积，IPC 接口上报/重置）
 * ------------------------------------------------------------------ */
let sessionTokenStats: TokenStats = {
  inputTokens: 0,
  outputTokens: 0,
  tokensPerSec: 0,
  tokPerSecAvg10: 0,
}

const recentTokPerSec: number[] = []

function recordInference(inputTokens: number, outputTokens: number, durationMs: number): void {
  sessionTokenStats.inputTokens += inputTokens
  sessionTokenStats.outputTokens += outputTokens

  if (durationMs > 0 && outputTokens > 0) {
    const tps = (outputTokens / durationMs) * 1000
    recentTokPerSec.push(tps)
    if (recentTokPerSec.length > 10) recentTokPerSec.shift()

    sessionTokenStats.tokensPerSec = Math.round(tps * 10) / 10
    sessionTokenStats.tokPerSecAvg10 =
      Math.round((recentTokPerSec.reduce((a, b) => a + b, 0) / recentTokPerSec.length) * 10) / 10
  }
}

// @ts-expect-error TS6133 — retained for future monitoring use
let prevSnapshot: SystemSnapshot | null = null

/**
 * 快照历史（内存累积，供“系统监控”图表真实回放）
 * 上限 120 条：按 2 秒采样可覆盖最近 4 分钟
 */
const snapshotHistory: SystemSnapshot[] = []
const SNAPSHOT_HISTORY_LIMIT = 120

async function captureSnapshot(): Promise<SystemSnapshot> {
  const gpu = await getGpuStats()
  const cpu = await getCpuStats()
  const memory = getMemoryStats()
  const disk = await getDiskStats()

  const snap: SystemSnapshot = {
    timestamp: Date.now(),
    gpu,
    cpu,
    memory,
    disk,
    tokens: { ...sessionTokenStats },
  }

  snapshotHistory.push(snap)
  if (snapshotHistory.length > SNAPSHOT_HISTORY_LIMIT) snapshotHistory.shift()

  prevSnapshot = snap
  return snap
}

/* ------------------------------------------------------------------
 * 设置 IPC 处理器
 * ------------------------------------------------------------------ */
export function setupSystemMonitorHandlers(): void {
  ipcMain.handle('system:snapshot', async () => {
    return captureSnapshot()
  })

  // 覆盖 system.ipc.ts 中同名空壳：返回真实累积快照历史（渲染层“系统监控”图表数据源）
  ipcMain.removeHandler('system:snapshots')
  ipcMain.handle('system:snapshots', (_event, params?: { limit?: number }) => {
    const limit = Math.min(120, Math.max(1, params?.limit ?? 60))
    return snapshotHistory.slice(-limit)
  })

  ipcMain.handle('system:token:record', (_event, inputTokens: number, outputTokens: number, durationMs: number) => {
    recordInference(inputTokens, outputTokens, durationMs)
    return { ...sessionTokenStats }
  })

  ipcMain.handle('system:token:stats', () => {
    return { ...sessionTokenStats }
  })

  ipcMain.handle('system:token:reset', () => {
    sessionTokenStats = {
      inputTokens: 0,
      outputTokens: 0,
      tokensPerSec: 0,
      tokPerSecAvg10: 0,
    }
    recentTokPerSec.length = 0
    return { ...sessionTokenStats }
  })
}
