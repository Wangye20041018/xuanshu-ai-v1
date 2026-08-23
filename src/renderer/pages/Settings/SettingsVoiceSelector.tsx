import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Volume2, Loader2, RotateCcw, Check, Play, AlertCircle } from 'lucide-react'
import { COLORS, GlassCard } from './index'

interface VoiceProfile {
  id: string
  name: string
  gender?: string
  age?: string
  description?: string
  ttsLabel?: string
  isBuiltIn?: boolean
  ttsEngine?: string
}

interface TtsStatus {
  available?: boolean
  edgeAvailable?: boolean
  piperAvailable?: boolean
  piperModelCount?: number
}

const PREVIEW_TEXT = '你好，我是玄枢，很高兴为你服务'

export default function SettingsVoiceSelector() {
  const [voices, setVoices] = useState<VoiceProfile[]>([])
  const [currentVoiceId, setCurrentVoiceId] = useState<string>('')
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [ttsStatus, setTtsStatus] = useState<TtsStatus | null>(null)
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  const [previewingId, setPreviewingId] = useState<string | null>(null)
  const [flash, setFlash] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = async () => {
    setStatus('loading')
    setErrorMsg('')
    try {
      const [voiceList, current, tts] = await Promise.all([
        window.api.invoke<VoiceProfile[]>('voice:get-voices'),
        window.api.invoke<{ currentVoiceId?: string }>('voice:get-current'),
        window.api.invoke<TtsStatus>('voice:tts-status').catch(() => null as unknown as TtsStatus),
      ])
      setVoices(Array.isArray(voiceList) ? voiceList : [])
      setCurrentVoiceId(current?.currentVoiceId || '')
      setTtsStatus(tts)
      setStatus('ready')
    } catch (e) {
      setStatus('error')
      setErrorMsg(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    load()
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current)
    }
  }, [])

  const showFlash = (type: 'success' | 'error', text: string) => {
    setFlash({ type, text })
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 2500)
  }

  const handleSelect = async (voice: VoiceProfile) => {
    if (switchingId) return
    setSwitchingId(voice.id)
    try {
      const res = await window.api.invoke<{ success?: boolean; currentVoiceId?: string; error?: string }>(
        'voice:set-current',
        voice.id,
      )
      if (res?.success === false) {
        showFlash('error', res.error || '切换失败')
      } else {
        setCurrentVoiceId(res?.currentVoiceId || voice.id)
        showFlash('success', `已切换为「${voice.name}」，即时生效`)
      }
    } catch (e) {
      showFlash('error', e instanceof Error ? e.message : String(e))
    } finally {
      setSwitchingId(null)
    }
  }

  const handlePreview = async (voice: VoiceProfile) => {
    setPreviewingId(voice.id)
    try {
      const res = await window.api.invoke<{ success?: boolean; error?: string; fallback?: boolean }>(
        'voice:speak',
        PREVIEW_TEXT,
        voice.id,
      )
      if (res?.success === false) {
        showFlash('error', `试听失败：${res.error || '未知错误'}`)
      } else if (res?.fallback) {
        showFlash('success', '已用浏览器语音试听（离线引擎不可用，已降级）')
      }
    } catch (e) {
      showFlash('error', `试听失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPreviewingId(null)
    }
  }

  return (
    <GlassCard
      title="语音音色"
      icon={<Volume2 size={18} />}
      accentColor={COLORS.purple}
      headerRight={
        <span style={{ fontSize: 12, color: COLORS.textMuted }}>
          {ttsStatus?.piperAvailable ? 'Piper 离线 + Edge 在线' : 'Edge 在线合成'}
          {ttsStatus?.piperModelCount ? ` · ${ttsStatus.piperModelCount} 模型` : ''}
        </span>
      }
    >
      {flash && (
        <div
          style={{
            marginBottom: 12,
            padding: '8px 12px',
            borderRadius: 8,
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: flash.type === 'success' ? 'rgba(52,199,123,0.12)' : 'rgba(255,92,92,0.12)',
            color: flash.type === 'success' ? COLORS.success : COLORS.danger,
          }}
        >
          {flash.type === 'success' ? <Check size={14} /> : <AlertCircle size={14} />}
          {flash.text}
        </div>
      )}

      {status === 'loading' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: COLORS.textMuted, padding: '12px 0' }}>
          <Loader2 size={16} className="spin" />
          正在加载音色列表…
        </div>
      )}

      {status === 'error' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: COLORS.danger, fontSize: 13 }}>
            <AlertCircle size={14} />
            加载音色失败：{errorMsg}
          </div>
          <button
            onClick={load}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
              padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
              border: `1px solid ${COLORS.accent}`, background: 'transparent', color: COLORS.accent,
            }}
          >
            <RotateCcw size={13} />
            重试
          </button>
        </div>
      )}

      {status === 'ready' && (
        <>
          {voices.length === 0 ? (
            <div style={{ color: COLORS.textMuted, fontSize: 13, padding: '12px 0' }}>暂无可用音色</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))', gap: 8 }}>
              {voices.map((v) => {
                const active = v.id === currentVoiceId
                const switching = switchingId === v.id
                const previewing = previewingId === v.id
                return (
                  <motion.div
                    key={v.id}
                    whileHover={{ y: -2 }}
                    onClick={() => handleSelect(v)}
                    style={{
                      cursor: 'pointer', borderRadius: 10, padding: '10px 12px', position: 'relative',
                      border: active ? `1.5px solid ${COLORS.accent}` : '1px solid rgba(255,255,255,0.08)',
                      background: active ? 'rgba(121,106,255,0.10)' : 'rgba(255,255,255,0.03)',
                      transition: 'all .15s',
                    }}
                  >
                    {active && (
                      <span
                        style={{
                          position: 'absolute', top: 8, right: 8, color: COLORS.accent,
                          display: 'flex', alignItems: 'center', gap: 2, fontSize: 11,
                        }}
                      >
                        <Check size={11} /> 当前
                      </span>
                    )}
                    <div style={{ fontWeight: 600, fontSize: 13, color: COLORS.textPrimary }}>{v.name}</div>
                    <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2 }}>
                      {v.ttsLabel || v.ttsEngine || ''}
                    </div>
                    <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 6, lineHeight: 1.5, minHeight: 32 }}>
                      {v.description || ''}
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handlePreview(v)
                      }}
                      disabled={previewing}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 8,
                        padding: '4px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
                        border: '1px solid rgba(255,255,255,0.12)', background: 'transparent', color: COLORS.textPrimary,
                      }}
                    >
                      {previewing ? <Loader2 size={12} className="spin" /> : <Play size={12} />}
                      {previewing ? '播放中' : '试听'}
                    </button>
                    {switching && (
                      <span style={{ position: 'absolute', bottom: 8, right: 8, color: COLORS.textMuted }}>
                        <Loader2 size={12} className="spin" />
                      </span>
                    )}
                  </motion.div>
                )
              })}
            </div>
          )}
          <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 12, lineHeight: 1.6 }}>
            点击音色即切换并即时生效；试听走当前 TTS 引擎（Piper 离线优先，不可用时降级 Edge/浏览器语音）。
          </div>
        </>
      )}
    </GlassCard>
  )
}
