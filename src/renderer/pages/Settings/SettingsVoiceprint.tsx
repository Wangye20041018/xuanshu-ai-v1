import { motion } from 'framer-motion'
import { Mic, Info, Plus, Radio, Trash2 } from 'lucide-react'
import { HEX_COLORS, COLORS, GlassCard } from './index'

interface VoiceprintSample {
  id: string
  label: string
  enrolledAt: number
  featureType: string
}

interface SettingsVoiceprintProps {
  voiceprintSampleCount: number
  voiceprintSamples: VoiceprintSample[]
  voiceEnrolling: boolean
  voiceVerifying: boolean
  voiceVerifyScore: number | null
  noiseFilterOn: boolean
  noiseLevel: number
  onVoiceEnroll: (label?: string) => void
  onVoiceVerify: () => void
  onVoiceClear: () => void
  onVoiceDeleteSample: (sampleId: string) => void
  onNoiseFilterChange: () => void
  onNoiseLevelChange: (level: number) => void
}

/** 格式化日期 */
function formatDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

export default function SettingsVoiceprint({
  voiceprintSampleCount,
  voiceprintSamples,
  voiceEnrolling,
  voiceVerifying,
  voiceVerifyScore,
  noiseFilterOn,
  noiseLevel,
  onVoiceEnroll,
  onVoiceVerify,
  onVoiceClear,
  onVoiceDeleteSample,
  onNoiseFilterChange,
  onNoiseLevelChange,
}: SettingsVoiceprintProps) {
  return (
    <GlassCard
      title="声纹与降噪"
      icon={<Mic size={18} />}
      accentColor={COLORS.success}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* 提示文字 */}
        <div style={{
          fontSize: 12, color: COLORS.textMuted, lineHeight: 1.6,
          background: 'rgba(255,255,255,0.03)', borderRadius: 10,
          padding: '10px 14px', borderLeft: `3px solid ${COLORS.accent}`,
        }}>
          <Info size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
          建议在不同嗓音状态下录入多个样本，以提高识别准确率
        </div>

        {/* 声纹状态 + 录入按钮 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: COLORS.textPrimary, marginBottom: 4 }}>
              声纹录入
            </div>
            <div style={{ fontSize: 12, color: COLORS.textMuted }}>
              {voiceprintSampleCount > 0
                ? `已录入 ${voiceprintSampleCount} 个样本`
                : '未录入'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <motion.button
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => onVoiceEnroll()}
              disabled={voiceEnrolling}
              style={{
                background: voiceEnrolling ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 'var(--radius-xl)',
                color: voiceEnrolling ? COLORS.textMuted : COLORS.textPrimary,
                fontSize: 13,
                padding: '8px 20px',
                cursor: voiceEnrolling ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Mic size={14} />
              {voiceEnrolling ? '录入中...' : '录入新样本'}
            </motion.button>
            {voiceprintSampleCount > 0 && (
              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => onVoiceEnroll(`样本${voiceprintSampleCount + 1}`)}
                disabled={voiceEnrolling}
                style={{
background: COLORS.successDim,
                  border: '1px solid rgba(16,185,129,0.20)',
                  borderRadius: 'var(--radius-xl)',
                  color: COLORS.success,
                  fontSize: 12,
                  padding: '8px 16px',
                  cursor: voiceEnrolling ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                  transition: 'all 0.2s',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <Plus size={14} />
                追加样本（当前嗓音）
              </motion.button>
            )}
          </div>
        </div>

        {/* 样本列表 - v2.3: 使用真实样本 ID */}
        {voiceprintSamples.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: COLORS.textSecondary, marginBottom: 2 }}>
              样本列表
            </div>
            {voiceprintSamples.map((sample) => (
              <div key={sample.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '8px 12px', borderRadius: 10,
                background: 'rgba(255,255,255,0.02)',
                border: `1px solid ${COLORS.cardBorder}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Radio size={14} style={{ color: COLORS.success }} />
                  <div>
                    <span style={{ fontSize: 13, color: COLORS.textPrimary }}>
                      {sample.label || '未命名'}
                    </span>
                    <span style={{ fontSize: 11, color: COLORS.textMuted, marginLeft: 8 }}>
                      {sample.featureType === 'mfcc' ? 'MFCC' : '统计'} · {formatDate(sample.enrolledAt)}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => onVoiceDeleteSample(sample.id)}
                  style={{
                    background: 'transparent', border: 'none',
                    color: COLORS.textMuted, cursor: 'pointer',
                    padding: '4px 8px', borderRadius: 6,
                  }}
                  title="删除此样本"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 声纹操作按钮组：验证测试 + 清除声纹 */}
        <div style={{ display: 'flex', gap: 8 }}>
          <motion.button
            whileHover={{ scale: voiceprintSampleCount > 0 ? 1.03 : 1 }}
            whileTap={{ scale: voiceprintSampleCount > 0 ? 0.97 : 1 }}
            onClick={onVoiceVerify}
            disabled={voiceprintSampleCount === 0 || voiceVerifying}
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: 'var(--radius-xl)',
              color: voiceprintSampleCount > 0 ? COLORS.textPrimary : COLORS.textMuted,
              fontSize: 12,
              padding: '6px 16px',
              cursor: voiceprintSampleCount > 0 ? 'pointer' : 'not-allowed',
              fontFamily: 'inherit',
              transition: 'all 0.2s',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              opacity: voiceprintSampleCount > 0 ? 1 : 0.4,
            }}
          >
            {voiceVerifying ? '验证中...' : '验证测试'}
          </motion.button>
          <motion.button
            whileHover={{ scale: voiceprintSampleCount > 0 ? 1.03 : 1 }}
            whileTap={{ scale: voiceprintSampleCount > 0 ? 0.97 : 1 }}
            onClick={onVoiceClear}
            disabled={voiceprintSampleCount === 0}
            style={{
background: COLORS.dangerDim,
border: `1px solid ${HEX_COLORS.dangerAlt}26`,
              borderRadius: 'var(--radius-xl)',
              color: voiceprintSampleCount > 0 ? COLORS.dangerAlt : COLORS.textMuted,
              fontSize: 12,
              padding: '6px 16px',
              cursor: voiceprintSampleCount > 0 ? 'pointer' : 'not-allowed',
              fontFamily: 'inherit',
              transition: 'all 0.2s',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              opacity: voiceprintSampleCount > 0 ? 1 : 0.4,
            }}
          >
            清除声纹
          </motion.button>
        </div>

        {/* 验证分数显示 */}
        {voiceVerifyScore !== null && (
          <div style={{
            fontSize: 12, color: COLORS.textMuted,
            background: 'rgba(255,255,255,0.04)',
            borderRadius: 'var(--radius-md)',
            padding: '8px 12px',
          }}>
            匹配分数：<span style={{ fontWeight: 600, color: voiceVerifyScore > 0.6 ? COLORS.success : COLORS.danger }}>
              {((voiceVerifyScore ?? 0) * 100).toFixed(1)}%
            </span>
            {voiceVerifyScore > 0.6 ? ' （匹配）' : ' （不匹配）'}
          </div>
        )}

        {/* 降噪开关 */}
        <div style={{ height: 1, background: 'rgba(255,255,255,0.05)', margin: '4px 0' }} />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: COLORS.textPrimary, marginBottom: 4 }}>
              环境降噪
            </div>
            <div style={{ fontSize: 12, color: COLORS.textMuted }}>
              过滤背景噪声，提升语音识别准确率
            </div>
          </div>
          <motion.div
            whileTap={{ scale: 0.92 }}
            onClick={() => onNoiseFilterChange()}
            style={{
              width: 44, height: 24, borderRadius: 12,
              background: noiseFilterOn ? COLORS.success : 'rgba(255,255,255,0.10)',
              padding: 2, cursor: 'pointer',
              display: 'flex', alignItems: 'center',
              justifyContent: noiseFilterOn ? 'flex-end' : 'flex-start',
              transition: 'all 0.3s',
            }}
          >
            <motion.div layout style={{
              width: 20, height: 20, borderRadius: '50%',
              background: '#fff',
            }} />
          </motion.div>
        </div>

        {/* 降噪等级 */}
        <motion.div
          animate={{ opacity: noiseFilterOn ? 1 : 0.35 }}
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, color: COLORS.textPrimary }}>降噪等级</span>
            <span style={{ fontSize: 13, fontWeight: 500, color: COLORS.accent }}>
              {noiseLevel} / 5
            </span>
          </div>
          <input
            type="range"
            min={1}
            max={5}
            value={noiseLevel}
            disabled={!noiseFilterOn}
            onChange={(e) => {
              const level = parseInt(e.target.value, 10)
              onNoiseLevelChange(level)
            }}
            style={{
              width: '100%',
              accentColor: 'var(--accent)',
              cursor: noiseFilterOn ? 'pointer' : 'not-allowed',
              opacity: noiseFilterOn ? 1 : 0.3,
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: COLORS.textMuted }}>
            <span>轻度</span><span>标准</span><span>深度</span>
          </div>
        </motion.div>
      </div>
    </GlassCard>
  )
}