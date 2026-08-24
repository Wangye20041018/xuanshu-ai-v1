import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Bot, Plus, Play, Square, Trash2, ShieldAlert, Sparkles, AlertTriangle, X, Loader2,
} from 'lucide-react'
import { COLORS, HEX_COLORS, containerVariants, itemVariants } from '../../shared/theme'
import ErrorBoundary from '../../components/ErrorBoundary'
import { useAgentStore, pushAgentEvent } from '../../store/agentStore'
import type { AgentDefinition, AgentCreatePreview, AgentRunEvent } from '../../../shared/agent-types'

function CreateWizard({ onClose }: { onClose: () => void }) {
  const creating = useAgentStore((s) => s.creating)
  const preview = useAgentStore((s) => s.preview)
  const createRequest = useAgentStore((s) => s.createRequest)
  const cancelCreate = useAgentStore((s) => s.cancelCreate)
  const [requirement, setRequirement] = useState('')
  const [draft, setDraft] = useState<AgentCreatePreview | null>(null)

  useEffect(() => {
    if (preview) setDraft(preview)
  }, [preview])

  const handleGenerate = async () => {
    if (!requirement.trim()) return
    await createRequest(requirement.trim())
  }

  const updateField = (patch: Partial<AgentDefinition>) => {
    setDraft((d) => (d ? { ...d, definition: { ...d.definition, ...patch } } : d))
  }

  const handleConfirm = async () => {
    if (!draft) return
    // 回写本地编辑后的 draft 到 store，再走 confirmCreate（内部读取 store.preview 落盘）
    useAgentStore.setState({ preview: { ...draft, confirmed: false } })
    const saved = await useAgentStore.getState().confirmCreate()
    if (saved) onClose()
  }

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.92, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.92, y: 20 }}
        transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
        onClick={(e) => e.stopPropagation()}
        style={{ width: 640, maxWidth: '92vw', maxHeight: '86vh', overflow: 'auto', padding: 28, borderRadius: 'var(--radius-2xl)', background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`, boxShadow: '0 25px 70px rgba(0,0,0,0.5)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Sparkles size={18} style={{ color: COLORS.accent }} />
            <span style={{ fontSize: 16, fontWeight: 600, color: COLORS.textPrimary }}>对话式创建智能体</span>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: COLORS.textMuted, cursor: 'pointer', padding: 6 }}>
            <X size={18} />
          </button>
        </div>

        {!draft ? (
          <>
            <p style={{ fontSize: 13, color: COLORS.textSecondary, lineHeight: 1.6, margin: '0 0 12px' }}>
              描述你想要的智能体，AI 会从人设库选基础模板并自动填空名称、定位、标签与工具集。
            </p>
            <textarea
              value={requirement}
              onChange={(e) => setRequirement(e.target.value)}
              placeholder="例如：帮我建一个股票分析智能体，擅长解读财报与行情…"
              rows={4}
              style={{
                width: '100%', padding: '14px 16px', borderRadius: 'var(--radius-xl)',
                background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}`,
                color: COLORS.textPrimary, fontSize: 14, lineHeight: 1.7, outline: 'none',
                boxSizing: 'border-box', fontFamily: 'inherit', resize: 'vertical',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <motion.button
                whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
                onClick={handleGenerate} disabled={creating || !requirement.trim()}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '10px 22px',
                  borderRadius: 'var(--radius-lg)', border: 'none', cursor: creating ? 'not-allowed' : 'pointer',
                  background: COLORS.accent, color: '#fff', fontSize: 13, fontWeight: 600, opacity: creating ? 0.6 : 1,
                }}
              >
                {creating && <Loader2 size={15} className="animate-spin" />}
                {creating ? '生成中…' : '生成配置'}
              </motion.button>
            </div>
          </>
        ) : (
          <>
            {draft.warning && (
              <div style={{ padding: '10px 14px', borderRadius: 'var(--radius-lg)', background: HEX_COLORS.warningDim, border: `1px solid ${HEX_COLORS.warning}30`, color: COLORS.warning, fontSize: 12, marginBottom: 14 }}>
                <AlertTriangle size={13} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />
                {draft.warning}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Field label="名称">
                <input value={draft.definition.name} onChange={(e) => updateField({ name: e.target.value })} style={inputStyle} />
              </Field>
              <Field label="定位描述">
                <textarea value={draft.definition.description} onChange={(e) => updateField({ description: e.target.value })} rows={2} style={inputStyle} />
              </Field>
              <Field label="标签（逗号分隔）">
                <input
                  value={(draft.definition.tags || []).join(', ')}
                  onChange={(e) => updateField({ tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
                  style={inputStyle}
                />
              </Field>
              <Field label="工具集（勾选授权给该智能体的工具）">
                <ToolPicker selected={draft.definition.toolIds} onChange={(ids) => updateField({ toolIds: ids })} />
              </Field>
              {draft.sourcePersonaName && (
                <div style={{ fontSize: 12, color: COLORS.textMuted }}>基础人设：{draft.sourcePersonaName}（{draft.definition.personaId}）</div>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 20 }}>
              <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }} onClick={cancelCreate}
                style={{ padding: '10px 20px', borderRadius: 'var(--radius-lg)', background: 'transparent', border: `1px solid ${COLORS.cardBorder}`, color: COLORS.textSecondary, fontSize: 13, cursor: 'pointer' }}>
                返回
              </motion.button>
              <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }} onClick={handleConfirm} disabled={creating}
                style={{ padding: '10px 24px', borderRadius: 'var(--radius-lg)', background: COLORS.accent, border: 'none', color: '#fff', fontSize: 13, fontWeight: 600, cursor: creating ? 'not-allowed' : 'pointer', opacity: creating ? 0.6 : 1 }}>
                {creating ? '创建中…' : '确认创建'}
              </motion.button>
            </div>
          </>
        )}
      </motion.div>
    </motion.div>
  )
}

