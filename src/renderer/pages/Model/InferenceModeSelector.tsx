import { useState, useCallback } from 'react'
import { motion } from 'framer-motion'
import { Cpu, Layers, Zap, Cloud, Check } from 'lucide-react'
import { HEX_COLORS, COLORS, itemVariants } from '../../shared/theme'

/* ============================================================
 * 类型定义
 * ============================================================ */
export interface InferenceMode {
  mode: 'GPU_FULL' | 'GPU_PARTIAL' | 'CPU_ONLY' | 'CLOUD_API'
  label: string
  description: string
  color: string
  bgColor: string
  borderColor: string
  icon: React.ReactNode
  estimatedSpeed: string
  recommended: boolean
  params: {
    gpuLayers: number
    threads: number
    contextSize: number
  }
}

interface DeviceStrategy {
  gpuName: string
  vramGB: number
  cpuCores: number
  ramGB: number
  recommendedQuant: string
  strategy: string
}

interface ModelAnalysis {
  fileName: string
  filePath: string
  fileSizeBytes: number
  fileSizeGB: number
  format: string
  formatConfidence: number
  family: string
  paramSize: string
  paramCount: number
  quantLevel: string
  quantConfidence: number
  estimatedVRAM_GB: number
  estimatedRAM_GB: number
  contextOverhead_4K_GB: number
  contextOverhead_32K_GB: number
  ggufMetadata?: {
    architecture: string
    contextLength: number
    fileType: string
  }
  deviceAdvice: {
    canRun: boolean
    mode: string
    recommendedGpuLayers: number
    warning: string | null
    tip: string
  }
}

interface ModelConfig {
  gpuLayers: number
  contextSize: number
  batchSize: number
  threads: number
  temperature: number
  topP: number
  topK: number
  repeatPenalty: number
  maxTokens: number
  idleUnloadMinutes: number
}

interface Props {
  deviceStrategy: DeviceStrategy | null
  modelAnalysis: ModelAnalysis | null
  currentConfig: ModelConfig
  onApplyMode: (params: Partial<ModelConfig>) => void
}

/* ============================================================
 * 模式配置
 * ============================================================ */
const MODE_CONFIGS = {
  GPU_FULL: {
    label: 'GPU 全加速',
    description: '全部层加载到 GPU，最快速度',
    color: COLORS.success,
    bgColor: `${HEX_COLORS.success}0f`,
    borderColor: `${HEX_COLORS.success}33`,
    icon: <Zap size={16} />,
    speedRange: '40-80 tok/s',
  },
  GPU_PARTIAL: {
    label: 'GPU 分层卸载',
    description: '部分层 GPU + 部分层 CPU，平衡速度与显存',
    color: '#3b82f6',
    bgColor: 'rgba(59,130,246,0.06)',
    borderColor: 'rgba(59,130,246,0.2)',
    icon: <Layers size={16} />,
    speedRange: '15-40 tok/s',
  },
  CPU_ONLY: {
    label: '纯 CPU 推理',
    description: '全部使用 CPU，适合无独立显卡设备',
    color: COLORS.warning,
    bgColor: `${HEX_COLORS.warning}0f`,
    borderColor: `${HEX_COLORS.warning}33`,
    icon: <Cpu size={16} />,
    speedRange: '2-8 tok/s',
  },
  CLOUD_API: {
    label: '云端 API',
    description: '使用云端模型，无需本地硬件',
    color: COLORS.violet,
    bgColor: `${HEX_COLORS.violet}0f`,
    borderColor: `${HEX_COLORS.violet}33`,
    icon: <Cloud size={16} />,
    speedRange: '30-100 tok/s',
  },
}

/* ============================================================
 * 计算推荐模式
 * ============================================================ */
