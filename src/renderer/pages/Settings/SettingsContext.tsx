import { useState, useEffect, useRef, useCallback } from 'react'
import { motion } from 'framer-motion'
import { Brain, Eye, Power, BarChart3, Bell, Shield, Lock, Mic } from 'lucide-react'
import { HEX_COLORS, COLORS } from './index'
import { logger } from '../../../shared/logger'

/* ============================================================
 * 情境感知设置卡片（M 章：感官总线 + 状态推理 + 情境引擎）
 * 支持：引擎启停 / 主动性档位 / 隐私模式 / 实时情境快照 / 长期画像
 * ============================================================ */

type Proactivity = 'quiet' | 'balanced' | 'active'

const PROACTIVITY_LABEL: Record<Proactivity, string> = {
  quiet: '安静',
  balanced: '平衡',
  active: '积极',
}

const CONTEXT_LABEL: Record<string, { name: string; color: string }> = {
  focused: { name: '专注工作', color: '#4ade80' },
  fatigued: { name: '疲惫', color: '#fb923c' },
  idle_away: { name: '离开/待机', color: '#94a3b8' },
  entertaining: { name: '娱乐/看视频', color: '#a78bfa' },
  deep_night: { name: '深夜', color: '#6366f1' },
  visitor: { name: '有访客', color: '#f87171' },
  meeting: { name: '会议/演讲', color: '#38bdf8' },
  stressed: { name: '压力/情绪低落', color: '#f472b6' },
  healthy: { name: '健康日常', color: '#34d399' },
}

const STATE_LABEL: Record<string, string> = {
  focus: '专注', fatigue: '疲劳', posture_bad: '坐姿不良', screen_too_close: '距离过近',
  breathing_slow: '呼吸平缓', sitting_long: '久坐', peeping: '防窥', late_night: '深夜',
  present: '人在场', absent: '人离开', looking_at: '注视屏幕', distracted: '注意力分散',
  emotion_down: '情绪低落', speaking: '演讲中', sleepy: '犯困', video_watching: '看视频',
}

