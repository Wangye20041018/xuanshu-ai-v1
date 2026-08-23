/**
 * TandemPanel — 多模型联动面板 v1.0
 *
 * 功能：
 * - 模型配对配置（选择两个模型 + 端口）
 * - 四种联动模式：双答案 / 搭档 / 师徒 / 辩论
 * - 服务器启停管理
 * - 实时状态展示
 */

import { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import {
  Cpu, Zap, Play, Square, AlertTriangle,
  Server, ArrowRightLeft, Users, MessageSquare, Swords, GraduationCap, Loader
} from 'lucide-react'
import { HEX_COLORS, COLORS, itemVariants } from '../shared/theme'

/* ============================================================
 * 类型
 * ============================================================ */

interface TandemModelEntry {
  id: string
  name: string
  modelPath: string
  port: number
  gpuLayers: number
  contextSize: number
  mode: 'gpu' | 'cpu'
  temperature: number
  maxTokens: number
}

interface TandemConfig {
  models: TandemModelEntry[]
  hardwareLimit: { maxVRAM_MB: number; maxThreads: number }
  defaultMode: TandemMode
}

interface ServerState {
  modelId: string
  port: number
  status: 'stopped' | 'starting' | 'running' | 'error'
  startedAt: number
  errorMessage?: string
}

interface DualResult {
  modelId: string
  modelName: string
  content: string
  elapsedMs: number
  tokensPerSec: number
}

interface DebateRound {
  index: number
  sideA: { modelName: string; content: string; elapsedMs: number; tokensPerSec: number }
  sideB: { modelName: string; content: string; elapsedMs: number; tokensPerSec: number }
}

interface MentorResult {
  draft: DualResult
  verified: DualResult
  finalContent: string
}

interface DebateResult {
  question: string
  rounds: DebateRound[]
  history: string[]
}

interface ModelOption {
  id: string
  name: string
  path?: string
  isDefault?: boolean
}

type TandemMode = 'dual' | 'partner' | 'mentor' | 'debate'

/* ============================================================
 * 模式元数据
 * ============================================================ */

const MODE_META: Record<TandemMode, { label: string; desc: string; icon: typeof Cpu; color: string }> = {
  dual:     { label: '双答案',  desc: '两个模型独立回答，并排展示对比', icon: ArrowRightLeft, color: '#6366f1' },
  partner:  { label: '搭档',   desc: '任务按专长拆分，A B 分工协同完成', icon: Users,          color: '#8b5cf6' },
  mentor:   { label: '师徒',   desc: '小模型快速草稿 → 大模型校验修正', icon: GraduationCap,  color: '#f59e0b' },
  debate:   { label: '辩论',   desc: '两个模型互相辩论，用户做裁判',   icon: Swords,         color: '#ef4444' },
}

const PARTNER_STRATEGIES = [
  { value: 'expertise', label: '按专长（代码/分析）' },
  { value: 'content',   label: '按内容（前后段拆分）' },
  { value: 'dimension', label: '按维度（中英文）' },
]

/* ============================================================
 * TandemPanel 主组件
 * ============================================================ */

export default function TandemPanel() {
  const [models, setModels] = useState<ModelOption[]>([])
  const [servers, setServers] = useState<ServerState[]>([])

  // 模型选择
  const [modelAId, setModelAId] = useState('')
  const [modelBId, setModelBId] = useState('')
  const [mode, setMode] = useState<TandemMode>('dual')
  const [strategy, setStrategy] = useState<string>('expertise')

  // UI 状态
  const [loading, setLoading] = useState(false)
  const [prompt, setPrompt] = useState('')
  // 结果状态
  const [dualResults, setDualResults] = useState<DualResult[] | null>(null)
  const [mentorResult, setMentorResult] = useState<MentorResult | null>(null)
  const [debateResult, setDebateResult] = useState<DebateResult | null>(null)
  const [error, setError] = useState('')

  /* ---------- 数据加载 ---------- */
  const loadModels = useCallback(async () => {
    try {
      if (window.api) {
        // 从注册表加载持久化模型
        const registryModels = await window.api.invoke('model-registry:list') as any[]
        if (registryModels && registryModels.length > 0) {
          setModels(registryModels.map((m: any) => ({
            id: m.id,
            name: m.name,
            path: m.modelPath,
            isDefault: m.isDefault,
          })))
          return
        }
        // 降级：从 model-manager 加载
        const result = await window.api.invoke('model:list') as any
        if (result?.models) {
          setModels(result.models.map((m: any) => ({
            id: m.id,
            name: m.name,
            path: m.path || m.filePath || '',
          })))
        }
      }
    } catch { /* ignore */ }
  }, [])

  const loadServerStatus = useCallback(async () => {
    try {
      if (window.api) {
        const s = await window.api.invoke('tandem:status') as ServerState[]
        if (s) setServers(s)
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    loadModels()
    loadServerStatus()
  }, [loadModels, loadServerStatus])

  // 模型列表加载完成后，自动选择默认模型配对
  useEffect(() => {
    if (models.length >= 2 && !modelAId && !modelBId) {
      const defaultModel = models.find(m => m.isDefault)
      if (defaultModel) {
        setModelAId(defaultModel.id)
        const other = models.find(m => m.id !== defaultModel.id)
        if (other) setModelBId(other.id)
      } else {
        setModelAId(models[0].id)
        setModelBId(models[1].id)
      }
    }
  }, [models])

  /* ---------- 操作 ---------- */
  const saveAndStart = async () => {
    if (!modelAId || !modelBId) {
      setError('请选择两个模型')
      return
    }
    setLoading(true)
    setError('')

    try {
      const modelA = models.find(m => m.id === modelAId)
      const modelB = models.find(m => m.id === modelBId)
      if (!modelA || !modelB) {
        setError('模型信息不完整')
        setLoading(false)
        return
      }

      // 构建配置
      const cfg: TandemConfig = {
        models: [
          {
            id: modelA.id,
            name: modelA.name,
            modelPath: modelA.path || '',
            port: 8080,
            gpuLayers: 28,
            contextSize: 4096,
            mode: 'gpu',
            temperature: 0.7,
            maxTokens: 2048,
          },
          {
            id: modelB.id,
            name: modelB.name,
            modelPath: modelB.path || '',
            port: 8081,
            gpuLayers: 0,
            contextSize: 2048,
            mode: 'cpu',
            temperature: 0.7,
            maxTokens: 2048,
          },
        ],
        hardwareLimit: { maxVRAM_MB: 5600, maxThreads: 8 },
        defaultMode: mode,
      }

      // 加载配置
      await window.api!.invoke('tandem:load-config', cfg)

      // 启动两个服务器（并行）
      const [rawA, rawB] = await Promise.all([
        window.api!.invoke('tandem:start-server', cfg.models[0]) as Promise<{ success: boolean; port: number; error?: string }>,
        window.api!.invoke('tandem:start-server', cfg.models[1]) as Promise<{ success: boolean; port: number; error?: string }>,
      ])

      const failed: string[] = []
      if (!rawA.success) failed.push(`${cfg.models[0].name}: ${rawA.error}`)
      if (!rawB.success) failed.push(`${cfg.models[1].name}: ${rawB.error}`)

      if (failed.length > 0) {
        setError(`启动失败: ${failed.join('; ')}`)
      }

      await loadServerStatus()
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  const stopAll = async () => {
    setLoading(true)
    try {
      await window.api!.invoke('tandem:stop-all')
      await loadServerStatus()
      setDualResults(null)
      setMentorResult(null)
      setDebateResult(null)
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  const runDual = async () => {
    if (!prompt.trim()) { setError('请输入测试提示词'); return }
    setLoading(true)
    setError('')
    setDualResults(null)
    setMentorResult(null)
    setDebateResult(null)
    try {
      const r = await window.api!.invoke('tandem:dual-answer', prompt, modelAId, modelBId) as DualResult[]
      setDualResults(r)
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  const runPartner = async () => {
    if (!prompt.trim()) { setError('请输入测试提示词'); return }
    setLoading(true)
    setError('')
    setDualResults(null)
    setMentorResult(null)
    setDebateResult(null)
    try {
      const r = await window.api!.invoke('tandem:partner-answer', prompt, modelAId, modelBId, strategy) as DualResult[]
      setDualResults(r)
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  const runMentor = async () => {
    if (!prompt.trim()) { setError('请输入测试提示词'); return }
    setLoading(true)
    setError('')
    setDualResults(null)
    setMentorResult(null)
    setDebateResult(null)
    try {
      const r = await window.api!.invoke('tandem:mentor-answer', prompt, modelAId, modelBId) as MentorResult
      setMentorResult(r)
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  const runDebate = async () => {
    if (!prompt.trim()) { setError('请输入测试提示词'); return }
    setLoading(true)
    setError('')
    setDualResults(null)
    setMentorResult(null)
    setDebateResult(null)
    try {
      const r = await window.api!.invoke('tandem:debate-answer', prompt, modelAId, modelBId, 2) as DebateResult
      setDebateResult(r)
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  const runQuery = () => {
    if (mode === 'dual') runDual()
    else if (mode === 'partner') runPartner()
    else if (mode === 'mentor') runMentor()
    else if (mode === 'debate') runDebate()
  }

  /* ---------- 计算 ---------- */
  const allRunning = servers.length >= 2 && servers.every(s => s.status === 'running')

  return (
    <motion.div variants={itemVariants} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ===== 模式选择卡片 ===== */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8,
      }}>
        {(Object.entries(MODE_META) as [TandemMode, typeof MODE_META['dual']][]).map(([key, meta]) => {
          const Icon = meta.icon
          const active = mode === key
          return (
            <button key={key} onClick={() => setMode(key)} style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
              padding: '16px 12px', borderRadius: 14, cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 13, fontWeight: active ? 600 : 400,
              background: active ? `${meta.color}18` : COLORS.cardBg,
              border: active ? `1.5px solid ${meta.color}` : `1px solid ${COLORS.cardBorder}`,
              color: active ? meta.color : COLORS.textSecondary,
              transition: 'all 0.2s',
            }}>
              <Icon size={22} color={active ? meta.color : COLORS.textSecondary} />
              <span>{meta.label}</span>
              <span style={{ fontSize: 11, opacity: 0.7, textAlign: 'center', lineHeight: 1.3 }}>
                {meta.desc}
              </span>
            </button>
          )
        })}
      </div>

      {/* ===== 模型配对 ===== */}
      <div style={{
        background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
        borderRadius: 'var(--radius-2xl)', padding: '20px 24px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <Cpu size={16} color={COLORS.accent} />
          <h3 style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary, margin: 0 }}>
            模型配对
          </h3>
        </div>

        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* 模型 A */}
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={{ display: 'block', fontSize: 12, color: COLORS.textSecondary, marginBottom: 6 }}>
              GPU 模型（端口 8080, ngl=28）
            </label>
            <select value={modelAId} onChange={e => setModelAId(e.target.value)} style={{
              width: '100%', padding: '8px 12px', borderRadius: 10,
              background: 'rgba(255,255,255,0.05)', border: `1px solid ${COLORS.cardBorder}`,
              color: COLORS.textPrimary, fontFamily: 'inherit', fontSize: 13,
              cursor: 'pointer',
            }}>
              <option value="">选择模型...</option>
              {models.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>

          {/* 箭头 */}
          <ArrowRightLeft size={20} color={COLORS.textSecondary} style={{ marginTop: 20 }} />

          {/* 模型 B */}
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={{ display: 'block', fontSize: 12, color: COLORS.textSecondary, marginBottom: 6 }}>
              CPU 模型（端口 8081, ngl=0）
            </label>
            <select value={modelBId} onChange={e => setModelBId(e.target.value)} style={{
              width: '100%', padding: '8px 12px', borderRadius: 10,
              background: 'rgba(255,255,255,0.05)', border: `1px solid ${COLORS.cardBorder}`,
              color: COLORS.textPrimary, fontFamily: 'inherit', fontSize: 13,
              cursor: 'pointer',
            }}>
              <option value="">选择模型...</option>
              {models.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* 搭档模式专属：分工策略 */}
        {mode === 'partner' && (
          <div style={{ marginTop: 12 }}>
            <label style={{ display: 'block', fontSize: 12, color: COLORS.textSecondary, marginBottom: 6 }}>
              分工策略
            </label>
            <select value={strategy} onChange={e => setStrategy(e.target.value)} style={{
              padding: '8px 12px', borderRadius: 10,
              background: 'rgba(255,255,255,0.05)', border: `1px solid ${COLORS.cardBorder}`,
              color: COLORS.textPrimary, fontFamily: 'inherit', fontSize: 13,
              cursor: 'pointer',
            }}>
              {PARTNER_STRATEGIES.map(s => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
        )}

        {/* 操作按钮 */}
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button onClick={saveAndStart} disabled={loading} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 20px', borderRadius: 10, cursor: loading ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit', fontSize: 13, fontWeight: 500,
            background: COLORS.accent, border: 'none', color: '#1a1a1c',
            opacity: loading ? 0.6 : 1,
          }}>
            {loading ? <Loader size={14} className="animate-spin" /> : <Play size={14} />}
            启动联动
          </button>
          <button onClick={stopAll} disabled={loading} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 20px', borderRadius: 10, cursor: loading ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit', fontSize: 13, fontWeight: 500,
            background: 'rgba(255,255,255,0.05)', border: `1px solid ${COLORS.cardBorder}`,
            color: COLORS.textSecondary,
            opacity: loading ? 0.6 : 1,
          }}>
            <Square size={14} />
            停止全部
          </button>
        </div>
      </div>

      {/* ===== 服务器状态 ===== */}
      {servers.length > 0 && (
        <div style={{
          background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
          borderRadius: 'var(--radius-2xl)', padding: '16px 24px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Server size={16} color={allRunning ? '#22c55e' : COLORS.warning} />
            <h3 style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary, margin: 0 }}>
              服务器状态
            </h3>
            <span style={{
              fontSize: 11, padding: '2px 8px', borderRadius: 8,
              background: allRunning ? '#22c55e20' : `${HEX_COLORS.warning}20`,
              color: allRunning ? '#22c55e' : COLORS.warning,
            }}>
              {allRunning ? '全部运行中' : `${servers.filter(s => s.status === 'running').length}/${servers.length} 运行`}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {servers.map(s => {
              const model = models.find(m => m.id === s.modelId)
              return (
                <div key={s.modelId} style={{
                  flex: 1, minWidth: 200,
                  padding: 12, borderRadius: 12,
                  background: 'rgba(255,255,255,0.03)',
                  border: `1px solid ${s.status === 'running' ? '#22c55e40' : s.status === 'error' ? '#ef444440' : COLORS.cardBorder}`,
                }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: COLORS.textPrimary }}>
                    {model?.name || s.modelId}
                  </div>
                  <div style={{ fontSize: 11, color: COLORS.textSecondary, marginTop: 4 }}>
                    端口 {s.port} · {
                      s.status === 'running' ? '运行中' :
                      s.status === 'starting' ? '启动中...' :
                      s.status === 'error' ? `错误: ${s.errorMessage}` : '已停止'
                    }
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ===== 错误提示 ===== */}
      {error && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '12px 16px', borderRadius: 12,
          background: '#ef444410', border: '1px solid #ef444430',
          color: '#ef4444', fontSize: 13,
        }}>
          <AlertTriangle size={16} />
          {error}
        </div>
      )}

      {/* ===== 测试输入区 ===== */}
      {allRunning && (
        <div style={{
          background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
          borderRadius: 'var(--radius-2xl)', padding: '20px 24px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <MessageSquare size={16} color={COLORS.accent} />
            <h3 style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary, margin: 0 }}>
              测试 {MODE_META[mode].label} 模式
            </h3>
          </div>
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="输入测试提示词..." style={{
            width: '100%', minHeight: 80, padding: '12px 16px', borderRadius: 12,
            background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}`,
            color: COLORS.textPrimary, fontFamily: 'inherit', fontSize: 13,
            resize: 'vertical', outline: 'none',
          }} />
          <button onClick={runQuery} disabled={loading} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            marginTop: 12, padding: '8px 20px', borderRadius: 10,
            cursor: loading ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit', fontSize: 13, fontWeight: 500,
            background: COLORS.accent, border: 'none', color: '#1a1a1c',
            opacity: loading ? 0.6 : 1,
          }}>
            {loading ? <Loader size={14} className="animate-spin" /> : <Zap size={14} />}
            运行
          </button>
        </div>
      )}

      {/* ===== 结果展示 ----- */}
      {/* dual / partner */}
      {dualResults && dualResults.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
            {dualResults.map((r, i) => (
              <div key={i} style={{
                background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
                borderRadius: 'var(--radius-2xl)', padding: '16px 20px',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>{r.modelName}</div>
                  <div style={{ fontSize: 11, color: COLORS.textSecondary }}>
                    {r.elapsedMs > 0 ? `${(r.elapsedMs / 1000).toFixed(1)}s · ${r.tokensPerSec} t/s` : 'N/A'}
                  </div>
                </div>
                <div style={{ fontSize: 13, color: COLORS.textSecondary, lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 300, overflowY: 'auto' }}>
                  {r.content || '(无输出)'}
                </div>
              </div>
            ))}
          </div>
        )}

      {/* mentor */}
      {mentorResult && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {[mentorResult.draft, mentorResult.verified].map((r, i) => (
              <div key={i} style={{
                background: COLORS.cardBg, border: `1px solid ${i === 0 ? '#f59e0b30' : '#22c55e30'}`,
                borderRadius: 'var(--radius-2xl)', padding: '16px 20px',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{
                      fontSize: 10, padding: '2px 6px', borderRadius: 6,
                      background: i === 0 ? '#f59e0b20' : '#22c55e20',
                      color: i === 0 ? '#f59e0b' : '#22c55e',
                    }}>{i === 0 ? '学徒草稿' : '导师校验'}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>{r.modelName}</span>
                  </div>
                  <div style={{ fontSize: 11, color: COLORS.textSecondary }}>
                    {r.elapsedMs > 0 ? `${(r.elapsedMs / 1000).toFixed(1)}s · ${r.tokensPerSec} t/s` : 'N/A'}
                  </div>
                </div>
                <div style={{ fontSize: 13, color: COLORS.textSecondary, lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 300, overflowY: 'auto' }}>
                  {r.content || '(无输出)'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* debate */}
      {debateResult && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {debateResult.rounds.map((round) => (
            <div key={round.index} style={{
              background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
              borderRadius: 'var(--radius-2xl)', padding: '16px 20px',
            }}>
              <div style={{
                fontSize: 13, fontWeight: 700, color: COLORS.accent, marginBottom: 12,
                borderBottom: `1px solid ${COLORS.cardBorder}`, paddingBottom: 8,
              }}>
                第 {round.index} 轮辩论
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                {[
                  { side: round.sideA, label: '正方', color: '#6366f1' },
                  { side: round.sideB, label: '反方', color: '#ef4444' },
                ].map(({ side, label, color }, j) => (
                  <div key={j} style={{
                    padding: '12px 16px', borderRadius: 12,
                    background: `${color}08`, border: `1px solid ${color}20`,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 6, background: `${color}20`, color }}>
                          {label}
                        </span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }}>{side.modelName}</span>
                      </div>
                      <span style={{ fontSize: 10, color: COLORS.textSecondary }}>
                        {side.elapsedMs > 0 ? `${(side.elapsedMs / 1000).toFixed(1)}s` : ''}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto' }}>
                      {side.content || '(无输出)'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

    </motion.div>
  )
}
