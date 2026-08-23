import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Package, Loader2, RotateCcw, Trash2, AlertCircle, Sparkles } from 'lucide-react'
import { COLORS, GlassCard, Toggle } from './index'

interface BuiltinPack {
  id: string
  app: string
  version: string
  actions: { id: string; name: string; description: string }[]
}

interface LearnedPack {
  id: string
  app: string
  appMatch: string[]
  actionCount: number
  learnCount: number
  createdAt: string
  updatedAt: string
  enabled: boolean
}

export default function SettingsSkillPacks() {
  const [builtins, setBuiltins] = useState<BuiltinPack[]>([])
  const [learned, setLearned] = useState<LearnedPack[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [flash, setFlash] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = async () => {
    setStatus('loading')
    setErrorMsg('')
    try {
      const [b, l] = await Promise.all([
        window.api.invoke<BuiltinPack[]>('skill-pack:list'),
        window.api.invoke<LearnedPack[]>('skill-pack:learned-list'),
      ])
      setBuiltins(Array.isArray(b) ? b : [])
      setLearned(Array.isArray(l) ? l : [])
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

  const handleToggle = async (pack: LearnedPack, enabled: boolean) => {
    setBusyId(pack.id)
    try {
      const res = await window.api.invoke<{ success?: boolean; error?: string }>(
        'skill-pack:learned-set-enabled',
        pack.id,
        enabled,
      )
      if (res?.success) {
        setLearned((prev) => prev.map((p) => (p.id === pack.id ? { ...p, enabled } : p)))
        showFlash('success', `已${enabled ? '启用' : '停用'}「${pack.app}」技能包`)
      } else {
        showFlash('error', res?.error || `操作失败（${pack.app}）`)
      }
    } catch (e) {
      showFlash('error', e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  const handleRemove = async (pack: LearnedPack) => {
    // 二次确认：删除学习型技能包后不可恢复
    const ok = window.confirm(
      `确定删除已沉淀技能包「${pack.app}」吗？\n\n删除后将不再自动匹配该应用的操作套路，如需恢复需重新学习。`,
    )
    if (!ok) return
    setBusyId(pack.id)
    try {
      const res = await window.api.invoke<{ success?: boolean; error?: string }>(
        'skill-pack:learned-remove',
        pack.id,
      )
      if (res?.success) {
        setLearned((prev) => prev.filter((p) => p.id !== pack.id))
        showFlash('success', `已删除「${pack.app}」技能包`)
      } else {
        showFlash('error', res?.error || '删除失败，请重试')
      }
    } catch (e) {
      showFlash('error', e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  const fmtTime = (s: string) => {
    if (!s) return ''
    const d = new Date(s)
    if (Number.isNaN(d.getTime())) return s
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  return (
    <GlassCard
      title="技能包管理"
      icon={<Package size={18} />}
      accentColor={COLORS.violet}
      headerRight={
        <span style={{ fontSize: 12, color: COLORS.textMuted }}>
          内建 {builtins.length} · 学习沉淀 {learned.length}
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
          {flash.type === 'success' ? <AlertCircle size={14} /> : <AlertCircle size={14} />}
          {flash.text}
        </div>
      )}

      {status === 'loading' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: COLORS.textMuted, padding: '12px 0' }}>
          <Loader2 size={16} className="spin" />
          正在加载技能包…
        </div>
      )}

      {status === 'error' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: COLORS.danger, fontSize: 13 }}>
            <AlertCircle size={14} />
            加载技能包失败：{errorMsg}
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* 学习沉淀技能包（可启停/删除） */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <Sparkles size={13} style={{ color: COLORS.purple }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>自动沉淀的技能包</span>
            </div>
            {learned.length === 0 ? (
              <div style={{ fontSize: 12, color: COLORS.textMuted, padding: '8px 0', lineHeight: 1.6 }}>
                暂无自动沉淀技能包。玄枢在成功操控某个应用后会自动学习固化操作套路，稍后即可在此管理。
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {learned.map((p) => {
                  const busy = busyId === p.id
                  return (
                    <motion.div
                      key={p.id}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '10px 12px', borderRadius: 10,
                        border: '1px solid rgba(255,255,255,0.08)',
                        background: 'rgba(255,255,255,0.03)',
                        opacity: p.enabled ? 1 : 0.55,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>{p.app}</div>
                        <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2 }}>
                          {p.actionCount} 项能力 · 学习 {p.learnCount} 次 · 最近 {fmtTime(p.updatedAt)}
                          {p.appMatch?.length ? ` · 匹配: ${p.appMatch.join('/')}` : ''}
                        </div>
                      </div>
                      <button
                        onClick={() => handleRemove(p)}
                        disabled={busy}
                        title="删除该技能包"
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          padding: '5px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
                          border: '1px solid rgba(255,92,92,0.35)', background: 'transparent', color: COLORS.danger,
                        }}
                      >
                        {busy ? <Loader2 size={12} className="spin" /> : <Trash2 size={12} />}
                        删除
                      </button>
                      {busy ? <Loader2 size={14} className="spin" /> : (
                        <Toggle
                          checked={p.enabled}
                          onChange={() => { void handleToggle(p, !p.enabled) }}
                        />
                      )}
                    </motion.div>
                  )
                })}
              </div>
            )}
          </div>

          {/* 内建技能包（只读展示） */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <Package size={13} style={{ color: COLORS.violet }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>内建技能包</span>
            </div>
            {builtins.length === 0 ? (
              <div style={{ fontSize: 12, color: COLORS.textMuted, padding: '8px 0' }}>暂无内建技能包</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 6 }}>
                {builtins.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      padding: '10px 12px', borderRadius: 10,
                      border: '1px solid rgba(255,255,255,0.08)',
                      background: 'rgba(255,255,255,0.02)',
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>{p.app}</div>
                    <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2 }}>
                      {p.actions.length} 项能力 · v{p.version}
                    </div>
                    <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 4, lineHeight: 1.5 }}>
                      {p.actions.slice(0, 3).map((a) => a.name).join('、')}
                      {p.actions.length > 3 ? ' 等' : ''}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ fontSize: 11, color: COLORS.textMuted, lineHeight: 1.6 }}>
            技能包是玄枢对特定应用的专属操控知识。自动沉淀的技能包可随时启停或删除，删除后需重新学习才能恢复。
          </div>
        </div>
      )}
    </GlassCard>
  )
}