function computeRecommendedModes(
  device: DeviceStrategy | null,
  analysis: ModelAnalysis | null,
): InferenceMode[] {
  const modes: InferenceMode[] = []

  const baseGPU = device?.vramGB || 0
  const hasGPU = device && device.vramGB > 0
  const modelVRAM = analysis?.estimatedVRAM_GB || 0
  const cores = device?.cpuCores || 4
  const ctxSize = analysis?.ggufMetadata?.contextLength || 4096

  // GPU 全加速 - 当显存 >= 模型显存 + 1GB
  if (hasGPU && baseGPU >= modelVRAM + 1.0) {
    modes.push({
      mode: 'GPU_FULL',
      label: MODE_CONFIGS.GPU_FULL.label,
      description: MODE_CONFIGS.GPU_FULL.description,
      color: MODE_CONFIGS.GPU_FULL.color,
      bgColor: MODE_CONFIGS.GPU_FULL.bgColor,
      borderColor: MODE_CONFIGS.GPU_FULL.borderColor,
      icon: MODE_CONFIGS.GPU_FULL.icon,
      estimatedSpeed: MODE_CONFIGS.GPU_FULL.speedRange,
      recommended: true,
      params: { gpuLayers: 999, threads: Math.min(cores, 4), contextSize: ctxSize },
    })
  }

  // GPU 分层卸载 - 当有 GPU 但显存不足
  if (hasGPU && baseGPU > 0 && baseGPU < modelVRAM + 1.0) {
    const gpuRatio = baseGPU / Math.max(modelVRAM, 0.1)
    const layers = Math.max(1, Math.floor(gpuRatio * 40))
    modes.push({
      mode: 'GPU_PARTIAL',
      label: MODE_CONFIGS.GPU_PARTIAL.label,
      description: MODE_CONFIGS.GPU_PARTIAL.description,
      color: MODE_CONFIGS.GPU_PARTIAL.color,
      bgColor: MODE_CONFIGS.GPU_PARTIAL.bgColor,
      borderColor: MODE_CONFIGS.GPU_PARTIAL.borderColor,
      icon: MODE_CONFIGS.GPU_PARTIAL.icon,
      estimatedSpeed: MODE_CONFIGS.GPU_PARTIAL.speedRange,
      recommended: modes.length === 0,
      params: { gpuLayers: layers, threads: cores, contextSize: ctxSize },
    })
  }

  // 纯 CPU 推理
  if (!hasGPU || baseGPU <= 0) {
    modes.push({
      mode: 'CPU_ONLY',
      label: MODE_CONFIGS.CPU_ONLY.label,
      description: MODE_CONFIGS.CPU_ONLY.description,
      color: MODE_CONFIGS.CPU_ONLY.color,
      bgColor: MODE_CONFIGS.CPU_ONLY.bgColor,
      borderColor: MODE_CONFIGS.CPU_ONLY.borderColor,
      icon: MODE_CONFIGS.CPU_ONLY.icon,
      estimatedSpeed: MODE_CONFIGS.CPU_ONLY.speedRange,
      recommended: true,
      params: { gpuLayers: 0, threads: cores, contextSize: Math.min(ctxSize, 4096) },
    })
  }

  // 云端 API - 始终可用
  modes.push({
    mode: 'CLOUD_API',
    label: MODE_CONFIGS.CLOUD_API.label,
    description: MODE_CONFIGS.CLOUD_API.description,
    color: MODE_CONFIGS.CLOUD_API.color,
    bgColor: MODE_CONFIGS.CLOUD_API.bgColor,
    borderColor: MODE_CONFIGS.CLOUD_API.borderColor,
    icon: MODE_CONFIGS.CLOUD_API.icon,
    estimatedSpeed: MODE_CONFIGS.CLOUD_API.speedRange,
    recommended: modes.length === 0,
    params: { gpuLayers: 0, threads: 0, contextSize: 8192 },
  })

  return modes
}

/* ============================================================
 * InferenceModeSelector 组件
 * ============================================================ */
