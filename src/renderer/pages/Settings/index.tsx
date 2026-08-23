import { useState, useEffect, useRef, useCallback } from 'react'
import { motion } from 'framer-motion'
import {
  Shield, XCircle, CheckCircle,
  Settings as SettingsIcon, Lock,
  Info, ArrowLeft, Search,
  Bell, Eye, Circle, Activity, X
} from 'lucide-react'
import { CONFIG_KEYS } from '../../../shared/config-keys'
import WebSearchPanel from '../../components/WebSearchPanel'
import { logger } from '../../../shared/logger'
import { HEX_COLORS, COLORS, containerVariants, itemVariants } from '../../shared/theme'
import ErrorBoundary from '../../components/ErrorBoundary'
import { useTranslation } from '../../i18n'
import { useUndoManager } from '../../hooks/useUndoManager'
import type { ConfigData } from '../../../shared/ipc-types'
import type { HealthReport } from '../../../main/health-check'
import SettingsVoiceWake from './SettingsVoiceWake'
import SettingsSkillPacks from './SettingsSkillPacks'
import SettingsPermissions from './SettingsPermissions'
import SettingsGeneral from './SettingsGeneral'
import SettingsVoiceprint from './SettingsVoiceprint'
import SettingsContext from './SettingsContext'
import SettingsQuickActions from './SettingsQuickActions'
import { THEME_OPTIONS, applyTheme as applyThemeGlobal } from '../../theme'

/* ============================================================
 * 设计常量（重新导出供子组件使用）
 * ============================================================ */
export { COLORS, HEX_COLORS, containerVariants, itemVariants, THEME_OPTIONS }

/* ============================================================
 * 动画变体（Settings 特有）
 * ============================================================ */
export const glowPulse = {
  scale: [1, 1.02, 1],
  boxShadow: [
    '0 0 12px var(--accent-dim)',
    '0 0 24px var(--accent-dim)',
    '0 0 12px var(--accent-dim)',
  ],
  transition: {
    duration: 2,
    repeat: Infinity,
    ease: 'easeInOut',
  },
}

/* ============================================================
 * 类型定义
 * ============================================================ */
export interface Permission {
  id: string
  name: string
  description: string
  type: string
  required: boolean
  granted: boolean
  canRequest: boolean
  lastChecked?: number
}

interface PermissionStatus {
  permissions: Permission[]
  allGranted: boolean
  requiredGranted: boolean
}
/* ============================================================
 * Toggle 开关组件
 * ============================================================ */
export function Toggle({ checked, onChange, size, label }: { checked: boolean; onChange: () => void; size?: 'sm' | 'md'; label?: string }) {
  const w = size === 'sm' ? 38 : 44
  const h = size === 'sm' ? 20 : 24
  const dotSize = size === 'sm' ? 14 : 16
  const dotTop = size === 'sm' ? 3 : 4
  const dotLeftOn = size === 'sm' ? (w - dotSize - 3) : 24
  const dotLeftOff = 3

  return (
    <motion.button
      role="switch"
      aria-checked={checked}
      aria-label={label || '开关'}
      onClick={onChange}
      whileTap={{ scale: 0.92 }}
      animate={checked ? {
        boxShadow: `0 0 20px ${HEX_COLORS.accent}55, 0 0 8px ${HEX_COLORS.accent}30, inset 0 0 8px ${HEX_COLORS.accent}20`,
      } : {
        boxShadow: 'none',
      }}
      style={{
        width: w,
        height: h,
        borderRadius: '9999px',
        backgroundColor: checked ? COLORS.accent : 'rgba(255,255,255,0.10)',
        position: 'relative',
        flexShrink: 0,
        border: 'none',
        cursor: 'pointer',
        transition: 'background-color 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      <motion.span
        animate={{
          left: checked ? dotLeftOn : dotLeftOff,
          scale: checked ? 1.05 : 1,
        }}
        transition={{ type: 'spring', stiffness: 600, damping: 28 }}
        style={{
          position: 'absolute',
          top: dotTop,
          width: dotSize,
          height: dotSize,
          borderRadius: '50%',
          backgroundColor: '#fff',
          boxShadow: '0 2px 6px rgba(0,0,0,0.35)',
        }}
      />
    </motion.button>
  )
}

export function Slider({ value, onChange, min = 0, max = 100 }: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <input
        type="range"
        aria-label="滑块调节"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          width: 140,
          height: 6,
          borderRadius: '3px',
          background: `linear-gradient(90deg, ${COLORS.accent} ${value}%, rgba(255,255,255,0.1) ${value}%)`,
          appearance: 'none',
          cursor: 'pointer',
          outline: 'none',
        }}
      />
      <span style={{ fontSize: 13, color: COLORS.textPrimary, fontWeight: 500, minWidth: 36 }}>
        {value}%
      </span>
    </div>
  )
}

/* ============================================================
 * 玻璃拟态卡片
 * ============================================================ */