function ToolPicker({ selected, onChange }: { selected: string[]; onChange: (ids: string[]) => void }) {
  const tools = useAgentStore((s) => s.tools)
  const toggle = (name: string) => {
    const set = new Set(selected)
    if (set.has(name)) set.delete(name)
    else set.add(name)
    onChange(Array.from(set))
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: 200, overflow: 'auto' }}>
      {tools.map((t) => {
        const on = selected.includes(t.name)
        return (
          <button key={t.name} onClick={() => toggle(t.name)} title={t.description}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px',
              borderRadius: '9999px', cursor: 'pointer', fontSize: 12,
              background: on ? `${HEX_COLORS.accent}22` : 'rgba(255,255,255,0.03)',
              border: `1px solid ${on ? HEX_COLORS.accent : 'rgba(255,255,255,0.1)'}`,
              color: on ? COLORS.textPrimary : COLORS.textMuted,
            }}
          >
            {t.dangerous && <ShieldAlert size={11} style={{ color: COLORS.warning }} />}
            {t.name}
          </button>
        )
      })}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, color: COLORS.textSecondary }}>{label}</span>
      {children}
    </label>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 14px', borderRadius: 'var(--radius-lg)',
  background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}`,
  color: COLORS.textPrimary, fontSize: 13, outline: 'none', boxSizing: 'border-box',
  fontFamily: 'inherit', lineHeight: 1.6, resize: 'vertical',
}

function RunMonitor() {
  const { runningAgentId, events, stopAgent, clearEvents } = useAgentStore()
  if (!runningAgentId && events.length === 0) return null

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
      style={{ marginTop: 20, padding: 18, borderRadius: 'var(--radius-2xl)', background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}` }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {runningAgentId ? (
            <motion.span animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1.2, repeat: Infinity }}
              style={{ width: 8, height: 8, borderRadius: '50%', background: COLORS.accent }} />
          ) : null}
          <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>
            {runningAgentId ? '运行中' : '运行记录'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {runningAgentId && (
            <button onClick={stopAgent} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 'var(--radius-lg)', background: HEX_COLORS.dangerDim, border: `1px solid ${HEX_COLORS.danger}40`, color: COLORS.danger, fontSize: 12, cursor: 'pointer' }}>
              <Square size={12} /> 停止
            </button>
          )}
          <button onClick={clearEvents} style={{ padding: '6px 14px', borderRadius: 'var(--radius-lg)', background: 'transparent', border: `1px solid ${COLORS.cardBorder}`, color: COLORS.textMuted, fontSize: 12, cursor: 'pointer' }}>
            清空
          </button>
        </div>
      </div>
      <div style={{ maxHeight: 280, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {events.map((ev, i) => <EventRow key={i} ev={ev} />)}
      </div>
    </motion.div>
  )
}

