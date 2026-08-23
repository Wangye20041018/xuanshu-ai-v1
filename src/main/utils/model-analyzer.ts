/* ============================================================
 * 本地模型文件分析器 v1.0.0
 *
 * 能力：
 *   a) 自动检测模型格式（GGUF/ONNX/PyTorch/SafeTensors 等）
 *   b) 自动估算模型参数量（从文件名/文件大小推断）
 *   c) 自动检测模型量化级别（Q4/Q5/Q8/FP16 等）
 *   d) 自动评估所需 VRAM/RAM
 *   e) 给出设备适配建议（当前设备能否运行、推荐分层策略）
 * ============================================================ */

import { existsSync, readFileSync, statSync } from 'fs'
import { basename, extname, join } from 'path'

/* ---- 类型定义 ---- */

export type ModelFormat = 'GGUF' | 'ONNX' | 'PyTorch' | 'SafeTensors' | 'CoreML' | 'TensorFlow' | 'HuggingFace' | 'Unknown'
export type QuantizationLevel = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | 'Q6' | 'Q8' | 'FP16' | 'FP32' | 'INT8' | 'INT4' | 'Unknown'
export type ModelFamily = 'LLaMA' | 'Qwen' | 'Mistral' | 'DeepSeek' | 'Gemma' | 'Phi' | 'Yi' | 'ChatGLM' | 'Falcon' | 'Baichuan' | 'Other'

export interface ModelAnalysis {
  /** 文件基本信息 */
  fileName: string
  filePath: string
  fileSizeBytes: number
  fileSizeGB: number
  format: ModelFormat
  formatConfidence: number

  /** 模型元数据 */
  family: ModelFamily
  paramSize: string           // e.g. "7B", "13B", "70B"
  paramCount: number          // estimated billions
  quantLevel: QuantizationLevel
  quantConfidence: number

  /** v12.2 是否多模态（可处理图片/屏幕截图，含视觉编码器） */
  isMultimodal: boolean
  /** 多模态检测置信度 0-1 */
  multimodalConfidence: number

  /** 资源估算 */
  estimatedVRAM_GB: number    // 模型加载到显存所需
  estimatedRAM_GB: number     // CPU推理所需
  contextOverhead_4K_GB: number
  contextOverhead_32K_GB: number

  /** GGUF 头部字段 (仅 GGUF) */
  ggufMetadata?: {
    architecture: string
    vocabSize: number
    contextLength: number
    embeddingLength: number
    blockCount: number
    fileType: string
  }

  /** 设备适配 */
  deviceAdvice: DeviceAdvice
}

export interface DeviceInfo {
  gpuName: string
  vramGB: number
  ramGB: number
  cpuCores: number
  hasGPU: boolean
}

export interface DeviceAdvice {
  canRun: boolean
  mode: 'GPU_FULL' | 'GPU_PARTIAL' | 'CPU_ONLY' | 'CANNOT_RUN'
  recommendedGpuLayers: number
  warning: string | null
  tip: string
}

/* ---- 模型家族关键词映射 ---- */

const FAMILY_PATTERNS: [RegExp, ModelFamily][] = [
  [/llama|meta-llama/i, 'LLaMA'],
  [/qwen/i, 'Qwen'],
  [/mistral/i, 'Mistral'],
  [/deepseek/i, 'DeepSeek'],
  [/gemma/i, 'Gemma'],
  [/phi/i, 'Phi'],
  [/yi[^a-z]/i, 'Yi'],
  [/chatglm|glm/i, 'ChatGLM'],
  [/falcon/i, 'Falcon'],
  [/baichuan/i, 'Baichuan'],
]

/* ---- 参数名关键词 ---- */

function extractParamCount(fileName: string): { paramStr: string; paramCount: number } {
  // 匹配 "7b", "13b", "70b", "1.5b", "0.5b" 等
  const sizeMatch = fileName.match(/(\d+\.?\d*)\s*[bB]/)
  if (sizeMatch) {
    const num = parseFloat(sizeMatch[1])
    const paramStr = num >= 1 ? `${num}B` : `${(num * 1000).toFixed(0)}M`
    return { paramStr, paramCount: num }
  }
  // 匹配 "7B" 类型
  const altMatch = fileName.match(/(\d+)B/)
  if (altMatch) {
    const num = parseInt(altMatch[1])
    return { paramStr: `${num}B`, paramCount: num > 100 ? num / 1000 : num }
  }
  // 无法识别，从文件大小估算（经验值：GGUF Q4 约 0.5-0.6 bytes/param）
  return { paramStr: 'Unknown', paramCount: 0 }
}

