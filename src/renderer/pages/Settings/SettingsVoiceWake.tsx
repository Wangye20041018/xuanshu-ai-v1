import { motion } from 'framer-motion'
import { Mic, Info } from 'lucide-react'
import { HEX_COLORS, COLORS, GlassCard, Toggle, Slider } from './index'

interface SettingsVoiceWakeProps {
  wakeEnabled: boolean
  wakeRunning: boolean
  wakeWord: string
  wakeSensitivity: number
  exitWord: string
  exitConfirmWords: string
  exitCancelWords: string
  exitConfirmTTS: string
  onToggleWake: () => void
  onWakeWordChange: (word: string) => void
  onSensitivityChange: (value: number) => void
  onExitWordChange: (word: string) => void
  onExitConfirmWordsChange: (words: string) => void
  onExitCancelWordsChange: (words: string) => void
  onExitConfirmTTSChange: (tts: string) => void
}

export default function SettingsVoiceWake({
  wakeEnabled,
  wakeRunning,
  wakeWord,
  wakeSensitivity,
  exitWord,
  exitConfirmWords,
  exitCancelWords,
  exitConfirmTTS,
  onToggleWake,
  onWakeWordChange,
  onSensitivityChange,
  onExitWordChange,
  onExitConfirmWordsChange,
  onExitCancelWordsChange,
  onExitConfirmTTSChange,
}: SettingsVoiceWakeProps) {
  return (
    <GlassCard
      title="语音唤醒"
      icon={<Mic size={18} />}
      accentColor={COLORS.purple}
      headerRight={
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <motion.span
            animate={wakeRunning ? {
              opacity: [0.7, 1, 0.7],
              color: COLORS.success,
            } : {
              color: COLORS.textMuted,
            }}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            style={{
              fontSize: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {wakeRunning ? (
              <>
                <motion.div
                  animate={{ scale: [1, 1.3, 1] }}
                  transition={{ duration: 1.5, repeat: Infinity }}
                  style={{ width: 8, height: 8, borderRadius: '50%', background: COLORS.success }}
                />
                监听中
              </>
            ) : (
              <>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: COLORS.textMuted }} />
                已停止
              </>
            )}
          </motion.span>
          <Toggle checked={wakeEnabled} onChange={onToggleWake} />
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* 唤醒词输入 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 18px',
            borderRadius: 'var(--radius-16)',
            background: 'rgba(255,255,255,0.02)',
            border: `1px solid ${COLORS.cardBorder}`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 13, color: COLORS.textMuted }}>唤醒词</span>
          </div>
          <input
            type="text"
            value={wakeWord}
            onChange={(e) => onWakeWordChange(e.target.value)}
            placeholder="输入唤醒词"
            style={{
              width: 120,
              padding: '6px 12px',
              borderRadius: '10px',
              background: 'rgba(255,255,255,0.04)',
              border: `1px solid ${COLORS.cardBorder}`,
              color: COLORS.textPrimary,
              fontSize: 14,
              fontWeight: 600,
              textAlign: 'center',
              outline: 'none',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--border-focus)'; e.currentTarget.style.boxShadow = `0 0 0 3px ${HEX_COLORS.violet}1a` }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-default)'; e.currentTarget.style.boxShadow = 'none' }}
          />
        </div>

        {/* 灵敏度滑块 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 18px',
            borderRadius: 'var(--radius-16)',
            background: 'rgba(255,255,255,0.02)',
            border: `1px solid ${COLORS.cardBorder}`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 13, color: COLORS.textMuted }}>灵敏度</span>
          </div>
          <Slider value={wakeSensitivity} onChange={onSensitivityChange} min={10} max={100} />
        </div>

        {/* 服务状态 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 18px',
            borderRadius: 'var(--radius-16)',
            background: 'rgba(255,255,255,0.02)',
            border: `1px solid ${COLORS.cardBorder}`,
          }}
        >
          <span style={{ fontSize: 13, color: COLORS.textMuted }}>服务状态</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, color: wakeRunning ? COLORS.success : COLORS.textMuted }}>
              {wakeRunning ? '运行中' : '未启动'}
            </span>
            {wakeRunning && (
              <motion.div
                animate={{ scale: [1, 1.2, 1] }}
                transition={{ duration: 1.5, repeat: Infinity }}
                style={{ width: 6, height: 6, borderRadius: '50%', background: COLORS.success }}
              />
            )}
          </div>
        </div>

        {/* ===== 退出词配置 ===== */}
        <div style={{ borderTop: `1px solid ${COLORS.cardBorder}`, paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <span style={{ fontSize: 12, fontWeight: 500, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            退出语音模式
          </span>

          {/* 退出语音词 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderRadius: 'var(--radius-12)', background: 'rgba(255,255,255,0.02)', border: `1px solid ${COLORS.cardBorder}` }}>
            <span style={{ fontSize: 13, color: COLORS.textMuted }}>退出语音词</span>
            <input type="text" value={exitWord}
              placeholder="退出"
              onChange={(e) => onExitWordChange(e.target.value)}
              style={{ width: 130, padding: '6px 12px', borderRadius: '10px', background: 'rgba(255,255,255,0.04)', border: `1px solid ${COLORS.cardBorder}`, color: COLORS.textPrimary, fontSize: 13, textAlign: 'center', outline: 'none' }}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--border-focus)' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
            />
          </div>

          {/* 退出确认词 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderRadius: 'var(--radius-12)', background: 'rgba(255,255,255,0.02)', border: `1px solid ${COLORS.cardBorder}` }}>
            <span style={{ fontSize: 13, color: COLORS.textMuted }}>退出确认词</span>
            <input type="text" value={exitConfirmWords}
              placeholder="确认退出,是的"
              onChange={(e) => onExitConfirmWordsChange(e.target.value)}
              style={{ width: 130, padding: '6px 12px', borderRadius: '10px', background: 'rgba(255,255,255,0.04)', border: `1px solid ${COLORS.cardBorder}`, color: COLORS.textPrimary, fontSize: 13, textAlign: 'center', outline: 'none' }}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--border-focus)' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
            />
          </div>

          {/* 取消退出词 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderRadius: 'var(--radius-12)', background: 'rgba(255,255,255,0.02)', border: `1px solid ${COLORS.cardBorder}` }}>
            <span style={{ fontSize: 13, color: COLORS.textMuted }}>取消退出词</span>
            <input type="text" value={exitCancelWords}
              placeholder="取消,不要"
              onChange={(e) => onExitCancelWordsChange(e.target.value)}
              style={{ width: 130, padding: '6px 12px', borderRadius: '10px', background: 'rgba(255,255,255,0.04)', border: `1px solid ${COLORS.cardBorder}`, color: COLORS.textPrimary, fontSize: 13, textAlign: 'center', outline: 'none' }}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--border-focus)' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
            />
          </div>

          {/* 退出确认语音播报文本 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderRadius: 'var(--radius-12)', background: 'rgba(255,255,255,0.02)', border: `1px solid ${COLORS.cardBorder}` }}>
            <span style={{ fontSize: 13, color: COLORS.textMuted }}>确认播报文本</span>
            <input type="text" value={exitConfirmTTS}
              placeholder="确认退出语音模式吗？"
              onChange={(e) => onExitConfirmTTSChange(e.target.value)}
              style={{ width: 130, padding: '6px 12px', borderRadius: '10px', background: 'rgba(255,255,255,0.04)', border: `1px solid ${COLORS.cardBorder}`, color: COLORS.textPrimary, fontSize: 13, textAlign: 'center', outline: 'none' }}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--border-focus)' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderRadius: 'var(--radius-8)', background: `${HEX_COLORS.violet}0a`, border: `1px solid ${HEX_COLORS.violet}1a` }}>
            <Info size={14} style={{ color: COLORS.purple, flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontSize: 11, color: COLORS.textMuted, lineHeight: 1.5 }}>
              退出语音模式流程：说出退出词 → 播报确认语音 → 说确认词退出 / 说取消词继续对话
            </span>
          </div>
        </div>
      </div>
    </GlassCard>
  )
}