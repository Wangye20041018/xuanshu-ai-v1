import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Cpu, Brain, Code2, FileText, Zap, GitBranch, Sparkles, Timer,
  Gauge, Layers, RefreshCw, Trash2, ChevronDown, ChevronUp, CheckCircle2,
  XCircle, Play, Info, Target, Route as RouteIcon, MessageSquare,
} from 'lucide-react'
import { HEX_COLORS, COLORS, containerVariants, itemVariants } from '../../shared/theme'
import { logger } from '../../../shared/logger'
import ErrorBoundary from '../../components/ErrorBoundary'
import { EmptyState } from '../../components/EmptyState'
import { showToast } from '../../components/Toast'
import { GlassCard } from '../Settings'

/* ==================== Types (与主进程 scheduler/types 对齐) ==================== */
type SchedulerTaskType = 'chat' | 'deep' | 'code' | 'longctx' | 'quick'

const TASK_META: Record<SchedulerTaskType, { label: string; icon: React.ReactNode; color: string }> = {
  chat: { label: '日常对话', icon: <MessageIcon />, color: COLORS.cyan },
  deep: { label: '深度推理', icon: <Brain size={14} />, color: COLORS.violet },
  code: { label: '代码编程', icon: <Code2 size={14} />, color: HEX_COLORS.blue },
  longctx: { label: '长上下文', icon: <FileText size={14} />, color: COLORS.warning },
  quick: { label: '快捷问答', icon: <Zap size={14} />, color: COLORS.success },
}

function MessageIcon() {
  return <MessageSquare size={13} />
}

interface TaskClassifyResult {
  taskType: SchedulerTaskType
  confidence: number
  evidence: string[]
  locked: boolean
}

interface ScheduleDecision {
  taskType: SchedulerTaskType
  classify: TaskClassifyResult
  modelId: string
  modelName: string
  reason: string
  candidates: string[]
  targetDevice: 'gpu' | 'cpu'
  gpuLayers: number
  contextSize: number
  ts: number
}

interface ModelProfile {
  id: string
  name: string
  speed: number
  quality: number
  contextCap: number
  role: string
  enabled: boolean
  priority: number
  suitedFor: SchedulerTaskType[]
  fallback?: string
}

interface ScheduleRecord {
  id: string
  ts: number
  request: string
  taskType: SchedulerTaskType
  classifyConfidence: number
  evidence: string[]
  modelId: string
  modelName: string
  reason: string
  device: 'gpu' | 'cpu'
  gpuLayers: number
  elapsedMs: number
  tokensPerSec: number
  status: 'success' | 'fallback' | 'failed'
  fallbackChain: string[]
  contentPreview?: string
}

interface SchedulerConfig {
  enabled: boolean
  historyLimit: number
  version: number
}

interface TandemState {
  modelId: string
  port: number
  status: 'stopped' | 'starting' | 'running' | 'error'
  mode?: 'gpu' | 'cpu'
  gpuLayers?: number
  errorMessage?: string
}

/* ==================== 子组件：运行位置徽章 ==================== */
function DeviceBadge({ device, gpuLayers }: { device: 'gpu' | 'cpu'; gpuLayers?: number }) {
  const isGpu = device === 'gpu'
  const color = isGpu ? COLORS.success : COLORS.warning
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '4px 12px', borderRadius: 9999, fontSize: 11, fontWeight: 600,
      background: isGpu ? `${HEX_COLORS.success}18` : `${HEX_COLORS.warning}18`,
      color, border: `1px solid ${color}35`,
    }}>
      {isGpu ? <Zap size={11} /> : <Cpu size={11} />}
      {isGpu ? 'GPU' : 'CPU'}
      {gpuLayers ? ` · ${gpuLayers} 层` : ''}
    </span>
  )
}