/* ---- 量化级别检测 ---- */

function detectQuantization(fileName: string, format: ModelFormat): { level: QuantizationLevel; confidence: number } {
  const lower = fileName.toLowerCase()

  // GGUF 的标准量化标记
  if (lower.includes('q1_')) return { level: 'Q1', confidence: 0.95 }
  if (lower.includes('q2_')) return { level: 'Q2', confidence: 0.95 }
  if (lower.includes('q3_')) return { level: 'Q3', confidence: 0.95 }
  if (/q4[^0-9]|q4_/.test(lower)) return { level: 'Q4', confidence: 0.95 }
  if (/q5[^0-9]|q5_/.test(lower)) return { level: 'Q5', confidence: 0.95 }
  if (/q6[^0-9]|q6_/.test(lower)) return { level: 'Q6', confidence: 0.95 }
  if (/q8[^0-9]|q8_/.test(lower)) return { level: 'Q8', confidence: 0.95 }

  if (lower.includes('iq1') || lower.includes('iq2')) return { level: 'Q4', confidence: 0.7 }
  if (lower.includes('iq3')) return { level: 'Q5', confidence: 0.7 }
  if (lower.includes('iq4')) return { level: 'Q8', confidence: 0.7 }

  if (lower.includes('fp16') || lower.includes('f16')) return { level: 'FP16', confidence: 0.95 }
  if (lower.includes('fp32') || lower.includes('f32')) return { level: 'FP32', confidence: 0.95 }
  if (lower.includes('int8') || lower.includes('i8')) return { level: 'INT8', confidence: 0.9 }
  if (lower.includes('int4')) return { level: 'INT4', confidence: 0.9 }
  if (lower.includes('awq')) return { level: 'INT4', confidence: 0.85 }
  if (lower.includes('gptq')) return { level: 'INT4', confidence: 0.8 }

  // SafeTensors 通常为 FP16 或 FP32
  if (format === 'SafeTensors' || format === 'PyTorch') {
    return { level: 'FP16', confidence: 0.6 }
  }

  return { level: 'Unknown', confidence: 0.3 }
}

/* ---- 格式检测 ---- */

function detectFormat(filePath: string, fileName: string): { format: ModelFormat; confidence: number } {
  const ext = extname(filePath).toLowerCase()
  const lower = fileName.toLowerCase()

  switch (ext) {
    case '.gguf':
      return { format: 'GGUF', confidence: 1.0 }
    case '.onnx':
      return { format: 'ONNX', confidence: 1.0 }
    case '.pt':
    case '.pth':
      return { format: 'PyTorch', confidence: 0.95 }
    case '.safetensors':
      return { format: 'SafeTensors', confidence: 1.0 }
    case '.mlmodel':
    case '.mlpackage':
      return { format: 'CoreML', confidence: 1.0 }
    case '.pb':
    case '.h5':
    case '.keras':
      return { format: 'TensorFlow', confidence: 0.9 }
    case '.bin':
      // .bin 可能是 PyTorch 或 SafeTensors 转换
      if (lower.includes('pytorch') || lower.includes('pth')) return { format: 'PyTorch', confidence: 0.7 }
      if (lower.includes('safetensor')) return { format: 'SafeTensors', confidence: 0.7 }
      if (lower.includes('gguf')) return { format: 'GGUF', confidence: 0.7 }
      return { format: 'Unknown', confidence: 0.2 }
    default:
      return { format: 'Unknown', confidence: 0.3 }
  }
}

/* ---- 参数量 → 显存估算 ---- */

const QUANT_BYTES_PER_PARAM: Record<string, number> = {
  'Q1': 0.2,   // ~1.5 bit
  'Q2': 0.35,  // ~2.5 bit
  'Q3': 0.45,  // ~3.5 bit
  'Q4': 0.55,  // ~4.5 bit
  'Q5': 0.65,  // ~5.5 bit
  'Q6': 0.75,  // ~6.5 bit
  'Q8': 1.0,   // 8 bit
  'INT8': 1.0,
  'INT4': 0.5,
  'FP16': 2.0,  // 16 bit
  'FP32': 4.0,  // 32 bit
  'Unknown': 0.6,
}

function estimateVRAM(paramCount: number, quantLevel: QuantizationLevel): number {
  if (paramCount <= 0) return 0
  const bytesPerParam = QUANT_BYTES_PER_PARAM[quantLevel] || 0.6
  // 模型本体 + 20% 开销（KV cache, activations, 运行时）
  const modelVRAM = paramCount * bytesPerParam
  return modelVRAM * 1.2
}

