import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Cpu, Zap, AlertTriangle, CheckCircle, XCircle, Info, Loader, FolderOpen, Layers } from 'lucide-react'
import { HEX_COLORS, COLORS, itemVariants } from '../../shared/theme'

/* ============================================================
 * 类型定义
 * ============================================================ */
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

/* ============================================================
 * 家族颜色映射
 * ============================================================ */
const FAMILY_COLORS: Record<string, string> = {
  Qwen: COLORS.violet,
  LLaMA: '#3b82f6',
  Mistral: COLORS.warning,
  DeepSeek: COLORS.cyan,
  Gemma: COLORS.success,
  Phi: '#ec4899',
  Yi: '#f97316',
  ChatGLM: '#6366f1',
  Falcon: '#14b8a6',
  Baichuan: COLORS.dangerAlt,
  Other: COLORS.accent,
}

const MODE_LABELS: Record<string, string> = {
  GPU_FULL: 'GPU 全加速',
  GPU_PARTIAL: 'GPU 分层卸载',
  CPU_ONLY: '纯 CPU 推理',
  CANNOT_RUN: '无法运行',
}

const MODE_ICONS: Record<string, React.ReactNode> = {
  GPU_FULL: <CheckCircle size={16} style={{ color: COLORS.success }} />,
  GPU_PARTIAL: <AlertTriangle size={16} style={{ color: COLORS.warning }} />,
  CPU_ONLY: <Info size={16} style={{ color: COLORS.warning }} />,
  CANNOT_RUN: <XCircle size={16} style={{ color: COLORS.dangerAlt }} />,
}

interface Props {
  filePath: string | null
  deviceStrategy: DeviceStrategy | null
  currentConfig: ModelConfig
  onApplyConfig: (config: Partial<ModelConfig>) => void
}

/* ============================================================
 * ModelAnalysisCard 组件
 * ============================================================ */
