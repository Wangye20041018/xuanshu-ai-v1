/**
 * Onboarding —— 首次启动新手引导
 *
 * 首次打开时展示欢迎/能力说明卡片，重点提示「控制电脑」等危险能力风险，
 * 用户勾选「已知晓」后写入 localStorage，此后不再显示。
 *
 * @module renderer/components/Onboarding
 */

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, Mic, Zap, Wrench, ShieldAlert, Monitor } from 'lucide-react'
import { COLORS, HEX_COLORS } from '../shared/theme'
import { useTranslation } from '../i18n'

const STORAGE_KEY = 'xuanshu-onboarding-done'

/** 判断是否已完成新手引导 */
export function isOnboardingDone(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return true // localStorage 不可用时不再打扰用户
  }
}

const CAPABILITIES = [
  { icon: <Sparkles size={16} />, label: '智能对话', desc: '多模型切换、流式输出、记忆与知识库检索' },
  { icon: <Mic size={16} />, label: '语音交互', desc: '实时语音识别与自然语音合成' },
  { icon: <Zap size={16} />, label: '自动化', desc: '定时任务与事件驱动的桌面自动化' },
  { icon: <Wrench size={16} />, label: '自我改造', desc: '在严格安全约束下修改自身代码（需显式开启）' },
]

export default function Onboarding() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [ack, setAck] = useState(false)

  useEffect(() => {
    setOpen(!isOnboardingDone())
  }, [])

  const confirm = () => {
    try {
      localStorage.setItem(STORAGE_KEY, '1')
    } catch {
      /* ignore */
    }
    setOpen(false)
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          style={{
            position: 'fixed', inset: 0, zIndex: 100000,
            background: 'rgba(10,10,15,0.7)', backdropFilter: 'blur(12px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            style={{
              width: 560, maxWidth: '92vw', maxHeight: '86vh', overflow: 'auto',
              background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
              borderRadius: 20, padding: 32,
              display: 'flex', flexDirection: 'column', gap: 20,
              boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 44, height: 44, borderRadius: 14,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: `${HEX_COLORS.accent}15`, color: COLORS.accent,
              }}>
                <Sparkles size={22} />
              </div>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 700, color: COLORS.textPrimary, margin: 0 }}>
                  欢迎使用 {t('common.appName')}
                </h2>
                <p style={{ fontSize: 12, color: COLORS.textMuted, margin: '4px 0 0' }}>
                  你的本地智能桌面助手
                </p>
              </div>
            </div>

            {/* 能力说明 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {CAPABILITIES.map((c) => (
                <div key={c.label} style={{
                  display: 'flex', gap: 12, padding: '12px 14px',
                  background: 'rgba(255,255,255,0.02)', borderRadius: 12,
                  border: `1px solid ${COLORS.cardBorder}`,
                }}>
                  <span style={{ color: COLORS.accent, flexShrink: 0, display: 'flex', marginTop: 1 }}>{c.icon}</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>{c.label}</div>
                    <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 2, lineHeight: 1.5 }}>{c.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* 危险能力风险提示 */}
            <div style={{
              padding: '14px 16px', borderRadius: 12,
              background: `${HEX_COLORS.warning}12`, border: `1px solid ${HEX_COLORS.warning}40`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <ShieldAlert size={16} style={{ color: COLORS.warning }} />
                <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.warning }}>危险能力风险提示</span>
              </div>
              <div style={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>
                「桌面自动化」（<Monitor size={11} style={{ verticalAlign: 'middle' }} /> 控制电脑）可模拟鼠标点击与键盘输入，
                直接作用于你的电脑。每次执行前都会弹出确认框，请确认任务来源可靠后再允许。
                自我改造会真实修改应用代码，默认关闭写模式，改动前需人工核对 diff。
              </div>
            </div>

            {/* 已知晓确认 */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ width: 16, height: 16, cursor: 'pointer' }} />
              <span style={{ fontSize: 13, color: COLORS.textPrimary }}>我已了解上述能力与风险</span>
            </label>

            <motion.button
              whileTap={{ scale: 0.97 }}
              onClick={confirm}
              disabled={!ack}
              style={{
                padding: '12px 0', borderRadius: 12, border: 'none', cursor: ack ? 'pointer' : 'not-allowed',
                fontFamily: 'inherit', fontSize: 14, fontWeight: 600,
                background: ack ? COLORS.accent : 'rgba(255,255,255,0.08)',
                color: ack ? '#fff' : COLORS.textMuted, opacity: ack ? 1 : 0.7,
              }}
            >
              开始使用
            </motion.button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