function estimateRAM(paramCount: number, quantLevel: QuantizationLevel): number {
  const bytesPerParam = QUANT_BYTES_PER_PARAM[quantLevel] || 0.6
  return paramCount * bytesPerParam * 1.15
}

function estimateContextOverhead(paramCount: number, quantLevel: QuantizationLevel, ctxTokens: number): number {
  // KV Cache overhead: 2 * layers * hidden_size * ctx_tokens * bytes_per_elem
  // 简化估算: ~0.05-0.1 GB per 1K tokens per 1B params
  const bytesPerElem = quantLevel === 'FP16' || quantLevel === 'FP32' ? 2 : 1
  const multiplier = (ctxTokens / 1024) * bytesPerElem * 0.06
  return paramCount * multiplier
}

/* ---- GGUF 头部解析 ---- */

function parseGGUFHeader(filePath: string): ModelAnalysis['ggufMetadata'] | undefined {
  try {
    const fd = readFileSync(filePath, { flag: 'r' })
    // GGUF magic: 0x47 0x47 0x55 0x46 = "GGUF"
    const magic = fd.subarray(0, 4).toString()
    if (magic !== 'GGUF') return undefined

    // Version (4 bytes LE)
    const version = fd.readUInt32LE(4)

    // 跳过 header size 读取...这里是简化版
    // 实际 GGUF 解析很复杂，这里只做快速探测

    // 尝试读取一些通用的 key-value 元数据
    const content = fd.toString('utf-8', 0, Math.min(4096, fd.length))
    const archMatch = content.match(/general\.architecture[\x00-\x1f]+(\w+)/)
    const ctxMatch = content.match(/\.context_length[\x00-\x1f]+(\d+)/)

    return {
      architecture: archMatch?.[1] || 'unknown',
      vocabSize: 0,
      contextLength: ctxMatch ? parseInt(ctxMatch[1]) : 4096,
      embeddingLength: 0,
      blockCount: 0,
      fileType: `GGUF v${version}`,
    }
  } catch {
    return undefined
  }
}

/* ---- 多模态检测 v12.2 ---- */

/** 已知视觉架构关键词（GGUF general.architecture） */
const VISION_ARCH_PATTERNS = [
  /clip/i,
  /mllama/i,
  /llava/i,
  /qwen2[_-]?vl/i,
  /qwen2vl/i,
  /internvl/i,
  /minicpm/i,
  /moondream/i,
  /paligemma/i,
  /gemma3/i,
  /phi[_-]?3[_-]?v/i,
  /phi3v/i,
  /florence/i,
  /smolvlm/i,
  /vit/i,
  /vision/i,
]

/** 文件名中的视觉标记 */
const VISION_NAME_PATTERNS = [
  /[-_.]?(vl|vision|visual|omni|multimodal|mmproj|llava|moondream|internvl|paligemma|gemma3)([-_.]|$)/i,
  /minicpm[_-]?v/i,
  /qwen2[_-]?vl/i,
  /phi[_-]?3[_-]?v/i,
]

/**
 * 检测模型是否多模态（具备视觉编码器，可处理图片/屏幕截图）
 * 检测依据（按置信度排序）：
 *   1. GGUF 头部 general.architecture 命中已知视觉架构（0.95）
 *   2. 文件名含视觉标记（0.9）
 *   3. 同目录存在 .mmproj 投影文件（0.85，llama.cpp 视觉模型特征）
 */
