import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, Cpu, Check, Loader, Cloud, Settings2, AlertTriangle, X, MemoryStick, Zap } from 'lucide-react'
import { COLORS } from '../shared/theme'

/**
 * ModelSwitcher — 首页"当前推理模型"切换器（第1批整改 · 模型链路真实化）
 *
 * 功能（对齐玄枢 GlassCard 视觉，三类入口 + 真实状态）：
 * - 本地主模型 9B（GPU 常驻）/ 2B 视觉待命：展示 运行中 / 待命 / 未加载 三态 + GPU/CPU 徽标
 * - 云端模型：已配置提供商一键切换；未配置时给出醒目接入入口
 * - 头部实时显示 GPU 显存占用（nvidia-smi 真实数据，随面板打开轮询）
 * - 一键切换（tandem:switch-model / llm:set-active-provider），切换中禁用全部操作
 * - 点击外部 / Esc 关闭下拉
 */
interface SwitchableModel {
  id: string
  name: string
  path: string
  type?: 'main' | 'vision' | 'embedding'
  mode?: 'gpu' | 'cpu'
  loaded?: boolean
  size?: number
}
interface LoadedInfo {
  modelId: string
  modelName: string
  modelPath?: string
}
interface ProviderItem {
  id: string
  name: string
  type?: string
  apiKey?: string
  baseUrl?: string
}
interface TandemStateItem {
  modelId: string
  port: number
  status: 'stopped' | 'starting' | 'running' | 'error'
  errorMessage?: string
  mode?: 'gpu' | 'cpu'
  gpuLayers?: number
}
interface SwitchResult {
  success: boolean
  modelId?: string
  name?: string
  port?: number
  error?: string
}
interface GpuStats {
  usage: number
  memoryUsed: number
  memoryTotal: number
}

/** 已下架模型（大修：仅保留 9B 主模型 + 2B 视觉待命模型） */
const REMOVED_MODEL_IDS = ['qwen2-vl-7b', 'qwen3.5-0.8b-behavior']
/** 本地引擎 provider id（选择"本地模型"时写入 activeProvider，主进程识别为非云端） */
const LOCAL_ENGINE_PROVIDER_ID = '__local_tandem__'

