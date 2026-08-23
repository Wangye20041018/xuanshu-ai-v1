import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, Loader2, Play, Trash2, Pause, CirclePlay, ListChecks, X, AlertCircle, CheckCircle2 } from 'lucide-react'
import { HEX_COLORS, COLORS, GlassCard, Toggle } from './index'

interface AutomationTask {
  id: string
  name: string
  cron: string
  description: string
  enabled: boolean
  runCount: number
  lastRun: string
  lastStatus: 'success' | 'failed'
  nextRun: string
  category?: string
  triggerType?: string
  triggerCondition?: string
  status?: string
  steps?: SequenceStep[]
}

interface SequenceStep {
  id: string
  action: 'open_app' | 'run_command' | 'send_message' | 'wait' | 'condition'
  params: string
  timeout: number
  retryCount?: number
  retryDelay?: number
  fallbackAction?: 'skip' | 'abort' | 'retry'
}

type TriggerKind = 'once' | 'daily' | 'weekly' | 'monthly' | 'cron'

const TRIGGER_LABEL: Record<TriggerKind, string> = {
  once: '一次性',
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  cron: '自定义 Cron',
}

function newStep(action: SequenceStep['action'] = 'send_message'): SequenceStep {
  return { id: `s${Date.now()}${Math.floor(Math.random() * 1000)}`, action, params: '', timeout: 15 }
}

function formatTrigger(cond?: string): string {
  if (!cond) return '--'
  const c = cond.trim()
  if (c.startsWith('at:')) return `一次性 · ${new Date(c.slice(3)).toLocaleString()}`
  if (c.startsWith('daily:')) return `每天 · ${c.slice(6)}`
  if (c.startsWith('weekly:')) {
    const m = c.match(/^weekly:(\d):(\d{1,2}:\d{2})$/)
    if (m) {
      const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
      return `${days[Number(m[1])]} · ${m[2]}`
    }
    return c
  }
  if (c.startsWith('monthly:')) {
    const m = c.match(/^monthly:(\d{1,2}):(\d{1,2}:\d{2})$/)
    if (m) return `每月${m[1]}日 · ${m[2]}`
    return c
  }
  return `Cron · ${c}`
}

const ACTION_LABEL: Record<SequenceStep['action'], string> = {
  open_app: '打开应用',
  run_command: '运行命令',
  send_message: '发送提醒',
  wait: '等待',
  condition: '条件检查',
}

