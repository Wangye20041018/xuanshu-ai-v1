import { useState, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Ear, Headphones, Music2, AudioLines, Play, ToggleLeft, ToggleRight, Wifi, WifiOff } from 'lucide-react'
import VoiceCloneTab from './VoiceCloneTab'
import ErrorBoundary from '../../components/ErrorBoundary'
import { useTranslation } from '../../i18n'
import { BUILT_IN_PRESETS, LEGACY_VOICE_ID_MAP } from '../../shared/voicePresets'
import { logger } from '../../../shared/logger'
import { HEX_COLORS, COLORS, containerVariants, itemVariants, listItemVariants } from '../../shared/theme'
import { showToast } from '../../components/Toast'

/* ============================================================ */
/* 本地常量（全局主题未覆盖的颜色） */

/* ============================================================
 * 从后端获取的语音包类型
 * ============================================================ */
interface VoiceProfile {
  id: string
  name: string
  description: string
  gender: string
  age: string
  emotion: string
  pitch: number
  speed: number
  volume: number
  isBuiltIn: boolean
  ttsEngine: 'piper' | 'edge' | 'hybrid'
  piperModelId: string
  edgeVoiceId: string
  ttsLabel: string
}

/* ============================================================
 * 语音图标映射
 * ============================================================ */
const voiceIcons: Record<string, React.ReactNode> = {
  'warm': <Ear size={18} />,
  'professional': <AudioLines size={18} />,
  'cheerful': <Music2 size={18} />,
  'calm': <Ear size={18} />,
  'friendly': <Headphones size={18} />,
  'energetic': <Music2 size={18} />,
  'sweet': <Ear size={18} />,
  'serious': <AudioLines size={18} />,
  'natural': <Ear size={18} />,
}

/* ============================================================
 * 主组件
 * ============================================================ */
