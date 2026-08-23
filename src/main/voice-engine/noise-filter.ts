/**
 * noise-filter.ts — 环境噪音过滤器
 *
 * 提供实时音频降噪能力：
 * - 噪声门（Noise Gate）：低于阈值的信号直接归零
 * - 自适应阈值：基于历史 RMS 动态调整
 * - 频谱减法（Spectral Subtraction）：在频域减去估计的噪声谱（高级模式）
 *
 * 使用 Web Audio API 的 AudioWorklet 或 ScriptProcessorNode 实现
 */

import { createLogger } from '../../shared/logger'

const logger = createLogger('NoiseFilter')

/* ============================================================
 * 类型定义
 * ============================================================ */

export interface NoiseFilterConfig {
  enabled: boolean
  level: number              // 1-5，越高越激进
  rmsThreshold: number       // 噪声门阈值
  attackMs: number           // 噪声门开启速度 (ms)
  releaseMs: number          // 噪声门关闭速度 (ms)
  adaptiveEnabled: boolean   // 是否启用自适应阈值
}

export interface NoiseFilterStats {
  inputRMS: number
  outputRMS: number
  noiseFloor: number
  reductionPercent: number
  gateActive: boolean
}

/* ============================================================
 * 默认配置
 * ============================================================ */

const DEFAULT_CONFIG: NoiseFilterConfig = {
  enabled: false,
  level: 3,
  rmsThreshold: 0.01,
  attackMs: 5,
  releaseMs: 50,
  adaptiveEnabled: true,
}

/* ============================================================
 * 噪声门处理器
 * ============================================================ */

export class NoiseGate {
  private config: NoiseFilterConfig
  private envelope: number = 0         // 当前包络跟踪值
  private noiseFloor: number = 0.001   // 估计的噪声底噪
  private noiseFloorAlpha: number = 0.999 // 噪声底噪平滑系数
  private stats: NoiseFilterStats = {
    inputRMS: 0, outputRMS: 0, noiseFloor: 0.001,
    reductionPercent: 0, gateActive: false,
  }

  constructor(config: Partial<NoiseFilterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  updateConfig(partial: Partial<NoiseFilterConfig>): void {
    this.config = { ...this.config, ...partial }
  }

  getConfig(): NoiseFilterConfig {
    return { ...this.config }
  }

  getStats(): NoiseFilterStats {
    return { ...this.stats }
  }

  /**
   * 处理音频缓冲区
   * @param input 输入音频采样 (Float32Array, -1.0 ~ 1.0)
   * @param output 输出音频采样 (会被原地修改)
   * @returns 降噪后的音频
   */
  process(input: Float32Array, output?: Float32Array): Float32Array {
    const out = output || new Float32Array(input.length)
    const N = input.length

    if (!this.config.enabled || N === 0) {
      // 直通模式
      if (output !== input) out.set(input)
      this.stats.gateActive = false
      return out
    }

    // 1. 计算输入 RMS
    let sumSq = 0
    for (let i = 0; i < N; i++) sumSq += input[i] * input[i]
    const inputRMS = Math.sqrt(sumSq / N)
    this.stats.inputRMS = inputRMS

    // 2. 自适应噪声底噪估计
    if (this.config.adaptiveEnabled) {
      if (inputRMS < this.noiseFloor * 2) {
        // 当前可能是静音/噪声，更新噪声底噪估计
        this.noiseFloor = this.noiseFloorAlpha * this.noiseFloor +
          (1 - this.noiseFloorAlpha) * inputRMS
      }
    }
    this.stats.noiseFloor = this.noiseFloor

    // 3. 计算噪声门阈值
    const threshold = this.config.adaptiveEnabled
      ? Math.max(this.config.rmsThreshold, this.noiseFloor * 2.5)
      : this.config.rmsThreshold

    // 4. 包络跟踪（平滑的噪声门）
    const targetGain = inputRMS > threshold ? 1.0 : 0.0
    const attackCoeff = Math.exp(-1.0 / (this.config.attackMs / 1000 * 16000 / N))
    const releaseCoeff = Math.exp(-1.0 / (this.config.releaseMs / 1000 * 16000 / N))
    const coeff = targetGain > this.envelope ? attackCoeff : releaseCoeff

    this.envelope = coeff * this.envelope + (1 - coeff) * targetGain
    this.stats.gateActive = this.envelope < 0.5

    // 5. 应用增益
    if (this.envelope > 0.999) {
      // 几乎全开，直接复制
      if (output !== input) out.set(input)
    } else if (this.envelope < 0.001) {
      // 几乎全关，输出静音
      out.fill(0)
    } else {
      for (let i = 0; i < N; i++) {
        out[i] = input[i] * this.envelope
      }
    }

    // 6. 计算输出 RMS 和降噪比
    let outSumSq = 0
    for (let i = 0; i < N; i++) outSumSq += out[i] * out[i]
    this.stats.outputRMS = Math.sqrt(outSumSq / N)
    this.stats.reductionPercent = inputRMS > 0
      ? Math.round((1 - this.stats.outputRMS / inputRMS) * 100)
      : 0

    return out
  }

  /**
   * 检查音频是否为有效语音（非噪声）
   */
  isVoice(input: Float32Array): boolean {
    if (!this.config.enabled) return true

    let sumSq = 0
    for (let i = 0; i < input.length; i++) sumSq += input[i] * input[i]
    const inputRMS = Math.sqrt(sumSq / input.length)

    const threshold = this.config.adaptiveEnabled
      ? Math.max(this.config.rmsThreshold, this.noiseFloor * 2.5)
      : this.config.rmsThreshold

    return inputRMS > threshold
  }

  /** 重置自适应状态 */
  reset(): void {
    this.envelope = 0
    this.noiseFloor = 0.001
    this.stats = {
      inputRMS: 0, outputRMS: 0, noiseFloor: 0.001,
      reductionPercent: 0, gateActive: false,
    }
  }
}

/* ============================================================
 * 频谱减法降噪器（高级模式，用于离线处理）
 * ============================================================ */

export class SpectralSubtractor {
  private fftSize: number
  private noiseProfile: Float32Array | null = null
  // @ts-expect-error TS6133 - reserved for future spectral subtraction
  private alpha: number = 0.98  // 噪声谱平滑系数
  private oversubtraction: number = 1.0  // 过减因子

