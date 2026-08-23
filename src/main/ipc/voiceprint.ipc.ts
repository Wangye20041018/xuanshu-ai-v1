/**
 * voiceprint.ipc.ts — 声纹识别 IPC Handler v2.0
 *
 * v2.0 升级：
 * - 使用 Python MFCC 桥接脚本进行特征提取（13维 MFCC 系数）
 * - 回退到简单统计特征（Python 不可用时）
 * - 集成噪声检测（环境噪音过滤）
 * - 多样本验证取最高分，降低误拒率
 *
 * 数据流：
 *   音频输入 → 噪声检测 → MFCC 特征提取 → 余弦相似度匹配 → 验证结果
 */

import { ipcMain } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { app } from 'electron'
import { getStore } from './config.ipc'
import { pythonRuntime } from '../runtime/python'
import { createLogger } from '../utils/logging'

const logger = createLogger('voiceprint')

/* ============================================================
 * 类型定义
 * ============================================================ */

interface VoiceprintSample {
  id: string
  features: number[]          // MFCC 均值特征向量（13维）
  label?: string
  enrolledAt: number
  /** 特征提取方式 */
  featureType: 'mfcc' | 'simple'
  /** 音频时长（秒） */
  durationSec?: number
  /** RMS 能量 */
  rmsEnergy?: number
}

interface VoiceprintData {
  samples: VoiceprintSample[]
  enrolledAt: number
  /** 噪声过滤配置 */
  noiseFilter: {
    enabled: boolean
    level: number             // 1-5
    rmsThreshold: number      // 自动计算的 RMS 阈值
  }
}

interface VoiceprintStatus {
  enrolled: boolean
  sampleCount: number
  enrolledAt: number | null
  samples: Array<{ id: string; label: string; enrolledAt: number; featureType: string }>
  noiseFilter: { enabled: boolean; level: number }
  mfccAvailable: boolean
}

/* ============================================================
 * Python 桥接调用
 * ============================================================ */

/** 获取 voiceprint_bridge.py 脚本路径 */
function getBridgeScriptPath(): string {
  // 开发环境路径
  const devPath = join(app.getAppPath(), 'scripts', 'voiceprint_bridge.py')
  if (existsSync(devPath)) return devPath

  // 打包环境路径
  const packedPath = join(process.resourcesPath, 'scripts', 'voiceprint_bridge.py')
  if (existsSync(packedPath)) return packedPath

  return devPath // 回退，让后续错误处理
}

/** 调用 Python 桥接脚本 */
async function callPythonBridge(command: string, args: string[]): Promise<any> {
  const pythonPath = pythonRuntime.getPythonPath()
  const scriptPath = getBridgeScriptPath()

  if (!existsSync(scriptPath)) {
    throw new Error(`voiceprint_bridge.py 未找到: ${scriptPath}`)
  }

  const { spawn } = require('child_process')
  return new Promise((resolve, reject) => {
    const allArgs = [scriptPath, command, ...args]
    const child = spawn(pythonPath, allArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('Python 桥接超时 (30s)'))
    }, 30000)

    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString('utf-8') })
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString('utf-8') })

    child.on('close', (code: number) => {
      clearTimeout(timer)
      if (code === 0) {
        try {
          const result = JSON.parse(stdout.trim().split('\n').pop() || '{}')
          resolve(result)
        } catch {
          reject(new Error(`JSON 解析失败: ${stdout.slice(-200)}`))
        }
      } else {
        reject(new Error(stderr || `Exit code: ${code}`))
      }
    })

    child.on('error', (err: Error) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** 检查 MFCC 桥接是否可用 */
let mfccAvailableCache: boolean | null = null
async function checkMfccAvailable(): Promise<boolean> {
  if (mfccAvailableCache !== null) return mfccAvailableCache

  try {
    if (!pythonRuntime.isReady()) {
      mfccAvailableCache = false
      return false
    }
    const result = await callPythonBridge('version', [])
    mfccAvailableCache = result?.version ? true : false
    logger.info(`[voiceprint] MFCC 桥接可用: ${mfccAvailableCache}, numpy: ${result?.numpy_available}`)
  } catch (e) {
    logger.warn(`[voiceprint] MFCC 桥接不可用: ${e}`)
    mfccAvailableCache = false
  }

  return mfccAvailableCache
}

/* ============================================================
 * 音频文件写入辅助
 * ============================================================ */

/**
 * 将 Float32Array 写入临时 WAV 文件
 */
function writeWavFile(filePath: string, audio: Float32Array, sampleRate: number = 16000): void {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = audio.length * (bitsPerSample / 8)
  const headerSize = 44

  const buffer = Buffer.alloc(headerSize + dataSize)

  // RIFF header
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)

  // fmt chunk
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(numChannels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)

  // data chunk
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)

  for (let i = 0; i < audio.length; i++) {
    const sample = Math.max(-1, Math.min(1, audio[i]))
    const intSample = sample < 0 ? sample * 32768 : sample * 32767
    buffer.writeInt16LE(intSample, headerSize + i * 2)
  }

  writeFileSync(filePath, buffer)
}