export function detectMultimodal(
  filePath: string,
  ggufMetadata?: ModelAnalysis['ggufMetadata'],
): { isMultimodal: boolean; confidence: number } {
  const fileName = basename(filePath).toLowerCase()
  const dirPath = filePath.substring(0, Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/')))
  let confidence = 0

  // 1) GGUF 架构命中
  if (ggufMetadata?.architecture && ggufMetadata.architecture !== 'unknown') {
    for (const pat of VISION_ARCH_PATTERNS) {
      if (pat.test(ggufMetadata.architecture)) {
        confidence = Math.max(confidence, 0.95)
        break
      }
    }
  }

  // 2) 文件名命中
  for (const pat of VISION_NAME_PATTERNS) {
    if (pat.test(fileName)) {
      confidence = Math.max(confidence, 0.9)
      break
    }
  }

  // 3) 伴生 .mmproj 投影文件
  try {
    const baseName = basename(filePath).replace(/\.(gguf|GGUF)$/i, '')
    const mmprojCandidates = [`${baseName}.mmproj`, `${baseName}-mmproj.gguf`, `${baseName}.mmproj.gguf`]
    for (const cand of mmprojCandidates) {
      if (existsSync(join(dirPath, cand))) {
        confidence = Math.max(confidence, 0.85)
        break
      }
    }
  } catch { /* 检测失败不阻塞 */ }

  return { isMultimodal: confidence > 0, confidence }
}

/* ---- 设备适配建议 ---- */

function computeDeviceAdvice(
  analysis: Omit<ModelAnalysis, 'deviceAdvice'>,
  device: DeviceInfo,
): DeviceAdvice {
  const { estimatedVRAM_GB, estimatedRAM_GB, quantLevel, paramCount } = analysis

  // 无参数量信息，保守判断
  if (paramCount <= 0) {
    return {
      canRun: true,
      mode: 'CPU_ONLY',
      recommendedGpuLayers: 0,
      warning: '无法确定模型参数量，建议使用 CPU 推理',
      tip: '模型参数信息缺失，请手动配置 GPU 层数',
    }
  }

  const vramAvailable = device.vramGB
  const ramAvailable = device.ramGB

  // GPU 推理可行性
  if (device.hasGPU && vramAvailable >= estimatedVRAM_GB + 1.0) {
    // 留 1GB 显存给系统
    return {
      canRun: true,
      mode: 'GPU_FULL',
      recommendedGpuLayers: 999, // 全部加载到 GPU
      warning: null,
      tip: `该模型需要约 ${estimatedVRAM_GB.toFixed(1)} GB 显存，你的 GPU (${device.gpuName}, ${vramAvailable.toFixed(0)} GB) 可以完全加载。推荐使用 GPU 全加速推理获得最佳速度。`,
    }
  }

  if (device.hasGPU && vramAvailable > 0) {
    // 部分 GPU 卸载
    const gpuRatio = vramAvailable / estimatedVRAM_GB
    const layers = Math.floor(gpuRatio * 40) // 假设 40 层
    return {
      canRun: true,
      mode: 'GPU_PARTIAL',
      recommendedGpuLayers: Math.max(1, layers),
      warning: `显存不足，仅能加载部分层到 GPU（建议 ${Math.max(1, layers)} 层）`,
      tip: `模型需要约 ${estimatedVRAM_GB.toFixed(1)} GB 显存，你的 GPU 仅有 ${vramAvailable.toFixed(0)} GB。建议将 ${Math.max(1, layers)} 层卸载到 GPU，其余使用 CPU 推理。`,
    }
  }

  // CPU 推理
  if (ramAvailable >= estimatedRAM_GB + 4.0) {
    // 留 4GB 给系统
    return {
      canRun: true,
      mode: 'CPU_ONLY',
      recommendedGpuLayers: 0,
      warning: '使用 CPU 推理，速度较慢',
      tip: `你的设备内存为 ${ramAvailable.toFixed(0)} GB，该模型 CPU 推理需要约 ${estimatedRAM_GB.toFixed(1)} GB。建议使用 ${quantLevel} 量化版本以减少内存占用。`,
    }
  }

  return {
    canRun: false,
    mode: 'CANNOT_RUN',
    recommendedGpuLayers: 0,
    warning: `内存不足：模型需要 ${estimatedRAM_GB.toFixed(1)} GB 可用内存，当前仅 ${ramAvailable.toFixed(0)} GB`,
    tip: `建议使用更小的量化版本（如 Q2/Q3）或参数量更少的模型（如 ${paramCount > 7 ? '7B' : '1B'} 版本）。`,
  }
}

/* ---- 检测模型家族 ---- */

function detectFamily(fileName: string): ModelFamily {
  for (const [pattern, family] of FAMILY_PATTERNS) {
    if (pattern.test(fileName)) return family
  }
  return 'Other'
}

/* ============================================================
 * 主分析函数
 * ============================================================ */

export function analyzeModelFile(filePath: string, device?: DeviceInfo): ModelAnalysis {
  const fileName = basename(filePath)
  const stats = statSync(filePath)
  const fileSizeBytes = stats.size

  // 格式检测
  const { format, confidence: fmtConf } = detectFormat(filePath, fileName)

  // 参数量
  const { paramStr, paramCount } = extractParamCount(fileName)

  // 量化级别
  const { level: quantLevel, confidence: _quantConf } = detectQuantization(fileName, format)

  // 模型家族
  const family = detectFamily(fileName)

  // 从文件大小反推参数量（文件名无法识别时）
  let finalParamCount = paramCount
  if (finalParamCount <= 0 && quantLevel !== 'Unknown') {
    const bytesPerParam = QUANT_BYTES_PER_PARAM[quantLevel] || 0.6
    // 反推: fileSize = paramCount * bytesPerParam * 1e9
    finalParamCount = fileSizeBytes / (bytesPerParam * 1e9)
  }

  // 资源估算
  const estimatedVRAM_GB = estimateVRAM(finalParamCount, quantLevel)
  const estimatedRAM_GB = estimateRAM(finalParamCount, quantLevel)

  const analysis: Omit<ModelAnalysis, 'deviceAdvice'> = {
    fileName,
    filePath,
    fileSizeBytes,
    fileSizeGB: fileSizeBytes / (1024 ** 3),
    format,
    formatConfidence: fmtConf,
    family,
    paramSize: paramStr,
    paramCount: finalParamCount > 0 ? Math.round(finalParamCount * 10) / 10 : 0,
    quantLevel,
    quantConfidence: _quantConf,
    estimatedVRAM_GB: Math.round(estimatedVRAM_GB * 100) / 100,
    estimatedRAM_GB: Math.round(estimatedRAM_GB * 100) / 100,
    contextOverhead_4K_GB: Math.round(estimateContextOverhead(finalParamCount, quantLevel, 4096) * 100) / 100,
    contextOverhead_32K_GB: Math.round(estimateContextOverhead(finalParamCount, quantLevel, 32768) * 100) / 100,
    isMultimodal: false,
    multimodalConfidence: 0,
  }

  // GGUF 头部
  if (format === 'GGUF') {
    analysis.ggufMetadata = parseGGUFHeader(filePath)
  }

  // v12.2 多模态检测
  const multimodal = detectMultimodal(filePath, analysis.ggufMetadata)
  analysis.isMultimodal = multimodal.isMultimodal
  analysis.multimodalConfidence = multimodal.confidence

  // 设备适配
  const deviceAdvice = device
    ? computeDeviceAdvice(analysis, device)
    : {
        canRun: true,
        mode: 'CPU_ONLY',
        recommendedGpuLayers: 0,
        warning: '未提供设备信息',
        tip: '请提供设备信息以获取精确适配建议',
      }

  return { ...analysis, deviceAdvice } as ModelAnalysis
}

/* ---- 批量分析 ---- */

export interface ScanResult {
  files: ModelAnalysis[]
  totalCount: number
  summary: {
    byFormat: Record<string, number>
    byFamily: Record<string, number>
    byQuant: Record<string, number>
    totalSizeGB: number
  }
}

export function scanAndAnalyzeModels(
  filePaths: string[],
  device?: DeviceInfo,
): ScanResult {
  const files = filePaths.map(p => analyzeModelFile(p, device))

  const byFormat: Record<string, number> = {}
  const byFamily: Record<string, number> = {}
  const byQuant: Record<string, number> = {}
  let totalSizeGB = 0

  for (const f of files) {
    byFormat[f.format] = (byFormat[f.format] || 0) + 1
    byFamily[f.family] = (byFamily[f.family] || 0) + 1
    byQuant[f.quantLevel] = (byQuant[f.quantLevel] || 0) + 1
    totalSizeGB += f.fileSizeGB
  }

  return {
    files,
    totalCount: files.length,
    summary: {
      byFormat,
      byFamily,
      byQuant,
      totalSizeGB: Math.round(totalSizeGB * 100) / 100,
    },
  }
}

/* ---- 支持的格式列表 ---- */

export const SUPPORTED_EXTENSIONS = [
  '.gguf', '.onnx', '.pt', '.pth', '.safetensors',
  '.bin', '.pb', '.h5', '.keras', '.mlmodel', '.mlpackage',
]

export const SUPPORTED_FORMAT_NAMES: Record<string, string> = {
  '.gguf': 'GGUF (llama.cpp / Ollama)',
  '.onnx': 'ONNX (跨平台推理)',
  '.pt': 'PyTorch Checkpoint',
  '.pth': 'PyTorch Checkpoint',
  '.safetensors': 'SafeTensors (HuggingFace)',
  '.bin': '二进制模型文件',
  '.pb': 'TensorFlow Frozen Graph',
  '.h5': 'Keras / TF Model',
  '.keras': 'Keras v3 Model',
  '.mlmodel': 'CoreML Model',
  '.mlpackage': 'CoreML Package',
}