export default function SettingsAutomation() {
  const [tasks, setTasks] = useState<AutomationTask[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [flash, setFlash] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 新建/编辑表单
  const [editing, setEditing] = useState<AutomationTask | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [triggerKind, setTriggerKind] = useState<TriggerKind>('daily')
  const [triggerOnce, setTriggerOnce] = useState('')
  const [triggerTime, setTriggerTime] = useState('09:00')
  const [triggerDow, setTriggerDow] = useState('1')
  const [triggerDom, setTriggerDom] = useState('1')
  const [triggerCron, setTriggerCron] = useState('0 9 * * *')
  const [steps, setSteps] = useState<SequenceStep[]>([])

  const load = async () => {
    setStatus('loading')
    setErrorMsg('')
    try {
      const list = await window.api.invoke<AutomationTask[]>('automation:list')
      setTasks(Array.isArray(list) ? list : [])
      setStatus('ready')
    } catch (e) {
      setStatus('error')
      setErrorMsg(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => { load() }, [])

  const showFlash = (type: 'success' | 'error', text: string) => {
    setFlash({ type, text })
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 2600)
  }

  const buildCondition = (): string => {
    switch (triggerKind) {
      case 'once': {
        const d = triggerOnce ? new Date(triggerOnce) : new Date(Date.now() + 60_000)
        return `at:${d.toISOString()}`
      }
      case 'daily': return `daily:${triggerTime}`
      case 'weekly': return `weekly:${Number(triggerDow)}:${triggerTime}`
      case 'monthly': return `monthly:${Number(triggerDom)}:${triggerTime}`
      case 'cron': return triggerCron.trim() || '0 9 * * *'
    }
  }

  const openNew = () => {
    setEditing(null)
    setFormName('')
    setFormDesc('')
    setTriggerKind('daily')
    setTriggerOnce('')
    setTriggerTime('09:00')
    setTriggerDow('1')
    setTriggerDom('1')
    setTriggerCron('0 9 * * *')
    setSteps([])
    setShowForm(true)
  }

  const openEdit = (t: AutomationTask) => {
    setEditing(t)
    setFormName(t.name)
    setFormDesc(t.description || '')
    const cond = t.triggerCondition ?? t.cron
    if (cond?.startsWith('at:')) { setTriggerKind('once'); setTriggerOnce(cond.slice(3)) }
    else if (cond?.startsWith('daily:')) { setTriggerKind('daily'); setTriggerTime(cond.slice(6)) }
    else if (cond?.startsWith('weekly:')) {
      const m = cond.match(/^weekly:(\d):(\d{1,2}:\d{2})$/)
      if (m) { setTriggerKind('weekly'); setTriggerDow(m[1]); setTriggerTime(m[2]) }
    } else if (cond?.startsWith('monthly:')) {
      const m = cond.match(/^monthly:(\d{1,2}):(\d{1,2}:\d{2})$/)
      if (m) { setTriggerKind('monthly'); setTriggerDom(m[1]); setTriggerTime(m[2]) }
    } else if (cond) { setTriggerKind('cron'); setTriggerCron(cond) }
    setSteps(t.steps && t.steps.length > 0 ? t.steps.map(s => ({ ...s })) : [])
    setShowForm(true)
  }

  const saveTask = async () => {
    if (!formName.trim()) { showFlash('error', '请填写任务名称'); return }
    if (steps.length > 0 && steps.some(s => s.action !== 'wait' && !s.params.trim())) {
      showFlash('error', '步骤参数不能为空'); return
    }
    const condition = buildCondition()
    const payload: AutomationTask = {
      id: editing?.id || `task-${Date.now()}`,
      name: formName.trim(),
      cron: condition,
      description: formDesc.trim(),
      enabled: editing ? editing.enabled : true,
      runCount: editing?.runCount || 0,
      lastRun: editing?.lastRun || '',
      lastStatus: editing?.lastStatus || 'success',
      nextRun: editing?.nextRun || '--',
      triggerType: triggerKind,
      triggerCondition: condition,
      status: editing?.status || 'running',
      steps: steps.length > 0 ? steps : undefined,
    }
    try {
      const ok = await window.api.invoke<boolean>('automation:save', payload)
      if (ok) {
        showFlash('success', editing ? '任务已更新' : '任务已创建')
        setShowForm(false)
        load()
      } else showFlash('error', '保存失败')
    } catch (e) { showFlash('error', `保存失败: ${e instanceof Error ? e.message : String(e)}`) }
  }

  const deleteTask = async (id: string) => {
    setBusyId(id)
    try {
      const ok = await window.api.invoke<boolean>('automation:delete', id)
      if (ok) { showFlash('success', '任务已删除'); load() }
      else showFlash('error', '删除失败')
    } catch { showFlash('error', '删除失败') } finally { setBusyId(null) }
  }

  const toggleTask = async (t: AutomationTask, enabled: boolean) => {
    setBusyId(t.id)
    try {
      const ok = await window.api.invoke<boolean>('automation:toggle', t.id, enabled)
      if (ok) { showFlash('success', enabled ? '任务已启用' : '任务已停用'); load() }
      else showFlash('error', '操作失败')
    } catch { showFlash('error', '操作失败') } finally { setBusyId(null) }
  }

  const executeNow = async (t: AutomationTask) => {
    setBusyId(t.id)
    try {
      const res = await window.api.invoke<{ success: boolean; error?: string }>('automation:execute', t.id)
      if (res?.success) showFlash('success', '执行完成')
      else showFlash('error', res?.error || '执行失败')
      load()
    } catch { showFlash('error', '执行异常') } finally { setBusyId(null) }
  }

  const actionBtnStyle: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '5px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(255,255,255,0.04)', color: COLORS.textSecondary,
    fontSize: 12, cursor: 'pointer', transition: 'all .15s',
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: 8,
    border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.04)',
    color: COLORS.textPrimary, fontSize: 13, outline: 'none',
  }

  const selectStyle: React.CSSProperties = {
    padding: '8px 10px', borderRadius: 8,
    border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.04)',
    color: COLORS.textPrimary, fontSize: 13, outline: 'none',
  }

  return (
    <GlassCard
      title="自动化任务"
      icon={<ListChecks size={18} />}
      accentColor={COLORS.success}
      headerRight={
        <button
          onClick={openNew}
          style={{ ...actionBtnStyle, color: COLORS.success, borderColor: `${HEX_COLORS.success}45` }}
        >
          <Plus size={14} /> 新建任务
        </button>
      }
    >
      {flash && (
        <motion.div
          initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12,
            padding: '8px 12px', borderRadius: 8, fontSize: 12,
            background: flash.type === 'success' ? `${HEX_COLORS.success}18` : 'rgba(239,68,68,0.15)',
            color: flash.type === 'success' ? COLORS.success : '#f87171',
          }}
        >
          {flash.type === 'success' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
          {flash.text}
        </motion.div>
      )}

      {status === 'loading' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: COLORS.textSecondary, fontSize: 13 }}>
          <Loader2 size={14} className="animate-spin" /> 加载中...
        </div>
      )}
      {status === 'error' && (
        <div style={{ color: '#f87171', fontSize: 13 }}>加载失败：{errorMsg}</div>
      )}

      {status === 'ready' && tasks.length === 0 && !showForm && (
        <div style={{ color: COLORS.textSecondary, fontSize: 13, padding: '8px 0' }}>
          暂无自动化任务。点击「新建任务」创建定时提醒或自动化操作。
        </div>
      )}

      <AnimatePresence initial={false}>
        {showForm && (
          <motion.div
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            style={{ overflow: 'hidden' }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary }}>
                  {editing ? '编辑任务' : '新建任务'}
                </div>
                <button onClick={() => setShowForm(false)} style={{ ...actionBtnStyle }}>
                  <X size={14} /> 取消
                </button>
              </div>

              <div>
                <div style={{ fontSize: 12, color: COLORS.textSecondary, marginBottom: 6 }}>任务名称</div>
                <input style={inputStyle} value={formName} onChange={e => setFormName(e.target.value)} placeholder="例如：每天早上提醒喝水" />
              </div>
              <div>
                <div style={{ fontSize: 12, color: COLORS.textSecondary, marginBottom: 6 }}>描述</div>
                <input style={inputStyle} value={formDesc} onChange={e => setFormDesc(e.target.value)} placeholder="任务说明（无步骤任务将作为提醒通知）" />
              </div>

              <div>
                <div style={{ fontSize: 12, color: COLORS.textSecondary, marginBottom: 6 }}>触发方式</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {(Object.keys(TRIGGER_LABEL) as TriggerKind[]).map(k => (
                    <button
                      key={k}
                      onClick={() => setTriggerKind(k)}
                      style={{
                        ...actionBtnStyle,
                        color: triggerKind === k ? COLORS.accent : COLORS.textSecondary,
                        borderColor: triggerKind === k ? `${HEX_COLORS.accent}55` : 'rgba(255,255,255,0.12)',
                        background: triggerKind === k ? `${HEX_COLORS.accent}12` : 'rgba(255,255,255,0.04)',
                      }}
                    >
                      {TRIGGER_LABEL[k]}
                    </button>
                  ))}
                </div>
                <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {triggerKind === 'once' && (
                    <input type="datetime-local" style={{ ...inputStyle, maxWidth: 260 }} value={triggerOnce} onChange={e => setTriggerOnce(e.target.value)} />
                  )}
                  {triggerKind === 'daily' && (
                    <input type="time" style={{ ...selectStyle }} value={triggerTime} onChange={e => setTriggerTime(e.target.value)} />
                  )}
                  {triggerKind === 'weekly' && (
                    <>
                      <select style={selectStyle} value={triggerDow} onChange={e => setTriggerDow(e.target.value)}>
                        {['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((d, i) => <option key={i} value={i}>{d}</option>)}
                      </select>
                      <input type="time" style={selectStyle} value={triggerTime} onChange={e => setTriggerTime(e.target.value)} />
                    </>
                  )}
                  {triggerKind === 'monthly' && (
                    <>
                      <input type="number" min={1} max={31} style={{ ...inputStyle, maxWidth: 90 }} value={triggerDom} onChange={e => setTriggerDom(e.target.value)} />
                      <span style={{ color: COLORS.textSecondary, fontSize: 12 }}>日</span>
                      <input type="time" style={selectStyle} value={triggerTime} onChange={e => setTriggerTime(e.target.value)} />
                    </>
                  )}
                  {triggerKind === 'cron' && (
                    <input style={{ ...inputStyle, maxWidth: 220 }} value={triggerCron} onChange={e => setTriggerCron(e.target.value)} placeholder="0 9 * * *" />
                  )}
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <div style={{ fontSize: 12, color: COLORS.textSecondary }}>执行步骤（留空则作为提醒通知）</div>
                  <button onClick={() => setSteps([...steps, newStep()])} style={{ ...actionBtnStyle, color: COLORS.accent }}>
                    <Plus size={13} /> 添加步骤
                  </button>
                </div>
                {steps.length === 0 && (
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', padding: '6px 0' }}>
                    无步骤时任务仅弹出系统通知提醒。
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {steps.map((s, idx) => (
                    <div key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, color: COLORS.textSecondary, width: 20 }}>{idx + 1}</span>
                      <select
                        style={selectStyle}
                        value={s.action}
                        onChange={e => { const next = [...steps]; next[idx] = { ...s, action: e.target.value as SequenceStep['action'] }; setSteps(next) }}
                      >
                        {(Object.keys(ACTION_LABEL) as SequenceStep['action'][]).map(a => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}
                      </select>
                      <input
                        style={{ ...inputStyle, flex: 1, minWidth: 180 }}
                        value={s.params}
                        onChange={e => { const next = [...steps]; next[idx] = { ...s, params: e.target.value }; setSteps(next) }}
                        placeholder={s.action === 'open_app' ? '应用名或路径' : s.action === 'run_command' ? '命令，如 notepad.exe' : s.action === 'wait' ? '等待秒数，如 5' : s.action === 'condition' ? '检查条件' : '提醒内容'}
                      />
                      <button
                        onClick={() => setSteps(steps.filter(x => x.id !== s.id))}
                        style={{ ...actionBtnStyle, color: '#f87171' }}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <button
                onClick={saveTask}
                style={{
                  ...actionBtnStyle, justifyContent: 'center', padding: '9px 0',
                  color: '#fff', background: COLORS.accent, borderColor: COLORS.accent, fontSize: 13,
                }}
              >
                保存任务
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {status === 'ready' && tasks.map(t => (
        <div
          key={t.id}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            padding: '10px 0', borderTop: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>{t.name}</span>
              {t.lastStatus === 'success' && t.runCount > 0 && (
                <span style={{ fontSize: 11, color: COLORS.success }}>上次成功</span>
              )}
              {t.lastStatus === 'failed' && t.runCount > 0 && (
                <span style={{ fontSize: 11, color: '#f87171' }}>上次失败</span>
              )}
            </div>
            {t.description && <div style={{ fontSize: 12, color: COLORS.textSecondary, marginTop: 2 }}>{t.description}</div>}
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 3 }}>
              {formatTrigger(t.triggerCondition ?? t.cron)} · 已执行 {t.runCount || 0} 次 · 下次 {t.nextRun || '--'}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {busyId === t.id ? <Loader2 size={15} className="animate-spin" style={{ color: COLORS.textSecondary }} /> : (
              <>
                <button onClick={() => executeNow(t)} style={{ ...actionBtnStyle }} title="立即执行">
                  <Play size={13} />
                </button>
                <button onClick={() => openEdit(t)} style={{ ...actionBtnStyle }} title="编辑">
                  <CirclePlay size={13} />
                </button>
                <button onClick={() => toggleTask(t, !t.enabled)} style={{ ...actionBtnStyle }} title={t.enabled ? '停用' : '启用'}>
                  {t.enabled ? <Pause size={13} /> : <Play size={13} />}
                </button>
                <button onClick={() => deleteTask(t.id)} style={{ ...actionBtnStyle, color: '#f87171' }} title="删除">
                  <Trash2 size={13} />
                </button>
                <Toggle checked={t.enabled} onChange={() => toggleTask(t, !t.enabled)} />
              </>
            )}
          </div>
        </div>
      ))}
    </GlassCard>
  )
}
