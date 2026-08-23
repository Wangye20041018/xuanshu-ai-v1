import { useState, useRef, useCallback, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Mic, Play, Trash2, Circle, Check, Loader, Music, Copy } from 'lucide-react'
import { HEX_COLORS, COLORS } from '../../shared/theme'
import { logger } from '../../../shared/logger'



interface CloneVoice {
  id: string
  name: string
  createdAt: string
  timbre: string
  duration: number
}

function VoiceCloneTab() {
  const [isRecording, setIsRecording] = useState(false)
  const [recordDuration, setRecordDuration] = useState(0)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [cloneStatus, setCloneStatus] = useState<'idle' | 'cloning' | 'done' | 'error'>('idle')
  const [voices, setVoices] = useState<CloneVoice[]>([])
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stopRecordingRef = useRef<() => void>(() => {})

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop()
    setIsRecording(false)
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
  }, [])

  // 保持 stopRecording ref 最新，避免 startRecording 闭包陈旧
  useEffect(() => {
    stopRecordingRef.current = stopRecording
  }, [stopRecording])

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      chunksRef.current = []
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        const url = URL.createObjectURL(blob)
        setAudioUrl(url)
        stream.getTracks().forEach(t => t.stop())
      }
      mr.start(100)
      mediaRecorderRef.current = mr
      setIsRecording(true)
      setRecordDuration(0)
      timerRef.current = setInterval(() => {
        setRecordDuration(prev => {
          if (prev >= 30) {
            stopRecordingRef.current()
            return prev
          }
          return prev + 1
        })
      }, 1000)
    } catch (e) {
      logger.error('Microphone access denied:', e)
    }
  }, [])

  // Cleanup on unmount

  useEffect(() => {

    return () => {

      if (timerRef.current) clearInterval(timerRef.current)

      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {

        mediaRecorderRef.current.stop()

      }

    }

  }, [])

  const startClone = useCallback(async () => {

    if (!audioUrl) return

    setCloneStatus('cloning')

    try {

      const response = await fetch(audioUrl)

      const blob = await response.blob()

      const reader = new FileReader()

      const base64 = await new Promise<string>(resolve => {

        reader.onload = () => resolve((reader.result as string).split(',')[1])

        reader.readAsDataURL(blob)

      })

      const result = await window.api?.invoke<{ success: boolean; voice?: CloneVoice; error?: string }>('voice:clone:start', base64)

      if (result?.success && result.voice) {

        setVoices(prev => [...prev, result.voice!])

        setCloneStatus('done')

      } else {

        setCloneStatus('error')

      }

    } catch {

      setCloneStatus('error')

    }

  }, [audioUrl])

  const resetRecording = useCallback(() => {

    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {

      mediaRecorderRef.current.stop()

    }

    setIsRecording(false)

    setRecordDuration(0)

    setAudioUrl(null)

    setCloneStatus('idle')

    chunksRef.current = []

    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }

  }, [])

  /* ───── 状态徽章───── */

  const statusBadge = () => {

    if (cloneStatus === 'cloning') return { icon: <Loader size={12} style={{ animation: 'spin 1s linear infinite' }} />, text: '声音克隆中..', color: COLORS.accent, bg: `${HEX_COLORS.accent}10` }

    if (cloneStatus === 'done') return { icon: <Check size={12} />, text: '克隆完成', color: COLORS.success, bg: COLORS.successDim }

    if (cloneStatus === 'error') return { icon: <span>⚠</span>, text: '克隆失败·请重试', color: COLORS.danger, bg: COLORS.dangerDim }

    return null

  }

  const badge = statusBadge()

  return (

    <motion.div

      initial={{ opacity: 0, y: 12 }}

      animate={{ opacity: 1, y: 0 }}

      transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}

      style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}

    >

      {/* ════════════════ 录制区域卡片 ════════════════ */}

      <div

        style={{

          borderRadius: 'var(--radius-20)',

          padding: '32px 28px',

          background: 'linear-gradient(135deg, rgba(99,102,241,0.06) 0%, rgba(13,17,23,0.95) 50%, rgba(245,158,11,0.04) 100%)',

          border: '1px solid rgba(255,255,255,0.08)',

          boxShadow: '0 8px 40px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.03)',

        }}

      >

        {/* 顶部标题*/}

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>

          <div style={{

            width: 44, height: 44, borderRadius: '14px',

            background: 'linear-gradient(135deg, rgba(99,102,241,0.2), rgba(245,158,11,0.1))',

            border: '1px solid rgba(255,255,255,0.1)',

            display: 'flex', alignItems: 'center', justifyContent: 'center',

          }}>

            <Mic size={20} style={{ color: COLORS.accent }} />

          </div>

          <div>

            <h3 style={{ margin: 0, fontSize: 'var(--text-xl)', fontWeight: 600, color: COLORS.textPrimary }}>

              录制你的声音样本

            </h3>

            <p style={{ margin: '2px 0 0', fontSize: 'var(--text-sm)', color: 'rgba(255,255,255,0.4)' }}>

              请用自然语气朗读，建议 30 秒以上以获得更好效果

            </p>

          </div>

        </div>

        {/* 可视化波形区 */}

        <div

          style={{

            position: 'relative',

            height: 80,

            borderRadius: 'var(--radius-16)',

            marginBottom: '24px',

            background: 'rgba(0,0,0,0.3)',

            border: '1px solid rgba(255,255,255,0.05)',

            display: 'flex', alignItems: 'center', justifyContent: 'center',

            overflow: 'hidden',

          }}

        >

          {isRecording ? (

            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: '60%' }}>

              {Array.from({ length: 24 }).map((_, i) => (

                <motion.div

                  key={i}

                  style={{

                    width: '3px',

                    borderRadius: '2px',

                    background: `linear-gradient(to top, #b0b0ba, ${i > 16 ? COLORS.warning : COLORS.accent})`,

                    opacity: 0.8,

                  }}

                  animate={{

                    height: [

                      8 + Math.sin(i * 0.6) * 8,

                      20 + Math.sin((i + Date.now() * 0.003) * 1.2) * 28,

                      8 + Math.sin(i * 0.6) * 8,

                    ],

                  }}

                  transition={{ duration: 0.6 + (i % 3) * 0.2, repeat: Infinity, ease: 'easeInOut' }}

                />

              ))}

            </div>

          ) : audioUrl ? (

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>

              <Check size={22} style={{ color: COLORS.success }} />

              <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 'var(--text-lg)' }}>

                录制完成 · {recordDuration}              </span>

            </div>

          ) : (

            <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: 'var(--text-lg)' }}>

              点击下方按钮开始录制            </span>

          )}

        </div>

        {/* 操作按钮*/}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', flexWrap: 'wrap' }}>

          {!isRecording && !audioUrl && (

            <motion.button

              whileHover={{ scale: 1.03 }}

              whileTap={{ scale: 0.96 }}

              onClick={startRecording}

              style={{

                display: 'flex', alignItems: 'center', gap: '10px',

                minHeight: 44, padding: '0 32px', borderRadius: '14px',

                border: 'none', cursor: 'pointer',

                fontSize: 'var(--text-xl)', fontWeight: 600,

                color: '#fff',

                background: `linear-gradient(135deg, ${COLORS.accent}, ${COLORS.purple})`,

                boxShadow: '0 6px 24px rgba(99,102,241,0.25)',

              }}

            >

              <Circle size={16} fill="#fff" /> 开始录制            </motion.button>

          )}

          {isRecording && (

            <motion.button

              whileTap={{ scale: 0.96 }}

              onClick={stopRecording}

              style={{

                display: 'flex', alignItems: 'center', gap: '8px',

                minHeight: 44, padding: '0 32px', borderRadius: '14px',

                border: '2px solid rgba(239,68,68,0.5)', cursor: 'pointer',

                fontSize: 'var(--text-xl)', fontWeight: 600,

                color: COLORS.danger,

                background: COLORS.dangerDim,

              }}

            >

              <span style={{

                width: 12, height: 12, borderRadius: '2px',

                background: COLORS.danger,

                display: 'inline-block',

              }} />

              停止录音 ({recordDuration}s)

            </motion.button>

          )}

          {audioUrl && !isRecording && cloneStatus !== 'done' && (

            <>

              <motion.button

                whileTap={{ scale: 0.96 }}

                onClick={startClone}

                disabled={cloneStatus === 'cloning'}

                style={{

                  display: 'flex', alignItems: 'center', gap: '10px',

                  minHeight: 44, padding: '0 32px', borderRadius: '14px',

                  border: 'none', cursor: cloneStatus === 'cloning' ? 'not-allowed' : 'pointer',

                  fontSize: 'var(--text-xl)', fontWeight: 600,

                  color: '#fff',

                  background: `linear-gradient(135deg, ${COLORS.warning}, ${COLORS.warningAlt})`,

                  boxShadow: '0 6px 24px rgba(245,158,11,0.2)',

                  opacity: cloneStatus === 'cloning' ? 0.6 : 1,

                }}

              >

                {cloneStatus === 'cloning' ? <Loader size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <Music size={16} />}

                {cloneStatus === 'cloning' ? '克隆中..' : '开始声音克隆'}

              </motion.button>

              <motion.button

                whileHover={{ scale: 1.03 }}

                whileTap={{ scale: 0.96 }}

                onClick={resetRecording}

                style={{

                  minHeight: 44, padding: '0 20px', borderRadius: '14px',

                  border: '1px solid rgba(255,255,255,0.1)', cursor: 'pointer',

                  fontSize: 'var(--text-lg)', color: COLORS.textSecondary,

                  background: COLORS.cardBg,

                }}

              >

                重新录制

              </motion.button>

            </>

          )}

          {cloneStatus === 'done' && (

            <motion.button

              whileHover={{ scale: 1.03 }}

              whileTap={{ scale: 0.96 }}

              onClick={resetRecording}

              style={{

                display: 'flex', alignItems: 'center', gap: '10px',

                minHeight: 44, padding: '0 32px', borderRadius: '14px',

                border: '1px solid rgba(34,197,94,0.4)', cursor: 'pointer',

                fontSize: 'var(--text-xl)', fontWeight: 600,

                color: COLORS.success,

                background: COLORS.successDim,

              }}

            >

              <Mic size={16} /> 录制新声音            </motion.button>

          )}

        </div>

        {/* 状态提示*/}

        {badge && (

          <motion.div

            initial={{ opacity: 0, y: 8 }}

            animate={{ opacity: 1, y: 0 }}

            style={{

              marginTop: '16px',

              padding: '8px 16px',

              borderRadius: '10px',

              background: badge.bg,

              border: `1px solid ${badge.color}20`,

              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',

              fontSize: 'var(--text-base)', color: badge.color,

            }}

          >

            {badge.icon}

            <span>{badge.text}</span>

          </motion.div>

        )}

        {/* 录制时长指示 */}

        <div style={{

          marginTop: '12px',

          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',

          fontSize: 'var(--text-sm)', color: COLORS.textMuted,

        }}>

          <div style={{ width: '60%', height: '3px', borderRadius: '2px', background: COLORS.cardBorder, overflow: 'hidden' }}>

            <div style={{

              width: `${Math.min((recordDuration / 30) * 100, 100)}%`,

              height: '100%',

              borderRadius: '2px',

              background: recordDuration >= 25 ? COLORS.success : recordDuration >= 10 ? COLORS.warning : COLORS.accent,

              transition: 'width 0.3s ease',

            }} />

          </div>

          <span>{recordDuration}s / 30s</span>

        </div>

      </div>

      {/* ════════════════ 已克隆的声音列表 ════════════════ */}

      {voices.length > 0 && (

        <motion.div

          initial={{ opacity: 0, y: 16 }}

          animate={{ opacity: 1, y: 0 }}

          transition={{ delay: 0.2 }}

        >

          <h3 style={{

            fontSize: 'var(--text-lg)', fontWeight: 600, color: COLORS.textSecondary,

            margin: '0 0 12px', letterSpacing: '0.5px',

          }}>

            已克隆的声音

          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>

            {voices.map((v, idx) => (

              <motion.div

                key={v.id}

                initial={{ opacity: 0, x: -12 }}

                animate={{ opacity: 1, x: 0 }}

                transition={{ delay: 0.1 + idx * 0.06 }}

                style={{

                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',

                  padding: '16px 20px',

                  borderRadius: 'var(--radius-16)',

                  background: COLORS.cardBg,

                  border: '1px solid rgba(255,255,255,0.06)',

                }}

              >

                <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>

                  <div style={{

                    width: 40, height: 40, borderRadius: '12px',

                    background: 'linear-gradient(135deg, rgba(99,102,241,0.15), rgba(245,158,11,0.08))',

                    border: '1px solid rgba(255,255,255,0.08)',

                    display: 'flex', alignItems: 'center', justifyContent: 'center',

                  }}>

                    <Copy size={16} style={{ color: COLORS.accent }} />

                  </div>

                  <div>

                    <div style={{ fontSize: 'var(--text-lg)', fontWeight: 500, color: COLORS.textPrimary }}>{v.name}</div>

                    <div style={{ fontSize: 'var(--text-xs)', color: COLORS.textMuted, marginTop: '2px' }}>

                      {v.createdAt} · {v.timbre} · {v.duration}s

                    </div>

                  </div>

                </div>

                <div style={{ display: 'flex', gap: '6px' }}>

                  <button

                    onClick={() => { window.api?.invoke('voice:preview', v.id)?.catch((e) => logger.error('[VoiceClone] 预览失败:', e)) }}

                    style={{

                      padding: '8px 10px', borderRadius: '10px',

                      border: '1px solid rgba(255,255,255,0.08)',

                      background: COLORS.cardBg, cursor: 'pointer',

                    }}

                  >

                    <Play size={14} style={{ color: 'rgba(255,255,255,0.4)' }} />

                  </button>

                  <button

                    onClick={() => { window.api?.invoke('voice:delete-voice', v.id)?.then(() => setVoices(prev => prev.filter(vc => vc.id !== v.id))).catch((e) => logger.error('[VoiceClone] 删除失败:', e)) }}

                    style={{

                      padding: '8px 10px', borderRadius: '10px',

                      border: '1px solid rgba(239,68,68,0.12)',

                      background: `${HEX_COLORS.dangerAlt}05`, cursor: 'pointer',

                    }}

                  >

                    <Trash2 size={14} style={{ color: COLORS.danger }} />

                  </button>

                </div>

              </motion.div>

            ))}

          </div>

        </motion.div>

      )}

    </motion.div>

  )

}

export default VoiceCloneTab

