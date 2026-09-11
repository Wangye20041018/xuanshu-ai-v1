/**
 * AgentProfileModal — 智能体档案弹层（第 3 批整改）
 *
 * 让用户一眼看清某个智能体「能干什么 / 用什么工具 / 擅长什么 / 和谁搭档」：
 * - 专属工具映射（toolIds -> 注册工具名 + 分类 + 说明）
 * - 擅长技能 / 示例场景
 * - 协作对象推荐（按 collaboration 提及 + tags/skills 相似度）
 * - 就地对话测试（带角色 prompt 走本地 9B 推理）
 */

import { useMemo, useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { X, Bot, Wrench, Zap, Users, Play, Loader2, Send } from 'lucide-react'
import { COLORS, HEX_COLORS } from '../../shared/theme'
import { useAgentStore, type AgentToolInfo } from '../../store/agentStore'
import type { AgentDefinition } from '../../../shared/agent-types'

interface Props {
  agent: AgentDefinition
  onClose: () => void
}

/** 根据 role/tags 提炼示例场景 */
function pickScenarios(agent: AgentDefinition): string[] {
  const r = (agent.role || '').toLowerCase()
  const t = (agent.tags || []).join(' ')
  const pool: Array<{ kw: string[]; scene: string }> = [
    { kw: ['文案', '文案策划', 'copy', '营销', '小红书', '广告'], scene: '为新品写一篇带卖点与 CTA 的小红书种草笔记' },
    { kw: ['翻译', 'translator'], scene: '把一段中英混合的合同条款翻译成通顺的目标语言' },
    { kw: ['数据', '分析', 'analyst'], scene: '基于一份订单表做 RFM 分层并给出运营建议' },
    { kw: ['编程', '开发', '工程', 'dev', 'code'], scene: '写一个带超时控制与指数退避重试的异步请求封装' },
    { kw: ['法律', 'law', '合规', '合同'], scene: '审一份竞业限制协议，列出风险点与法律依据' },
    { kw: ['旅行', '旅游', 'travel'], scene: '规划一趟预算 5000 元、5 天的云南行程' },
    { kw: ['设计', 'design', 'ui', '平面'], scene: '为一款 App 首页给出配色与排版建议' },
    { kw: ['客服', '客服', 'support'], scene: '模拟一位购买后退货的客户，给出安抚与处理话术' },
    { kw: ['产品', 'product', '经理'], scene: '为一个新功能梳理用户故事与验收标准' },
  ]
  const hit = pool.filter((p) => p.kw.some((k) => r.includes(k) || t.includes(k)))
  if (hit.length > 0) return hit.slice(0, 3).map((h) => h.scene)
  return [
    '用一句话描述你的目标，让该智能体基于角色给出专业输出',
    '追问细节：让它针对具体场景补充执行步骤与注意事项',
  ]
}

/** 协作对象推荐：collaboration 提及 + tags/skills 相似度 */
function recommendCollaborators(agent: AgentDefinition, agents: AgentDefinition[]): AgentDefinition[] {
  const self = agent.id
  const myTags = new Set(agent.tags || [])
  const mySkills = new Set(agent.skills || [])
  const collab = agent.collaboration || ''
  const scored = agents
    .filter((a) => a.id !== self)
    .map((a) => {
      let score = 0
      if (collab && a.name && collab.includes(a.name)) score += 5
      const aTags = new Set(a.tags || [])
      const aSkills = new Set(a.skills || [])
      for (const t of aTags) if (myTags.has(t)) score += 2
      for (const s of aSkills) if (mySkills.has(s)) score += 1
      // 工具交集
      const overlap = (a.toolIds || []).filter((x) => (agent.toolIds || []).includes(x)).length
      score += overlap
      return { a, score }
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, 3)
    .map((x) => x.a)
  return scored
}

export default function AgentProfileModal({ agent, onClose }: Props) {
  const personas = useAgentStore((s) => s.personas)
  const tools = useAgentStore((s) => s.tools)
  const agents = useAgentStore((s) => s.agents)
  const runAgent = useAgentStore((s) => s.runAgent)

  const [testInput, setTestInput] = useState('')
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState('')
  const [testErr, setTestErr] = useState('')

  const persona = personas.find((p) => p.id === agent.personaId)
  const ownedTools = useMemo(
    () => (agent.toolIds || []).map((tid) => tools.find((t) => t.name === tid)).filter(Boolean) as AgentToolInfo[],
    [agent.toolIds, tools],
  )
  const collabAgents = useMemo(() => recommendCollaborators(agent, agents), [agent, agents])
  const scenes = useMemo(() => pickScenarios(agent), [agent])

  // 就地对话测试：复用 agent:event 全局流，把本 agent 的事件展示在弹层
  useEffect(() => {
    const win = window as any
    if (!win.api?.on) return
    const unsub = win.api.on('agent:event', (_e: unknown, payload: { agentId: string; type: string; content?: string; message?: string; tool?: string; isFinal?: boolean }) => {
      if (!payload || payload.agentId !== agent.id) return
      const ev = payload as { agentId: string; type: string; content?: string; message?: string; tool?: string; isFinal?: boolean }
      setRunning(true)
      if (ev.type === 'tool_call') {
        setOutput((p) => p + `\n[调用工具] ${ev.tool}`)
      } else if (ev.type === 'tool_result') {
        setOutput((p) => p + `\n[工具结果] ${ev.message || 'ok'}`)
      } else if (ev.type === 'thinking' && ev.content) {
        setOutput((p) => p + `\n[思考] ${ev.content}`)
      } else if (ev.type === 'response' && ev.content) {
        setOutput((p) => p + (ev.isFinal ? `\n[完成]\n${ev.content}` : `\n${ev.content}`))
        if (ev.isFinal) setRunning(false)
      } else if (ev.type === 'error') {
        setTestErr(ev.message || '运行出错')
        setRunning(false)
      }
    })
    return () => unsub?.()
  }, [agent.id])

  const handleTest = async () => {
    if (!testInput.trim() || running) return
    setRunning(true)
    setOutput('')
    setTestErr('')
    try {
      await runAgent(agent.id, [{ role: 'user', content: testInput.trim() }])
    } catch (e) {
      setTestErr(e instanceof Error ? e.message : String(e))
      setRunning(false)
    }
    // 等待 agent:event 的 isFinal 来收尾；若长时间无事件则在此兜底释放
    setTimeout(() => setRunning((r) => r && (useAgentStore.getState().runningAgentId === agent.id)), 100)
  }

  const sectionTitle = (icon: React.ReactNode, text: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: COLORS.textSecondary, letterSpacing: 0.2, marginBottom: 8 }}>
      {icon}
      {text}
    </div>
  )

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      style={{ position: 'fixed', inset: 0, zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: 18 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.94, y: 18 }}
        transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }}
        onClick={(e) => e.stopPropagation()}
        style={{ width: 680, maxWidth: '94vw', maxHeight: '88vh', overflow: 'auto', padding: 26, borderRadius: 'var(--radius-2xl)', background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`, boxShadow: '0 25px 70px rgba(0,0,0,0.5)' }}
      >
        {/* 头部 */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 18 }}>
          <div style={{ width: 46, height: 46, borderRadius: 'var(--radius-2xl)', background: `${HEX_COLORS.accent}18`, border: `1px solid ${HEX_COLORS.accent}25`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>
            {agent.icon || <Bot size={22} style={{ color: COLORS.accent }} />}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 17, fontWeight: 800, color: COLORS.textPrimary }}>{agent.name}</span>
              {agent.preset && <span style={{ padding: '1px 9px', fontSize: 10, borderRadius: 999, background: HEX_COLORS.accentDim, color: COLORS.accent }}>预置</span>}
              {persona && <span style={{ padding: '1px 9px', fontSize: 10, borderRadius: 999, background: 'rgba(255,255,255,0.05)', border: `1px solid ${COLORS.cardBorder}`, color: COLORS.textMuted }}>角色 {persona.name}</span>}
            </div>
            <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2 }}>{agent.role}</div>
            <p style={{ fontSize: 13, color: COLORS.textSecondary, lineHeight: 1.7, margin: '8px 0 0' }}>{agent.description || '（无描述）'}</p>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: COLORS.textMuted, cursor: 'pointer', padding: 6 }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* 专属工具 */}
          <div style={{ padding: 14, borderRadius: 'var(--radius-xl)', background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}` }}>
            {sectionTitle(<Wrench size={13} style={{ color: COLORS.accent }} />, `可用工具（${ownedTools.length || '默认'}）`)}
            {ownedTools.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {ownedTools.map((t) => (
                  <div key={t.name} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12 }}>
                    <span
                      title={`工具 ${t.name}（${t.category || '通用'}）`}
                      style={{
                        padding: '2px 10px', borderRadius: 999, background: `${HEX_COLORS.accent}12`,
                        color: COLORS.accent, fontWeight: 600, whiteSpace: 'nowrap', fontSize: 11,
                        maxWidth: '42%', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}
                    >
                      {t.name}
                    </span>
                    <span style={{ color: COLORS.textSecondary, lineHeight: 1.5, flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                      {t.description || '（无说明）'}
                    </span>
                    {t.dangerous && <span style={{ color: COLORS.warning, fontSize: 11, whiteSpace: 'nowrap' }}>需确认</span>}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: COLORS.textMuted, lineHeight: 1.6 }}>
                未绑定专属工具，运行时可调用默认基础工具（检索 / 分析 / 回复）。
              </div>
            )}
          </div>

          {/* 擅长技能 + 示例场景 */}
          <div style={{ padding: 14, borderRadius: 'var(--radius-xl)', background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}` }}>
            {sectionTitle(<Zap size={13} style={{ color: COLORS.warning }} />, '擅长技能与示例场景')}
            {(agent.skills || []).length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {(agent.skills || []).map((s) => (
                  <span key={s} title={s} style={{ padding: '2px 10px', fontSize: 11, borderRadius: 999, background: 'rgba(255,255,255,0.04)', border: `1px solid ${COLORS.cardBorder}`, color: COLORS.textSecondary, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s}</span>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {scenes.map((s, i) => (
                <button key={i} onClick={() => setTestInput(s)}
                  style={{ textAlign: 'left', padding: '8px 12px', borderRadius: 'var(--radius-lg)', background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}`, color: COLORS.textSecondary, fontSize: 12, cursor: 'pointer', transition: 'border-color 0.15s' }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = HEX_COLORS.accent }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = COLORS.cardBorder }}>
                  示例 {i + 1}：{s}
                </button>
              ))}
            </div>
          </div>

          {/* 协作对象推荐 */}
          <div style={{ padding: 14, borderRadius: 'var(--radius-xl)', background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}` }}>
            {sectionTitle(<Users size={13} style={{ color: COLORS.success }} />, '协作对象推荐')}
            {agent.collaboration && (
              <div style={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6, marginBottom: 8 }}>
                <span style={{ color: COLORS.accent }}>协作协议：</span>{agent.collaboration}
              </div>
            )}
            {collabAgents.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {collabAgents.map((c) => (
                  <div key={c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 999, background: 'rgba(255,255,255,0.04)', border: `1px solid ${COLORS.cardBorder}` }}>
                    <span style={{ fontSize: 13 }}>{c.icon || '🤖'}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }}>{c.name}</span>
                    <span style={{ fontSize: 11, color: COLORS.textMuted }}>{c.role}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: COLORS.textMuted }}>暂无高相似搭档，可在「团队模板 / 手动组队」中自由搭配。</div>
            )}
          </div>

          {/* 就地对话测试 */}
          <div style={{ padding: 14, borderRadius: 'var(--radius-xl)', background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}` }}>
            {sectionTitle(<Send size={13} style={{ color: COLORS.success }} />, '能力实测（本地 9B 推理）')}
            <div style={{ display: 'flex', gap: 8 }}>
              <textarea
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                placeholder="输入一句测试指令，看它是否真的像这个角色…"
                rows={2}
                style={{ flex: 1, padding: '8px 12px', borderRadius: 'var(--radius-lg)', background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}`, color: COLORS.textPrimary, fontSize: 12, outline: 'none', resize: 'none', fontFamily: 'inherit' }}
              />
              <button onClick={handleTest} disabled={running || !testInput.trim()}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 18px', borderRadius: 'var(--radius-lg)', background: COLORS.accent, border: 'none', color: '#fff', fontSize: 12, fontWeight: 600, cursor: running ? 'not-allowed' : 'pointer', opacity: running ? 0.6 : 1, alignSelf: 'stretch' }}>
                {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                {running ? '推理中' : '实测'}
              </button>
            </div>
            {testErr && <div style={{ marginTop: 8, fontSize: 12, color: COLORS.danger }}>{testErr}</div>}
            {output && (
              <div style={{ marginTop: 10, padding: '10px 14px', borderRadius: 'var(--radius-lg)', background: 'rgba(0,0,0,0.25)', border: `1px solid ${COLORS.cardBorder}`, color: COLORS.textSecondary, fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto', fontFamily: 'inherit' }}>
                {output}
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