/**
 * 将音频写入临时文件
 */
function writeTempWav(audioData: Float32Array, sampleRate: number = 16000): string {
  const tempDir = join(app.getPath('userData'), 'temp')
  mkdirSync(tempDir, { recursive: true })
  const wavPath = join(tempDir, `vp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.wav`)
  writeWavFile(wavPath, audioData, sampleRate)
  return wavPath
}

/* ============================================================
 * 简单统计特征提取（回退方案）
 * ============================================================ */

function computeSimpleFeatures(audioData: Float32Array): number[] {
  const N = audioData.length
  if (N === 0) return new Array(32).fill(0)

  let sum = 0, sumSq = 0, zeroCrossCount = 0
  for (let i = 0; i < N; i++) {
    sum += audioData[i]
    sumSq += audioData[i] * audioData[i]
    if (i > 0 && (audioData[i] >= 0) !== (audioData[i - 1] >= 0)) zeroCrossCount++
  }
  const mean = sum / N
  const variance = (sumSq / N) - (mean * mean)
  const rms = Math.sqrt(Math.max(0, sumSq / N))
  const zcr = zeroCrossCount / (N - 1)

  const segSize = Math.floor(N / 8)
  const segMeans: number[] = []
  for (let s = 0; s < 8; s++) {
    const start = s * segSize, end = s === 7 ? N : (s + 1) * segSize
    let segSum = 0
    for (let i = start; i < end; i++) segSum += audioData[i]
    segMeans.push(segSum / (end - start))
  }

  const segKurt: number[] = []
  for (let s = 0; s < 8; s++) {
    const start = s * segSize, end = s === 7 ? N : (s + 1) * segSize
    const cnt = end - start
    let segSum = 0, segSumSq = 0
    for (let i = start; i < end; i++) { segSum += audioData[i]; segSumSq += audioData[i] * audioData[i] }
    const sMean = segSum / cnt
    const sVar = (segSumSq / cnt) - (sMean * sMean)
    let m4 = 0
    for (let i = start; i < end; i++) m4 += Math.pow(audioData[i] - sMean, 4)
    segKurt.push(sVar > 1e-10 ? (m4 / cnt) / (sVar * sVar) : 0)
  }

  const segMag: number[] = []
  for (let s = 0; s < 8; s++) {
    const start = s * segSize, end = s === 7 ? N : (s + 1) * segSize
    let magSum = 0
    for (let i = start; i < end; i++) magSum += Math.abs(audioData[i])
    segMag.push(magSum / (end - start))
  }

  return [mean, variance, rms, zcr, ...segMeans, ...segKurt, ...segMag, ...Array(4).fill(0)]
}

/**
 * 余弦相似度
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  if (denom < 1e-12) return 0
  return Math.max(-1, Math.min(1, dot / denom))
}

function generateSampleId(): string {
  return `vp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/* ============================================================
 * 噪声检测
 * ============================================================ */

