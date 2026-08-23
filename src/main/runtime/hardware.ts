import { exec } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * 硬件检测模块（环境自适应模型配置）
 * 仅通过运行时探测决定模型是否可用 / 是否上 GPU / 动态 contextSize。
 * 绝不在此硬编码修改任何固定 gpuLayers 数值（如 7B=99 / 14B=22）。
 */

const execAsync = promisify(exec)

export interface HardwareInfo {
  hasDGPU: boolean
  vendor: 'nvidia' | 'amd' | 'intel' | 'unknown'
  gpuName: string
  vramMB: number
  freeMB: number
  detected: boolean
  cpuCores?: number
}

const SMI = 'nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits'

// 模块级 Promise 缓存单例：探测一次，全程复用
let cache: Promise<HardwareInfo> | null = null

export const getHardware = (): Promise<HardwareInfo> => (cache ??= detectHardware())

export async function detectHardware(): Promise<HardwareInfo> {
  const fallback: HardwareInfo = {
    hasDGPU: false,
    vendor: 'unknown',
    gpuName: '无独立显卡（核显/无 GPU）',
    vramMB: 0,
    freeMB: 0,
    detected: false,
  }
  try {
    const { stdout } = (await Promise.race([
      execAsync(SMI),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
    ])) as { stdout: string }

    const vramLines = stdout.trim().split('\n').filter(l => l.trim())
    const totalVRAM = vramLines.reduce((sum, line) => {
      const parts = line.split(',').map(s => s.trim())
      const t = parseInt(parts[1], 10)
      return sum + (Number.isFinite(t) ? t : 0)
    }, 0)
    if (!Number.isFinite(totalVRAM) || totalVRAM <= 0) return fallback
    const freeVRAM = vramLines.reduce((sum, line) => {
      const parts = line.split(',').map(s => s.trim())
      const f = parseInt(parts[2], 10)
      return sum + (Number.isFinite(f) ? f : 0)
    }, 0)
    const firstLine = vramLines[0]
    const firstName = firstLine.split(',')[0].trim()
    const name = vramLines.length > 1 ? `${firstName} ×${vramLines.length}` : firstName
    return {
      hasDGPU: true,
      vendor: 'nvidia',
      gpuName: name || 'NVIDIA GPU',
      vramMB: totalVRAM,
      freeMB: freeVRAM,
      detected: true,
    }
  } catch {
    // nvidia-smi not available, try AMD ROCm
  }

  // 尝试 AMD ROCm
  try {
    const { stdout: rocmOut } = (await Promise.race([
      execAsync('rocm-smi --showmeminfo vram --json'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
    ])) as { stdout: string }
    const cards = JSON.parse(rocmOut)
    if (cards && Object.keys(cards).length > 0) {
      const totalVRAM = Object.values(cards).reduce(
        (sum: number, card: any) => sum + (parseInt(card['VRAM Total Memory (B)']) / (1024 * 1024)),
        0
      )
      return {
        hasDGPU: true,
        vendor: 'amd',
        gpuName: 'AMD GPU',
        vramMB: Math.round(totalVRAM),
        freeMB: 0,
        detected: true,
      }
    }
  } catch { /* rocm-smi not available */ }

  return fallback
}

export const getVramMB = (): Promise<number> => getHardware().then(h => h.vramMB)

export interface ModelRuntime {
  gpuLayers: number
  contextSize: number
  available: boolean
  targetDevice: 'gpu' | 'cpu'
  reason: string
}

/**
 * 根据模型注册信息与运行时硬件，推导本次加载的实际运行时参数。
 * - 7B：有 GPU 且 ≥6GB 上 GPU；否则整体回退 CPU（gpuLayers=0），不改 99 这个固定值。
 * - quality 档（14B）：需 ≥8GB 显存，否则整档禁用（available=false）；gpuLayers 原样透传（22）。
 * - 其余模型：CPU，contextSize 512。
 */
export function resolveModelRuntime(
  model: { id?: string; gpuLayers?: number; tier?: string; mode?: string },
  hw: HardwareInfo,
): ModelRuntime {
  const target = model.gpuLayers ?? 0
  const vram = hw.vramMB
  const hasGPU = hw.hasDGPU
  const fmt = (m: number) => (m >= 1024 ? (m / 1024).toFixed(1) + 'GB' : '无独显')

  // 显式 CPU 模式：固定纯 CPU（gpuLayers=0），不参与 GPU 显存判定
  if (model.mode === 'cpu') {
    return {
      gpuLayers: 0,
      contextSize: 2048,
      available: true,
      targetDevice: 'cpu',
      reason: '显式 CPU 模式',
    }
  }

  if (model.id === 'qwen2-vl-7b') {
    if (hasGPU && vram >= 6144) {
      return {
        gpuLayers: target,
        contextSize: vram >= 12288 ? 8192 : 4096,
        available: true,
        targetDevice: 'gpu',
        reason: '',
      }
    }
    return {
      gpuLayers: 0,
      contextSize: 2048,
      available: true,
      targetDevice: 'cpu',
      reason: hasGPU ? `显存 ${fmt(vram)}<6GB，7B 权重装不下，回退 CPU` : '无独显，7B 走 CPU',
    }
  }

  if (model.tier === 'quality') {
    if (!hasGPU || vram < 8192) {
      return {
        gpuLayers: 0,
        contextSize: 0,
        available: false,
        targetDevice: 'cpu',
        reason: `质量档需 ≥8GB 显存（当前 ${fmt(vram)}），已禁用`,
      }
    }
    return {
      gpuLayers: target,
      contextSize: vram >= 12288 ? 2048 : 1024,
      available: true,
      targetDevice: 'gpu',
      reason: '',
    }
  }

  // === 通用化运行时参数自动分级（不再硬编码模型/档位） ===
  // 根据 hw.vramMB 和 hw.hasDGPU 自动推导 gpuLayers 系数和 contextSize

  if (hasGPU && vram >= 12288) {
    return {
      gpuLayers: target,
      contextSize: 8192,
      available: true,
      targetDevice: 'gpu',
      reason: '',
    }
  }
  if (hasGPU && vram >= 8192) {
    return {
      gpuLayers: Math.max(1, Math.floor(target / 2)),
      contextSize: 4096,
      available: true,
      targetDevice: 'gpu',
      reason: '',
    }
  }
  if (hasGPU && vram >= 6144) {
    // 6GB 档：空闲显存充足（≥5GB 或 AMD 未报告 freeMB）时按 ÷3 缩放；空闲偏紧时降至 ÷4 档并收缩上下文，
    // 避免 29 层 + 2048ctx 在 6GB 卡上 OOM 回退 CPU
    const safe = hw.freeMB >= 5120 || hw.freeMB === 0
    const layers = safe ? Math.max(1, Math.floor(target / 3)) : Math.max(16, Math.floor(target / 4))
    return {
      gpuLayers: layers,
      contextSize: safe ? 2048 : 1024,
      available: true,
      targetDevice: 'gpu',
      reason: safe ? '' : `空闲显存 ${(hw.freeMB / 1024).toFixed(1)}GB 偏紧，降档至 ${layers} 层`,
    }
  }
  if (hasGPU && vram >= 4096) {
    // 4GB 档：÷4 缩放并收缩上下文至 1024，优先保证能上 GPU
    return {
      gpuLayers: Math.max(16, Math.floor(target / 4)),
      contextSize: 1024,
      available: true,
      targetDevice: 'gpu',
      reason: '',
    }
  }

  // 无 GPU / 低于 4GB 显存：CPU fallback
  return {
    gpuLayers: 0,
    contextSize: 1024,
    available: true,
    targetDevice: 'cpu',
    reason: hasGPU ? `显存 ${fmt(vram)}<4GB，回退 CPU` : '无独显，走 CPU',
  }
}
