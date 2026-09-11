import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { totalmem } from 'node:os'

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
  /** 系统物理内存（MB），用于判断 KV offload 到系统内存时上下文可撑到多大而不 OOM */
  ramMB?: number
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
    ramMB: Math.round(totalmem() / 1024 / 1024),
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
      ramMB: Math.round(totalmem() / 1024 / 1024),
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
        ramMB: Math.round(totalmem() / 1024 / 1024),
      }
    }
  } catch { /* rocm-smi not available */ }

  return fallback
}

export const getVramMB = (): Promise<number> => getHardware().then(h => h.vramMB)

/** 上下文容量上限：262144（262K）。KV 已由系统内存承载（--no-kv-offload + q8_0），不再受显存限制。 */
export const MAX_CONTEXT = 262144

/** 钳制到 [1, MAX_CONTEXT]；非法/未显式设置返回 0（表示不覆盖缺省值） */
function clampCtx(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0
  return Math.min(Math.round(v), MAX_CONTEXT)
}

/** 用户显式设定的 contextSize（已按 262144 钳制）；未显式设置返回 0 */
function userCtx(model: { contextSize?: number }): number {
  return clampCtx(model.contextSize ?? 0)
}

/**
 * 按系统内存余量探测可承载的上下文长度（KV offload 到系统内存场景）。
 * 估算法：q8_0 KV ≈ 0.075 MB/token（9B/36 层近似），预留 15% 内存余量；
 * 对齐到 1024 整数倍并钳制到 262144，保证不因 KV 吃爆物理内存而 OOM。
 */
function ramSafeCtx(hw: HardwareInfo, target = MAX_CONTEXT): number {
  const ramMB = hw.ramMB && hw.ramMB > 0 ? hw.ramMB : 16384
  const cap = Math.floor((ramMB * 1000 * 0.85) / 0.075)
  const aligned = Math.max(8192, Math.floor(cap / 1024) * 1024)
  return clampCtx(Math.min(target, aligned))
}

/** 通用缺省值解析：用户显式设置优先（≤262144），否则用缺省值（同样钳制到上限） */
function resolveCtx(model: { contextSize?: number }, fallback: number): number {
  const c = userCtx(model)
  return c > 0 ? c : clampCtx(fallback || 0)
}

/** 内存承载场景缺省值解析：用户显式设置优先，否则按系统内存余量探测可行值（不 OOM 才算数） */
function resolveCtxRamScaled(model: { contextSize?: number }, hw: HardwareInfo): number {
  const c = userCtx(model)
  return c > 0 ? c : ramSafeCtx(hw)
}

export interface ModelRuntime {
  gpuLayers: number
  contextSize: number
  available: boolean
  targetDevice: 'gpu' | 'cpu'
  reason: string
}

/**
 * 模型运行位置（用户显式设置）。
 * - auto：自动（按显存分级自适应，保留原 resolveModelRuntime 缩放逻辑）
 * - cpu：纯 CPU（gpuLayers=0，全部层走内存）
 * - gpu：纯 GPU（全部层 offload 至显存，gpuLayers 直通用户指定值）
 * - layered：分层 offload（gpuLayers 直通用户指定层数，其余层走内存）
 * 显式指定（cpu/gpu/layered）直通用户设置，不被显存自动缩放覆盖。
 */
export type ModelRunLocation = 'auto' | 'cpu' | 'gpu' | 'layered'

/**
 * 根据模型注册信息与运行时硬件，推导本次加载的实际运行时参数。
 * - 显式 runLocation（cpu/gpu/layered）：直通用户设置，不参与显存自动缩放。
 * - auto（默认）：按显存自动分级。
 * - 7B：有 GPU 且 ≥6GB 上 GPU；否则整体回退 CPU（gpuLayers=0），不改 99 这个固定值。
 * - quality 档（14B）：需 ≥8GB 显存，否则整档禁用（available=false）；gpuLayers 原样透传（22）。
 * - 其余模型：CPU，contextSize 512。
 */