/**
 * 简单 RMS 能量噪声检测（本地回退）
 */
function computeRMSEnergy(audio: Float32Array): number {
  if (audio.length === 0) return 0
  let sumSq = 0
  for (let i = 0; i < audio.length; i++) sumSq += audio[i] * audio[i]
  return Math.sqrt(sumSq / audio.length)
}

/**
 * 检测音频是否为噪声/静音
 */
async function checkNoise(audioData: Float32Array): Promise<{ isNoise: boolean; rms: number; reason: string }> {
  try {
    const wavPath = writeTempWav(audioData)
    try {
      const result = await callPythonBridge('noise-check', [wavPath])
      return {
        isNoise: result?.is_noise ?? false,
        rms: result?.rms ?? computeRMSEnergy(audioData),
        reason: result?.reason ?? 'unknown',
      }
    } finally {
      try { unlinkSync(wavPath) } catch { /* ignore */ }
    }
  } catch {
    // 回退到本地 RMS 检测
    const rms = computeRMSEnergy(audioData)
    const store = getStore()
    const vp = store.get('voiceprint') as VoiceprintData | undefined
    const threshold = vp?.noiseFilter?.rmsThreshold ?? 0.01
    return {
      isNoise: rms < threshold,
      rms,
      reason: rms < threshold ? 'low_energy' : 'ok',
    }
  }
}

/* ============================================================
 * 特征提取（MFCC 优先，回退简单特征）
 * ============================================================ */

async function extractFeatures(audioData: Float32Array): Promise<{
  features: number[]
  featureType: 'mfcc' | 'simple'
  durationSec: number
  rmsEnergy: number
}> {
  const rmsEnergy = computeRMSEnergy(audioData)
  const durationSec = audioData.length / 16000

  // 尝试 MFCC 提取
  if (await checkMfccAvailable()) {
    try {
      const wavPath = writeTempWav(audioData)
      try {
        const result = await callPythonBridge('extract', [wavPath])
        if (result?.status === 'ok' && result?.mfcc_mean?.length > 0) {
          logger.debug(`[voiceprint] MFCC 提取成功: ${result.mfcc_mean.length}维, ${result.num_frames}帧`)
          return {
            features: result.mfcc_mean,
            featureType: 'mfcc',
            durationSec: result.duration_sec ?? durationSec,
            rmsEnergy: result.rms_energy ?? rmsEnergy,
          }
        }
        logger.warn(`[voiceprint] MFCC 提取返回异常: ${JSON.stringify(result)}`)
      } finally {
        try { unlinkSync(wavPath) } catch { /* ignore */ }
      }
    } catch (e) {
      logger.warn(`[voiceprint] MFCC 提取失败，回退简单特征: ${e}`)
    }
  }

  // 回退到简单统计特征
  return {
    features: computeSimpleFeatures(audioData),
    featureType: 'simple',
    durationSec,
    rmsEnergy,
  }
}

/* ============================================================
 * IPC Handler 注册
 * ============================================================ */

/**
 * v2.3: 可复用的声纹验证函数（供 voice-engine 直接调用）
 *
 * 流程：
 *   1. 噪声检测 → 过滤环境噪音
 *   2. MFCC 特征提取 → 获取说话人声学特征
 *   3. 多样本余弦相似度匹配 → 识别用户声音，踢出他人声音
 */