function StatusBadge({ status }: { status: ScheduleRecord['status'] }) {
  const map = {
    success: { label: '成功', color: COLORS.success, icon: <CheckCircle2 size={11} /> },
    fallback: { label: '回退', color: COLORS.warning, icon: <GitBranch size={11} /> },
    failed: { label: '失败', color: COLORS.danger, icon: <XCircle size={11} /> },
  }
  const c = map[status]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 10px', borderRadius: 9999, fontSize: 10, fontWeight: 600,
      background: `${c.color}15`, color: c.color,
    }}>
      {c.icon} {c.label}
    </span>
  )
}

function Metric({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6, padding: '16px 18px',
      borderRadius: 'var(--radius-2xl)', background: `${HEX_COLORS.cardBg}66`,
      border: `1px solid ${COLORS.cardBorder}`, minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: COLORS.textMuted }}>
        {icon} {label}
      </div>
      <div style={{ fontSize: '1.25rem', fontWeight: 700, color: COLORS.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {value}
      </div>
      {sub ? <div style={{ fontSize: 11, color: COLORS.textSecondary }}>{sub}</div> : null}
    </div>
  )
}

/* ==================== 主页面 ==================== */
function SchedulerPage() {
  const [config, setConfig] = useState<SchedulerConfig>({ enabled: true, historyLimit: 50, version: 1 })
  const [profiles, setProfiles] = useState<ModelProfile[]>([])
  const [history, setHistory] = useState<ScheduleRecord[]>([])
  const [tandemStates, setTandemStates] = useState<TandemState[]>([])

  // 测试区
  const [testText, setTestText] = useState('')
  const [classifyResult, setClassifyResult] = useState<TaskClassifyResult | null>(null)
  const [decision, setDecision] = useState<ScheduleDecision | null>(null)
  const [running, setRunning] = useState(false)
  const [runOutput, setRunOutput] = useState<string>('')
  const [runMetrics, setRunMetrics] = useState<{ elapsedMs: number; tokensPerSec: number } | null>(null)
  const [expandedRecord, setExpandedRecord] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    if (!window.api) return
    const res = await window.api.invokeSafe<{ config: SchedulerConfig; history: ScheduleRecord[]; profiles: ModelProfile[] }>('scheduler:get-status')
    if (res.ok && res.data) {
      setConfig(res.data.config)
      setHistory(res.data.history)
      setProfiles(res.data.profiles)
    }
    const t = await window.api.invokeSafe<TandemState[]>('tandem:status')
    if (t.ok && t.data) setTandemStates(t.data)
  }, [])

  useEffect(() => { loadStatus() }, [loadStatus])

  useEffect(() => {
    if (!window.api) return
    const offUpdate = window.api.on('scheduler:update', (_e: unknown, ...args: unknown[]) => {
      const payload = args[0] as { type: string; payload: unknown }
      if (!payload) return
      if (payload.type === 'history') setHistory(payload.payload as ScheduleRecord[])
      if (payload.type === 'config') setConfig(payload.payload as SchedulerConfig)
      if (payload.type === 'decision') setDecision(payload.payload as ScheduleDecision)
    })
    const offTandem = window.api.on('tandem:status-change', (_e: unknown, ...args: unknown[]) => {
      setTandemStates((args[0] as TandemState[]) || [])
    })
    return () => { offUpdate(); offTandem() }
  }, [])

  /* ---- 任务识别 ---- */
  const handleClassify = useCallback(async () => {
    if (!testText.trim()) { showToast('warning', '请输入要识别的请求文本'); return }
    const res = await window.api.invokeSafe<TaskClassifyResult>('scheduler:classify', testText)
    if (res.ok && res.data) {
      setClassifyResult(res.data)
      setDecision(null)
    } else {
      showToast('error', res.error || '识别失败')
    }
  }, [testText])

  /* ---- 调度决策（不执行）---- */
  const handleDecide = useCallback(async () => {
    if (!testText.trim()) { showToast('warning', '请输入要识别的请求文本'); return }
    const res = await window.api.invokeSafe<ScheduleDecision>('scheduler:decide', testText)
    if (res.ok && res.data) {
      setDecision(res.data)
      setClassifyResult(res.data.classify)
      setRunOutput('')
    } else {
      showToast('error', res.error || '决策失败')
    }
  }, [testText])

  /* ---- 完整调度运行 ---- */
  const handleRun = useCallback(async () => {
    if (!testText.trim()) { showToast('warning', '请输入要调度的请求文本'); return }
    if (running) return
    setRunning(true)
    setRunOutput('')
    setRunMetrics(null)
    try {
      const res = await window.api.invokeSafe<{
        success: boolean; content: string; elapsedMs: number; tokensPerSec: number;
        decision: ScheduleDecision; fallbackChain: string[]; error?: string
      }>('scheduler:run', testText)
      if (res.ok && res.data) {
        setRunOutput(res.data.success ? res.data.content : `调度失败：${res.data.error || ''}`)
        setRunMetrics({ elapsedMs: res.data.elapsedMs, tokensPerSec: res.data.tokensPerSec })
        if (res.data.decision) {
          setDecision(res.data.decision)
          setClassifyResult(res.data.decision.classify)
        }
        showToast(res.data.success ? 'success' : 'error', res.data.success ? '调度完成' : '调度失败，已记录')
      } else {
        showToast('error', res.error || '调度失败')
      }
    } catch (e) {
      logger.error('[Scheduler] run 异常:', e)
      showToast('error', '调度执行异常')
    } finally {
      setRunning(false)
    }
  }, [testText, running])

  /* ---- 画像配置 ---- */
  const toggleProfile = useCallback(async (id: string, enabled: boolean) => {
    const res = await window.api.invokeSafe<ModelProfile>('scheduler:update-profile', id, { enabled })
    if (res.ok) {
      setProfiles(prev => prev.map(p => p.id === id ? { ...p, enabled } : p))
      showToast('success', res.data?.name ? `${res.data.name} ${enabled ? '已启用' : '已禁用'}` : '已更新')
    } else {
      showToast('error', res.error || '更新失败')
    }
  }, [])

  const setPriority = useCallback(async (id: string, priority: number) => {
    const res = await window.api.invokeSafe<ModelProfile>('scheduler:update-profile', id, { priority })
    if (res.ok) {
      setProfiles(prev => prev.map(p => p.id === id ? { ...p, priority } : p))
      showToast('success', '优先级已更新')
    } else {
      showToast('error', res.error || '更新失败')
    }
  }, [])

  const resetProfiles = useCallback(async () => {
    const res = await window.api.invokeSafe<ModelProfile[]>('scheduler:reset-profiles')
    if (res.ok && res.data) {
      setProfiles(res.data)
      showToast('success', '画像已重置为默认')
    }
  }, [])

  const toggleScheduler = useCallback(async (enabled: boolean) => {
    const res = await window.api.invokeSafe<SchedulerConfig>('scheduler:set-config', { enabled })
    if (res.ok && res.data) {
      setConfig(res.data)
      showToast('success', enabled ? '智能调度已开启' : '智能调度已关闭（走默认主模型）')
    }
  }, [])

  const clearHistory = useCallback(async () => {
    await window.api.invokeSafe('scheduler:clear-history')
    setHistory([])
    showToast('success', '调度记录已清空')
  }, [])

  const runningModels = tandemStates.filter(s => s.status === 'running' || s.status === 'starting')
  const activeProfileIds = new Set(profiles.filter(p => p.enabled).map(p => p.id))
  const currentModel = runningModels[0]

  return (
    <ErrorBoundary>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: COLORS.bg, padding: '20px', minHeight: 0, overflow: 'auto' }}>
        <motion.div variants={containerVariants} initial="hidden" animate="visible" style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: 1280, margin: '0 auto', width: '100%' }}>

          {/* Header */}
          <motion.div variants={itemVariants} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <h2 style={{ fontSize: '1.4rem', fontWeight: 600, color: COLORS.textPrimary, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Cpu size={22} style={{ color: COLORS.accent }} /> 智能模型调度
              </h2>
              <p style={{ fontSize: '0.85rem', color: COLORS.textMuted, margin: '4px 0 0' }}>
                按任务类型自动挑选最优模型 · 自动分层优先 GPU · 失败自动回退
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 12, color: COLORS.textSecondary }}>智能调度</span>
              <motion.button
                whileTap={{ scale: 0.92 }}
                onClick={() => toggleScheduler(!config.enabled)}
                style={{
                  width: 44, height: 24, borderRadius: 9999, border: 'none', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', padding: 2,
                  background: config.enabled ? COLORS.success : 'rgba(255,255,255,0.12)',
                  justifyContent: config.enabled ? 'flex-end' : 'flex-start',
                  transition: 'all 0.25s',
                  boxShadow: config.enabled ? `0 0 14px ${HEX_COLORS.success}40` : 'none',
                }}
                aria-label="toggle scheduler"
              >
                <span style={{ width: 20, height: 20, borderRadius: 9999, background: '#fff' }} />
              </motion.button>
            </div>
          </motion.div>

          {/* 实时状态概览 */}
          <motion.div variants={itemVariants} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
            <Metric
              icon={<Zap size={12} />} label="当前运行位置"
              value={currentModel
                ? (currentModel.mode === 'gpu' ? `GPU · ${currentModel.gpuLayers ?? 0} 层` : 'CPU')
                : '无模型在跑'}
              sub={currentModel ? currentModel.modelId : '空闲'}
            />
            <Metric icon={<Brain size={12} />} label="调度启用模型" value={`${activeProfileIds.size} 个`} sub={[...activeProfileIds].join(' / ') || '无'} />
            <Metric icon={<Target size={12} />} label="任务识别" value={classifyResult ? TASK_META[classifyResult.taskType].label : '未识别'} sub={classifyResult ? `置信度 ${Math.round(classifyResult.confidence * 100)}%` : '输入文本后识别'} />
            <Metric icon={<Gauge size={12} />} label="调度记录" value={`${history.length} 条`} sub={`保留上限 ${config.historyLimit}`} />
          </motion.div>

          {/* 调度测试区 */}
          <GlassCard title="调度测试台" icon={<Play size={16} />} accentColor={COLORS.accent} headerRight={
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleClassify} style={btnStyle(false)}>识别</button>
              <button onClick={handleDecide} style={btnStyle(false)}>决策预览</button>
              <button onClick={handleRun} disabled={running} style={btnStyle(true)}>
                {running ? <RefreshCw size={13} className="spin" /> : <Play size={13} />} {running ? '调度中...' : '完整调度'}
              </button>
            </div>
          }>
            <textarea
              value={testText}
              onChange={e => setTestText(e.target.value)}
              placeholder="输入一段用户请求，测试任务识别与模型调度，例如：请帮我写一个 Python 快速排序函数；或：为什么地球是圆的？；或：把这份合同的关键条款总结出来..."
              rows={3}
              style={{
                width: '100%', resize: 'vertical', padding: '14px 16px', borderRadius: 'var(--radius-xl)',
                background: COLORS.bg, color: COLORS.textPrimary, border: `1px solid ${COLORS.cardBorder}`,
                fontFamily: 'inherit', fontSize: 13, outline: 'none', boxSizing: 'border-box',
              }}
            />

            {/* 识别结果 */}
            {classifyResult && (
              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: COLORS.textMuted }}>任务判定：</span>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 14px', borderRadius: 9999,
                    fontSize: 12, fontWeight: 700, background: `${TASK_META[classifyResult.taskType].color}18`,
                    color: TASK_META[classifyResult.taskType].color, border: `1px solid ${TASK_META[classifyResult.taskType].color}35`,
                  }}>
                    {TASK_META[classifyResult.taskType].icon} {TASK_META[classifyResult.taskType].label}
                  </span>
                  <span style={{ fontSize: 11, color: COLORS.textSecondary }}>置信度 {Math.round(classifyResult.confidence * 100)}%</span>
                  {classifyResult.locked && (
                    <span style={{ fontSize: 10, color: COLORS.danger, fontWeight: 600 }}>· 结构强锁定</span>
                  )}
                  <div style={{ flex: 1 }} />
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {(Object.keys(TASK_META) as SchedulerTaskType[]).map(t => (
                      <span key={t} style={{
                        width: 8, height: 8, borderRadius: 9999,
                        background: t === classifyResult.taskType ? TASK_META[t].color : 'rgba(255,255,255,0.12)',
                        boxShadow: t === classifyResult.taskType ? `0 0 8px ${TASK_META[t].color}80` : 'none',
                      }} />
                    ))}
                  </div>
                </div>

                {/* 证据链（透明可见） */}
                {classifyResult.evidence.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 16px', borderRadius: 'var(--radius-xl)', background: `${HEX_COLORS.accentDim}`, border: `1px solid ${COLORS.cardBorder}` }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: COLORS.textSecondary, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Info size={12} /> 为什么这么判定
                    </div>
                    {classifyResult.evidence.map((ev, i) => (
                      <div key={i} style={{ fontSize: 12, color: COLORS.textPrimary, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ color: COLORS.textMuted }}>{i + 1}.</span> {ev}
                      </div>
                    ))}
                  </div>
                )}

                {/* 决策预览 */}
                {decision && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 16px', borderRadius: 'var(--radius-xl)', background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}` }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: COLORS.textSecondary, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <RouteIcon size={12} /> 调度决策
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, color: COLORS.textMuted }}>选中模型：</span>
                      <span style={{ fontSize: 14, fontWeight: 700, color: COLORS.textPrimary }}>{decision.modelName}</span>
                      <DeviceBadge device={decision.targetDevice} gpuLayers={decision.gpuLayers} />
                      <span style={{ fontSize: 11, color: COLORS.textSecondary }}>ctx {decision.contextSize}</span>
                    </div>
                    <div style={{ fontSize: 12, color: COLORS.textSecondary }}>{decision.reason}</div>
                    {decision.candidates.length > 1 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 11, color: COLORS.textMuted }}>
                        <GitBranch size={11} /> 候选链：
                        {decision.candidates.map((c, i) => (
                          <span key={c} style={{
                            padding: '2px 8px', borderRadius: 8, background: i === 0 ? `${HEX_COLORS.accent}20` : 'rgba(255,255,255,0.06)',
                            color: i === 0 ? COLORS.textPrimary : COLORS.textSecondary, fontWeight: i === 0 ? 600 : 400,
                          }}>
                            {i === 0 ? '★ ' : ''}{c}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* 运行结果 */}
                {runOutput && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 16px', borderRadius: 'var(--radius-xl)', background: `${HEX_COLORS.successDim}`, border: `1px solid ${COLORS.success}35` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: COLORS.success, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <CheckCircle2 size={12} /> 调度结果
                      </span>
                      {runMetrics && (
                        <>
                          <span style={{ fontSize: 11, color: COLORS.textSecondary }}>耗时 {(runMetrics.elapsedMs / 1000).toFixed(1)}s</span>
                          <span style={{ fontSize: 11, color: COLORS.textSecondary }}>速度 {runMetrics.tokensPerSec.toFixed(1)} tok/s</span>
                        </>
                      )}
                    </div>
                    <pre style={{
                      margin: 0, fontSize: 12.5, color: COLORS.textPrimary, lineHeight: 1.6, whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word', maxHeight: 260, overflow: 'auto', fontFamily: 'inherit',
                    }}>
                      {runOutput}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </GlassCard>

          {/* 模型画像配置 */}
          <GlassCard
            title="模型画像"
            icon={<Brain size={16} />}
            accentColor={COLORS.violet}
            headerRight={
              <button onClick={resetProfiles} style={ghostBtnStyle()}><RefreshCw size={12} /> 重置默认</button>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {profiles.length === 0 ? (
                <EmptyState title="暂无模型画像" description="模型注册后自动生成画像" />
              ) : (
                profiles.map(p => {
                  const color = p.id.includes('18b') ? COLORS.violet : COLORS.accent
                  return (
                    <div key={p.id} style={{
                      display: 'flex', alignItems: 'center', gap: 16, padding: '16px 18px',
                      borderRadius: 'var(--radius-2xl)', background: COLORS.bg, border: `1px solid ${COLORS.cardBorder}`,
                      opacity: p.enabled ? 1 : 0.55,
                    }}>
                      <div style={{
                        width: 40, height: 40, borderRadius: 12, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: `${color}20`, color, border: `1px solid ${color}30`,
                      }}>
                        {p.id.includes('18b') ? <Sparkles size={18} /> : <Zap size={18} />}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: COLORS.textPrimary }}>{p.name}</span>
                          <span style={{ fontSize: 11, color: COLORS.textMuted }}>{p.role}</span>
                        </div>
                        {/* 速度/质量条 */}
                        <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: COLORS.textSecondary }}>
                            速度
                            <div style={{ width: 70, height: 5, borderRadius: 4, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                              <div style={{ width: `${p.speed * 10}%`, height: '100%', borderRadius: 4, background: COLORS.cyan }} />
                            </div>
                            <span style={{ color: COLORS.textMuted }}>{p.speed}/10</span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: COLORS.textSecondary }}>
                            质量
                            <div style={{ width: 70, height: 5, borderRadius: 4, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                              <div style={{ width: `${p.quality * 10}%`, height: '100%', borderRadius: 4, background: COLORS.success }} />
                            </div>
                            <span style={{ color: COLORS.textMuted }}>{p.quality}/10</span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: COLORS.textSecondary }}>
                            <Layers size={11} /> ctx {p.contextCap.toLocaleString()}
                          </div>
                        </div>
                        {/* 适用任务 */}
                        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                          {p.suitedFor.map(t => (
                            <span key={t} style={{
                              display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 8,
                              fontSize: 10, fontWeight: 600, background: `${TASK_META[t].color}15`, color: TASK_META[t].color,
                            }}>
                              {TASK_META[t].icon} {TASK_META[t].label}
                            </span>
                          ))}
                          {p.fallback && (
                            <span style={{ fontSize: 10, color: COLORS.textMuted, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <GitBranch size={10} /> 回退: {p.fallback}
                            </span>
                          )}
                        </div>
                      </div>
                      {/* 优先级 */}
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                        <span style={{ fontSize: 10, color: COLORS.textMuted }}>优先级</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <button onClick={() => setPriority(p.id, Math.max(1, p.priority - 1))} style={miniBtn()}>−</button>
                          <span style={{ fontSize: 14, fontWeight: 700, color: COLORS.textPrimary, minWidth: 20, textAlign: 'center' }}>{p.priority}</span>
                          <button onClick={() => setPriority(p.id, Math.min(9, p.priority + 1))} style={miniBtn()}>+</button>
                        </div>
                      </div>
                      {/* 启用开关 */}
                      <motion.button
                        whileTap={{ scale: 0.92 }}
                        onClick={() => toggleProfile(p.id, !p.enabled)}
                        style={{
                          width: 40, height: 22, borderRadius: 9999, border: 'none', cursor: 'pointer', flexShrink: 0,
                          display: 'flex', alignItems: 'center', padding: 2,
                          background: p.enabled ? COLORS.success : 'rgba(255,255,255,0.12)',
                          justifyContent: p.enabled ? 'flex-end' : 'flex-start',
                          transition: 'all 0.25s',
                          boxShadow: p.enabled ? `0 0 12px ${HEX_COLORS.success}40` : 'none',
                        }}
                        aria-label={`toggle ${p.name}`}
                      >
                        <span style={{ width: 18, height: 18, borderRadius: 9999, background: '#fff' }} />
                      </motion.button>
                    </div>
                  )
                })
              )}
            </div>
          </GlassCard>

          {/* 调度记录 */}
          <GlassCard
            title="调度记录"
            icon={<Timer size={16} />}
            accentColor={COLORS.cyan}
            headerRight={
              <button onClick={clearHistory} style={ghostBtnStyle()}><Trash2 size={12} /> 清空</button>
            }
          >
            {history.length === 0 ? (
              <EmptyState title="暂无调度记录" description="执行完整调度后，这里会展示 决策 → 模型 → 原因 → 速度 的完整链路" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <AnimatePresence>
                  {history.map(rec => (
                    <motion.div
                      key={rec.id}
                      initial={{ opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      style={{
                        borderRadius: 'var(--radius-xl)', background: COLORS.bg, border: `1px solid ${COLORS.cardBorder}`,
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        onClick={() => setExpandedRecord(expandedRecord === rec.id ? null : rec.id)}
                        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer' }}
                      >
                        <StatusBadge status={rec.status} />
                        <span style={{ fontSize: 12, color: COLORS.textMuted, flexShrink: 0, width: 84 }}>{new Date(rec.ts).toLocaleTimeString()}</span>
                        <span style={{ fontSize: 12.5, color: COLORS.textPrimary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {rec.request}
                        </span>
                        <span style={{ fontSize: 11, color: TASK_META[rec.taskType].color, flexShrink: 0 }}>{TASK_META[rec.taskType].label}</span>
                        <DeviceBadge device={rec.device} gpuLayers={rec.gpuLayers} />
                        <span style={{ fontSize: 11, color: COLORS.textSecondary, flexShrink: 0 }}>{(rec.elapsedMs / 1000).toFixed(1)}s</span>
                        {rec.tokensPerSec > 0 && <span style={{ fontSize: 11, color: COLORS.textSecondary, flexShrink: 0 }}>{rec.tokensPerSec.toFixed(1)} t/s</span>}
                        {expandedRecord === rec.id ? <ChevronUp size={14} style={{ color: COLORS.textMuted }} /> : <ChevronDown size={14} style={{ color: COLORS.textMuted }} />}
                      </div>
                      {expandedRecord === rec.id && (
                        <div style={{ padding: '0 16px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <div style={{ fontSize: 12, color: COLORS.textSecondary, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                            <span style={{ color: COLORS.textMuted }}>模型：</span><span style={{ color: COLORS.textPrimary, fontWeight: 600 }}>{rec.modelName}</span>
                            <span style={{ color: COLORS.textMuted }}>置信度：</span>{Math.round(rec.classifyConfidence * 100)}%
                          </div>
                          <div style={{ fontSize: 12, color: COLORS.textSecondary }}>决策原因：{rec.reason}</div>
                          {rec.evidence.length > 0 && (
                            <div style={{ fontSize: 11.5, color: COLORS.textMuted }}>识别证据：{rec.evidence.join('；')}</div>
                          )}
                          {rec.fallbackChain.length > 1 && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: COLORS.textMuted }}>
                              <GitBranch size={11} /> 回退链：{rec.fallbackChain.join(' → ')}
                            </div>
                          )}
                          {rec.contentPreview && (
                            <div style={{ fontSize: 12, color: COLORS.textSecondary, background: `${HEX_COLORS.accentDim}`, padding: '10px 12px', borderRadius: 10, lineHeight: 1.5 }}>
                              {rec.contentPreview}...
                            </div>
                          )}
                        </div>
                      )}
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            )}
          </GlassCard>

        </motion.div>
      </div>
    </ErrorBoundary>
  )
}

/* ==================== 样式辅助 ==================== */
function btnStyle(primary: boolean) {
  return {
    display: 'flex', alignItems: 'center', gap: 6, padding: primary ? '8px 18px' : '8px 14px',
    borderRadius: 9999, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
    background: primary ? COLORS.accent : 'rgba(255,255,255,0.06)',
    border: primary ? 'none' : `1px solid ${COLORS.cardBorder}`,
    color: primary ? '#fff' : COLORS.textSecondary,
    opacity: primary ? 1 : 1,
  } as React.CSSProperties
}

function ghostBtnStyle() {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 9999,
    background: 'rgba(255,255,255,0.06)', border: `1px solid ${COLORS.cardBorder}`,
    color: COLORS.textSecondary, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
  } as React.CSSProperties
}

function miniBtn() {
  return {
    width: 22, height: 22, borderRadius: 7, border: `1px solid ${COLORS.cardBorder}`,
    background: 'rgba(255,255,255,0.05)', color: COLORS.textSecondary, fontSize: 13,
    cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1,
  } as React.CSSProperties
}

export default SchedulerPage