export default function ModelSwitcher() {
  const navigate = useNavigate()
  const [models, setModels] = useState<SwitchableModel[]>([])
  const [current, setCurrent] = useState<LoadedInfo | null>(null)
  const [providers, setProviders] = useState<ProviderItem[]>([])
  const [activeProviderId, setActiveProviderId] = useState<string>('')
  const [tandemStates, setTandemStates] = useState<TandemStateItem[]>([])
  const [gpu, setGpu] = useState<GpuStats | null>(null)
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try {
      const [list, cur, provs, ap, tandemStates, rt] = await Promise.all([
        window.api?.invoke<SwitchableModel[]>('model:manager:list') ?? Promise.resolve([]),
        window.api?.invoke<LoadedInfo | null>('model:manager:current') ?? Promise.resolve(null),
        window.api?.invoke<ProviderItem[]>('llm:list-providers') ?? Promise.resolve([]),
        window.api?.invoke<string | undefined>('config:get', 'activeProvider') ?? Promise.resolve(undefined),
        window.api?.invoke<TandemStateItem[]>('tandem:status') ?? Promise.resolve([]),
        window.api?.invoke<{ gpu: GpuStats | null }>('model-registry:runtime-status') ?? Promise.resolve({ gpu: null }),
      ])
      // 对话真实引擎是 tandem 正在运行的模型；无则回退 modelManager.current
      const running = (tandemStates || []).find(s => s.status === 'running')
      if (running) {
        const name = (list || []).find(m => m.id === running.modelId)?.name
          || (cur && cur.modelId === running.modelId ? cur.modelName : undefined)
          || running.modelId
        setCurrent({ modelId: running.modelId, modelName: name })
      } else {
        setCurrent(cur || null)
      }
      // 只显示主对话模型（过滤 embedding 专用模型 + 已下架模型，仅留 9B/2B）
      setModels((list || []).filter(m => m.type !== 'embedding' && !REMOVED_MODEL_IDS.includes(m.id)))
      setProviders(provs || [])
      setActiveProviderId(ap || '')
      setTandemStates(tandemStates || [])
      setGpu(rt?.gpu ?? null)
    } catch { /* 忽略：窗口未就绪时保持现状 */ }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // 模型加载状态 / tandem 引擎状态广播后自动刷新（切换 / 加载 / 卸载都会触发）
  useEffect(() => {
    const off1 = window.api?.on('model:load-status', () => { refresh() })
    const off2 = window.api?.on('tandem:status-change', () => { refresh() })
    return () => { off1?.(); off2?.() }
  }, [refresh])

  // 面板打开时 4 秒轮询 GPU 显存（真实 nvidia-smi 数据）
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => refresh(), 4000)
    return () => clearInterval(t)
  }, [open, refresh])

  // 点击外部关闭下拉（防误触）
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [])

  // Esc 关闭下拉
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const activeProvider = providers.find(p => p.id === activeProviderId)
  // apiKey 已被主进程脱敏为 'xxxx****'，存在即为已配置
  const cloudConfigured = !!(activeProvider?.apiKey)
  const currentName = current?.modelName || null
  // GPU/CPU 真实运行状态：以 tandem 引擎为准（合并原右上角状态窗能力）
  const runningState = (tandemStates || []).find(s => s.status === 'running')
  const engineReady = !!runningState || !!current
  const dispMode = runningState?.mode
  const gpuOk = !!(gpu && gpu.memoryTotal > 0)
  const gpuPct = gpuOk ? Math.min(100, Math.round((gpu.memoryUsed / gpu.memoryTotal) * 100)) : 0

  const handleSwitch = useCallback(async (id: string) => {
    if (!id || switching) return
    if (current && current.modelId === id) { setOpen(false); return }
    setSwitching(true)
    setError(null)
    try {
      const res = await window.api?.invoke<SwitchResult>('tandem:switch-model', id)
      if (!res?.success) throw new Error(res?.error || '切换失败，请确认目标模型文件存在')
      await refresh()
    } catch (e: any) {
      setError(e?.message || String(e))
      setTimeout(() => setError(null), 4500)
    } finally {
      setSwitching(false)
      setOpen(false)
    }
  }, [current, switching, refresh])

  /** 切换对话提供商：本地引擎 or 云端 provider */
  const handleProviderSelect = useCallback(async (providerId: string) => {
    if (switching) return
    setSwitching(true)
    setError(null)
    try {
      const ok = await window.api?.invoke<boolean>('llm:set-active-provider', providerId)
      if (ok === false) throw new Error('切换提供商失败')
      await refresh()
    } catch (e: any) {
      setError(e?.message || String(e))
      setTimeout(() => setError(null), 4500)
    } finally {
      setSwitching(false)
      setOpen(false)
    }
  }, [switching, refresh])

  const goModelPage = () => { setOpen(false); navigate('/model') }

  const isCloudActive = cloudConfigured && !!activeProvider

  /** 状态徽标：运行中 / 待命 / 未加载 */
  const StateBadge = ({ color, bg, label }: { color: string; bg: string; label: string }) => (
    <span style={{
      fontSize: 10, padding: '2px 7px', borderRadius: 6, flexShrink: 0,
      background: bg, color, fontWeight: 600, whiteSpace: 'nowrap',
    }}>{label}</span>
  )

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      {/* 主切换按钮：当前模型 + GPU/CPU 真实运行状态 */}
      <button
        onClick={() => { if (!switching) setOpen(v => !v) }}
        disabled={switching}
        title="切换当前推理模型（本地 9B / 2B，或云端提供商）"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          // A批1：去掉固定 300px 宽（修复与"新建会话"按钮并排时互相遮挡/宽度漂移），改为自适应弹性宽度
          padding: '0 14px', height: 34, minWidth: 200, maxWidth: 340, flex: '0 1 auto',
          justifyContent: 'space-between',
          borderRadius: 12, cursor: switching ? 'wait' : 'pointer',
          fontFamily: 'inherit', fontSize: 12,
          background: open ? 'var(--bg-elevated)' : 'var(--bg-surface)',
          border: `1px solid ${isCloudActive ? 'var(--status-done)' : open ? 'var(--status-running)' : currentName ? COLORS.cardBorder : COLORS.danger + '66'}`,
          color: COLORS.textSecondary, transition: 'all 0.18s',
          boxShadow: open ? '0 4px 20px rgba(0,0,0,0.35)' : '0 2px 8px rgba(0,0,0,0.18)',
        }}
      >
        <Cpu size={14} color={currentName ? COLORS.accent : COLORS.textMuted} />
        {switching ? (
          <>
            <Loader size={12} color={COLORS.accent} style={{ animation: 'spin 1s linear infinite' }} />
            <span style={{ color: COLORS.textSecondary }}>切换中…</span>
          </>
        ) : (
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ color: COLORS.textMuted }}>{isCloudActive ? '云端：' : '推理模型：'}</span>
            <span style={{ color: currentName ? COLORS.textPrimary : COLORS.warning, fontWeight: 700 }}>
              {isCloudActive ? (activeProvider?.name || '云端') : (currentName || '未加载')}
            </span>
          </span>
        )}
        {/* GPU/CPU 真实状态徽标（合并原右上角状态窗） */}
        {!switching && (
          engineReady ? (
            dispMode ? (
              <span style={{
                fontSize: 10, padding: '1px 6px', borderRadius: 6, flexShrink: 0,
                background: dispMode === 'gpu' ? COLORS.successDim : COLORS.warningDim,
                color: dispMode === 'gpu' ? COLORS.success : COLORS.warning,
                fontWeight: 600,
              }}>
                {dispMode === 'gpu' ? 'GPU 运行中' : 'CPU 运行中'}
              </span>
            ) : isCloudActive ? (
              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 6, flexShrink: 0, background: COLORS.successDim, color: COLORS.success, fontWeight: 600 }}>
                <Cloud size={10} style={{ display: 'inline', verticalAlign: -1 }} /> 云端
              </span>
            ) : (
              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 6, flexShrink: 0, background: COLORS.warningDim, color: COLORS.warning, fontWeight: 600 }}>
                就绪
              </span>
            )
          ) : (
            <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 6, flexShrink: 0, background: COLORS.dangerDim, color: COLORS.dangerAlt, fontWeight: 600 }}>
              未就绪
            </span>
          )
        )}
        <ChevronDown size={13} color={COLORS.textMuted} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }} />
      </button>

      {error && (
        <span style={{ fontSize: 11, color: COLORS.danger, maxWidth: 220 }}>{error}</span>
      )}

      {/* 下拉面板（GlassCard 风格） */}
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', left: 0, zIndex: 80,
          width: 360,
          background: 'var(--bg-overlay)',
          border: `1px solid ${COLORS.cardBorder}`,
          borderLeft: '3px solid var(--status-running)',
          borderRadius: 12, boxShadow: 'var(--shadow-lg)',
          padding: '10px',
        }}>
          {/* 面板头部：当前引擎状态摘要 + GPU 显存 */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '6px 8px 8px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <Zap size={12} color={COLORS.accent} />
              <span style={{ fontSize: 11, color: COLORS.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {engineReady
                  ? (dispMode ? `引擎运行中（${dispMode === 'gpu' ? 'GPU' : 'CPU'}${runningState ? ` · :${runningState.port}` : ''}）` : (isCloudActive ? '当前使用云端提供商' : '引擎就绪'))
                  : '引擎未就绪 — 请先加载模型'}
              </span>
            </div>
            <button
              onClick={() => setOpen(false)}
              title="关闭"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: COLORS.textMuted, padding: 2, display: 'flex' }}
            >
              <X size={13} />
            </button>
          </div>

          {/* GPU 显存占用（真实数据） */}
          <div style={{
            padding: '8px 10px', margin: '0 2px 6px', borderRadius: 10,
            background: 'rgba(255,255,255,0.04)', border: `1px solid ${COLORS.cardBorder}`,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
              <span style={{ fontSize: 11, color: COLORS.textSecondary, display: 'flex', alignItems: 'center', gap: 4 }}>
                <MemoryStick size={11} /> GPU 显存占用
              </span>
              <span style={{ fontSize: 11, color: COLORS.textSecondary, fontWeight: 600 }}>
                {gpuOk
                  ? `${Math.round(gpu.memoryUsed)} / ${Math.round(gpu.memoryTotal)} MB（${gpu.usage ?? 0}%）`
                  : '不可用（未检测到 NVIDIA GPU）'}
              </span>
            </div>
            <div style={{ height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
              {gpuOk && (
                <div style={{
                  height: '100%', borderRadius: 3,
                  width: `${gpuPct}%`,
                  background: 'var(--status-running)',
                  transition: 'width 0.5s ease',
                }} />
              )}
            </div>
          </div>

          {/* 本地模型区块：9B 主模型 + 2B 视觉待命 */}
          <div style={{ fontSize: 11, color: COLORS.textMuted, padding: '6px 10px 4px', fontWeight: 600 }}>
            本地模型
          </div>
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
            {models.length === 0 && (
              <div style={{ fontSize: 12, color: COLORS.textMuted, padding: '10px 12px' }}>
                暂无已接入模型，可前往模型设置页拖入 GGUF 文件接入
              </div>
            )}
            {models.map(m => {
              const isCurrent = current?.modelId === m.id && !isCloudActive
              const state = (tandemStates || []).find((t: TandemStateItem) => t.modelId === m.id)
              const isRunning = state?.status === 'running'
              const isStarting = state?.status === 'starting'
              const dispModeLocal = state?.mode ?? m.mode
              // 状态归类：运行中 / 待命 / 未加载
              const statusLabel = isRunning ? `运行中${state?.port ? ` :${state.port}` : ''}`
                : isStarting ? '启动中'
                : (m.type === 'vision' ? '待命' : '未加载')
              const statusColor = isRunning ? COLORS.success : isStarting ? COLORS.warning : COLORS.textMuted
              const statusBg = isRunning ? COLORS.successDim : isStarting ? COLORS.warningDim : 'rgba(255,255,255,0.05)'
              return (
                <button
                  key={m.id}
                  onClick={() => handleSwitch(m.id)}
                  disabled={switching}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                    padding: '9px 10px', borderRadius: 10, cursor: switching ? 'wait' : 'pointer',
                    fontFamily: 'inherit', fontSize: 12, textAlign: 'left',
                    background: isCurrent ? 'var(--status-running-dim)' : 'transparent',
                    border: isCurrent ? '1px solid var(--status-running)' : '1px solid transparent',
                    color: COLORS.textPrimary, transition: 'background 0.12s',
                  }}
                  onMouseEnter={(e) => { if (!isCurrent) e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
                  onMouseLeave={(e) => { if (!isCurrent) e.currentTarget.style.background = 'transparent' }}
                >
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                    background: isCurrent ? COLORS.success : isRunning ? 'var(--status-running)' : COLORS.textMuted,
                    boxShadow: 'none',
                  }} />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span style={{ fontWeight: isCurrent ? 700 : 500 }}>{m.name}</span>
                    <span style={{ fontSize: 10, color: COLORS.textMuted, marginLeft: 6 }}>
                      {m.type === 'vision' ? '视觉待命' : '主模型'}
                      {m.id.includes('9b') ? ' · GPU 常驻' : ''}
                    </span>
                  </span>
                  {dispModeLocal && (
                    <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 6, background: dispModeLocal === 'gpu' ? COLORS.successDim : COLORS.warningDim, color: dispModeLocal === 'gpu' ? COLORS.success : COLORS.warning, flexShrink: 0 }}>
                      {dispModeLocal === 'gpu' ? 'GPU' : 'CPU'}
                    </span>
                  )}
                  <StateBadge color={statusColor} bg={statusBg} label={statusLabel} />
                  {isCurrent && <Check size={13} color={COLORS.success} style={{ flexShrink: 0 }} />}
                </button>
              )
            })}
          </div>

          {/* 云端模型区块 */}
          <div style={{ fontSize: 11, color: COLORS.textMuted, padding: '8px 10px 4px', fontWeight: 600, borderTop: `1px solid ${COLORS.cardBorder}`, marginTop: 6 }}>
            云端模型
          </div>
          <div style={{ maxHeight: 180, overflowY: 'auto' }}>
            <button
              onClick={() => handleProviderSelect(LOCAL_ENGINE_PROVIDER_ID)}
              disabled={switching}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                padding: '8px 10px', borderRadius: 10, cursor: switching ? 'wait' : 'pointer',
                fontFamily: 'inherit', fontSize: 12, textAlign: 'left',
                background: !isCloudActive ? 'var(--status-running-dim)' : 'transparent',
                border: !isCloudActive ? '1px solid var(--status-running)' : '1px solid transparent',
                color: COLORS.textPrimary, transition: 'background 0.12s',
              }}
              onMouseEnter={(e) => { if (isCloudActive) e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
              onMouseLeave={(e) => { if (isCloudActive) e.currentTarget.style.background = 'transparent' }}
            >
              <Cpu size={13} color={COLORS.accent} />
              <span style={{ flex: 1, fontWeight: !isCloudActive ? 700 : 500 }}>本地模型引擎</span>
              {!isCloudActive && <Check size={13} color={COLORS.success} />}
            </button>
            {providers.length === 0 ? (
              <button
                onClick={goModelPage}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '8px 10px', borderRadius: 10, cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: 12, textAlign: 'left',
                  background: 'transparent', border: '1px dashed rgba(255,255,255,0.15)',
                  color: COLORS.textSecondary, transition: 'background 0.12s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
              >
                <Cloud size={13} color={COLORS.warning} />
                <span style={{ flex: 1 }}>未配置云端 API，点击前往接入</span>
                <Settings2 size={12} color={COLORS.accent} />
              </button>
            ) : (
              providers.map(p => {
                const isActiveCloud = isCloudActive && p.id === activeProviderId
                const keyOk = !!p.apiKey
                return (
                  <button
                    key={p.id}
                    onClick={() => handleProviderSelect(p.id)}
                    disabled={switching || !keyOk}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                      padding: '8px 10px', borderRadius: 10, cursor: (switching || !keyOk) ? 'not-allowed' : 'pointer',
                      fontFamily: 'inherit', fontSize: 12, textAlign: 'left',
                      background: isActiveCloud ? 'var(--status-done-dim)' : 'transparent',
                      border: isActiveCloud ? '1px solid var(--status-done)' : '1px solid transparent',
                      color: COLORS.textPrimary, opacity: keyOk ? 1 : 0.65,
                      transition: 'background 0.12s',
                    }}
                    onMouseEnter={(e) => { if (!isActiveCloud && keyOk) e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
                    onMouseLeave={(e) => { if (!isActiveCloud) e.currentTarget.style.background = 'transparent' }}
                  >
                    <Cloud size={13} color={keyOk ? COLORS.success : COLORS.warning} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isActiveCloud ? 700 : 500 }}>
                      {p.name || p.id}
                    </span>
                    {!keyOk && <AlertTriangle size={12} color={COLORS.warning} style={{ flexShrink: 0 }} />}
                    {isActiveCloud && <Check size={13} color={COLORS.success} style={{ flexShrink: 0 }} />}
                  </button>
                )
              })
            )}
          </div>

          <div style={{ borderTop: `1px solid ${COLORS.cardBorder}`, marginTop: 6, paddingTop: 6 }}>
            <button
              onClick={goModelPage}
              style={{
                display: 'flex', alignItems: 'center', gap: 7, width: '100%',
                padding: '9px 10px', borderRadius: 10, cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 12, textAlign: 'left',
                background: 'rgba(255,255,255,0.04)', border: 'none', color: COLORS.accent,
              }}
            >
              <Settings2 size={13} />
              模型设置与云端配置
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