function Voice() {
  const { t: _t } = useTranslation()
  const [activeTab, setActiveTab] = useState<'voices' | 'clone'>('voices')
  const [voices, setVoices] = useState<VoiceProfile[]>([])
  const [selectedVoiceId, setSelectedVoiceId] = useState(() => {
    try {
      const stored = localStorage.getItem('voice_selected_id')
      if (stored) {
        // 向后兼容旧版 local_* ID
        return LEGACY_VOICE_ID_MAP[stored] || stored
      }
      return 'xuanxu_warm_female'
    }
    catch { return 'xuanxu_warm_female' }
  })
  const [autoPlayEnabled, setAutoPlayEnabled] = useState(() => {
    try {
      return localStorage.getItem('voice_autoplay') === 'true'
    }
    catch { return false }
  })
  const [isPreviewing, setIsPreviewing] = useState<string | null>(null)
  const [synthesisEngine, setSynthesisEngine] = useState<string>('')

  /* TTS 引擎状态 */
  const [ttsStatus, setTtsStatus] = useState<{
    edgeAvailable: boolean
    piperAvailable: boolean
    piperModels: string[]
    checked: boolean
  }>({ edgeAvailable: false, piperAvailable: false, piperModels: [], checked: false })

  const audioRef = useRef<HTMLAudioElement | null>(null)
  /* 预加载的 Web Speech 语音列表缓存 */
  const speechVoicesRef = useRef<SpeechSynthesisVoice[]>([])
  /* 避免 handleSelectVoice 依赖 selectedVoiceId 导致不必要的重渲染 */
  const selectedVoiceIdRef = useRef(selectedVoiceId)
  useEffect(() => { selectedVoiceIdRef.current = selectedVoiceId }, [selectedVoiceId])
  /* 用 ref 跟踪 voices 和 autoPlayEnabled，避免 useCallback 依赖频繁变化 */
  const voicesRef = useRef(voices)
  useEffect(() => { voicesRef.current = voices }, [voices])
  const autoPlayRef = useRef(autoPlayEnabled)
  useEffect(() => { autoPlayRef.current = autoPlayEnabled }, [autoPlayEnabled])

  /* ------ 预加载 Web Speech 语音列表 ------ */
  useEffect(() => {
    const loadSpeechVoices = () => {
      const voices = speechSynthesis.getVoices()
      if (voices.length > 0) {
        speechVoicesRef.current = voices
        logger.debug('[Voice] Web Speech 语音列表已加载:', voices.filter(v => v.lang.startsWith('zh')).map(v => v.name))
      }
    }
    loadSpeechVoices()
    speechSynthesis.onvoiceschanged = () => {
      speechVoicesRef.current = speechSynthesis.getVoices()
      logger.debug('[Voice] Web Speech 语音列表已更新:', speechVoicesRef.current.filter(v => v.lang.startsWith('zh')).map(v => v.name))
    }
  }, [])

  /* ------ 检查 TTS 引擎状态 ------ */
  useEffect(() => {
    const checkTtsStatus = async () => {
      if (window.api) {
        try {
          const status = await window.api.invoke<{
            piperAvailable: boolean
            piperModels: string[]
            edgeVoices: Array<{ id: string; name: string }>
          }>('voice:tts-status')
          if (status) {
            setTtsStatus({
              edgeAvailable: (status.edgeVoices?.length ?? 0) > 0,
              piperAvailable: status.piperAvailable,
              piperModels: status.piperModels || [],
              checked: true,
            })
            logger.info('[Voice] TTS引擎状态:', {
              edgeAvailable: (status.edgeVoices?.length ?? 0) > 0,
              piperAvailable: status.piperAvailable,
              models: status.piperModels,
            })
          }
        } catch (e) {
          logger.warn('[Voice] TTS状态检查失败:', e)
          showToast('warning', 'TTS 引擎状态检查失败，已降级为浏览器语音')
          setTtsStatus(prev => ({ ...prev, checked: true }))
        }
      } else {
        setTtsStatus(prev => ({ ...prev, checked: true }))
      }
    }
    checkTtsStatus()
  }, [])

  /* ------ 加载语音列表和设置 ------ */
  useEffect(() => {
    const requestMicPermission = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        // 成功获取权限后立即释放流
        stream.getTracks().forEach(track => track.stop())
        logger.debug('[Voice] 麦克风权限已获取')
      } catch (err) {
        logger.warn('[Voice] 麦克风权限获取失败', err)
      }
    }
    requestMicPermission()

    const loadVoices = async () => {
      if (window.api) {
        try {
          const voiceList = await window.api.invoke<VoiceProfile[]>('voice:get-voices')
          if (voiceList && voiceList.length > 0) {
            // 从 localStorage 恢复已保存的语音配置
            const restored = voiceList.map(v => {
              try {
                const saved = localStorage.getItem(`voice_profile_${v.id}`)
                if (saved) {
                  const parsed = JSON.parse(saved)
                  return { ...v, ...parsed }
                }
              } catch (_e) { /* ignore */ }
              return v
            })
            setVoices(restored)
            // 自动匹配：如果当前选中的音色ID不在列表中，选择第一个
            setSelectedVoiceId(prev => {
              const match = restored.find(v => v.id === prev)
              if (match) return prev
              const firstId = restored[0]?.id
              if (firstId) {
                logger.info(`[Voice] 音色ID "${prev}" 不在后端列表中，自动选择 "${firstId}"`)
                return firstId
              }
              return prev
            })
          } else {
            setVoices([...BUILT_IN_PRESETS])
          }
        } catch (e) {
          logger.warn('[Voice] 无法从后端加载语音列表，使用内置预设:', e)
          setVoices([...BUILT_IN_PRESETS])
        }

        try {
          const settings = await window.api.invoke<{ currentVoiceId?: string }>('voice:get-settings')
          if (settings) {
            if (settings.currentVoiceId) setSelectedVoiceId(settings.currentVoiceId)
          }
        } catch (e) { logger.warn('[Voice] 获取语音设置失败:', e) }
      } else {
        // 浏览器预览模式直接使用内置预设
        setVoices([...BUILT_IN_PRESETS])
      }
    }
    loadVoices()

    // 创建音频元素
    audioRef.current = new Audio()
    return () => {
      try { speechSynthesis.cancel() } catch (_e) { /* 非关键操作，失败可安全忽略 */ }
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
    }
  }, [])

  /* ------ 保存设置 ------ */
  const saveSettings = useCallback(async (voiceId: string) => {
    if (window.api) {
      try {
        // 使用 voice:set-current 确保触发 onVoiceChange 回调
        await window.api.invoke('voice:set-current', voiceId)
      } catch (e) { logger.warn('[Voice] 保存语音设置失败:', e) }
    }
  }, [])

  /* ------ 保存语音配置（引擎、语速、音调、音量）------ */
  const saveVoiceProfile = useCallback((voice: VoiceProfile) => {
    try {
      localStorage.setItem(`voice_profile_${voice.id}`, JSON.stringify({
        ttsEngine: voice.ttsEngine,
        speed: voice.speed,
        pitch: voice.pitch,
        volume: voice.volume,
      }))
    } catch (_e) { /* quota exceeded */ }
  }, [])

  /* ------ Web Speech API 降级（优先使用 Edge 在线语音）------ */
  const fallbackToWebSpeech = useCallback((text: string, voice: VoiceProfile) => {
    try {
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = 'zh-CN'
      utterance.rate = 0.8 + (voice.speed - 0.8) * 1.5
      utterance.pitch = 0.5 + (voice.pitch - 0.5) * 2.5
      utterance.volume = Math.min(1, voice.volume * 1.2)

      // 优先使用缓存的语音列表，如果没有则实时获取
      const voices = speechVoicesRef.current.length > 0 ? speechVoicesRef.current : speechSynthesis.getVoices()

      // 优先使用 Edge 在线神经语音（更自然）
      const edgeVoiceId = voice.edgeVoiceId
      const exactMatch = voices.find(v => v.voiceURI === edgeVoiceId || v.name === edgeVoiceId)
      if (exactMatch) {
        utterance.voice = exactMatch
        setSynthesisEngine('Edge 神经语音')
      } else {
        // 降级：查找中文 Edge 在线语音（zh-CN 优先，按自然度排序）
        const edgeNeuralNames = [
          'Xiaoxiao', 'Yunxi', 'Yunjian', 'Xiaoyi', 'Xiaozhen',
          'Yunyang', 'Xiaohan', 'Yunfeng', 'Xiaochen', 'Xiaorui',
          'Xiaoshuang', 'Xiaoxuan', 'Xiaoyan', 'Xiaoyou', 'Xiaoqiu',
          'Yunhao', 'Yunye', 'Yunxia', 'Yunze'
        ]
        const zhEdgeVoices = voices.filter(v =>
          v.lang.startsWith('zh') && (
            v.name.includes('Microsoft') ||
            v.name.includes('Neural') ||
            v.name.includes('Natural') ||
            edgeNeuralNames.some(n => v.name.includes(n))
          )
        )
        // 按 zh-CN 优先排序
        zhEdgeVoices.sort((a, b) => {
          const aCN = a.lang === 'zh-CN' ? 0 : 1
          const bCN = b.lang === 'zh-CN' ? 0 : 1
          return aCN - bCN
        })
        if (zhEdgeVoices.length > 0) {
          utterance.voice = zhEdgeVoices[0]
          setSynthesisEngine('Edge 神经语音')
        } else {
          // 再降级：任意中文语音（zh-CN 优先）
          const zhVoices = voices.filter(v => v.lang.startsWith('zh'))
          zhVoices.sort((a, b) => {
            const aCN = a.lang === 'zh-CN' ? 0 : 1
            const bCN = b.lang === 'zh-CN' ? 0 : 1
            return aCN - bCN
          })
          if (zhVoices.length > 0) {
            const idx = Math.abs(voice.id.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)) % zhVoices.length
            utterance.voice = zhVoices[idx]
            setSynthesisEngine('系统语音')
          } else {
            setSynthesisEngine('默认语音')
          }
        }
      }

      utterance.onend = () => setIsPreviewing(null)
      utterance.onerror = () => setIsPreviewing(null)
      speechSynthesis.speak(utterance)
    } catch (e) {
      logger.error('[Voice] WebSpeech降级失败:', e)
      setIsPreviewing(null)
    }
  }, [])

  /* ------ 试听：Edge TTS 在线合成 → Web Speech 降级 ------ */
  const handleTtsPreview = useCallback(async (voice: VoiceProfile, previewText: string) => {
    const EDGE_TTS_TIMEOUT = 15000 // Edge TTS 超时 15 秒（含偶发连接重试），之后降级到离线/浏览器语音

    try {
      if (window.api) {
        setSynthesisEngine('synthesizing')

        // 带超时的 Edge TTS 调用
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Edge TTS 合成超时')), EDGE_TTS_TIMEOUT)
        )

        const result = await Promise.race([
          window.api.invoke<{
            success: boolean
            audioPath?: string
            error?: string
            engine: string
            ttsLabel: string
            fallback?: boolean
            fallbackText?: string
          }>('voice:speak', previewText, voice.id),
          timeoutPromise,
        ])

        if (result && result.success && result.audioPath) {
          setSynthesisEngine(result.engine === 'edge' ? 'Edge 在线' : 'Piper 离线')
          const audio = audioRef.current
          if (audio) {
            const fileUrl = `local-file://${result.audioPath.replace(/\\/g, '/')}`
            audio.src = fileUrl
            audio.volume = voice.volume
            audio.onended = () => { setIsPreviewing(null) }
            audio.onerror = (e) => {
              logger.error('[Voice] Edge TTS 音频播放失败，降级 WebSpeech:', e)
              fallbackToWebSpeech(previewText, voice)
            }
            try {
              await audio.play()
            } catch (playErr) {
              logger.error('[Voice] 音频播放异常，降级 WebSpeech:', playErr)
              fallbackToWebSpeech(previewText, voice)
            }
          } else {
            // audioRef 不可用，降级
            fallbackToWebSpeech(previewText, voice)
          }
        } else if (result?.fallback) {
          logger.warn('[Voice] Edge TTS 返回降级标记:', result.fallbackText)
          setSynthesisEngine('浏览器语音(降级)')
          fallbackToWebSpeech(result.fallbackText || previewText, voice)
        } else {
          logger.warn('[Voice] Edge TTS 合成失败:', result?.error || '未知错误')
          setSynthesisEngine('浏览器语音(降级)')
          fallbackToWebSpeech(previewText, voice)
        }
      } else {
        // 无 window.api，直接降级
        setSynthesisEngine('浏览器语音(降级)')
        fallbackToWebSpeech(previewText, voice)
      }
    } catch (e) {
      const isTimeout = e instanceof Error && e.message.includes('超时')
      logger.warn(`[Voice] Edge TTS ${isTimeout ? '合成超时' : '调用异常'}，降级 WebSpeech:`, e)

      // 清理之前的音频和语音合成状态
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.currentTime = 0
      }
      try { speechSynthesis.cancel() } catch (_e) { /* 非关键操作，失败可安全忽略 */ }

      setSynthesisEngine(isTimeout ? 'Edge 超时·降级中' : '浏览器语音(降级)')
      fallbackToWebSpeech(previewText, voice)
    }
  }, [fallbackToWebSpeech])

  const handlePreview = useCallback(async (voice: VoiceProfile) => {
    // 停止之前的播放
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
    }
    try { speechSynthesis.cancel() } catch (_e) { /* 非关键操作，失败可安全忽略 */ }

    setIsPreviewing(voice.id)
    setSynthesisEngine('connecting')

    const previewText = `你好，我是玄枢的${voice.name.replace('玄枢-', '')}。你可以用我来进行语音对话，体验自然流畅的语音交互。`

    // 直接 Edge TTS 在线合成，失败时自动降级 WebSpeech
    handleTtsPreview(voice, previewText)
  }, [handleTtsPreview])

  /* ------ 选择语音 ------ */
  const handleSelectVoice = useCallback((voiceId: string) => {
    setSelectedVoiceId(voiceId)
    try { localStorage.setItem('voice_selected_id', voiceId) } catch (_e) { /* quota exceeded or private mode */ }
    saveSettings(voiceId)

    // 自动播报：选择新音色后自动试听
    if (autoPlayRef.current && voiceId !== selectedVoiceIdRef.current) {
      const voice = voicesRef.current.find(v => v.id === voiceId)
      if (voice) {
        // 延迟一下让 UI 先更新
        setTimeout(() => handlePreview(voice), 300)
      }
    }
  }, [saveSettings, handlePreview])

  /* ------ 自动播报开关 ------ */
  const toggleAutoPlay = useCallback(() => {
    setAutoPlayEnabled(prev => {
      const next = !prev
      try { localStorage.setItem('voice_autoplay', String(next)) } catch (_e) { /* 非关键操作，失败可安全忽略 */ }
      return next
    })
  }, [])

  /* ------ 获取在线/离线标签颜色 ------ */
  const getTtsLabelColor = (label: string) => {
    if (label.includes('在线') && label.includes('离线')) return COLORS.violet
    if (label.includes('在线')) return COLORS.success
    return COLORS.warning
  }

  /* ------ 获取在线/离线图标 ------ */
  const getTtsIcon = (label: string) => {
    if (label.includes('离线') && !label.includes('在线')) return <WifiOff size={11} />
    return <Wifi size={11} />
  }

  const selectedVoice = voices.find(v => v.id === selectedVoiceId)
  const selectedVoiceDisplay = selectedVoice || {
    id: 'xuanxu_warm_female',
    name: '温暖女声',
    description: '温暖亲切的女性音色，语调柔和自然，适合日常助手、情感交流和轻松聊天',
    gender: 'female',
    age: 'young',
    emotion: 'warm',
    pitch: 1.0,
    speed: 0.97,
    volume: 0.95,
    isBuiltIn: true,
    ttsEngine: 'hybrid' as const,
    piperModelId: 'zh_female_warm',
    edgeVoiceId: 'zh-CN-XiaoxiaoNeural',
    ttsLabel: '在线(离线降级)',
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: COLORS.bg, padding: '20px', minHeight: 0 }}>
      {/* CSS 动画类已在 globals.css 中统一定义，此处不再重复 */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <ErrorBoundary>
        <motion.div variants={containerVariants} initial="hidden" animate="visible" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* 标题 */}
          <motion.div variants={itemVariants} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <h2 style={{ fontSize: '1.4rem', fontWeight: 600, color: COLORS.textPrimary, margin: 0 }}>声音设置</h2>
              <p style={{ fontSize: '0.85rem', color: COLORS.textSecondary, margin: '4px 0 0' }}>
               10 种真人语音，Edge 在线合成优先，离线自动降级</p>
            </div>
            {/* TTS 引擎状态指示器 */}
            {ttsStatus.checked && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{
                  fontSize: 11, padding: '3px 10px', borderRadius: 9999,
background: ttsStatus.edgeAvailable ? COLORS.successDim : COLORS.dangerDim,
                  color: ttsStatus.edgeAvailable ? COLORS.success : COLORS.danger,
border: `1px solid ${ttsStatus.edgeAvailable ? `${HEX_COLORS.success}30` : `${HEX_COLORS.dangerAlt}30`}`,
                  display: 'flex', alignItems: 'center', gap: 4,
                }}>
                  <Wifi size={10} />
                  Edge {ttsStatus.edgeAvailable ? '可用' : '不可用'}
                </span>
                <span style={{
                  fontSize: 11, padding: '3px 10px', borderRadius: 9999,
background: ttsStatus.piperAvailable ? COLORS.successDim : COLORS.warningDim,
                  color: ttsStatus.piperAvailable ? COLORS.success : COLORS.warning,
border: `1px solid ${ttsStatus.piperAvailable ? `${HEX_COLORS.success}30` : `${HEX_COLORS.warning}30`}`,
                  display: 'flex', alignItems: 'center', gap: 4,
                }}>
                  <WifiOff size={10} />
                  Piper {ttsStatus.piperAvailable ? `就绪(${ttsStatus.piperModels.length})` : '待下载'}
                </span>
              </div>
            )}
          </motion.div>

          {/* Tab 切换 + 自动播报 */}
          <motion.div variants={itemVariants} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px', borderRadius: 'var(--radius-3xl)', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', position: 'relative', zIndex: 5, overflow: 'visible' }}>
            <div style={{ display: 'flex', gap: '4px' }}>
            {[
              { id: 'voices' as const, label: '语音', icon: '' },
              { id: 'clone' as const, label: '自定义录制', icon: '' },
            ].map(tab => (
              <motion.button
                key={tab.id}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  flex: 1, padding: '10px 16px', borderRadius: '10px', cursor: 'pointer',
background: activeTab === tab.id ? COLORS.accentDim : 'transparent',
border: activeTab === tab.id ? `1px solid ${HEX_COLORS.accent}25` : '1px solid transparent',
                  color: activeTab === tab.id ? COLORS.accent : COLORS.textSecondary,
                  fontSize: 'var(--text-base)', fontWeight: activeTab === tab.id ? 600 : 400,
                  transition: 'all 0.3s', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px'
                }}
              >
                <span>{tab.icon}</span> {tab.label}
              </motion.button>
            ))}
            </div>
            <motion.button
              whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}
              onClick={toggleAutoPlay}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                gap: 10, minHeight: 44, padding: '0 24px',
                borderRadius: 'var(--radius-3xl)', cursor: 'pointer',
                position: 'relative', zIndex: 10,