function InferenceModeSelector({ deviceStrategy, modelAnalysis, currentConfig, onApplyMode }: Props) {
  const [selectedMode, setSelectedMode] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)

  const modes = useCallback(
    () => computeRecommendedModes(deviceStrategy, modelAnalysis),
    [deviceStrategy, modelAnalysis],
  )()

  const handleSelectMode = (mode: InferenceMode) => {
    setSelectedMode(mode.mode)
    onApplyMode(mode.params)
  }

  const isCurrentMode = (mode: InferenceMode): boolean => {
    if (mode.mode === 'GPU_FULL' && currentConfig.gpuLayers >= 99) return true
    if (mode.mode === 'GPU_PARTIAL' && currentConfig.gpuLayers > 0 && currentConfig.gpuLayers < 99 && deviceStrategy && deviceStrategy.vramGB > 0) return true
    if (mode.mode === 'CPU_ONLY' && currentConfig.gpuLayers === 0 && deviceStrategy && deviceStrategy.vramGB <= 0) return true
    return false
  }

  return (
    <motion.div
      variants={itemVariants}
      initial="hidden"
      animate="visible"
      style={{
        background: COLORS.cardBg,
        border: `1px solid ${COLORS.cardBorder}`,
        borderRadius: 'var(--radius-2xl)',
        padding: '20px 24px',
        marginBottom: 16,
      }}
    >
      {/* 标题栏 - 可折叠 */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          cursor: 'pointer', marginBottom: expanded ? 16 : 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: `${HEX_COLORS.accent}18`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Cpu size={18} style={{ color: COLORS.accent }} />
          </div>
          <div>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary, margin: 0 }}>
              推理模式选择
            </h3>
            <span style={{ fontSize: 11, color: COLORS.textMuted }}>
              {deviceStrategy
                ? `${deviceStrategy.gpuName} · VRAM ${deviceStrategy.vramGB}GB · ${deviceStrategy.recommendedQuant} 推荐`
                : '未检测到设备信息'}
            </span>
          </div>
        </div>
        <motion.span
          animate={{ rotate: expanded ? 180 : 0 }}
          transition={{ duration: 0.25 }}
          style={{ color: COLORS.textSecondary, display: 'flex' }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </motion.span>
      </div>

      {expanded && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          transition={{ duration: 0.3 }}
          style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          {/* 模式卡片 */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 12,
          }}>
            {modes.map((mode) => {
              const isSelected = selectedMode === mode.mode
              const isActive = isCurrentMode(mode)

              return (
                <motion.button
                  key={mode.mode}
                  whileHover={{ scale: 1.02, y: -2 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => handleSelectMode(mode)}
                  style={{
                    display: 'flex', flexDirection: 'column', gap: 10,
                    padding: '16px',
                    borderRadius: 14,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    textAlign: 'left',
                    border: isSelected || isActive
                      ? `2px solid ${mode.color}`
                      : `1px solid ${COLORS.cardBorder}`,
                    background: isSelected
                      ? mode.bgColor
                      : isActive
                        ? `${mode.color}08`
                        : 'rgba(255,255,255,0.02)',
                    transition: 'all 0.2s ease',
                    position: 'relative',
                    overflow: 'hidden',
                  }}
                >
                  {/* 推荐标记 */}
                  {mode.recommended && (
                    <div style={{
                      position: 'absolute', top: 0, right: 0,
                      padding: '3px 10px',
                      borderRadius: '0 14px 0 12px',
                      background: mode.color,
                      fontSize: 10, fontWeight: 700, color: '#fff',
                    }}>
                      推荐
                    </div>
                  )}

                  {/* 选中标记 */}
                  {(isSelected || isActive) && (
                    <div style={{
                      position: 'absolute', top: 8, left: 8,
                      width: 20, height: 20, borderRadius: '50%',
                      background: mode.color,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <Check size={12} style={{ color: '#fff' }} />
                    </div>
                  )}

                  {/* 图标和标题 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{
                      width: 32, height: 32, borderRadius: 8,
                      background: `${mode.color}20`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: mode.color,
                    }}>
                      {mode.icon}
                    </div>
                    <span style={{ fontSize: 14, fontWeight: 600, color: mode.color }}>
                      {mode.label}
                    </span>
                  </div>

                  {/* 描述 */}
                  <span style={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.5 }}>
                    {mode.description}
                  </span>

                  {/* 预估速度 */}
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '6px 10px', borderRadius: 8,
                    background: 'rgba(255,255,255,0.03)',
                    fontSize: 11, color: COLORS.textMuted,
                  }}>
                    <Zap size={12} style={{ color: mode.color }} />
                    <span>预估速度: <strong style={{ color: COLORS.textPrimary }}>{mode.estimatedSpeed}</strong></span>
                  </div>

                  {/* 参数预览 */}
                  <div style={{
                    display: 'flex', flexWrap: 'wrap', gap: 4,
                    fontSize: 10, color: COLORS.textMuted,
                  }}>
                    {mode.params.gpuLayers > 0 && (
                      <span style={{ padding: '2px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.04)' }}>
                        GPU层: {mode.params.gpuLayers >= 999 ? '全部' : mode.params.gpuLayers}
                      </span>
                    )}
                    {mode.params.threads > 0 && (
                      <span style={{ padding: '2px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.04)' }}>
                        线程: {mode.params.threads}
                      </span>
                    )}
                    <span style={{ padding: '2px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.04)' }}>
                      上下文: {mode.params.contextSize >= 1024 ? `${(mode.params.contextSize / 1024).toFixed(0)}K` : mode.params.contextSize}
                    </span>
                  </div>
                </motion.button>
              )
            })}
          </div>

          {/* 设备信息提示 */}
          {deviceStrategy && (
            <div style={{
              fontSize: 11, color: COLORS.textMuted,
              padding: '8px 12px', borderRadius: 8,
              background: 'rgba(255,255,255,0.02)',
              border: `1px solid ${COLORS.cardBorder}`,
              lineHeight: 1.5,
            }}>
              当前设备: {deviceStrategy.gpuName} · VRAM {deviceStrategy.vramGB}GB · RAM {deviceStrategy.ramGB}GB · CPU {deviceStrategy.cpuCores}核
              {deviceStrategy.recommendedQuant && ` · 推荐量化: ${deviceStrategy.recommendedQuant}`}
            </div>
          )}
        </motion.div>
      )}
    </motion.div>
  )
}

export default InferenceModeSelector