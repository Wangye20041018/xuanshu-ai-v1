/**
 * 云端余量监控面板 v12.2
 *
 * 展示已接入云端 API Provider 的余量（估算 tokens 口径），
 * 支持设置用量上限、重置用量、远程账单余额查询。
 * 调度说明：仅复杂任务才调用云端模型；余量耗尽自动降级本地主模型。
 */
import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Cloud, Gauge, RefreshCw, RotateCcw, ShieldAlert, CheckCircle2 } from 'lucide-react'
import { logger } from '../../../shared/logger'
import { HEX_COLORS, COLORS, containerVariants, itemVariants } from '../../shared/theme'

interface ProviderCfg {
  id: string
  name: string
  baseUrl?: string
  apiKey?: string
  models?: string[]
}

interface QuotaEntry {
  providerId: string
  limitTokens: number
  usedTokens: number
  lastPromptTokens: number
  lastCompletionTokens: number
  updatedAt: number
}

interface RemoteBalance {
  total: number
  used: number
  remaining: number
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(Math.round(n))
}

export default function CloudQuotaPanel() {
  const [providers, setProviders] = useState<ProviderCfg[]>([])
  const [activeId, setActiveId] = useState('')
  const [quota, setQuota] = useState<QuotaEntry | null>(null)
  const [limitInput, setLimitInput] = useState('')
  const [remoteBalance, setRemoteBalance] = useState<RemoteBalance | null>(null)
  const [checkingRemote, setCheckingRemote] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [savedTip, setSavedTip] = useState(false)

  const load = useCallback(async () => {
    try {
      const cfg: any = await window.api?.invoke('config:get')
      const p: ProviderCfg[] = cfg?.providers || []
      setProviders(p)
      const id = cfg?.activeProvider || p[0]?.id || ''
      setActiveId(id)
      if (id) {
        const q = await window.api?.invoke<QuotaEntry | null>('cloud-quota:get', id)
        setQuota(q || null)
        setLimitInput(String(q?.limitTokens ?? 0))
      } else {
        setQuota(null)
        setLimitInput('')
      }
      setRemoteBalance(null)
    } catch (e) {
      logger.warn('[CloudQuota] load failed', e)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const selectProvider = async (id: string) => {
    setActiveId(id)
    try {
      const q = await window.api?.invoke<QuotaEntry | null>('cloud-quota:get', id)
      setQuota(q || null)
      setLimitInput(String(q?.limitTokens ?? 0))
      setRemoteBalance(null)
    } catch (e) {
      logger.warn('[CloudQuota] select failed', e)
    }
  }

  const setLimit = async () => {
    if (!activeId) return
    const v = parseInt(limitInput, 10) || 0
    const res = await window.api?.invoke<{ success: boolean; quota: QuotaEntry }>('cloud-quota:set-limit', activeId, v)
    if (res?.success) {
      setQuota(res.quota)
      setSavedTip(true)
      setTimeout(() => setSavedTip(false), 1500)
    }
  }

  const reset = async () => {
    if (!activeId) return
    await window.api?.invoke<{ success: boolean }>('cloud-quota:reset', activeId)
    const q = await window.api?.invoke<QuotaEntry | null>('cloud-quota:get', activeId)
    setQuota(q || null)
  }

  const checkRemote = async () => {
    if (!activeId) return
    setCheckingRemote(true)
    try {
      const cfg: any = await window.api?.invoke('config:get')
      const p = (cfg?.providers || []).find((x: ProviderCfg) => x.id === activeId)
      if (p?.baseUrl && p?.apiKey) {
        const r = await window.api?.invoke<RemoteBalance | null>('cloud-quota:remote-balance', p.baseUrl, p.apiKey)
        setRemoteBalance(r || null)
      } else {
        setRemoteBalance(null)
      }
    } catch (e) {
      logger.warn('[CloudQuota] remote check failed', e)
      setRemoteBalance(null)
    } finally {
      setCheckingRemote(false)
    }
  }

  const refresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const limit = quota?.limitTokens ?? 0
  const used = quota?.usedTokens ?? 0
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0
  const exhausted = limit > 0 && used >= limit

  return (
    <motion.div variants={containerVariants} initial="hidden" animate="visible"
      style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <motion.div variants={itemVariants} style={{
        background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
        borderRadius: 'var(--radius-2xl)', padding: 24,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, color: COLORS.textPrimary, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Gauge size={16} color={COLORS.accent} /> 云端余量监控
          </h3>
          <button onClick={refresh} title="刷新" style={{
            background: 'rgba(255,255,255,0.05)', border: `1px solid ${COLORS.cardBorder}`,
            borderRadius: 8, cursor: 'pointer', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 6,
            color: COLORS.textSecondary, fontSize: 12, fontFamily: 'inherit',
          }}>
            <RefreshCw size={13} className={refreshing ? 'spin' : ''} /> 刷新
          </button>
        </div>
        <p style={{ fontSize: 13, color: COLORS.textSecondary, margin: '0 0 16px' }}>
          仅复杂任务调用云端模型，调用前检查余量、耗尽自动降级本地主模型
        </p>

        {/* Provider 选择 */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          {providers.map(p => (
            <button key={p.id} onClick={() => selectProvider(p.id)} style={{
              padding: '6px 14px', borderRadius: 10, cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 13, fontWeight: activeId === p.id ? 600 : 400,
              border: activeId === p.id ? `2px solid ${COLORS.accent}` : `1px solid ${COLORS.cardBorder}`,
              background: activeId === p.id ? `${HEX_COLORS.accent}15` : 'transparent',
              color: activeId === p.id ? COLORS.accent : COLORS.textSecondary,
              transition: 'all 0.2s',
            }}>{p.name || p.id}</button>
          ))}
          {providers.length === 0 && (
            <span style={{ fontSize: 13, color: COLORS.textMuted }}>尚未接入云端 API，请先在上方完成接入</span>
          )}
        </div>

        {activeId && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* 用量进度 */}
            <div style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}`, borderRadius: 14, padding: '14px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: COLORS.textSecondary }}>
                  已用 <b style={{ color: COLORS.textPrimary }}>{fmtTokens(used)}</b>
                  {limit > 0 && <> / <b style={{ color: COLORS.textPrimary }}>{fmtTokens(limit)}</b> tokens</>}
                </span>
                {exhausted && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: COLORS.danger }}>
                    <ShieldAlert size={13} /> 已耗尽，自动降级本地
                  </span>
                )}
                {limit === 0 && <span style={{ fontSize: 12, color: COLORS.textMuted }}>未设置上限</span>}
              </div>
              <div style={{ height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', width: `${pct}%`, borderRadius: 4,
                  background: exhausted ? COLORS.danger : (pct > 80 ? COLORS.warning : COLORS.accent),
                  transition: 'width 0.4s',
                }} />
              </div>
              {quota && quota.updatedAt > 0 && (
                <div style={{ marginTop: 8, fontSize: 11, color: COLORS.textMuted }}>
                  最近一次: 输入 {fmtTokens(quota.lastPromptTokens)} / 输出 {fmtTokens(quota.lastCompletionTokens)} tokens · {new Date(quota.updatedAt).toLocaleString('zh-CN', { hour12: false })}
                </div>
              )}
            </div>

            {/* 控制区 */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, color: COLORS.textSecondary }}>上限(tokens)</span>
                <input type="number" min={0} step={10000} value={limitInput}
                  onChange={e => setLimitInput(e.target.value)}
                  placeholder="0=不限制"
                  style={{
                    width: 130, padding: '6px 10px', borderRadius: 8,
                    background: 'rgba(255,255,255,0.04)', border: `1px solid ${COLORS.cardBorder}`,
                    color: COLORS.textPrimary, fontSize: 13, fontFamily: 'var(--font-mono)',
                  }} />
                <button onClick={setLimit} style={{
                  background: `${HEX_COLORS.accent}20`, border: `1px solid ${HEX_COLORS.accent}55`,
                  borderRadius: 8, cursor: 'pointer', padding: '6px 12px',
                  color: COLORS.accent, fontSize: 12, fontFamily: 'inherit',
                }}>{savedTip ? <><CheckCircle2 size={12} /> 已保存</> : '保存上限'}</button>
              </div>
              <button onClick={reset} style={{
                background: 'rgba(255,255,255,0.05)', border: `1px solid ${COLORS.cardBorder}`,
                borderRadius: 8, cursor: 'pointer', padding: '6px 12px',
                color: COLORS.textSecondary, fontSize: 12, fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <RotateCcw size={13} /> 重置用量
              </button>
              <button onClick={checkRemote} disabled={checkingRemote} style={{
                background: 'rgba(255,255,255,0.05)', border: `1px solid ${COLORS.cardBorder}`,
                borderRadius: 8, cursor: 'pointer', padding: '6px 12px',
                color: COLORS.textSecondary, fontSize: 12, fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <Cloud size={13} /> {checkingRemote ? '查询中...' : '查询远程余额'}
              </button>
            </div>

            {remoteBalance && (
              <div style={{
                background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.25)',
                borderRadius: 12, padding: '12px 16px', fontSize: 13, color: COLORS.textSecondary,
                display: 'flex', gap: 24, flexWrap: 'wrap',
              }}>
                <span>总额 <b style={{ color: COLORS.textPrimary }}>${remoteBalance.total.toFixed(2)}</b></span>
                <span>已用 <b style={{ color: COLORS.textPrimary }}>${remoteBalance.used.toFixed(2)}</b></span>
                <span>剩余 <b style={{ color: COLORS.success }}>${remoteBalance.remaining.toFixed(2)}</b></span>
              </div>
            )}
            {!remoteBalance && !checkingRemote && (
              <span style={{ fontSize: 11, color: COLORS.textMuted }}>
                远程余额查询依赖中转站 OpenAI 计费接口（/v1/dashboard/billing），不支持时自动跳过
              </span>
            )}
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}