background: autoPlayEnabled ? COLORS.accentDim : 'rgba(255,255,255,0.06)',
border: `1.5px solid ${autoPlayEnabled ? `${HEX_COLORS.accent}35` : 'rgba(255,255,255,0.12)'}`,
                color: autoPlayEnabled ? COLORS.accent : COLORS.textSecondary,
                transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)'
              }}
            >
              {autoPlayEnabled ? <ToggleRight size={22} /> : <ToggleLeft size={22} />}
              <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>自动播报</span>
            </motion.button>
          </motion.div>

          {/* 当前选中语音卡片 */}
          <motion.div variants={itemVariants} className="voice-glow"
            style={{
              padding: '24px 28px', borderRadius: 'var(--radius-2xl)',
              background: 'linear-gradient(135deg, COLORS.accentDim 0%, rgba(40,40,42,0.98) 100%)',
border: `1px solid ${HEX_COLORS.accent}25`,
              boxShadow: '0 4px 24px rgba(176,176,186,0.08)',
              display: 'flex', flexDirection: 'column', gap: '16px'
            }}
          >
            {/* 头部：图标 + 名称 + 试听 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
              <div style={{
                width: 56, height: 56, borderRadius: '50%',
background: COLORS.accentDim, border: '1.5px solid rgba(176,176,186,0.3)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: COLORS.accent
              }}>
                {voiceIcons[selectedVoiceDisplay.emotion] || <Ear size={18} />}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: COLORS.textPrimary, margin: 0 }}>{selectedVoiceDisplay.name}</h3>
                  <span style={{
                    fontSize: '0.68rem', padding: '3px 10px', borderRadius: '9999px',
                    background: `${getTtsLabelColor(selectedVoiceDisplay.ttsLabel)}15`,
                    color: getTtsLabelColor(selectedVoiceDisplay.ttsLabel),
                    border: `1px solid ${getTtsLabelColor(selectedVoiceDisplay.ttsLabel)}30`,
                    display: 'flex', alignItems: 'center', gap: '4px'
                  }}>
                    {getTtsIcon(selectedVoiceDisplay.ttsLabel)}
                    {selectedVoiceDisplay.ttsLabel}
                  </span>
                  {synthesisEngine && isPreviewing && (
                    <span className="pulse-anim" style={{ fontSize: '0.68rem', color: COLORS.textMuted }}>
                      {synthesisEngine}
                    </span>
                  )}
                </div>
                <p style={{ fontSize: '0.8rem', color: COLORS.textSecondary, margin: '4px 0 0' }}>{selectedVoiceDisplay.description}</p>
              </div>
              <motion.button
                whileHover={{ scale: 1.08 }} whileTap={{ scale: 0.92 }}
                onClick={() => selectedVoice && handlePreview(selectedVoice)}
                disabled={isPreviewing === selectedVoice?.id}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  gap: 8, minHeight: 44, padding: '0 24px',
                  borderRadius: 'var(--radius-3xl)', cursor: 'pointer',
background: isPreviewing === selectedVoice?.id ? 'rgba(176,176,186,0.2)' : `${HEX_COLORS.accent}10`,
border: `1px solid ${HEX_COLORS.accent}25`, color: COLORS.accent,
                  opacity: isPreviewing === selectedVoice?.id ? 0.8 : 1,
                  fontSize: 14, fontWeight: 500, transition: 'all 0.3s'
                }}
              >
                {isPreviewing === selectedVoice?.id ? (
                  <span className="spin-anim" style={{ display: 'flex', alignItems: 'center' }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                  </span>
                ) : (
                  <Play size={15} />
                )}
                {isPreviewing === selectedVoice?.id
                  ? (synthesisEngine === 'connecting' ? '正在连接语音引擎...' :
                     synthesisEngine === 'synthesizing' ? '正在合成语音...' :
                     synthesisEngine.includes('降级') ? '已降级为浏览器语音' :
                     '播放中...')
                  : '试听'}
              </motion.button>
            </div>

            {/* TTS 引擎 + 语速/音调/音量滑块 */}
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px 24px',
              padding: '16px 0 0', borderTop: '1px solid rgba(255,255,255,0.06)'
            }}>
              {/* 引擎选择 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 11, color: COLORS.textMuted, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em' }}>TTS 引擎</span>
                <select
                  value={selectedVoice?.ttsEngine || 'hybrid'}
                  onChange={(e) => {
                    const v = selectedVoice
                    if (!v) return
                    const engine = e.target.value as VoiceProfile['ttsEngine']
                    const updated = { ...v, ttsEngine: engine }
                    setVoices(prev => prev.map(p => p.id === v.id ? updated : p))
                    saveVoiceProfile(updated)
                  }}
                  style={{
                    padding: '8px 32px 8px 12px', borderRadius: 'var(--radius-xl)',
                    border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.25)',
                    color: COLORS.textPrimary, fontSize: 13, outline: 'none',
                    cursor: 'pointer', fontFamily: 'inherit', appearance: 'auto'
                  }}
                >
                  <option value="hybrid">混合（在线优先·离线降级）</option>
                  <option value="edge">Edge 神经语音（在线）</option>
                  <option value="piper">Piper（离线本地）</option>
                </select>
              </div>
              {/* 语速 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: COLORS.textMuted, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em' }}>语速</span>
                  <span style={{ fontSize: 11, color: COLORS.accent, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{((selectedVoice?.speed ?? 1.0)).toFixed(1)}x</span>
                </div>
                <input
                  type="range" min="0.5" max="2.0" step="0.05"
                  value={selectedVoice?.speed ?? 1.0}
                  onChange={(e) => {
                    const v = selectedVoice
                    if (!v) return
                    const speed = parseFloat(e.target.value)
                    const updated = { ...v, speed }
                    setVoices(prev => prev.map(p => p.id === v.id ? updated : p))
                    saveVoiceProfile(updated)
                  }}
                  style={{ width: '100%', accentColor: COLORS.accent, cursor: 'pointer' }}
                />
              </div>
              {/* 音调 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: COLORS.textMuted, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em' }}>音调</span>
                  <span style={{ fontSize: 11, color: COLORS.accent, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{((selectedVoice?.pitch ?? 1.0)).toFixed(2)}</span>
                </div>
                <input
                  type="range" min="0.5" max="2.0" step="0.05"
                  value={selectedVoice?.pitch ?? 1.0}
                  onChange={(e) => {
                    const v = selectedVoice
                    if (!v) return
                    const pitch = parseFloat(e.target.value)
                    const updated = { ...v, pitch }
                    setVoices(prev => prev.map(p => p.id === v.id ? updated : p))
                    saveVoiceProfile(updated)
                  }}
                  style={{ width: '100%', accentColor: COLORS.accent, cursor: 'pointer' }}
                />
              </div>
              {/* 音量 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: COLORS.textMuted, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em' }}>音量</span>
                  <span style={{ fontSize: 11, color: COLORS.accent, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{((selectedVoice?.volume ?? 1.0) * 100).toFixed(0)}%</span>
                </div>
                <input
                  type="range" min="0.1" max="1.5" step="0.05"
                  value={selectedVoice?.volume ?? 1.0}
                  onChange={(e) => {
                    const v = selectedVoice
                    if (!v) return
                    const volume = parseFloat(e.target.value)
                    const updated = { ...v, volume }
                    setVoices(prev => prev.map(p => p.id === v.id ? updated : p))
                    saveVoiceProfile(updated)
                  }}
                  style={{ width: '100%', accentColor: COLORS.accent, cursor: 'pointer' }}
                />
              </div>
            </div>
          </motion.div>

          {/* 语音包列表（仅在voices tab显示） */}
          {activeTab === 'voices' && (
            <motion.div variants={itemVariants}>
              <h3 style={{ fontSize: '1rem', fontWeight: 600, color: COLORS.textPrimary, margin: '0 0 14px' }}>全部语音</h3>
<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '24px' }}>
                <AnimatePresence>
                  {(voices).map((voice) => {
                    const isSelected = selectedVoiceId === voice.id
                    const isPreviewingThis = isPreviewing === voice.id
                    return (
                      <motion.div
                        key={voice.id}
                        variants={listItemVariants}
                        whileHover={{
                          scale: 1.02,
                          borderColor: isSelected ? `${HEX_COLORS.accent}25` : COLORS.cardBorderHover,
boxShadow: isSelected ? `0 0 24px ${HEX_COLORS.accent}18` : '0 4px 16px rgba(255,255,255,0.08)'
                        }}
                        whileTap={{ scale: 0.98 }}
                        onClick={() => handleSelectVoice(voice.id)}
                        style={{
padding: '16px 20px', borderRadius: 'var(--radius-2xl)', cursor: 'pointer',
                          background: isSelected ? `${HEX_COLORS.accent}06` : COLORS.cardBg,
                          border: `1.5px solid ${isSelected ? `${HEX_COLORS.accent}25` : COLORS.cardBorder}`,
boxShadow: isSelected ? '0 4px 20px COLORS.accentDim' : '0 2px 8px rgba(255,255,255,0.04)',
                          display: 'flex', alignItems: 'center', gap: '14px',
                          transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
                          position: 'relative'
                        }}
                      >
                        <div style={{
                          width: 42, height: 42, borderRadius: '50%',
background: isSelected ? `${HEX_COLORS.accent}10` : `${HEX_COLORS.accent}04`,
border: `1.5px solid ${isSelected ? `${HEX_COLORS.accent}25` : 'rgba(255,255,255,0.06)'}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          color: isSelected ? COLORS.accent : COLORS.textSecondary, flexShrink: 0
                        }}>{voiceIcons[voice.emotion] || <Ear size={18} />}</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '0.9rem', fontWeight: 600, color: COLORS.textPrimary }}>{voice.name}</span>
                            <span style={{
                              fontSize: '0.63rem', padding: '2px 6px', borderRadius: '9999px',
                              background: 'rgba(255,255,255,0.04)', color: COLORS.textMuted
                            }}>{voice.gender === 'female' ? '女' : '男'}·{voice.emotion}</span>
                            <span style={{
                              fontSize: '0.6rem', padding: '2px 6px', borderRadius: '9999px',
                              background: `${getTtsLabelColor(voice.ttsLabel)}15`,
                              color: getTtsLabelColor(voice.ttsLabel),
                              border: `1px solid ${getTtsLabelColor(voice.ttsLabel)}30`,
                              display: 'flex', alignItems: 'center', gap: '3px'
                            }}>
                              {getTtsIcon(voice.ttsLabel)}
                              {voice.ttsLabel}
                            </span>
                          </div>
                          <p style={{ fontSize: '0.75rem', color: COLORS.textSecondary, margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{voice.description}</p>
                        </div>
                        <motion.button
                          whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
                          onClick={(e) => { e.stopPropagation(); handlePreview(voice) }}
                          disabled={isPreviewingThis}
                          style={{
                            minWidth: 44, minHeight: 44, borderRadius: 'var(--radius-2xl)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: isPreviewingThis ? 'rgba(176,176,186,0.2)' : 'transparent',
                            color: isPreviewingThis ? COLORS.accent : COLORS.textMuted, cursor: 'pointer', border: 'none',
                            opacity: isPreviewingThis ? 0.8 : 1, flexShrink: 0
                          }}
                        >
                          {isPreviewingThis ? (
                            <span className="spin-anim" style={{ display: 'flex', alignItems: 'center' }}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                              </svg>
                            </span>
                          ) : (
                            <Play size={14} />
                          )}
                        </motion.button>
                        {isSelected && (
                          <motion.div
                            layoutId="voiceCheck"
                            className="selected-pulse"
                            style={{
                              position: 'absolute', top: -1, right: -1,
                              padding: '3px 10px',
                              borderRadius: '0 var(--radius-2xl) 0 var(--radius-2xl)',
                              background: COLORS.accent,
                              color: COLORS.bg,
                              fontSize: '0.6rem', fontWeight: 700,
                              letterSpacing: '0.03em',
                              border: '1px solid rgba(176,176,186,0.3)',
                            }}
                          >当前使用</motion.div>
                        )}
                      </motion.div>
                    )
                  })}
                </AnimatePresence>
              </div>
            </motion.div>
          )}

        {activeTab === 'clone' ? (
          <ErrorBoundary>
            <VoiceCloneTab />
          </ErrorBoundary>
        ) : null}

        </motion.div>
        </ErrorBoundary>
        </div>
      </div>
    )
  }

export default Voice