export async function verifyVoiceprintDirect(audioData: Float32Array): Promise<{
  match: boolean
  score: number
  reason: string
  bestSampleId: string
  featureType?: string
  noiseInfo?: { isNoise: boolean; rms: number; reason: string }
}> {
  const store = getStore()
  const vp = store.get('voiceprint') as VoiceprintData | undefined

  if (!vp?.samples || vp.samples.length === 0) {
    return { match: false, score: 0, reason: 'not_enrolled', bestSampleId: '' }
  }

  try {
    // 1. 噪声检测
    const noiseResult = await checkNoise(audioData)
    if (noiseResult.isNoise && vp.noiseFilter?.enabled) {
      return {
        match: false,
        score: 0,
        reason: `noise:${noiseResult.reason}`,
        bestSampleId: '',
        noiseInfo: noiseResult,
      }
    }

    // 2. 特征提取
    const { features: inputFeatures, featureType } = await extractFeatures(audioData)

    // 3. 多样本匹配（取最高分）
    let bestScore = -1, bestSampleId = ''
    for (const sample of vp.samples) {
      const score = cosineSimilarity(inputFeatures, sample.features)
      if (score > bestScore) { bestScore = score; bestSampleId = sample.id }
    }

    // MFCC 特征阈值更高（区分度更好），简单特征阈值较低
    const threshold = featureType === 'mfcc' ? 0.65 : 0.6
    const match = bestScore > threshold

    if (!match) {
      logger.debug(`[voiceprint] 验证失败: score=${bestScore.toFixed(3)} < threshold=${threshold}, featureType=${featureType}`)
    }

    return {
      match,
      score: Math.round(bestScore * 10000) / 10000,
      reason: match ? 'ok' : 'mismatch',
      bestSampleId,
      featureType,
      noiseInfo: noiseResult,
    }
  } catch (e: any) {
    logger.error(`[voiceprint] 验证异常: ${e.message}`)
    return { match: false, score: 0, reason: 'error', bestSampleId: '' }
  }
}