export function GlassCard({
  title,
  icon,
  accentColor,
  headerRight,
  children,
}: {
  title: string
  icon: React.ReactNode
  accentColor?: string
  headerRight?: React.ReactNode
  children: React.ReactNode
}) {
  const accent = accentColor || COLORS.accent
  const titleId = `glasscard-title-${title.replace(/\s+/g, '-').toLowerCase()}`

  return (
    <motion.div
      role="region"
      aria-labelledby={titleId}
      variants={itemVariants}
      whileHover={{
        borderColor: COLORS.cardBorderHover,
        boxShadow: `var(--shadow-card-hover), 0 0 0 1px ${accent}10`,
      }}
      style={{
        padding: '28px 32px',
        borderRadius: 'var(--radius-2xl)',
        border: `1px solid ${COLORS.cardBorder}`,
        background: COLORS.cardBg,
        borderLeft: `3px solid ${accent}`,
        boxShadow: 'var(--shadow-card)',
        backdropFilter: 'blur(12px)',
        transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 24,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <motion.span
            whileHover={{ scale: 1.1, rotate: 5 }}
            style={{
              width: 36,
              height: 36,
              borderRadius: '14px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: `${accent}18`,
              color: accent,
              fontSize: 14,
              transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
          >
            {icon}
          </motion.span>
          <h3
            id={titleId}
            style={{
              fontFamily: 'var(--font-heading)',
              fontSize: 'var(--text-lg)',
              fontWeight: 600,
              color: COLORS.textPrimary,
              letterSpacing: '0.01em',
            }}
          >
            {title}
          </h3>
        </div>
        {headerRight}
      </div>
      {children}
    </motion.div>
  )
}

/* ============================================================
 * 权限项行
 * ============================================================ */
export function PermissionRow({ permission, onToggle, disabled }: { permission: Permission; onToggle: (id: string) => void; disabled?: boolean }) {
  const typeColorMap: Record<string, { bg: string; color: string }> = {
    system: { bg: 'rgba(59,130,246,0.12)', color: '#60a5fa' },
file: { bg: COLORS.successDim, color: '#4ade80' },
network: { bg: COLORS.warningDim, color: '#fbbf24' },
screen: { bg: COLORS.warningDim, color: '#a78bfa' },
    audio: { bg: 'rgba(236,72,153,0.12)', color: '#f472b6' },
microphone: { bg: 'rgba(249,115,22,0.12)', color: '#fb923c' },
    camera: { bg: `${HEX_COLORS.accent}15`, color: COLORS.accent },
  }

  const typeIconMap: Record<string, React.ReactNode> = {
    system: <Shield size={14} />,
    file: <Lock size={14} />,
    network: <Bell size={14} />,
    screen: <Eye size={14} />,
    audio: <Bell size={14} />,
    microphone: <Bell size={14} />,
    camera: <Eye size={14} />,
  }

const colors = typeColorMap[permission.type] || { bg: 'rgba(255,255,255,0.05)', color: COLORS.textMuted }
  const [hovered, setHovered] = useState(false)

  return (
    <motion.div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      whileHover={{
backgroundColor: 'rgba(255,255,255,0.045)',
borderColor: permission.granted ? `${HEX_COLORS.success}35` : 'rgba(255,255,255,0.18)',
        boxShadow: permission.granted
          ? `0 0 20px ${HEX_COLORS.success}12, inset 0 0 12px ${HEX_COLORS.success}06`
          : `0 0 20px rgba(255,255,255,0.04)`,
        y: -1,
      }}
      style={{
        padding: '16px 18px',
borderRadius: 'var(--radius-2xl)',
        border: `1px solid ${permission.granted ? `${HEX_COLORS.success}25` : COLORS.cardBorder}`,
background: permission.granted ? `${HEX_COLORS.success}06` : 'rgba(255,255,255,0.015)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
        cursor: 'default',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <motion.div
          animate={hovered ? { scale: 1.08 } : { scale: 1 }}
          style={{
            width: 40,
            height: 40,
            borderRadius: '14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: colors.bg,
            color: colors.color,
            transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          {typeIconMap[permission.type] || <SettingsIcon size={14} />}
        </motion.div>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 500, color: COLORS.textPrimary }}>
              {permission.name}
            </span>
            {permission.required && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: '2px 7px',
borderRadius: '8px',
                  background: `${HEX_COLORS.danger}18`,
                  color: COLORS.danger,
                }}
              >
                必需
              </span>
            )}
          </div>
          <p style={{ fontSize: 13, color: COLORS.textMuted, marginTop: 4, lineHeight: 1.5 }}>
            {permission.description}
          </p>
        </div>
      </div>

<div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {permission.granted ? (
          <motion.div
            animate={{ scale: [1, 1.1, 1] }}
transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
          >
            <CheckCircle size={20} style={{ color: COLORS.success }} />
          </motion.div>
        ) : (
          <XCircle size={20} style={{ color: COLORS.danger }} />
        )}
        {!permission.granted && permission.canRequest && (
          <motion.button
            aria-label={`请求权限: ${permission.name}`}
            onClick={() => onToggle(permission.id)}
            disabled={disabled}
            whileHover={!disabled ? {
              scale: 1.06,
              boxShadow: `0 0 20px ${HEX_COLORS.accent}30, 0 0 8px ${HEX_COLORS.accent}15`,
              background: `${HEX_COLORS.accent}18`,
            } : {}}
            whileTap={!disabled ? { scale: 0.93 } : {}}
            style={{
padding: '7px 14px',
borderRadius: '14px',
              border: `1px solid ${HEX_COLORS.accent}35`,
              background: `${HEX_COLORS.accent}12`,
              color: COLORS.accent,
              fontSize: 13,
              fontWeight: 500,
cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.4 : 1,
              transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
          >
            获取权限
          </motion.button>
        )}
      </div>
    </motion.div>
  )
}

/* ============================================================
 * 设置页面主组件
 * ============================================================ */

function Settings() {
  const { t } = useTranslation()
  const undoMgr = useUndoManager()
  const [permissionStatus, setPermissionStatus] = useState<PermissionStatus>({
    permissions: [],
    allGranted: false,
    requiredGranted: false,
  })
  const [isLoading, setIsLoading] = useState(false)
  const requestSeqRef = useRef(0)

  /* ---------- 管理员/注册表权限检测状态 ---------- */
  const [adminCheckStatus, setAdminCheckStatus] = useState<'idle' | 'checking' | 'checked' | 'error'>('idle')
  const [registryCheckStatus, setRegistryCheckStatus] = useState<'idle' | 'checking' | 'checked' | 'error'>('idle')
  const [adminCheckError, setAdminCheckError] = useState<string | null>(null)
  const [registryCheckError, setRegistryCheckError] = useState<string | null>(null)

  /* ---------- Config 保存防抖 ---------- */
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 已知配置值缓存：loadConfig 后填充；scheduleConfigSave 时用于计算撤销旧值
  const configValuesRef = useRef<Record<string, unknown>>({})

  const scheduleConfigSave = useCallback((key: string, value: unknown) => {
    // 记录当前值用于撤销（以缓存中最近一次已知值为准，避免恒空对象导致撤销永不注册）
    const oldValue = configValuesRef.current[key]
    configValuesRef.current[key] = value
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      window.api?.invoke('config:set', key, value).catch((e) => { logger.error('[Settings] 保存配置失败', e) })
    }, 800)
    // 注册可撤销命令
    if (oldValue !== undefined && oldValue !== value) {
      undoMgr.execute({
        description: `${key}: ${String(value)}`,
        execute: async () => { window.api?.invoke('config:set', key, value) },
        undo: async () => {
          configValuesRef.current[key] = oldValue
          window.api?.invoke('config:set', key, oldValue)
        },
      }).catch(() => {})
    }
  }, [undoMgr])

  useEffect(() => {
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [])

  /* ---------- 语音唤醒状态 ---------- */
  const [wakeEnabled, setWakeEnabled] = useState(false)
  const [wakeRunning, setWakeRunning] = useState(false)
  const [wakeWord, setWakeWord] = useState('玄枢')
  const [wakeSensitivity, setWakeSensitivity] = useState(80)

  /* ---------- 退出词配置 ---------- */
  const [exitWord, setExitWord] = useState('退出')
  const [exitConfirmWords, setExitConfirmWords] = useState('确认退出,是的')
  const [exitCancelWords, setExitCancelWords] = useState('取消,不要')
  const [exitConfirmTTS, setExitConfirmTTS] = useState('确认退出语音模式吗？')

  /* ---------- 声纹与降噪 ---------- */
  const [voiceEnrolling, setVoiceEnrolling] = useState(false)
  const [voiceVerifying, setVoiceVerifying] = useState(false)
  const [voiceVerifyScore, setVoiceVerifyScore] = useState<number | null>(null)
  const [voiceprintSampleCount, setVoiceprintSampleCount] = useState(0)
  const [voiceprintSamples, setVoiceprintSamples] = useState<Array<{ id: string; label: string; enrolledAt: number; featureType: string }>>([])
  const [noiseFilterOn, setNoiseFilterOn] = useState(true)
  const [noiseLevel, setNoiseLevel] = useState(3)

  /* ---------- 粒子球设置 ---------- */
  const [floatingBallEnabled, setFloatingBallEnabled] = useState(false)

  /* ---------- 常规设置状态 ---------- */
  const [autoUpdate, setAutoUpdate] = useState(true)
  const [sendStats, setSendStats] = useState(false)
  const [autoStart, setAutoStart] = useState(false)

  /* ---------- 主题色状态 ---------- */
  const [themeColor, setThemeColor] = useState(() => {
    return localStorage.getItem('xuanshu-theme-color') || 'silver'
  })

  const applyTheme = useCallback((themeId: string) => {
    setThemeColor(themeId)
    applyThemeGlobal(themeId)
  }, [])

  // 初始化时应用主题
  useEffect(() => { applyTheme(themeColor) }, [applyTheme, themeColor])

  /* ---------- 版本信息 ---------- */
  const [appVersion, setAppVersion] = useState('...')
  const [electronVersion, setElectronVersion] = useState('...')
  const [buildDate, setBuildDate] = useState('...')
  const [iconPath, setIconPath] = useState<string | null>(null)
  const [healthReport, setHealthReport] = useState<HealthReport | null>(null)
  const [healthLoading, setHealthLoading] = useState(false)
  // B7：一键修复弹窗状态
  const [fixOpen, setFixOpen] = useState(false)
  const [fixSel, setFixSel] = useState<Set<string>>(new Set())
  const [fixing, setFixing] = useState(false)
  const [fixMsg, setFixMsg] = useState('')

  const handleHealthCheck = useCallback(async () => {
    setHealthLoading(true)
    try {
      const report = await window.api.invoke<HealthReport>('health:run')
      setHealthReport(report)
    } catch (e: any) {
      logger.error('[Settings] 体检失败:', e)
      setHealthReport({
        timestamp: Date.now(),
        overall: 'error',
        items: [{ key: 'health.err', label: '体检服务', status: 'error', detail: `调用失败：${e?.message || e}` }],
      })
    } finally {
      setHealthLoading(false)
    }
  }, [])

  /* ---------- B7 一键修复 ---------- */
  const fixableItems = healthReport?.items.filter((i) => (i as any).fixable) ?? []

  const openFixModal = useCallback(() => {
    setFixSel(new Set(fixableItems.map((i) => i.key)))
    setFixMsg('')
    setFixOpen(true)
  }, [fixableItems])

  const handleFixAll = useCallback(async () => {
    setFixing(true)
    setFixMsg('')
    try {
      const keys = Array.from(fixSel)
      let ok = 0
      for (const key of keys) {
        const res = await window.api.invoke<{ success: boolean; detail?: string }>('health:fix', key)
        if (res?.success) ok++
      }
      setFixMsg(`已修复 ${ok}/${keys.length} 项，正在重新体检...`)
      await handleHealthCheck()
      setFixOpen(false)
    } catch (e: any) {
      setFixMsg(`修复失败：${e?.message || e}`)
    } finally {
      setFixing(false)
    }
  }, [fixSel, handleHealthCheck])

  useEffect(() => {
    if (window.api) {
      window.api.invoke<Partial<ConfigData>>('config:get').then((cfg) => {
        if (cfg?.appVersion) setAppVersion(cfg.appVersion)
        if (cfg?.electronVersion) setElectronVersion(cfg.electronVersion)
        if (cfg?.buildDate) setBuildDate(cfg.buildDate)
      }).catch((e) => { logger.error('[Settings] 获取配置失败:', e) })
      window.api.invoke<string | null>('app:get-icon-path').then((p) => {
        if (p) setIconPath(p)
      }).catch(() => { /* 图标路径获取失败时忽略 */ })
    }
    // 从 UA 获取 Electron 版本作为后备
    try {
      const ua = navigator.userAgent
      const match = ua.match(/Electron\/([\d.]+)/)
      if (match && !electronVersion) setElectronVersion(match[1])
    } catch { /* 忽略 */ }
  }, [])

  useEffect(() => {
    loadPermissions()
    loadWakeStatus()
    loadConfig()
    loadVoiceprintStatus()

    return () => {
      if (wakeWordDebounceRef.current) clearTimeout(wakeWordDebounceRef.current)
      if (sensitivityDebounceRef.current) clearTimeout(sensitivityDebounceRef.current)
    }
  }, [])

  /** 加载声纹状态（样本列表、降噪配置等） */
  const loadVoiceprintStatus = async () => {
    try {
      if (window.api) {
        const status = await window.api.invoke<{
          enrolled: boolean; sampleCount: number;
          samples: Array<{ id: string; label: string; enrolledAt: number; featureType: string }>;
          noiseFilter: { enabled: boolean; level: number };
          mfccAvailable: boolean;
        }>('voiceprint:status')
        if (status) {
          setVoiceprintSampleCount(status.sampleCount || 0)
          setVoiceprintSamples(status.samples || [])
          if (status.noiseFilter) {
            setNoiseFilterOn(status.noiseFilter.enabled)
            setNoiseLevel(status.noiseFilter.level)
          }
        }
      }
    } catch (e) {
      logger.error('[Settings] 加载声纹状态失败:', e)
    }
  }

  const loadConfig = async () => {
    try {
      if (window.api) {
        const config = await window.api.invoke<Partial<ConfigData>>('config:get')
        if (config) {
          // 缓存完整配置，供 scheduleConfigSave 计算撤销旧值
          configValuesRef.current = { ...config }
          setAutoUpdate(config.autoUpdate ?? true)
          setSendStats(config.sendStats ?? false)
          setAutoStart(config.autoStart ?? false)
          if (config.voiceExitWord !== undefined) setExitWord(config.voiceExitWord)
          if (config.voiceExitConfirmWords !== undefined) setExitConfirmWords(config.voiceExitConfirmWords)
          if (config.voiceExitCancelWords !== undefined) setExitCancelWords(config.voiceExitCancelWords)
          if (config.voiceExitConfirmTTS !== undefined) setExitConfirmTTS(config.voiceExitConfirmTTS)

          /* ---------- 声纹与降噪配置 ---------- */
          if (config.noiseFilterOn !== undefined) setNoiseFilterOn(config.noiseFilterOn)
          if (config.noiseLevel !== undefined) setNoiseLevel(config.noiseLevel)

          /* ---------- 粒子球配置 ---------- */
          if (config.floatingBallEnabled !== undefined) setFloatingBallEnabled(config.floatingBallEnabled)
        }
      }
    } catch (err) {
      logger.error('加载配置失败:', err)
    }
  }

  /* ---------- IPC 调用 ---------- */
  /**
   * IPC 通用重试辅助函数
   * 对 IPC 调用进行最多 maxRetries 次重试，每次失败后延迟递增
   */
  const retryIpc = async <T,>(fn: () => Promise<T>, maxRetries = 2, delayMs = 600): Promise<T> => {
    let lastError: Error | null = null
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn()
      } catch (e) {
        lastError = e as Error
        if (attempt < maxRetries) {
          logger.warn(`[Settings] IPC 调用失败 (第${attempt + 1}次)，${delayMs * (attempt + 1)}ms 后重试...`, (e as Error).message)
          await new Promise(resolve => setTimeout(resolve, delayMs * (attempt + 1)))
        }
      }
    }
    throw lastError ?? new Error('IPC 调用失败，已达最大重试次数')
  }

  /**
   * 单权限检测辅助：IPC 调用 + 缓存备用 + 状态更新
   */
  const checkSinglePermission = async (
    permId: string,
    ipcChannel: string,
    setStatus: (v: 'idle' | 'checking' | 'checked' | 'error') => void,
    setError: (v: string | null) => void,
  ): Promise<boolean> => {
    setStatus('checking')
    setError(null)
    try {
      const result = await retryIpc(
        () => window.api!.invoke(ipcChannel as any).then(r => r as boolean),
        2, 600
      )
      setStatus('checked')
      logger.info(`[Settings] ${permId}权限检测完成:`, result)
      return result
    } catch (e) {
      const errMsg = (e as Error).message || '未知错误'
      logger.warn(`[Settings] ${permId}权限 IPC 检测失败，尝试缓存备用:`, errMsg)
      // 前端本地备用检测：尝试从缓存状态中获取
      try {
        const cachedStatus = await window.api!.invoke<PermissionStatus>('permission:get-status')
        const cached = cachedStatus?.permissions?.find(p => p.id === permId)
        if (cached?.lastChecked) {
          const ageMs = Date.now() - cached.lastChecked
          if (ageMs < 30 * 60 * 1000) {
            logger.info(`[Settings] 使用缓存的${permId}权限状态（备用）:`, cached.granted, `(缓存年龄: ${Math.round(ageMs / 1000)}s)`)
            setStatus('checked')
            return cached.granted
          }
        }
      } catch (cacheErr) {
        logger.warn(`[Settings] ${permId}缓存备用检测也失败:`, (cacheErr as Error).message)
      }
      setError(`检测失败: ${errMsg}`)
      setStatus('error')
      return false
    }
  }

  const augmentPermissions = async (permissions: Permission[]): Promise<Permission[]> => {
    const updated = [...permissions]
    try {
      if (window.api) {
        const isAdmin = await checkSinglePermission('admin', 'permission:is-admin', setAdminCheckStatus, setAdminCheckError)
        const regAccess = await checkSinglePermission('registry', 'permission:registry-check', setRegistryCheckStatus, setRegistryCheckError)

        // 覆写权限状态
        updated.forEach(p => {
          if (p.id === 'admin' || p.type === 'system') {
            p.granted = isAdmin
            p.canRequest = !isAdmin
          }
          if (p.id === 'registry' || p.description?.includes('注册表')) {
            p.granted = regAccess
            p.canRequest = !regAccess
          }
        })
      }
    } catch {
      setAdminCheckStatus('error')
      setRegistryCheckStatus('error')
      setAdminCheckError('权限检测模块不可用')
      setRegistryCheckError('权限检测模块不可用')
    }
    return updated
  }

  const loadPermissions = async () => {
    const seq = ++requestSeqRef.current
    setIsLoading(true)
    try {
      if (window.api) {
        const status = await window.api.invoke<PermissionStatus>('permission:get-status')
        if (seq !== requestSeqRef.current) return

        // 对管理员权限和注册表权限进行本地二次检测
        if (status?.permissions) {
          const updatedPermissions = await augmentPermissions(status.permissions)
          setPermissionStatus({
            ...status,
            permissions: updatedPermissions,
            allGranted: updatedPermissions.every(p => p.granted),
            requiredGranted: updatedPermissions.filter(p => p.required).every(p => p.granted),
          })
        } else {
          setPermissionStatus(status)
        }
      }
    } catch (err) {
      if (seq !== requestSeqRef.current) return
      logger.error('加载权限失败:', err)
    } finally {
      if (seq === requestSeqRef.current) {
        setIsLoading(false)
      }
    }
  }

  const handleCheckPermissions = async () => {
    setIsLoading(true)
    try {
      if (window.api) {
        const status = await window.api.invoke<PermissionStatus>('permission:check-all')
        // 本地二次检测
        if (status?.permissions) {
          const updatedPermissions = await augmentPermissions(status.permissions)
          setPermissionStatus({ ...status, permissions: updatedPermissions, allGranted: updatedPermissions.every(p => p.granted), requiredGranted: updatedPermissions.filter(p => p.required).every(p => p.granted) })
        } else {
          setPermissionStatus(status)
        }
      }
    } catch (err) {
      logger.error('检查权限失败:', err)
    } finally {
      setIsLoading(false)
    }
  }

  const handleRequestPermission = async (permissionId: string) => {
    setIsLoading(true)
    try {
      if (window.api) {
        await window.api.invoke('permission:request', permissionId)
        await loadPermissions()
      }
    } catch (err) {
      logger.error('请求权限失败:', err)
    } finally {
      setIsLoading(false)
    }
  }

  const handleRequestAll = async () => {
    setIsLoading(true)
    try {
      if (window.api) {
        const status = await window.api.invoke<PermissionStatus>('permission:request-all')
        setPermissionStatus(status)
      }
    } catch (err) {
      logger.error('请求全部权限失败:', err)
    } finally {
      setIsLoading(false)
    }
  }

  /* ---------- 管理员权限操作 ---------- */

  /** 以管理员身份重启应用 */
  const handleRestartAdmin = async () => {
    try {
      if (window.api) {
        await window.api.invoke('permission:fix', 'admin')
      }
    } catch (err) {
      logger.error('[Settings] 管理员重启失败:', err)
    }
  }

  /** 手动刷新管理员和注册表权限检测 */
  const handleRefreshAdminRegistry = async () => {
    if (isLoading) return
    setAdminCheckStatus('idle')
    setRegistryCheckStatus('idle')
    setAdminCheckError(null)
    setRegistryCheckError(null)
    await loadPermissions()
  }

  /* ---------- 语音唤醒操作 ---------- */
  const loadWakeStatus = async () => {
    try {
      if (window.api) {
        const status = await window.api.invoke<{ running: boolean; config?: { enabled: boolean; wakeWord: string; sensitivity: number } }>('wake:status')
        if (status) {
          setWakeRunning(status.running || false)
          if (status.config) {
            setWakeEnabled(status.config.enabled || false)
            setWakeWord(status.config.wakeWord || '玄枢')
            setWakeSensitivity(status.config.sensitivity || 80)
          }
        }
      }
    } catch (err) {
      logger.error('加载唤醒状态失败:', err)
    }
  }

  const handleToggleWake = async () => {
    try {
      const newEnabled = !wakeEnabled
      setWakeEnabled(newEnabled)
      if (window.api) {
        await window.api.invoke('wake:set-config', { enabled: newEnabled, wakeWord, sensitivity: wakeSensitivity })
        if (newEnabled) {
          await window.api.invoke('wake:start')
          setWakeRunning(true)
        } else {
          await window.api.invoke('wake:stop')
          setWakeRunning(false)
        }
      }
    } catch (err) {
      logger.error('切换唤醒失败:', err)
      setWakeEnabled(!wakeEnabled)
    }
  }

  const wakeWordDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleWakeWordChange = async (word: string) => {
    setWakeWord(word)
    if (wakeWordDebounceRef.current) clearTimeout(wakeWordDebounceRef.current)
    wakeWordDebounceRef.current = setTimeout(() => {
      if (window.api) window.api.invoke('wake:set-config', { wakeWord: word }).catch((e) => { logger.error('[Settings] 设置唤醒词失败:', e) })
    }, 500)
  }

  const sensitivityDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleSensitivityChange = async (value: number) => {
    setWakeSensitivity(value)
    if (sensitivityDebounceRef.current) clearTimeout(sensitivityDebounceRef.current)
    sensitivityDebounceRef.current = setTimeout(() => {
      if (window.api) window.api.invoke('wake:set-config', { sensitivity: value }).catch((e) => { logger.error('[Settings] 设置灵敏度失败:', e) })
    }, 500)
  }

  /* ---------- 声纹与降噪 ---------- */
  const handleVoiceEnroll = async (label?: string) => {
    if (voiceEnrolling) return
    setVoiceEnrolling(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const audioCtx = new AudioContext({ sampleRate: 16000 })
      const source = audioCtx.createMediaStreamSource(stream)
      const processor = audioCtx.createScriptProcessor(4096, 1, 1)
      const chunks: Float32Array[] = []

      processor.onaudioprocess = (e) => {
        chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
      }
      source.connect(processor)
      processor.connect(audioCtx.destination)

      // 录音 5 秒
      await new Promise<void>((resolve) => setTimeout(resolve, 5000))

      processor.disconnect()
      source.disconnect()
      stream.getTracks().forEach(t => t.stop())
      await audioCtx.close()

      const totalLength = chunks.reduce((s, c) => s + c.length, 0)
      const audioData = new Float32Array(totalLength)
      let offset = 0
      for (const chunk of chunks) {
        audioData.set(chunk, offset)
        offset += chunk.length
      }

      if (window.api) {
        const result = await window.api.invoke<{ success: boolean; sampleCount?: number; error?: string }>(
          'voiceprint:enroll',
          { audioData, label: label || undefined }
        )
        if (result?.success) {
          const count = result.sampleCount || 1
          setVoiceprintSampleCount(count)
          // v2.3: 刷新声纹样本列表，确保前端样本 ID 与后端一致
          loadVoiceprintStatus()
        } else {
          logger.error('[Settings] 声纹注册失败:', result?.error)
        }
      }
    } catch (e) {
      logger.error('[Settings] 声纹录入失败:', e)
    } finally {
      setVoiceEnrolling(false)
    }
  }

  const handleVoiceVerify = async () => {
    if (voiceVerifying) return
    setVoiceVerifying(true)
    setVoiceVerifyScore(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const audioCtx = new AudioContext({ sampleRate: 16000 })
      const source = audioCtx.createMediaStreamSource(stream)
      const processor = audioCtx.createScriptProcessor(4096, 1, 1)
      const chunks: Float32Array[] = []

      processor.onaudioprocess = (e) => {
        chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
      }
      source.connect(processor)
      processor.connect(audioCtx.destination)

      // 录音 3 秒
      await new Promise<void>((resolve) => setTimeout(resolve, 3000))

      processor.disconnect()
      source.disconnect()
      stream.getTracks().forEach(t => t.stop())
      await audioCtx.close()

      const totalLength = chunks.reduce((s, c) => s + c.length, 0)
      const audioData = new Float32Array(totalLength)
      let offset = 0
      for (const chunk of chunks) {
        audioData.set(chunk, offset)
        offset += chunk.length
      }

      if (window.api) {
        const result = await window.api.invoke<{ match: boolean; score: number }>('voiceprint:verify', audioData)
        setVoiceVerifyScore(result?.score ?? 0)
      }
    } catch (e) {
      logger.error('[Settings] 声纹验证失败:', e)
    } finally {
      setVoiceVerifying(false)
    }
  }

  const handleVoiceClear = async () => {
    try {
      if (window.api) {
        await window.api.invoke('voiceprint:clear')
        setVoiceprintSampleCount(0)
        setVoiceprintSamples([])
        setVoiceVerifyScore(null)
      }
    } catch (e) {
      logger.error('[Settings] 清除声纹失败:', e)
    }
  }

  /** 删除单个声纹样本 */
  const handleVoiceDeleteSample = async (sampleId: string) => {
    try {
      if (window.api) {
        const result = await window.api.invoke<{ success: boolean; sampleCount?: number }>('voiceprint:delete-sample', sampleId)
        if (result?.success) {
          setVoiceprintSampleCount(result.sampleCount || 0)
          // v2.3: 刷新声纹样本列表
          loadVoiceprintStatus()
        }
      }
    } catch (e) {
      logger.error('[Settings] 删除声纹样本失败:', e)
    }
  }

  // 声纹状态已在 loadConfig 中统一加载，此处不再重复

  const toggleNoiseFilter = () => {
    const next = !noiseFilterOn
    setNoiseFilterOn(next)
    scheduleConfigSave(CONFIG_KEYS.NOISE_FILTER_ON, next)
    // v2.3: 同步到 voiceprint 模块，与后端 voiceprint:noise-filter handler 一致
    if (window.api) window.api.invoke('voiceprint:noise-filter', next).catch((e) => { logger.error('[Settings] 噪音过滤切换失败:', e) })
  }

  /* ---------- 子组件回调包装器 ---------- */

  const handleExitWordChange = (v: string) => { setExitWord(v); scheduleConfigSave(CONFIG_KEYS.VOICE_EXIT_WORD, v) }
  const handleExitConfirmWordsChange = (v: string) => { setExitConfirmWords(v); scheduleConfigSave(CONFIG_KEYS.VOICE_EXIT_CONFIRM_WORDS, v) }
  const handleExitCancelWordsChange = (v: string) => { setExitCancelWords(v); scheduleConfigSave(CONFIG_KEYS.VOICE_EXIT_CANCEL_WORDS, v) }
  const handleExitConfirmTTSChange = (v: string) => { setExitConfirmTTS(v); scheduleConfigSave(CONFIG_KEYS.VOICE_EXIT_CONFIRM_TTS, v) }

  // SettingsGeneral callbacks
  const handleAutoUpdateChange = () => { const v = !autoUpdate; setAutoUpdate(v); scheduleConfigSave(CONFIG_KEYS.AUTO_UPDATE, v) }
  const handleSendStatsChange = () => { const v = !sendStats; setSendStats(v); scheduleConfigSave(CONFIG_KEYS.SEND_STATS, v) }
  const handleAutoStartChange = () => { const v = !autoStart; setAutoStart(v); scheduleConfigSave(CONFIG_KEYS.AUTO_START, v) }
  const handleThemeColorChange = (themeId: string) => { applyTheme(themeId) }

  // 悬浮球切换
  const handleFloatingBallToggle = () => {
    const v = !floatingBallEnabled
    setFloatingBallEnabled(v)
    scheduleConfigSave('floatingBallEnabled', v)
    if (window.api) {
      if (v) {
        window.api.invoke('floating-ball:open').catch((e) => { logger.error('[Settings] 悬浮球开启失败:', e) })
      } else {
        window.api.invoke('floating-ball:hide').catch((e) => { logger.error('[Settings] 悬浮球关闭失败:', e) })
      }
    }
  }

  // SettingsVoiceprint callbacks
  const handleNoiseLevelChange = (level: number) => {
    setNoiseLevel(level)
    scheduleConfigSave(CONFIG_KEYS.NOISE_LEVEL, level)
    // v2.3: 同步到 voiceprint 模块，更新后端噪声门阈值
    if (window.api) window.api.invoke('voiceprint:noise-level', level).catch((e) => { logger.error('[Settings] 降噪等级同步失败:', e) })
  }

  return (
    <motion.div
      style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, backgroundColor: COLORS.bg, color: COLORS.textPrimary }}
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {/* ==================== 页面标题 ==================== */}
      <motion.div
        variants={itemVariants}
        style={{
          padding: '20px 32px',
          borderBottom: `1px solid ${COLORS.cardBorder}`,
          display: 'flex',
          alignItems: 'center',
          gap: 14,
        }}
      >
        <motion.button
          aria-label="返回上一页"
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.92 }}
          onClick={() => window.history.back()}
          style={{
            width: 34,
            height: 34,
            borderRadius: '10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(255,255,255,0.04)',
            border: `1px solid ${COLORS.cardBorder}`,
            color: COLORS.textSecondary,
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
        >
          <ArrowLeft size={16} />
        </motion.button>
        <h2 style={{ fontSize: 17, fontWeight: 600 }}>{t('settings.title')}</h2>
        {undoMgr.canUndo && (
          <motion.button
            whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
            onClick={() => undoMgr.undo()}
            title={t('common.undo')}
            style={{ marginLeft: 12, padding: '4px 10px', borderRadius: 8, fontSize: 11, border: '1px solid var(--border-subtle)', background: 'transparent', color: COLORS.textSecondary, cursor: 'pointer' }}
          >
            {t('common.undo')}
          </motion.button>
        )}
      </motion.div>

      {/* ==================== 设置内容 ==================== */}
      <ErrorBoundary>
      <div
        className="flex-1 overflow-auto"
        style={{
          padding: '28px 32px',
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
        }}
      >
        {/* ~~~~~~~~~~~ 粒子球设置卡片 ~~~~~~~~~~~ */}
        <GlassCard
          title="悬浮球"
          icon={<Circle size={18} />}
          accentColor={COLORS.accent}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ fontSize: 13, color: COLORS.textSecondary }}>
                显示悬浮球（桌面快捷球，单击打开主窗口，双击快捷面板）
              </div>
              <Toggle checked={floatingBallEnabled} onChange={handleFloatingBallToggle} />
            </div>
          </div>
        </GlassCard>

        {/* ~~~~~~~~~~~ 情境感知 · 第六感 ~~~~~~~~~~~ */}
        <SettingsContext />

        {/* ~~~~~~~~~~~ 首页预指令配置 ~~~~~~~~~~~ */}
        <SettingsQuickActions />

        {/* ~~~~~~~~~~~ 语音唤醒卡片 ~~~~~~~~~~~ */}
        <SettingsVoiceWake
          wakeEnabled={wakeEnabled}
          wakeRunning={wakeRunning}
          wakeWord={wakeWord}
          wakeSensitivity={wakeSensitivity}
          exitWord={exitWord}
          exitConfirmWords={exitConfirmWords}
          exitCancelWords={exitCancelWords}
          exitConfirmTTS={exitConfirmTTS}
          onToggleWake={handleToggleWake}
          onWakeWordChange={handleWakeWordChange}
          onSensitivityChange={handleSensitivityChange}
          onExitWordChange={handleExitWordChange}
          onExitConfirmWordsChange={handleExitConfirmWordsChange}
          onExitCancelWordsChange={handleExitCancelWordsChange}
          onExitConfirmTTSChange={handleExitConfirmTTSChange}
        />

        {/* ~~~~~~~~~~~ 权限管理卡片 ~~~~~~~~~~~ */}
        <SettingsPermissions
          permissionStatus={permissionStatus}
          isLoading={isLoading}
          adminCheckStatus={adminCheckStatus}
          registryCheckStatus={registryCheckStatus}
          adminCheckError={adminCheckError}
          registryCheckError={registryCheckError}
          onCheckPermission={handleCheckPermissions}
          onRequestPermission={handleRequestPermission}
          onRequestAll={handleRequestAll}
          onRefreshAdmin={handleRefreshAdminRegistry}
          onRestartAdmin={handleRestartAdmin}
        />


        {/* ~~~~~~~~~~~ 常规设置卡片 ~~~~~~~~~~~ */}
        <SettingsGeneral
          autoUpdate={autoUpdate}
          sendStats={sendStats}
          autoStart={autoStart}
          themeColor={themeColor}
          onAutoUpdateChange={handleAutoUpdateChange}
          onSendStatsChange={handleSendStatsChange}
          onAutoStartChange={handleAutoStartChange}
          onThemeColorChange={handleThemeColorChange}
        />

        {/* ~~~~~~~~~~~ 声纹与降噪 ~~~~~~~~~~~ */}
        <SettingsVoiceprint
          voiceprintSampleCount={voiceprintSampleCount}
          voiceprintSamples={voiceprintSamples}
          voiceEnrolling={voiceEnrolling}
          voiceVerifying={voiceVerifying}
          voiceVerifyScore={voiceVerifyScore}
          noiseFilterOn={noiseFilterOn}
          noiseLevel={noiseLevel}
          onVoiceEnroll={handleVoiceEnroll}
          onVoiceVerify={handleVoiceVerify}
          onVoiceClear={handleVoiceClear}
          onVoiceDeleteSample={handleVoiceDeleteSample}
          onNoiseFilterChange={toggleNoiseFilter}
          onNoiseLevelChange={handleNoiseLevelChange}
        />

        {/* ~~~~~~~~~~~ 技能包管理卡片 ~~~~~~~~~~~ */}
        <SettingsSkillPacks />

        {/* ~~~~~~~~~~~ 搜索设置卡片 ~~~~~~~~~~~ */}
        <GlassCard
          title="搜索设置"
          icon={<Search size={18} />}
          accentColor={COLORS.accent}
        >
          <WebSearchPanel />
        </GlassCard>

        {/* ~~~~~~~~~~~ 体检卡片 ~~~~~~~~~~~ */}
        <GlassCard
          title="体检"
          icon={<Activity size={18} />}
          accentColor={COLORS.cyan}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {healthReport && (
              <div
                style={{
                  display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 4,
                }}
              >
                {healthReport.items.map((item) => {
                  const color = item.status === 'ok' ? '#4ade80' : item.status === 'warn' ? '#fbbf24' : '#f87171'
                  return (
                    <div
                      key={item.key}
                      style={{
                        flex: '1 1 180px', padding: '10px 12px', borderRadius: 12,
                        background: `${color}0d`, border: `1px solid ${color}30`,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <div style={{ width: 8, height: 8, borderRadius: 4, background: color, flexShrink: 0 }} />
                        <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }}>{item.label}</span>
                      </div>
                      <div style={{ fontSize: 11, color: COLORS.textMuted, lineHeight: 1.4 }}>{item.detail}</div>
                      {item.fix && (
                        <div style={{ fontSize: 10, color, marginTop: 4 }}>{item.fix}</div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={handleHealthCheck}
                disabled={healthLoading}
                style={{
                  padding: '8px 16px', borderRadius: 10, border: 'none',
                  background: 'linear-gradient(135deg, #4ade80, #22d3ee)',
                  color: '#000', fontWeight: 600, fontSize: 12, cursor: 'pointer',
                  opacity: healthLoading ? 0.6 : 1,
                }}
              >
                {healthLoading ? '检查中...' : '运行体检'}
              </motion.button>
              {fixableItems.length > 0 && (
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={openFixModal}
                  disabled={fixing}
                  style={{
                    padding: '8px 16px', borderRadius: 10, border: 'none',
                    background: 'linear-gradient(135deg, #fbbf24, #fb923c)',
                    color: '#000', fontWeight: 600, fontSize: 12, cursor: 'pointer',
                    opacity: fixing ? 0.6 : 1,
                  }}
                >
                  一键修复（{fixableItems.length}）
                </motion.button>
              )}
              {healthReport && (
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
                    color: healthReport.overall === 'ok' ? '#4ade80' : healthReport.overall === 'warn' ? '#fbbf24' : '#f87171',
                  }}
                >
                  <div style={{ width: 10, height: 10, borderRadius: 5, background: 'currentColor' }} />
                  {healthReport.overall === 'ok' ? '一切正常' : healthReport.overall === 'warn' ? '存在警告' : '需要修复'}
                </div>
              )}
            </div>
          </div>
        </GlassCard>

        {/* ~~~~~~~~~~~ 关于信息卡片 ~~~~~~~~~~~ */}
        <GlassCard
          title="关于"
          icon={<Info size={18} />}
          accentColor={COLORS.purple}
        >
          <div
            style={{
              padding: '14px 18px',
              marginBottom: 14,
              borderRadius: 'var(--radius-20)',
background: `linear-gradient(135deg, ${HEX_COLORS.violet}14, rgba(167,139,250,0.06))`,
border: `1px solid ${HEX_COLORS.violet}40`,
              display: 'flex',
              alignItems: 'center',
              gap: 16,
            }}
          >
            {iconPath && (
              <img
                src={`local-file://${iconPath.replace(/\\/g, '/')}`}
                alt="玄枢"
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 16,
                  objectFit: 'cover',
                  flexShrink: 0,
boxShadow: `0 4px 16px ${HEX_COLORS.violet}40`,
                }}
              />
            )}
            <div>
              <div style={{ fontSize: 13, lineHeight: 1.8, color: COLORS.textPrimary }}>
                玄枢，由 <span style={{ color: COLORS.accent, fontWeight: 700 }}>阿木</span> 打造的本地智能桌面助手。
                它不止是一个工具——它记得你说过的话，懂得你的情绪，
                会在深夜提醒你休息，也会在你专注时安静陪伴。
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.7, color: COLORS.textMuted, marginTop: 6 }}>
                玄枢正在学习成为一个真正的人：有记忆、有性格、有情绪、会主动关心。
                这是阿木与玄枢共同的故事。
              </div>
            </div>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 14,
            }}
          >
            {[ 
              { label: '应用名称', value: '玄枢 AI' },
              { label: '版本', value: appVersion },
              { label: 'Electron', value: electronVersion },
              { label: '构建日期', value: buildDate },
            ].map((item) => (
              <motion.div
                key={item.label}
                whileHover={{
                  borderColor: COLORS.cardBorderHover,
                  boxShadow: '0 0 16px rgba(255,255,255,0.04)',
                  y: -1,
                }}
                style={{
                  padding: '16px 18px',
                  borderRadius: 'var(--radius-20)',
                  background: 'rgba(255,255,255,0.02)',
                  border: `1px solid ${COLORS.cardBorder}`,
                  transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
                }}
              >
                <div style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 6 }}>
                  {item.label}
                </div>
                <div style={{ fontSize: 14, fontWeight: 500, color: COLORS.textPrimary, fontFamily: 'var(--font-mono)' }}>
                  {item.value}
                </div>
              </motion.div>
            ))}
          </div>
        </GlassCard>
      </div>
      </ErrorBoundary>
      {fixOpen && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)',
          }}
          onClick={() => setFixOpen(false)}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            style={{
              width: 560, maxWidth: '92vw', maxHeight: '82vh', overflow: 'auto',
              background: COLORS.bg, border: `1px solid ${COLORS.cardBorder}`,
              borderRadius: 20, padding: 22,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, color: COLORS.textPrimary, margin: 0 }}>一键修复</h3>
              <button
                onClick={() => setFixOpen(false)}
                style={{ width: 30, height: 30, borderRadius: 9, border: 'none', background: 'rgba(255,255,255,0.05)', color: COLORS.textSecondary, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <X size={15} />
              </button>
            </div>
            <div style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 12 }}>
              检测到 {fixableItems.length} 项可自动修复的问题，请勾选需要修复的项目：
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {fixableItems.map((item) => (
                <label
                  key={item.key}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 12px', borderRadius: 12,
                    background: 'rgba(255,255,255,0.03)',
                    border: `1px solid ${COLORS.cardBorder}`, cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={fixSel.has(item.key)}
                    onChange={() => {
                      const next = new Set(fixSel)
                      if (next.has(item.key)) next.delete(item.key)
                      else next.add(item.key)
                      setFixSel(next)
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>{item.label}</div>
                    <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2, wordBreak: 'break-all' }}>{item.detail}</div>
                  </div>
                  <span style={{ fontSize: 10, color: '#4ade80', flexShrink: 0 }}>{(item as any).fixLabel}</span>
                </label>
              ))}
            </div>
            {fixMsg && <div style={{ fontSize: 12, color: COLORS.warning, marginTop: 12 }}>{fixMsg}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button
                onClick={() => setFixOpen(false)}
                style={{ padding: '8px 16px', borderRadius: 10, border: `1px solid ${COLORS.cardBorder}`, background: 'transparent', color: COLORS.textSecondary, fontSize: 12, cursor: 'pointer' }}
              >
                取消
              </button>
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={handleFixAll}
                disabled={fixing || fixSel.size === 0}
                style={{
                  padding: '8px 16px', borderRadius: 10, border: 'none',
                  background: 'linear-gradient(135deg, #4ade80, #22d3ee)',
                  color: '#000', fontWeight: 600, fontSize: 12, cursor: 'pointer',
                  opacity: fixing ? 0.6 : 1,
                }}
              >
                {fixing ? '修复中...' : '一键修复'}
              </motion.button>
            </div>
          </motion.div>
        </div>
      )}
    </motion.div>
  )
}

export default Settings