export default function SettingsContext() {
  const [running, setRunning] = useState(false)
  const [proactivity, setProactivity] = useState<Proactivity>('balanced')
  const [privacy, setPrivacy] = useState(false)
  const [audioOn, setAudioOn] = useState(false)
  const [audioState, setAudioState] = useState<{ status: string; db: number; level: string; speech: boolean; music: boolean; transient: boolean } | null>(null)
  const [pointAtOn, setPointAtOn] = useState(false)
  const [pointAtResult, setPointAtResult] = useState<{ region: string; confidence: number; gazeMatched: boolean; candidates: Array<{ name: string; score: number }>; needsConfirm: boolean; windowTitle: string } | null>(null)
  const [contexts, setContexts] = useState<Record<string, { confidence: number }>>({})
  const [states, setStates] = useState<Record<string, { confidence: number }>>({})
  const [profile, setProfile] = useState<Record<string, number | string> | null>(null)
  const [report, setReport] = useState<{ insights: string[]; suggestions: string[]; avgFocusPerDay: number } | null>(null)
  const [lastAttention, setLastAttention] = useState<string>('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    try {
      const snap = await window.api?.invoke<{ contexts: Record<string, { confidence: number }>; states: Record<string, { confidence: number }> }>('context:snapshot')
      if (snap) {
        setContexts(snap.contexts || {})
        setStates(snap.states || {})
      }
      const p = await window.api?.invoke<Record<string, number | string>>('context:profile')
      if (p) setProfile(p)
      const r = await window.api?.invoke<{ insights: string[]; suggestions: string[]; avgFocusPerDay: number }>('context:weekly-report')
      if (r) setReport(r)
    } catch (e) {
      logger.error('[SettingsContext] 刷新失败', e)
    }
  }, [])

  // 监听主动提醒
  useEffect(() => {
    const off = window.api?.on('context:attention', (_e, ...args) => {
      const decision = args[0] as { context: string; message: string; channel: string } | undefined
      if (decision?.message) setLastAttention(`${decision.message}（${decision.channel}）`)
    })
    return () => { off?.() }
  }, [])

  // 监听听觉感知状态（M3）
  useEffect(() => {
    const off = window.api?.on('audio:state', (_e, ...args) => {
      const st = args[0] as { status: string; db: number; level: string; speech: boolean; music: boolean; transient: boolean } | undefined
      if (st) setAudioState(st)
    })
    return () => { off?.() }
  }, [])

  // 监听指哪问哪结果（M5）
  useEffect(() => {
    const off = window.api?.on('context:point-at', (_e, ...args) => {
      const r = args[0] as { region: string; confidence: number; gazeMatched: boolean; candidates: { name: string; score: number }[]; needsConfirm: boolean; windowTitle: string } | undefined
      if (r) setPointAtResult(r)
    })
    return () => { off?.() }
  }, [])

  const handlePointAtToggle = async (on: boolean) => {
    try {
      const res = await window.api?.invoke<{ ok: boolean; enabled: boolean }>('context:point-at:set', on)
      if (res?.ok) setPointAtOn(res.enabled)
    } catch (e) { logger.error('[SettingsContext] 指哪问哪切换失败', e) }
  }

  const handleAudioToggle = async (on: boolean) => {
    try {
      const ok = await window.api?.invoke<boolean>(on ? 'audio:start' : 'audio:stop')
      if (ok) setAudioOn(on)
    } catch (e) { logger.error('[SettingsContext] 听觉感知切换失败', e) }
  }

  const handleStart = async () => {
    if (running) return
    try {
      const ok = await window.api?.invoke<boolean>('context:start')
      if (ok) {
        setRunning(true)
        pollRef.current = setInterval(refresh, 2000)
        refresh()
      }
    } catch (e) { logger.error('[SettingsContext] 启动失败', e) }
  }

  const handleProactivity = async (level: Proactivity) => {
    setProactivity(level)
    try { await window.api?.invoke('context:set-proactivity', level) } catch { /* noop */ }
  }

  const handlePrivacy = async (on: boolean) => {
    setPrivacy(on)
    try { await window.api?.invoke('context:set-privacy', on ? 'on' : 'off') } catch { /* noop */ }
  }

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const activeContexts = Object.entries(contexts)
    .filter(([, v]) => v.confidence > 0.2)
    .sort((a, b) => b[1].confidence - a[1].confidence)
    .slice(0, 5)

  const activeStates = Object.entries(states)
    .filter(([, v]) => v.confidence > 0.3)
    .sort((a, b) => b[1].confidence - a[1].confidence)
    .slice(0, 8)

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      style={{
        borderRadius: 'var(--radius-24)',
        background: `linear-gradient(135deg, ${HEX_COLORS.violet}0f, rgba(167,139,250,0.05))`,
        border: '1px solid rgba(255,255,255,0.08)',
        backdropFilter: 'blur(12px)',
        overflow: 'hidden',
      }}
    >
      {/* 头部 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '18px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div style={{ width: 40, height: 40, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, #6366f1, #a78bfa)', color: '#fff', boxShadow: `0 4px 16px ${HEX_COLORS.violet}59` }}>
          <Brain size={20} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: COLORS.textPrimary }}>情境感知 · 第六感</div>
          <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 2 }}>感官总线 + 状态推理 + 情境引擎 · 让玄枢知道您在做什么</div>
        </div>
        <button
          onClick={handleStart}
          disabled={running}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 16px', borderRadius: 10, border: 'none', cursor: running ? 'default' : 'pointer',
            fontSize: 13, fontWeight: 600,
            background: running ? 'rgba(74,222,128,0.15)' : 'linear-gradient(135deg, #6366f1, #a78bfa)',
            color: running ? '#4ade80' : '#fff',
            boxShadow: running ? 'none' : `0 4px 14px ${HEX_COLORS.violet}59`,
            opacity: running ? 1 : 0.9,
          }}
        >
          <Power size={14} /> {running ? '运行中' : '启动引擎'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, padding: 18 }}>
        {/* 左列：档位与隐私 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: COLORS.textSecondary, marginBottom: 8 }}>
              <Bell size={13} /> 主动性档位
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {(Object.keys(PROACTIVITY_LABEL) as Proactivity[]).map((lv) => (
                <button
                  key={lv}
                  onClick={() => handleProactivity(lv)}
                  style={{
                    flex: 1, padding: '8px 0', borderRadius: 10, fontSize: 13,
                    border: `1px solid ${proactivity === lv ? COLORS.accent : 'rgba(255,255,255,0.1)'}`,
                    background: proactivity === lv ? `${HEX_COLORS.accent}18` : 'transparent',
                    color: proactivity === lv ? COLORS.accent : COLORS.textSecondary,
                    cursor: 'pointer', transition: 'all 0.2s ease',
                  }}
                >
                  {PROACTIVITY_LABEL[lv]}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 6 }}>
              安静=少打扰 · 平衡=按严重度提醒 · 积极=主动关心
            </div>
          </div>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: COLORS.textSecondary, marginBottom: 8 }}>
              <Lock size={13} /> 隐私模式
            </div>
            <button
              onClick={() => handlePrivacy(!privacy)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                padding: '10px 14px', borderRadius: 10, border: 'none', cursor: 'pointer',
                background: privacy ? 'rgba(248,113,113,0.12)' : 'rgba(255,255,255,0.04)',
                color: privacy ? '#f87171' : COLORS.textSecondary, fontSize: 13, textAlign: 'left',
              }}
            >
              <Shield size={14} />
              {privacy ? '隐私模式开启中：感官通道已暂停' : '关闭全部感知，退回纯对话'}
            </button>
          </div>

          {/* M3 听觉情境 */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: COLORS.textSecondary, marginBottom: 8 }}>
              <Mic size={13} /> 听觉情境（环境音）
            </div>
            <button
              onClick={() => handleAudioToggle(!audioOn)}
              disabled={privacy}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                padding: '10px 14px', borderRadius: 10, border: 'none', cursor: privacy ? 'not-allowed' : 'pointer',
                background: audioOn ? 'rgba(56,189,248,0.12)' : 'rgba(255,255,255,0.04)',
                color: audioOn ? '#38bdf8' : COLORS.textSecondary, fontSize: 13, textAlign: 'left', opacity: privacy ? 0.5 : 1,
              }}
            >
              <Mic size={14} />
              {audioOn ? '听觉感知已开启：识别说话/音乐/敲门/音量' : '开启听觉感知，识别环境声音'}
            </button>
            {audioOn && audioState && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 999, background: 'rgba(255,255,255,0.06)', color: COLORS.textSecondary }}>
                  音量 {Math.round(audioState.db)}dB · {audioState.level}
                </span>
                {audioState.speech && <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 999, background: 'rgba(56,189,248,0.15)', color: '#38bdf8' }}>有人说话</span>}
                {audioState.music && <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 999, background: 'rgba(167,139,250,0.15)', color: '#a78bfa' }}>播放音乐</span>}
                {audioState.transient && <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 999, background: 'rgba(251,146,60,0.15)', color: '#fb923c' }}>瞬态异响</span>}
              </div>
            )}
          </div>

          {/* M5 指哪问哪 */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: COLORS.textSecondary, marginBottom: 8 }}>
              <Eye size={13} /> 指哪问哪（屏幕语义锚定）
            </div>
            <button
              onClick={() => handlePointAtToggle(!pointAtOn)}
              disabled={privacy}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                padding: '10px 14px', borderRadius: 10, border: 'none', cursor: privacy ? 'not-allowed' : 'pointer',
                background: pointAtOn ? 'rgba(74,222,128,0.12)' : 'rgba(255,255,255,0.04)',
                color: pointAtOn ? '#4ade80' : COLORS.textSecondary, fontSize: 13, textAlign: 'left', opacity: privacy ? 0.5 : 1,
              }}
            >
              <Eye size={14} />
              {pointAtOn ? '指哪问哪已开启：指屏幕即锚定元素' : '开启指哪问哪，指向屏幕询问元素'}
            </button>
            {pointAtOn && pointAtResult && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                <div style={{ fontSize: 12, color: COLORS.textSecondary }}>
                  指向区域 <b style={{ color: COLORS.textPrimary }}>{pointAtResult.region}</b>
                  {' '}· 置信 {Math.round(pointAtResult.confidence * 100)}%
                  {' '}· 视线交叉 {pointAtResult.gazeMatched ? '是' : '否'}
                  {' '}· 窗口「{pointAtResult.windowTitle || '前台'}」
                </div>
                <div style={{ fontSize: 11, color: pointAtResult.needsConfirm ? '#fb923c' : '#4ade80' }}>
                  {pointAtResult.needsConfirm ? `候选 ${pointAtResult.candidates.length} 个，等待对话确认：${pointAtResult.candidates.slice(0, 3).map(c => c.name).join(' / ')}` : `已锚定：${pointAtResult.candidates[0]?.name ?? '无'}`}
                </div>
              </div>
            )}
          </div>

          {lastAttention && (
            <div style={{ fontSize: 12, color: COLORS.accent, background: `${HEX_COLORS.accent}10`, padding: '10px 12px', borderRadius: 10 }}>
              最近主动提醒：{lastAttention}
            </div>
          )}
        </div>

        {/* 右列：实时情境 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: COLORS.textSecondary, marginBottom: 2 }}>
            <Eye size={13} /> 当前情境（置信度）
          </div>
          {!running ? (
            <div style={{ fontSize: 12, color: COLORS.textMuted, padding: '20px 0', textAlign: 'center' }}>
              启动引擎后实时显示玄枢对当前情境的判断
            </div>
          ) : activeContexts.length === 0 ? (
            <div style={{ fontSize: 12, color: COLORS.textMuted, padding: '20px 0', textAlign: 'center' }}>
              正在观察……（需要键鼠/窗口/摄像头信号持续喂入）
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {activeContexts.map(([key, v]) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, width: 84, color: CONTEXT_LABEL[key]?.color || COLORS.textPrimary }}>{CONTEXT_LABEL[key]?.name || key}</span>
                  <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                    <motion.div
                      animate={{ width: `${Math.round(v.confidence * 100)}%` }}
                      transition={{ duration: 0.6 }}
                      style={{ height: '100%', borderRadius: 3, background: CONTEXT_LABEL[key]?.color || COLORS.accent }}
                    />
                  </div>
                  <span style={{ fontSize: 11, color: COLORS.textMuted, minWidth: 34, textAlign: 'right' }}>{Math.round(v.confidence * 100)}%</span>
                </div>
              ))}
              {activeStates.length > 0 && (
                <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {activeStates.map(([key, v]) => (
                    <span key={key} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 999, background: 'rgba(255,255,255,0.06)', color: COLORS.textSecondary }}>
                      {STATE_LABEL[key] || key} {Math.round(v.confidence * 100)}%
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 长期画像 */}
      {profile && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: COLORS.textSecondary }}>
            <BarChart3 size={13} /> 今日画像
          </div>
          <span style={{ fontSize: 12, color: COLORS.textPrimary }}>专注 {String(profile.focusMinutes ?? 0)} 分钟</span>
          <span style={{ fontSize: 12, color: COLORS.textMuted }}>·</span>
          <span style={{ fontSize: 12, color: COLORS.textPrimary }}>离开 {String(profile.idleMinutes ?? 0)} 分钟</span>
          <span style={{ fontSize: 12, color: COLORS.textMuted }}>·</span>
          <span style={{ fontSize: 12, color: COLORS.textPrimary }}>深夜 {String(profile.lateNightMinutes ?? 0)} 分钟</span>
          <span style={{ fontSize: 12, color: COLORS.textMuted }}>·</span>
          <span style={{ fontSize: 12, color: COLORS.textPrimary }}>疲劳提醒 {String(profile.fatigueHits ?? 0)} 次</span>
          <span style={{ fontSize: 12, color: COLORS.textMuted }}>·</span>
          <span style={{ fontSize: 12, color: COLORS.textPrimary }}>久坐提醒 {String(profile.sittingLongHits ?? 0)} 次</span>
        </div>
      )}

      {/* M4 数字健康周报 */}
      {report && report.insights && report.insights.length > 0 && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '14px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: COLORS.textSecondary, marginBottom: 8 }}>
            <BarChart3 size={13} /> 数字健康周报（近 7 天 · 洞察而非监控）
          </div>
          {report.insights.map((ins, i) => (
            <div key={`i${i}`} style={{ fontSize: 12, color: COLORS.textPrimary, marginBottom: 4 }}>· {ins}</div>
          ))}
          {report.suggestions.map((sug, i) => (
            <div key={`s${i}`} style={{ fontSize: 12, color: COLORS.accent, marginTop: 2 }}>→ {sug}</div>
          ))}
        </div>
      )}
    </motion.div>
  )
}