export function setupVoiceprintHandlers(): void {
  /* ---------- 状态查询 ---------- */
  ipcMain.handle('voiceprint:status', async () => {
    const store = getStore()
    const vp = store.get('voiceprint') as VoiceprintData | undefined
    const mfccAvailable = await checkMfccAvailable()

    const status: VoiceprintStatus = {
      enrolled: !!(vp?.samples && vp.samples.length > 0),
      sampleCount: vp?.samples?.length ?? 0,
      enrolledAt: vp?.enrolledAt ?? null,
      samples: (vp?.samples ?? []).map(s => ({
        id: s.id,
        label: s.label || '未命名',
        enrolledAt: s.enrolledAt,
        featureType: s.featureType || 'simple',
      })),
      noiseFilter: {
        enabled: vp?.noiseFilter?.enabled ?? false,
        level: vp?.noiseFilter?.level ?? 3,
      },
      mfccAvailable,
    }

    return status
  })

  /* ---------- 多样本声纹注册 ---------- */
  ipcMain.handle('voiceprint:enroll', async (_event, payload: { audioData?: Float32Array; label?: string }) => {
    const audioData = (payload as any) instanceof Float32Array
      ? (payload as Float32Array)
      : payload?.audioData

    if (!audioData || audioData.length === 0) {
      return { success: false, error: '音频数据为空' }
    }

    try {
      // 噪声检测
      const noiseResult = await checkNoise(audioData)
      if (noiseResult.isNoise) {
        return {
          success: false,
          error: `音频质量不足（${noiseResult.reason}），请靠近麦克风清晰朗读`,
          noiseInfo: noiseResult,
        }
      }

      // 提取特征
      const { features, featureType, durationSec, rmsEnergy } = await extractFeatures(audioData)

      const store = getStore()
      let vp = store.get('voiceprint') as VoiceprintData | undefined

      if (!vp?.samples) {
        vp = {
          samples: [],
          enrolledAt: Date.now(),
          noiseFilter: { enabled: false, level: 3, rmsThreshold: 0.01 },
        }
      }

      const label = (payload as any)?.label || `样本${vp.samples.length + 1}`

      vp.samples.push({
        id: generateSampleId(),
        features,
        label,
        enrolledAt: Date.now(),
        featureType,
        durationSec,
        rmsEnergy,
      })

      // 自动更新噪声阈值（基于所有样本的平均 RMS 的 30%）
      if (vp.samples.length > 0) {
        const avgRms = vp.samples.reduce((sum, s) => sum + (s.rmsEnergy || 0), 0) / vp.samples.length
        vp.noiseFilter.rmsThreshold = Math.max(0.005, avgRms * 0.3)
      }

      store.set('voiceprint', vp)
      logger.info(`[voiceprint] 已注册新样本 "${label}" (${featureType}), 共 ${vp.samples.length} 个, RMS=${rmsEnergy.toFixed(4)}`)
      return {
        success: true,
        sampleCount: vp.samples.length,
        featureType,
        rmsEnergy: Math.round(rmsEnergy * 10000) / 10000,
      }
    } catch (e: any) {
      logger.error(`[voiceprint] 注册失败: ${e.message}`)
      return { success: false, error: `声纹注册失败: ${e.message}` }
    }
  })

  /* ---------- 声纹验证 IPC ---------- */
  ipcMain.handle('voiceprint:verify', async (_event, audioData: Float32Array) => {
    return verifyVoiceprintDirect(audioData)
  })

  /* ---------- 快速噪声检测 ---------- */
  ipcMain.handle('voiceprint:noise-check', async (_event, audioData: Float32Array) => {
    try {
      return await checkNoise(audioData)
    } catch (e: any) {
      return { isNoise: false, rms: 0, reason: 'error' }
    }
  })

  /* ---------- 噪声过滤设置 ---------- */
  ipcMain.handle('voiceprint:noise-filter', async (_event, enabled: boolean) => {
    const store = getStore()
    const vp = store.get('voiceprint') as VoiceprintData | undefined
    if (!vp) {
      store.set('voiceprint', {
        samples: [],
        enrolledAt: 0,
        noiseFilter: { enabled, level: 3, rmsThreshold: 0.01 },
      })
    } else {
      vp.noiseFilter = vp.noiseFilter || { enabled: false, level: 3, rmsThreshold: 0.01 }
      vp.noiseFilter.enabled = enabled
      store.set('voiceprint', vp)
    }
    return { success: true, enabled }
  })

  ipcMain.handle('voiceprint:noise-level', async (_event, level: number) => {
    const store = getStore()
    const vp = store.get('voiceprint') as VoiceprintData | undefined
    if (vp) {
      vp.noiseFilter = vp.noiseFilter || { enabled: false, level: 3, rmsThreshold: 0.01 }
      vp.noiseFilter.level = Math.max(1, Math.min(5, level))
      // 根据等级调整阈值
      const thresholds = [0.02, 0.015, 0.01, 0.007, 0.005]
      vp.noiseFilter.rmsThreshold = thresholds[level - 1] || 0.01
      store.set('voiceprint', vp)
    }
    return { success: true, level }
  })

  /* ---------- 清除所有声纹 ---------- */
  ipcMain.handle('voiceprint:clear', async () => {
    const store = getStore()
    store.delete('voiceprint')
    logger.info('[voiceprint] 所有声纹已清除')
    return { success: true }
  })

  /* ---------- 删除单个样本 ---------- */
  ipcMain.handle('voiceprint:delete-sample', async (_event, sampleId: string) => {
    const store = getStore()
    const vp = store.get('voiceprint') as VoiceprintData | undefined

    if (!vp?.samples) return { success: false, error: '没有已注册的声纹' }

    const oldLen = vp.samples.length
    vp.samples = vp.samples.filter(s => s.id !== sampleId)
    if (vp.samples.length === oldLen) return { success: false, error: '未找到指定样本' }

    if (vp.samples.length === 0) store.delete('voiceprint')
    else store.set('voiceprint', vp)

    logger.info(`[voiceprint] 已删除样本 ${sampleId}，剩余 ${vp.samples.length} 个`)
    return { success: true, sampleCount: vp.samples.length }
  })

  /* ---------- MFCC 桥接状态 ---------- */
  ipcMain.handle('voiceprint:mfcc-status', async () => {
    const available = await checkMfccAvailable()
    return { available, pythonReady: pythonRuntime.isReady() }
  })

  logger.info('[voiceprint] 声纹 IPC Handler v2.0 注册完成')
}