function EventRow({ ev }: { ev: AgentRunEvent }) {
  const style: React.CSSProperties = { fontSize: 12, lineHeight: 1.6, padding: '8px 12px', borderRadius: 'var(--radius-lg)', background: 'rgba(255,255,255,0.03)' }
  if (ev.type === 'thinking') {
    return <div style={{ ...style, color: COLORS.textMuted }}><span style={{ color: COLORS.accent }}>思考</span> {ev.content}</div>
  }
  if (ev.type === 'tool_call') {
    return <div style={{ ...style, color: COLORS.textSecondary }}><span style={{ color: COLORS.warning }}>调用工具</span> {ev.tool}</div>
  }
  if (ev.type === 'tool_result') {
    const ok = ev.result?.success
    return <div style={{ ...style, color: COLORS.textMuted }}><span style={{ color: ok ? COLORS.success : COLORS.danger }}>结果</span> {ok ? '成功' : ev.result?.error}</div>
  }
  if (ev.type === 'response') {
    return <div style={{ ...style, color: COLORS.textPrimary }}><span style={{ color: COLORS.success }}>回复</span> {ev.content}</div>
  }
  if (ev.type === 'error') {
    return <div style={{ ...style, color: COLORS.danger }}>错误 {ev.message}</div>
  }
  return <div style={{ ...style, color: COLORS.textMuted }}>{ev.message}</div>
}