export function resolveModelRuntime(
  model: {
    id?: string
    gpuLayers?: number
    tier?: string
    mode?: string
    runLocation?: ModelRunLocation
    contextSize?: number
  },
  hw: HardwareInfo,
): ModelRuntime {
  const target = model.gpuLayers ?? 0
  const vram = hw.vramMB
  const hasGPU = hw.hasDGPU
  const fmt = (m: number) => (m >= 1024 ? (m / 1024).toFixed(1) + 'GB' : '无独显')

  // 显式运行位置（runLocation）：用户手动指定的直通用户设置，不参与显存自动缩放
  const explicit = model.runLocation ?? 'auto'
  if (explicit === 'cpu') {
    return {
      gpuLayers: 0,
      contextSize: resolveCtx(model, 2048),
      available: true,
      targetDevice: 'cpu',
      reason: '显式纯 CPU 运行',
    }
  }
  if (explicit === 'gpu') {
    return {
      gpuLayers: target,
      contextSize: resolveCtx(model, 8192),
      available: true,
      targetDevice: 'gpu',
      reason: '显式纯 GPU 运行（全部层数 offload 至显存）',
    }
  }
  if (explicit === 'layered') {
    return {
      gpuLayers: target,
      contextSize: resolveCtx(model, 8192),
      available: true,
      targetDevice: 'gpu',
      reason: `显式分层运行（${target} 层 offload 至 GPU，其余层走内存）`,
    }
  }

  // 显式 CPU 模式（旧字段兼容）：固定纯 CPU（gpuLayers=0），不参与 GPU 显存判定
  if (model.mode === 'cpu') {
    return {
      gpuLayers: 0,
      contextSize: resolveCtx(model, 2048),
      available: true,
      targetDevice: 'cpu',
      reason: '显式 CPU 模式',
    }
  }

  if (model.id === 'qwen2-vl-7b') {
    if (hasGPU && vram >= 6144) {
      return {
        gpuLayers: target,
        contextSize: resolveCtx(model, vram >= 12288 ? 8192 : 4096),
        available: true,
        targetDevice: 'gpu',
        reason: '',
      }
    }
    return {
      gpuLayers: 0,
      contextSize: resolveCtx(model, 2048),
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
      contextSize: resolveCtx(model, vram >= 12288 ? 2048 : 1024),
      available: true,
      targetDevice: 'gpu',
      reason: '',
    }
  }

  // === 通用化运行时参数自动分级（不再硬编码模型/档位） ===
  // 根据 hw.vramMB 和 hw.hasDGPU 自动推导 gpuLayers 系数和 contextSize

  // === 18B 大模型单独分层策略（实测结论：RTX3060 6GB 下 ngl=16 最快，ngl>20 显存打满降速；16384ctx 稳定） ===
  const isBig18B = typeof model.id === 'string' && model.id.toLowerCase().includes('18b')
  if (isBig18B) {
    if (!hasGPU || vram < 4096) {
      return {
        gpuLayers: 0,
        contextSize: resolveCtx(model, 4096),
        available: true,
        targetDevice: 'cpu',
        reason: hasGPU ? `显存 ${fmt(vram)}<4GB，18B 权重装不下，回退 CPU` : '无独显，18B 走 CPU',
      }
    }
    if (vram >= 12288) {
      return {
        gpuLayers: target,
        contextSize: resolveCtx(model, 16384),
        available: true,
        targetDevice: 'gpu',
        reason: '',
      }
    }
    if (vram >= 8192) {
      return {
        gpuLayers: Math.max(1, Math.min(target, Math.floor(target / 2))),
        contextSize: resolveCtx(model, 16384),
        available: true,
        targetDevice: 'gpu',
        reason: '',
      }
    }
    // 6GB 档：限 16 层（实测 ngl=16 最快，ngl>20 打满显存降速），固定 16384ctx
    const layers = Math.max(12, Math.min(target, 16))
    return {
      gpuLayers: layers,
      contextSize: resolveCtx(model, 16384),
      available: true,
      targetDevice: 'gpu',
      reason: `6GB 显存档，18B 限 ${layers} 层（实测 ngl=16 最快），16384ctx`,
    }
  }

  if (hasGPU && vram >= 12288) {
    return {
      gpuLayers: target,
      contextSize: resolveCtx(model, 8192),
      available: true,
      targetDevice: 'gpu',
      reason: '',
    }
  }
  if (hasGPU && vram >= 8192) {
    return {
      gpuLayers: Math.max(1, Math.floor(target / 2)),
      contextSize: resolveCtx(model, 4096),
      available: true,
      targetDevice: 'gpu',
      reason: '',
    }
  }
  if (hasGPU && vram >= 6144) {
    // 6GB 档：空闲显存充足（≥5GB 或 AMD 未报告 freeMB）时按 ÷3 缩放；空闲偏紧时降至 ÷4 档并收缩上下文，
    // 避免 29 层 + 大 ctx 在 6GB 卡上 OOM 回退 CPU
    const safe = hw.freeMB >= 5120 || hw.freeMB === 0
    const layers = safe ? Math.max(1, Math.floor(target / 3)) : Math.max(16, Math.floor(target / 4))
    // 262K 上下文全开（P0-4 升级）：llama-server 已启用 KV cache offload 到系统内存（--no-kv-offload + q8_0），
    // 显存只装权重，contextSize 由系统内存承载 → 上下文长度不再被 6GB 显存写死在小值。
    // 缺省不写死：按系统内存余量探测可行值（16GB 机 → ~196K，32GB → 满 262144）；
    // 用户/配置显式设置 contextSize（≤262144）则尊重其值。保证超出物理显存的 KV 走内存/CPU 不 OOM。
    const ramCtx = resolveCtxRamScaled(model, hw)
    return {
      gpuLayers: layers,
      contextSize: ramCtx,
      available: true,
      targetDevice: 'gpu',
      reason: safe
        ? `6GB 档：上下文 ${ramCtx}（KV offload 到系统内存，按内存余量得出，不再写死小值）`
        : `空闲显存 ${(hw.freeMB / 1024).toFixed(1)}GB 偏紧，已降档至 ${layers} 层，上下文 ${ramCtx}（KV offload 到系统内存）；可关闭占用显存的其他应用后重启模型以提升性能`,
    }
  }
  if (hasGPU && vram >= 4096) {
    // 4GB 档：÷4 缩放并收缩上下文至 1024，优先保证能上 GPU
    return {
      gpuLayers: Math.max(16, Math.floor(target / 4)),
      contextSize: resolveCtx(model, 1024),
      available: true,
      targetDevice: 'gpu',
      reason: '',
    }
  }

  // 无 GPU / 低于 4GB 显存：CPU fallback
  return {
    gpuLayers: 0,
    contextSize: resolveCtx(model, 1024),
    available: true,
    targetDevice: 'cpu',
    reason: hasGPU ? `显存 ${fmt(vram)}<4GB，回退 CPU` : '无独显，走 CPU',
  }
}