function ModelAnalysisCard({ filePath, deviceStrategy, currentConfig: _currentConfig, onApplyConfig }: Props) {
  const [analysis, setAnalysis] = useState<ModelAnalysis | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const analyzeFile = useCallback(async (path: string) => {
    setLoading(true)
    setError(null)
    try {
      if (window.api) {
        const result = await window.api.invoke('model:analyze-file', path) as ModelAnalysis & { error?: string }
        if (result.error) {
          setError(result.error)
        } else {
          setAnalysis(result)
        }
      } else {
        setError('IPC 不可用')
      }
    } catch (e) {
      setError(String(e))
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (filePath) {
      analyzeFile(filePath)
    } else {
      setAnalysis(null)
      setError(null)
    }
  }, [filePath, analyzeFile])

  const handleApplyRecommended = () => {
    if (!analysis) return
    const advice = analysis.deviceAdvice
    const newConfig: Partial<ModelConfig> = {
      gpuLayers: advice.recommendedGpuLayers,
      threads: deviceStrategy?.cpuCores || 4,
      contextSize: analysis.ggufMetadata?.contextLength || 4096,
    }
    onApplyConfig(newConfig)
  }

  if (!filePath) return null

  const familyColor = analysis ? (FAMILY_COLORS[analysis.family] || FAMILY_COLORS.Other) : COLORS.accent

  return (
    <AnimatePresence>
      {filePath && (
        <motion.div
          variants={itemVariants}
          initial="hidden"
          animate="visible"
          exit="hidden"
          style={{
            background: COLORS.cardBg,
            border: `1px solid ${COLORS.cardBorder}`,
            borderRadius: 'var(--radius-2xl)',
            padding: '24px',
            marginBottom: 16,
          }}
        >
          {/* 标题 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 12,
              background: `${familyColor}20`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <FolderOpen size={20} style={{ color: familyColor }} />
            </div>
            <div>
              <h3 style={{ fontSize: 15, fontWeight: 600, color: COLORS.textPrimary, margin: 0 }}>
                模型分析
              </h3>
              <span style={{ fontSize: 12, color: COLORS.textMuted }}>
                {loading ? '正在分析...' : analysis ? analysis.fileName : filePath.split(/[/\\]/).pop()}
              </span>
            </div>
          </div>

          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 0', gap: 12 }}>
              <Loader size={20} style={{ color: COLORS.accent, animation: 'spin 1s linear infinite' }} />
              <span style={{ fontSize: 13, color: COLORS.textSecondary }}>分析模型文件中...</span>
            </div>
          )}

          {error && (
            <div style={{
              padding: '12px 16px', borderRadius: 10,
background: COLORS.dangerDim, border: `1px solid ${HEX_COLORS.dangerAlt}26`,
              fontSize: 13, color: COLORS.danger, display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <XCircle size={16} />
              {error}
            </div>
          )}

          {analysis && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* 关键指标卡片 */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                {/* 家族 */}
                <div style={{
                  background: 'rgba(255,255,255,0.02)', border: `1px solid ${COLORS.cardBorder}`,
                  borderRadius: 12, padding: 12,
                }}>
                  <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 6 }}>模型家族</div>
                  <motion.span
                    initial={{ scale: 0.9 }}
                    animate={{ scale: 1 }}
                    style={{
                      display: 'inline-block', padding: '4px 12px', borderRadius: 8,
                      background: `${familyColor}20`, color: familyColor,
                      fontSize: 13, fontWeight: 600, border: `1px solid ${familyColor}30`,
                    }}
                  >
                    {analysis.family}
                  </motion.span>
                </div>

                {/* 参数量 */}
                <div style={{
                  background: 'rgba(255,255,255,0.02)', border: `1px solid ${COLORS.cardBorder}`,
                  borderRadius: 12, padding: 12,
                }}>
                  <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 6 }}>参数量</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Cpu size={14} style={{ color: COLORS.accent }} />
                    <span style={{ fontSize: 15, fontWeight: 700, color: COLORS.textPrimary }}>
                      {analysis.paramSize}
                    </span>
                  </div>
                </div>

                {/* 量化级别 */}
                <div style={{
                  background: 'rgba(255,255,255,0.02)', border: `1px solid ${COLORS.cardBorder}`,
                  borderRadius: 12, padding: 12,
                }}>
                  <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 6 }}>量化级别</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Layers size={14} style={{ color: COLORS.accent }} />
                    <span style={{ fontSize: 15, fontWeight: 700, color: COLORS.textPrimary }}>
                      {analysis.quantLevel}
                    </span>
                    {analysis.quantConfidence > 0 && (
                      <span style={{ fontSize: 11, color: COLORS.textMuted }}>
                        {(analysis.quantConfidence * 100).toFixed(0)}% 置信度
                      </span>
                    )}
                  </div>
                </div>

                {/* 文件大小 */}
                <div style={{
                  background: 'rgba(255,255,255,0.02)', border: `1px solid ${COLORS.cardBorder}`,
                  borderRadius: 12, padding: 12,
                }}>
                  <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 6 }}>文件大小</div>
                  <span style={{ fontSize: 15, fontWeight: 700, color: COLORS.textPrimary }}>
                    {analysis?.fileSizeGB?.toFixed(1) ?? '0.0'} GB
                  </span>
                </div>
              </div>

              {/* 资源估算 */}
              <div style={{
                background: 'rgba(255,255,255,0.02)', border: `1px solid ${COLORS.cardBorder}`,
                borderRadius: 12, padding: 16,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <Zap size={14} style={{ color: COLORS.accent }} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>资源估算</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 11, color: COLORS.textMuted }}>预估显存</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary }}>
                      {analysis?.estimatedVRAM_GB?.toFixed(1) ?? '0.0'} GB
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: COLORS.textMuted }}>预估内存</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary }}>
                      {analysis?.estimatedRAM_GB?.toFixed(1) ?? '0.0'} GB
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: COLORS.textMuted }}>4K上下文开销</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary }}>
                      {analysis?.contextOverhead_4K_GB > 0.01 ? `${analysis?.contextOverhead_4K_GB?.toFixed(2) ?? '0.00'} GB` : '< 0.01 GB'}
                    </div>
                  </div>
                </div>
              </div>

              {/* 设备适配建议 */}
              <div style={{
                borderRadius: 12, padding: 16,
                background: analysis.deviceAdvice.canRun
? (analysis.deviceAdvice.mode === 'GPU_FULL' ? `${HEX_COLORS.success}0f` : `${HEX_COLORS.warning}0f`)
: `${HEX_COLORS.dangerAlt}0f`,
                border: `1px solid ${analysis.deviceAdvice.canRun
? (analysis.deviceAdvice.mode === 'GPU_FULL' ? `${HEX_COLORS.success}33` : `${HEX_COLORS.warning}33`)
: `${HEX_COLORS.dangerAlt}33`}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {MODE_ICONS[analysis.deviceAdvice.mode]}
                    <span style={{
                      fontSize: 13, fontWeight: 600,
                      color: analysis.deviceAdvice.mode === 'GPU_FULL' ? COLORS.success
                        : analysis.deviceAdvice.mode === 'CANNOT_RUN' ? COLORS.dangerAlt : COLORS.warning,
                    }}>
                      {MODE_LABELS[analysis.deviceAdvice.mode]}
                    </span>
                  </div>
                  {analysis.deviceAdvice.recommendedGpuLayers > 0 && (
                    <span style={{ fontSize: 11, color: COLORS.textMuted, padding: '2px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.05)' }}>
                      建议 GPU 层数: {analysis.deviceAdvice.recommendedGpuLayers}
                    </span>
                  )}
                </div>
                {analysis.deviceAdvice.warning && (
                  <div style={{ fontSize: 12, color: COLORS.warning, marginBottom: 4 }}>
                    {analysis.deviceAdvice.warning}
                  </div>
                )}
                <div style={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>
                  {analysis.deviceAdvice.tip}
                </div>
                {deviceStrategy && (
                  <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 8, padding: '6px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.03)' }}>
                    当前设备: {deviceStrategy.gpuName} · VRAM {deviceStrategy.vramGB}GB · RAM {deviceStrategy.ramGB}GB
                  </div>
                )}
              </div>

              {/* 一键应用推荐配置 */}
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={handleApplyRecommended}
                style={{
                  padding: '12px 24px', borderRadius: 12, cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: 14, fontWeight: 600,
                  background: COLORS.accent, border: 'none', color: COLORS.bg,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}
              >
                <Zap size={16} />
                应用推荐配置
              </motion.button>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default ModelAnalysisCard