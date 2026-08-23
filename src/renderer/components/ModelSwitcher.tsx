import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, Cpu, Check, Loader, Cloud, Settings2, AlertTriangle } from 'lucide-react'
import { COLORS } from '../shared/theme'

/**
 * ModelSwitcher — 首页"当前推理模型"切换器
 *
 * 功能：
 * - 展示当前正在使用的推理模型名与运行状态（以 tandem 引擎实际运行模型为准）
 * - 下拉选择已接入（注册表 / 资源目录扫描）的模型，调用 tandem:switch-model 停旧引擎 → 起新引擎，对话立即走新模型
 * - 展示本地 / 云端 provider 状态；云端未配置 API Key 时给出引导，点击跳转模型设置页
 * - 切换过程有 loading 与失败提示
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
}
interface SwitchResult {
  success: boolean
  modelId?: string
  name?: string
  port?: number
  error?: string
}

export default function ModelSwitcher() {
  const navigate = useNavigate()
  const [models, setModels] = useState<SwitchableModel[]>([])
  const [current, setCurrent] = useState<LoadedInfo | null>(null)
  const [providers, setProviders] = useState<ProviderItem[]>([])
  const [activeProviderId, setActiveProviderId] = useState<string>('')
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try {
      const [list, cur, provs, ap, tandemStates] = await Promise.all([
        window.api?.invoke<SwitchableModel[]>('model:manager:list') ?? Promise.resolve([]),
        window.api?.invoke<LoadedInfo | null>('model:manager:current') ?? Promise.resolve(null),
        window.api?.invoke<ProviderItem[]>('llm:list-providers') ?? Promise.resolve([]),
        window.api?.invoke<string | undefined>('config:get', 'activeProvider') ?? Promise.resolve(undefined),
        window.api?.invoke<TandemStateItem[]>('tandem:status') ?? Promise.resolve([]),
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
      // 过滤 embedding 专用模型（不可作为主对话推理模型）
      setModels((list || []).filter(m => m.type !== 'embedding'))
      setProviders(provs || [])
      setActiveProviderId(ap || '')
    } catch { /* 忽略：窗口未就绪时保持现状 */ }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // 模型加载状态 / tandem 引擎状态广播后自动刷新（切换 / 加载 / 卸载都会触发）
  useEffect(() => {
    const off1 = window.api?.on('model:load-status', () => { refresh() })
    const off2 = window.api?.on('tandem:status-change', () => { refresh() })
    return () => { off1?.(); off2?.() }
  }, [refresh])

  // 点击外部关闭下拉
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [])

  const activeProvider = providers.find(p => p.id === activeProviderId)
  // apiKey 已被主进程脱敏为 'xxxx****'，存在即为已配置
  const cloudConfigured = !!(activeProvider?.apiKey)
  const currentName = current?.modelName || null

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

  const goModelPage = () => { setOpen(false); navigate('/model') }

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      {/* 主切换按钮 */}
      <button
        onClick={() => { if (!switching) setOpen(v => !v) }}
        disabled={switching}
        title="切换当前推理模型"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '6px 12px', borderRadius: 10, cursor: switching ? 'wait' : 'pointer',
          fontFamily: 'inherit', fontSize: 12,
          background: 'rgba(255,255,255,0.04)', border: `1px solid ${COLORS.cardBorder}`,
          color: COLORS.textSecondary, transition: 'all 0.15s',
        }}
      >
        <Cpu size={13} color={currentName ? COLORS.accent : COLORS.textMuted} />
        {switching ? (
          <>
            <Loader size={12} color={COLORS.accent} style={{ animation: 'spin 1s linear infinite' }} />
            <span style={{ color: COLORS.textSecondary }}>切换中…</span>
          </>
        ) : (
          <span style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ color: COLORS.textMuted }}>推理模型：</span>
            <span style={{ color: currentName ? COLORS.textPrimary : COLORS.warning, fontWeight: 600 }}>
              {currentName || '未加载'}
            </span>
          </span>
        )}
        <ChevronDown size={13} color={COLORS.textMuted} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }} />
      </button>

      {/* 云端 / 本地 状态徽标 */}
      {cloudConfigured ? (
        <button
          onClick={goModelPage}
          title={`云端：${activeProvider.name || activeProviderId}`}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '5px 10px', borderRadius: 10, cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 11,
            background: `${COLORS.successDim}`, border: `1px solid ${COLORS.cardBorder}`,
            color: COLORS.success,
          }}
        >
          <Cloud size={12} />
          <span style={{ maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeProvider.name || '云端'}</span>
        </button>
      ) : (
        <button
          onClick={goModelPage}
          title="尚未配置云端 API，点击前往配置"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '5px 10px', borderRadius: 10, cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 11,
            background: `${COLORS.warningDim}`, border: `1px solid ${COLORS.cardBorder}`,
            color: COLORS.warning,
          }}
        >
          <AlertTriangle size={12} />
          未配置云端
        </button>
      )}

      {error && (
        <span style={{ fontSize: 11, color: COLORS.danger, maxWidth: 220 }}>{error}</span>
      )}

      {/* 下拉面板 */}
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 80,
          minWidth: 300, maxWidth: 360,
          background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
          borderRadius: 14, boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
          padding: '6px', overflow: 'hidden',
        }}>
          <div style={{ fontSize: 11, color: COLORS.textMuted, padding: '6px 10px 4px', fontWeight: 600 }}>
            本地已接入模型（{models.length}）
          </div>
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {models.length === 0 && (
              <div style={{ fontSize: 12, color: COLORS.textMuted, padding: '10px 12px' }}>
                暂无已接入模型，可前往模型设置页拖入 GGUF 文件接入
              </div>
            )}
            {models.map(m => {
              const isCurrent = current?.modelId === m.id
              return (
                <button
                  key={m.id}
                  onClick={() => handleSwitch(m.id)}
                  disabled={switching}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                    padding: '8px 10px', borderRadius: 9, cursor: switching ? 'wait' : 'pointer',
                    fontFamily: 'inherit', fontSize: 12, textAlign: 'left',
                    background: isCurrent ? 'rgba(255,255,255,0.07)' : 'transparent',
                    border: 'none', color: COLORS.textPrimary,
                  }}
                >
                  <span style={{
                    width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                    background: isCurrent ? COLORS.success : m.loaded ? COLORS.accent : COLORS.textMuted,
                  }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {m.name}
                  </span>
                  {m.mode && (
                    <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 6, background: m.mode === 'gpu' ? COLORS.successDim : COLORS.warningDim, color: m.mode === 'gpu' ? COLORS.success : COLORS.warning, flexShrink: 0 }}>
                      {m.mode === 'gpu' ? 'GPU' : 'CPU'}
                    </span>
                  )}
                  {isCurrent && <Check size={13} color={COLORS.success} style={{ flexShrink: 0 }} />}
                </button>
              )
            })}
          </div>
          <div style={{ borderTop: `1px solid ${COLORS.cardBorder}`, marginTop: 4, paddingTop: 4 }}>
            <button
              onClick={goModelPage}
              style={{
                display: 'flex', alignItems: 'center', gap: 7, width: '100%',
                padding: '8px 10px', borderRadius: 9, cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 12, textAlign: 'left',
                background: 'transparent', border: 'none', color: COLORS.accent,
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