function Agents() {
  const agents = useAgentStore((s) => s.agents)
  const loading = useAgentStore((s) => s.loading)
  const error = useAgentStore((s) => s.error)
  const runningAgentId = useAgentStore((s) => s.runningAgentId)
  const loadAgents = useAgentStore((s) => s.loadAgents)
  const loadPersonas = useAgentStore((s) => s.loadPersonas)
  const loadTools = useAgentStore((s) => s.loadTools)
  const deleteAgent = useAgentStore((s) => s.deleteAgent)
  const runAgent = useAgentStore((s) => s.runAgent)
  const [showCreate, setShowCreate] = useState(false)
  const promptRef = useRef<Record<string, string>>({})

  useEffect(() => {
    void loadAgents()
    void loadPersonas()
    void loadTools()
  }, [loadAgents, loadPersonas, loadTools])

  // 订阅 agent:event 运行事件
  useEffect(() => {
    const win = window as any
    if (!win.api?.on) return
    const unsub = win.api.on('agent:event', (_e: unknown, payload: { agentId: string } & AgentRunEvent) => {
      if (payload?.agentId) {
        const { agentId, ...ev } = payload
        pushAgentEvent(agentId, ev)
      }
    })
    return () => unsub?.()
  }, [])

  const handleRun = useCallback(async (agentId: string) => {
    const text = promptRef.current[agentId] || ''
    if (!text.trim()) return
    await runAgent(agentId, [{ role: 'user', content: text.trim() }])
    promptRef.current[agentId] = ''
  }, [runAgent])

  const handlePanic = useCallback(async () => {
    try {
      await (window as any).api?.invoke?.('agent:panic')
    } catch {
      /* ignore */
    }
  }, [])

  return (
    <ErrorBoundary>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, backgroundColor: COLORS.bg, overflow: 'auto' }}>
        <motion.div initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
          style={{ padding: '28px 32px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, background: `${HEX_COLORS.accent}15`, border: `1px solid ${HEX_COLORS.accent}25`, borderRadius: 'var(--radius-2xl)' }}>
                <Bot size={19} style={{ color: COLORS.accent }} />
              </div>
              <div>
                <h2 style={{ fontSize: 26, fontWeight: 800, color: COLORS.textPrimary, margin: 0, letterSpacing: '-0.02em' }}>智能体</h2>
                <p style={{ fontSize: 12, color: COLORS.textMuted, margin: '2px 0 0', opacity: 0.7 }}>智能体操作系统 · 多智能体工作台</p>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} onClick={handlePanic}
                title="紧急暂停（Ctrl+Shift+F12）"
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px', borderRadius: 'var(--radius-lg)', background: HEX_COLORS.dangerDim, border: `1px solid ${HEX_COLORS.danger}40`, color: COLORS.danger, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                <ShieldAlert size={15} /> 紧急暂停
              </motion.button>
              <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} onClick={() => setShowCreate(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', borderRadius: 'var(--radius-lg)', background: COLORS.accent, border: 'none', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                <Plus size={15} /> 新建智能体
              </motion.button>
            </div>
          </div>

          {error && (
            <div style={{ padding: '10px 14px', borderRadius: 'var(--radius-lg)', background: HEX_COLORS.dangerDim, border: `1px solid ${HEX_COLORS.danger}30`, color: COLORS.danger, fontSize: 12, marginBottom: 16 }}>
              {error}
            </div>
          )}
        </motion.div>

        <div style={{ flex: 1, padding: '0 32px 32px' }}>
          {loading ? (
            <div style={{ color: COLORS.textMuted, fontSize: 13, padding: '40px 0', textAlign: 'center' }}>加载中…</div>
          ) : agents.length === 0 ? (
            <div style={{ padding: '80px 0', textAlign: 'center', color: COLORS.textMuted }}>
              <Bot size={40} style={{ opacity: 0.3, marginBottom: 16 }} />
              <div style={{ fontSize: 15, color: COLORS.textSecondary, marginBottom: 8 }}>还没有智能体</div>
              <div style={{ fontSize: 12 }}>点击「新建智能体」，用一句话创建你的专属智能体</div>
            </div>
          ) : (
            <motion.div variants={containerVariants} initial="hidden" animate="visible"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 18 }}>
              <AnimatePresence>
                {agents.map((a) => (
                  <motion.div key={a.id} variants={itemVariants} whileHover={{ y: -4, borderColor: COLORS.cardBorderHover }}
                    style={{ padding: 20, borderRadius: 'var(--radius-2xl)', background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`, boxShadow: '0 8px 32px rgba(0,0,0,0.3)', transition: 'all 0.3s' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.textPrimary }}>{a.name}</div>
                        <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 3 }}>{a.personaId}</div>
                      </div>
                      <button onClick={() => deleteAgent(a.id)}
                        style={{ padding: 6, background: 'transparent', border: 'none', color: COLORS.textMuted, cursor: 'pointer' }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = COLORS.danger }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = COLORS.textMuted }}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <p style={{ fontSize: 13, color: COLORS.textSecondary, lineHeight: 1.6, margin: '0 0 12px', minHeight: 40, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                      {a.description || '（无描述）'}
                    </p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                      {(a.tags || []).slice(0, 4).map((t) => (
                        <span key={t} style={{ padding: '2px 10px', fontSize: 11, borderRadius: '9999px', background: 'rgba(255,255,255,0.04)', border: `1px solid ${COLORS.cardBorder}`, color: COLORS.textMuted }}>{t}</span>
                      ))}
                      <span style={{ padding: '2px 10px', fontSize: 11, borderRadius: '9999px', background: HEX_COLORS.accentDim, color: COLORS.accent }}>{a.toolIds.length} 工具</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        value={promptRef.current[a.id] ?? ''}
                        onChange={(e) => { promptRef.current[a.id] = e.target.value }}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleRun(a.id) }}
                        placeholder="输入指令运行…"
                        style={{ flex: 1, padding: '8px 12px', borderRadius: 'var(--radius-lg)', background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}`, color: COLORS.textPrimary, fontSize: 12, outline: 'none', boxSizing: 'border-box' }}
                      />
                      <button onClick={() => handleRun(a.id)} disabled={runningAgentId === a.id}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 'var(--radius-lg)', background: COLORS.accent, border: 'none', color: '#fff', cursor: runningAgentId === a.id ? 'not-allowed' : 'pointer', opacity: runningAgentId === a.id ? 0.6 : 1 }}>
                        {runningAgentId === a.id ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                      </button>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </motion.div>
          )}

          <RunMonitor />
        </div>

        <AnimatePresence>
          {showCreate && <CreateWizard onClose={() => setShowCreate(false)} />}
        </AnimatePresence>
      </div>
    </ErrorBoundary>
  )
}

export default Agents