  constructor(fftSize: number = 1024) {
    this.fftSize = fftSize
  }

  /**
   * 从静音段估计噪声谱
   */
  estimateNoiseProfile(noiseFrames: Float32Array[]): void {
    if (noiseFrames.length === 0) return

    const halfSize = this.fftSize / 2 + 1
    this.noiseProfile = new Float32Array(halfSize)

    // 对每个噪声帧做 FFT，取平均幅度谱
    for (const frame of noiseFrames) {
      const spectrum = this.computeMagnitudeSpectrum(frame)
      for (let i = 0; i < halfSize; i++) {
        this.noiseProfile[i] += spectrum[i] / noiseFrames.length
      }
    }
    logger.debug(`[NoiseFilter] 噪声谱估计完成: ${noiseFrames.length} 帧`)
  }

  /**
   * 对单帧音频做频谱减法
   */
  processFrame(frame: Float32Array): Float32Array {
    if (!this.noiseProfile) return frame

    const halfSize = this.fftSize / 2 + 1
    const spectrum = this.computeMagnitudeSpectrum(frame)

    // 频谱减法
    const cleanSpectrum = new Float32Array(halfSize)
    for (let i = 0; i < halfSize; i++) {
      const subtracted = spectrum[i] - this.oversubtraction * this.noiseProfile[i]
      cleanSpectrum[i] = Math.max(0, subtracted)
    }

    // 这里只返回干净的幅度谱，实际使用时需要结合相位信息做 IFFT
    // 简化实现：返回幅度谱
    return cleanSpectrum
  }

  private computeMagnitudeSpectrum(frame: Float32Array): Float32Array {
    const halfSize = this.fftSize / 2 + 1
    const magnitude = new Float32Array(halfSize)

    // 简单的 DFT（生产环境应使用 FFT）
    for (let k = 0; k < halfSize; k++) {
      let re = 0, im = 0
      for (let n = 0; n < Math.min(frame.length, this.fftSize); n++) {
        const angle = -2 * Math.PI * k * n / this.fftSize
        re += frame[n] * Math.cos(angle)
        im += frame[n] * Math.sin(angle)
      }
      magnitude[k] = Math.sqrt(re * re + im * im) / this.fftSize
    }

    return magnitude
  }

  clearNoiseProfile(): void {
    this.noiseProfile = null
  }
}

/* ============================================================
 * 便捷工厂函数
 * ============================================================ */

/** 创建默认噪声门 */
export function createNoiseGate(level: number = 3): NoiseGate {
  const thresholds = [0.02, 0.015, 0.01, 0.007, 0.005]
  return new NoiseGate({
    enabled: true,
    level: Math.max(1, Math.min(5, level)),
    rmsThreshold: thresholds[level - 1] || 0.01,
    attackMs: 5,
    releaseMs: 50,
    adaptiveEnabled: true,
  })
}