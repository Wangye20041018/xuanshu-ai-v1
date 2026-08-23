import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Zap, Plus, Play, Pause, AlertCircle, Clock, Trash2, Monitor, FileText, Timer, Activity, List, X, FolderOpen } from 'lucide-react'
import { HEX_COLORS, COLORS, containerVariants, itemVariants, listItemVariants } from '../../shared/theme'

import { logger } from '../../../shared/logger'
import ErrorBoundary from '../../components/ErrorBoundary'
import { useTranslation } from '../../i18n'

/* ==================== Types ==================== */
type AutomationStatus = 'running' | 'stopped' | 'error'

type TriggerType = 'schedule' | 'file_watch' | 'system_event' | 'sequence'

type TaskCategory = 'file' | 'system' | 'sync' | 'notification' | 'other'

interface SequenceStep {
  id: string
  action: 'open_app' | 'run_command' | 'send_message' | 'wait' | 'condition'
  params: string
  timeout: number
}

interface AutomationTask {
  id: string
  name: string
  description: string
  triggerType: TriggerType
  triggerCondition: string
  category: TaskCategory
  lastRun: string
  status: AutomationStatus
  enabled: boolean
  createdAt: number
  steps?: SequenceStep[]
}

/* ==================== Smart Classification ==================== */
function classifyTask(description: string): TaskCategory {
  const d = description.toLowerCase()
  if (/文件|文件夹|整理|清理/.test(d)) return 'file'
  if (/系统|设置|更新|重启/.test(d)) return 'system'
  if (/备份|同步|上传|下载/.test(d)) return 'sync'
  if (/提醒|通知|消息|发送/.test(d)) return 'notification'
  return 'other'
}

/* ==================== Status Badge ==================== */
function StatusBadge({ status }: { status: AutomationStatus }) {
  const config: Record<AutomationStatus, { color: string; bg: string; icon: React.ReactNode; label: string }> = {
    running: { color: COLORS.success, bg: `${HEX_COLORS.success}15`, icon: <Play size={11} />, label: '运行中' },
    stopped: { color: COLORS.textMuted, bg: `${HEX_COLORS.textMuted}15`, icon: <Pause size={11} />, label: '已停止' },
    error: { color: COLORS.danger, bg: `${HEX_COLORS.danger}15`, icon: <AlertCircle size={11} />, label: '错误' },
  }
  const c = config[status]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '4px 10px', borderRadius: 9999, fontSize: 11, fontWeight: 500,
      background: c.bg, color: c.color,
    }}>
      {c.icon} {c.label}
    </span>
  )
}

/* ==================== Trigger Type Badge ==================== */
function TriggerBadge({ type }: { type: TriggerType }) {
  const config: Record<TriggerType, { icon: React.ReactNode; label: string; color: string }> = {
    schedule: { icon: <Timer size={13} />, label: '定时', color: COLORS.accent },
    file_watch: { icon: <FileText size={13} />, label: '文件监控', color: COLORS.success },
    system_event: { icon: <Monitor size={13} />, label: '系统事件', color: COLORS.warning },
    sequence: { icon: <List size={13} />, label: '序列', color: '#a78bfa' },
  }
  const c = config[type]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '4px 10px', borderRadius: 10, fontSize: 11, fontWeight: 500,
      background: `${c.color}15`, color: c.color, border: `1px solid ${c.color}30`,
    }}>
      {c.icon} {c.label}
    </span>
  )
}

/* ==================== Category Badge ==================== */
function CategoryBadge({ category }: { category: TaskCategory }) {
  const config: Record<TaskCategory, { label: string; color: string }> = {
    file: { label: '文件', color: '#3b82f6' },
    system: { label: '系统', color: COLORS.violet },
    sync: { label: '同步', color: COLORS.successAlt },
    notification: { label: '通知', color: COLORS.warning },
    other: { label: '其他', color: COLORS.textMuted },
  }
  const c = config[category]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 9px', borderRadius: 8, fontSize: 10, fontWeight: 500,
      background: `${c.color}15`, color: c.color, border: `1px solid ${c.color}30`,
    }}>
      {c.label}
    </span>
  )
}

/* ==================== Toggle Switch ==================== */
function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <motion.button
      onClick={onChange}
      whileTap={{ scale: 0.92 }}
      animate={{
        background: checked ? COLORS.success : 'rgba(255,255,255,0.10)',
        boxShadow: checked ? `0 0 16px ${HEX_COLORS.success}40` : 'none',
      }}
      style={{
        width: 48, height: 26, borderRadius: 13, border: 'none',
        cursor: 'pointer', position: 'relative', padding: 0,
      }}
    >
      <motion.div
        animate={{ left: checked ? 25 : 3 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        style={{
          width: 20, height: 20, borderRadius: '50%',
          background: '#fff', position: 'absolute', top: 3,
        }}
      />
    </motion.button>
  )
}

/* ==================== Empty State ==================== */
function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      style={{
        background: COLORS.cardBg, border: '1px solid ' + COLORS.cardBorder,
        borderRadius: 'var(--radius-2xl)', padding: '40px', textAlign: 'center',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
      }}
    >
      <Zap size={40} style={{ color: COLORS.textMuted, opacity: 0.3 }} />
      <div>
        <p style={{ color: COLORS.textSecondary, margin: 0, fontSize: 14, fontWeight: 500 }}>
          暂无自动化任务
        </p>
        <p style={{ color: COLORS.textMuted, margin: '6px 0 0', fontSize: 12 }}>
          创建第一个自动化，简化重复性工作
        </p>
      </div>
      <motion.button
        whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}
        onClick={onCreate}
        style={{
          padding: '10px 24px', borderRadius: 'var(--radius-2xl)', cursor: 'pointer',
          background: COLORS.accent, border: 'none', color: '#fff',
          fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
          display: 'flex', alignItems: 'center', gap: 8,
        }}
      >
        <Plus size={15} /> 新建自动化
      </motion.button>
    </motion.div>
  )
}

/* ==================== Type Overview Cards ==================== */
function TypeOverview() {
  const types: { icon: React.ReactNode; label: string; desc: string; color: string }[] = [
    { icon: <Timer size={18} />, label: '定时任务', desc: '在指定时间或间隔运行', color: COLORS.accent },
    { icon: <FileText size={18} />, label: '文件监控', desc: '监控文件夹中的文件变更', color: COLORS.success },
    { icon: <Monitor size={18} />, label: '系统事件', desc: '响应设备、网络或电源事件', color: COLORS.warning },
    { icon: <List size={18} />, label: '序列任务', desc: '多步骤按序执行', color: '#a78bfa' },
  ]

  return (
    <motion.div variants={itemVariants} style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
      {types.map((t) => (
        <motion.div
          key={t.label}
          whileHover={{ borderColor: COLORS.cardBorderHover, boxShadow: 'var(--shadow-card-hover)' }}
          style={{
            background: COLORS.cardBg, border: '1px solid ' + COLORS.cardBorder,
            borderRadius: 'var(--radius-2xl)', padding: '18px 20px',
            display: 'flex', flexDirection: 'column', gap: 8,
          }}
        >
          <span style={{ display: 'flex', color: t.color }}>{t.icon}</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>{t.label}</div>
            <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 3 }}>{t.desc}</div>
          </div>
        </motion.div>
      ))}
    </motion.div>
  )
}

/* ==================== Input Styles ==================== */
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 14px', borderRadius: 12,
  backgroundColor: COLORS.bg, border: '1px solid ' + COLORS.cardBorder,
  color: COLORS.textPrimary, fontSize: 13, outline: 'none',
  boxSizing: 'border-box', fontFamily: 'inherit',
}

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: 'pointer',
  appearance: 'none',
  WebkitAppearance: 'none',
  paddingRight: 36,
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23a0a0b0' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 11px center',
  backgroundSize: 14,
  transition: 'all 0.3s ease',
}

const labelStyle: React.CSSProperties = {
  fontSize: 12, color: COLORS.textSecondary, display: 'block', marginBottom: 6
}

/* ==================== Main Component ==================== */
export default function Automation() {
  const { t: _t } = useTranslation()
  const [tasks, setTasks] = useState<AutomationTask[]>([])
  const [showModal, setShowModal] = useState(false)
  const [newTask, setNewTask] = useState({
    name: '',
    description: '',
    triggerType: 'schedule' as TriggerType,
    // Schedule
    scheduleDate: '',
    scheduleTime: '',
    repeatMode: 'once' as 'once' | 'daily' | 'weekly' | 'monthly' | 'cron',
    cronExpression: '',
    weekDay: '0',
    monthDay: '1',
    // File watch
    watchDirectory: '',
    fileFilter: '',
    // System event
    eventType: 'startup',
    // Sequence
    steps: [] as SequenceStep[],
  })
  const [isAdding, setIsAdding] = useState(false)
  const stepIdCounter = useRef(0)
  const genStepId = (): string => `step_${Date.now()}_${++stepIdCounter.current}`

  /* ------ Cron Validation ------ */
  const [cronValidation, setCronValidation] = useState<{ valid: boolean; message: string }>({ valid: true, message: '' })
  const validateCronExpression = (expr: string): { valid: boolean; message: string } => {
    if (!expr.trim()) return { valid: true, message: '' }
    const parts = expr.trim().split(/\s+/)
    if (parts.length !== 5) {
      return { valid: false, message: 'Cron 表达式需要 5 个字段（分 时 日 月 周）' }
    }
    const [minute, hour, day, month, week] = parts
    const ranges: [string, number, number][] = [
      [minute, 0, 59], [hour, 0, 23], [day, 1, 31], [month, 1, 12], [week, 0, 7],
    ]
    for (const [val, min, max] of ranges) {
      if (val === '*') continue
      if (/^\d+$/.test(val)) {
        const n = parseInt(val, 10)
        if (n < min || n > max) return { valid: false, message: `字段 "${val}" 超出范围 ${min}-${max}` }
      } else if (/^\d+-\d+$/.test(val)) {
        const [a, b] = val.split('-').map(Number)
        if (a < min || b > max) return { valid: false, message: `范围 "${val}" 超出 ${min}-${max}` }
      } else if (/^\*\/(\d+)$/.test(val)) {
        const step = parseInt(val.split('/')[1], 10)
        if (step < 1) return { valid: false, message: `步长必须为正整数` }
      }
      // Allow comma-separated, ranges, steps - skip full validation for brevity
    }
    return { valid: true, message: '表达式格式正确' }
  }

  /* ------ Load Tasks ------ */
  useEffect(() => {
    async function load() {
      if (window.api) {
        try {
          const result = await window.api.invoke<AutomationTask[]>('automation:list')
          if (result) setTasks(result)
        } catch {
          logger.error('[Automation] 无法加载任务列表')
        }
      }
    }
    load()
  }, [])

  /* ------ Toggle ------ */
  const handleToggle = async (id: string, enabled: boolean) => {
    // Optimistically update enabled state
    setTasks(prev => prev.map(t => t.id === id ? { ...t, enabled } : t))
    if (window.api) {
      try {
        const result = await window.api.invoke<{ success?: boolean }>(enabled ? 'automation:start' : 'automation:stop', id)
        if (result && result.success === false) {
          logger.error('[Automation] toggle失败:', (result as any).error)
          setTasks(prev => prev.map(t => t.id === id ? { ...t, enabled: !enabled } : t))
          return
        }
        setTasks(prev => prev.map(t => t.id === id ? { ...t, status: (enabled ? 'running' : 'stopped') as AutomationStatus } : t))
      } catch (e) {
        logger.error('[Automation] toggle失败:', e)
        // Revert on failure
        setTasks(prev => prev.map(t => t.id === id ? { ...t, enabled: !enabled } : t))
      }
    }
  }

  /* ------ Delete ------ */
  const handleDelete = async (id: string) => {
    if (window.api) {
      try {
        await window.api.invoke('automation:delete', id)
        setTasks(prev => prev.filter(t => t.id !== id))
      } catch (e) { logger.error('[Automation] delete失败:', e) }
    } else {
      setTasks(prev => prev.filter(t => t.id !== id))
    }
  }

  /* ------ Execute Now ------ */
  const [executingTaskId, setExecutingTaskId] = useState<string | null>(null)
  const handleExecuteNow = async (id: string) => {
    if (executingTaskId) return
    setExecutingTaskId(id)
    try {
      if (window.api) {
        const result = await window.api.invoke<{ success: boolean; error?: string }>('automation:execute', id)
        if (result?.success) {
          setTasks(prev => prev.map(t =>
            t.id === id ? { ...t, lastRun: new Date().toLocaleString() } : t
          ))
        } else {
          logger.error('[Automation] 执行失败:', result?.error)
        }
      } else {
        setTasks(prev => prev.map(t =>
          t.id === id ? { ...t, lastRun: new Date().toLocaleString() } : t
        ))
      }
    } catch (e) {
      logger.error('[Automation] executeNow失败:', e)
    } finally {
      setExecutingTaskId(null)
    }
  }

  /* ------ Build Trigger Condition ------ */
  const buildTriggerCondition = (): string => {
    const nt = newTask
    switch (nt.triggerType) {
      case 'schedule': {
        const date = nt.scheduleDate || new Date().toISOString().slice(0, 10)
        const time = nt.scheduleTime || '09:00'
        const dt = `${date}T${time}`
        switch (nt.repeatMode) {
          case 'once': return `at:${dt}`
          case 'daily': return `daily:${time}`
          case 'weekly': return `weekly:${nt.weekDay}:${time}`
          case 'monthly': return `monthly:${nt.monthDay}:${time}`
          case 'cron': return nt.cronExpression || '0 9 * * *'
          default: return `at:${dt}`
        }
      }
      case 'file_watch':
        return `dir:${nt.watchDirectory}|filter:${nt.fileFilter || '*'}`
      case 'system_event':
        return nt.eventType
      case 'sequence':
        return `sequence:${nt.steps.length}`
      default:
        return ''
    }
  }

  /* ------ Add ------ */
  const handleAdd = async () => {
    if (!newTask.name.trim() || isAdding) return

    // Validate cron expression
    if (newTask.triggerType === 'schedule' && newTask.repeatMode === 'cron') {
      const parts = (newTask.cronExpression || '0 9 * * *').trim().split(/\s+/)
      if (parts.length !== 5) {
        logger.warn('[Automation] 无效的 Cron 表达式，需要 5 个字段')
        return
      }
    }

    setIsAdding(true)

    const category = classifyTask(newTask.description)
    const condition = buildTriggerCondition()

    // Also call backend classify for future AI support
    if (window.api) {
      try { window.api.invoke('automation:classify', newTask.description).catch((e) => { logger.warn('[Automation] 任务分类失败:', e) }) } catch (e) { logger.warn('[Automation] 分类调用异常:', e) }
    }

    const task: AutomationTask = {
      id: Date.now().toString(),
      name: newTask.name.trim(),
      description: newTask.description.trim(),
      triggerType: newTask.triggerType,
      triggerCondition: condition,
      category,
      lastRun: '--',
      status: 'stopped',
      enabled: false,
      createdAt: Date.now(),
      steps: newTask.triggerType === 'sequence' ? [...newTask.steps] : undefined,
    }
    if (window.api) {
      try { await window.api.invoke('automation:save', task) } catch (e) { logger.error('[Automation] save失败:', e) }
    }
    setTasks(prev => [task, ...prev])
    setNewTask({
      name: '', description: '', triggerType: 'schedule',
      scheduleDate: '', scheduleTime: '', repeatMode: 'once',
      cronExpression: '', weekDay: '0', monthDay: '1',
      watchDirectory: '', fileFilter: '', eventType: 'startup',
      steps: [],
    })
    setShowModal(false)
    setIsAdding(false)
  }

  /* ------ Format time ------ */
  /* ------ Sequence Step Helpers ------ */
  const addStep = () => {
    setNewTask(prev => ({
      ...prev,
      steps: [...prev.steps, { id: genStepId(), action: 'open_app', params: '', timeout: 30 }],
    }))
  }

  const updateStep = (id: string, field: keyof SequenceStep, value: string | number) => {
    setNewTask(prev => ({
      ...prev,
      steps: prev.steps.map(s => s.id === id ? { ...s, [field]: value } : s),
    }))
  }

  const removeStep = (id: string) => {
    setNewTask(prev => ({
      ...prev,
      steps: prev.steps.filter(s => s.id !== id),
    }))
  }

  /* ------ Step Action Labels ------ */
  const actionLabels: Record<SequenceStep['action'], string> = {
    open_app: '打开应用',
    run_command: '执行命令',
    send_message: '发送消息',
    wait: '等待',
    condition: '条件判断',
  }

  /* ------ Render Trigger-Specific Form ------ */
  const renderTriggerForm = () => {
    switch (newTask.triggerType) {
      case 'schedule':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {newTask.repeatMode === 'once' && (
              <div>
                <label style={labelStyle}>日期</label>
                <input type="date" value={newTask.scheduleDate}
                  onChange={(e) => setNewTask(prev => ({ ...prev, scheduleDate: e.target.value }))}
                  style={inputStyle} />
              </div>
            )}
            <div>
              <label style={labelStyle}>时间</label>
              <input type="time" value={newTask.scheduleTime}
                onChange={(e) => setNewTask(prev => ({ ...prev, scheduleTime: e.target.value }))}
                style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>重复模式</label>
              <select value={newTask.repeatMode}
                onChange={(e) => setNewTask(prev => ({ ...prev, repeatMode: e.target.value as typeof prev.repeatMode }))}
                style={selectStyle}>
                <option value="once">仅一次</option>
                <option value="daily">每天</option>
                <option value="weekly">每周</option>
                <option value="monthly">每月</option>
                <option value="cron">自定义 Cron</option>
              </select>
            </div>
            {newTask.repeatMode === 'weekly' && (
              <div>
                <label style={labelStyle}>星期</label>
                <select value={newTask.weekDay}
                  onChange={(e) => setNewTask(prev => ({ ...prev, weekDay: e.target.value }))}
                  style={selectStyle}>
                  <option value="0">周日</option>
                  <option value="1">周一</option>
                  <option value="2">周二</option>
                  <option value="3">周三</option>
                  <option value="4">周四</option>
                  <option value="5">周五</option>
                  <option value="6">周六</option>
                </select>
              </div>
            )}
            {newTask.repeatMode === 'monthly' && (
              <div>
                <label style={labelStyle}>日期（1-31）</label>
                <input type="number" min={1} max={31} value={newTask.monthDay}
                  onChange={(e) => setNewTask(prev => ({ ...prev, monthDay: e.target.value }))}
                  style={inputStyle} />
              </div>
            )}
            {newTask.repeatMode === 'cron' && (
              <div>
                <label style={labelStyle}>Cron 表达式</label>
                <input value={newTask.cronExpression}
                  onChange={(e) => {
                    const val = e.target.value
                    setNewTask(prev => ({ ...prev, cronExpression: val }))
                    setCronValidation(validateCronExpression(val))
                  }}
                  placeholder="e.g., 0 2 * * *"
                  style={{
                    ...inputStyle,
                    borderColor: newTask.cronExpression.trim() && !cronValidation.valid
                      ? COLORS.danger
                      : newTask.cronExpression.trim() && cronValidation.valid
                        ? COLORS.success
                        : COLORS.cardBorder,
                  }} />
                {newTask.cronExpression.trim() && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    style={{
                      marginTop: 6, fontSize: 11,
                      display: 'flex', alignItems: 'center', gap: 5,
                      color: cronValidation.valid ? COLORS.success : COLORS.danger,
                    }}
                  >
                    {cronValidation.valid ? (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: COLORS.success }} />
                        {cronValidation.message}
                      </span>
                    ) : (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <AlertCircle size={12} />
                        {cronValidation.message}
                      </span>
                    )}
                  </motion.div>
                )}
              </div>
            )}
          </div>
        )
      case 'file_watch':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={labelStyle}>
                <FolderOpen size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                监控目录
              </label>
              <input value={newTask.watchDirectory}
                onChange={(e) => setNewTask(prev => ({ ...prev, watchDirectory: e.target.value }))}
                placeholder="例如：C:\Users\Downloads"
                style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>文件类型过滤</label>
              <input value={newTask.fileFilter}
                onChange={(e) => setNewTask(prev => ({ ...prev, fileFilter: e.target.value }))}
                placeholder="例如：*.pdf,*.docx（留空监控所有）"
                style={inputStyle} />
            </div>
          </div>
        )
      case 'system_event':
        return (
          <div>
            <label style={labelStyle}>事件类型</label>
            <select value={newTask.eventType}
              onChange={(e) => setNewTask(prev => ({ ...prev, eventType: e.target.value }))}
              style={selectStyle}>
              <option value="startup">开机</option>
              <option value="shutdown">关机</option>
              <option value="lock">锁屏</option>
              <option value="unlock">解锁</option>
              <option value="network_change">网络变化</option>
              <option value="usb_insert">USB 插入</option>
            </select>
          </div>
        )
      case 'sequence':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label style={{ ...labelStyle, marginBottom: 0 }}>子步骤（{newTask.steps.length}）</label>
              <motion.button
                whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}
                onClick={addStep}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '5px 12px', borderRadius: 8, cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: 11, fontWeight: 500,
                  background: `${HEX_COLORS.accent}15`, border: `1px solid ${HEX_COLORS.accent}30`,
                  color: COLORS.accent,
                }}
              >
                <Plus size={12} /> 添加步骤
              </motion.button>
            </div>
            {newTask.steps.length === 0 ? (
              <div style={{ padding: '16px', textAlign: 'center', color: COLORS.textMuted, fontSize: 12,
                background: COLORS.bg, borderRadius: 12, border: `1px dashed ${COLORS.cardBorder}` }}>
                暂无步骤，点击上方按钮添加
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {newTask.steps.map((step, idx) => (
                  <div key={step.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '10px 12px', borderRadius: 12,
                    background: COLORS.bg, border: '1px solid ' + COLORS.cardBorder,
                  }}>
                    <span style={{ fontSize: 11, color: COLORS.textMuted, minWidth: 16, textAlign: 'center', flexShrink: 0 }}>
                      {idx + 1}
                    </span>
                    <select value={step.action}
                      onChange={(e) => updateStep(step.id, 'action', e.target.value)}
                      style={{ ...selectStyle, width: 110, padding: '6px 10px', fontSize: 12, flexShrink: 0 }}>
                      {Object.entries(actionLabels).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                    <input value={step.params}
                      onChange={(e) => updateStep(step.id, 'params', e.target.value)}
                      placeholder={step.action === 'open_app' ? '应用路径' : step.action === 'run_command' ? '命令' : step.action === 'send_message' ? '消息内容' : step.action === 'condition' ? '条件表达式' : '—'}
                      style={{ ...inputStyle, flex: 1, padding: '6px 10px', fontSize: 12 }} />
                    <input type="number" value={step.timeout}
                      onChange={(e) => updateStep(step.id, 'timeout', parseInt(e.target.value) || 0)}
                      title="超时（秒）"
                      style={{ ...inputStyle, width: 54, padding: '6px 8px', fontSize: 12, textAlign: 'center', flexShrink: 0 }} />
                    <motion.button
                      whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.85 }}
                      onClick={() => removeStep(step.id)}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: COLORS.textMuted, padding: 2, display: 'flex', flexShrink: 0,
                      }}
                    >
                      <X size={14} />
                    </motion.button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      default:
        return null
    }
  }

  /* ------ Handle Trigger Type Change (reset form fields) ------ */
  const handleTriggerTypeChange = (type: TriggerType) => {
    setNewTask(prev => ({
      ...prev,
      triggerType: type,
      scheduleDate: '', scheduleTime: '', repeatMode: 'once',
      cronExpression: '', weekDay: '0', monthDay: '1',
      watchDirectory: '', fileFilter: '', eventType: 'startup',
      steps: [],
    }))
  }

  return (
    <ErrorBoundary>
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: COLORS.bg, padding: '20px', minHeight: 0, overflow: 'auto' }}>
      <motion.div variants={containerVariants} initial="hidden" animate="visible" style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: 1200, margin: '0 auto', width: '100%' }}>

        {/* Header */}
        <motion.div variants={itemVariants} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ fontSize: '1.4rem', fontWeight: 600, color: COLORS.textPrimary, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Zap size={22} style={{ color: COLORS.accent }} /> 自动化
            </h2>
            <p style={{ fontSize: '0.85rem', color: COLORS.textMuted, margin: '4px 0 0' }}>
              创建和管理自动化任务流程
            </p>
          </div>
          <motion.button
            whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}
            onClick={() => setShowModal(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '10px 24px',
              borderRadius: 'var(--radius-2xl)', cursor: 'pointer', fontFamily: 'inherit',
              background: COLORS.accent, border: 'none', color: '#fff', fontSize: 13, fontWeight: 600,
            }}
          >
            <Plus size={15} /> 新建自动化
          </motion.button>
        </motion.div>

        {/* Type Overview */}
        <TypeOverview />

        {/* Task List */}
        <motion.div variants={itemVariants}>
          <h3 style={{ fontSize: '1rem', fontWeight: 600, color: COLORS.textPrimary, margin: '0 0 14px' }}>
            我的自动化（{tasks.length}）
          </h3>

          {tasks.length === 0 ? (
            <EmptyState onCreate={() => setShowModal(true)} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <AnimatePresence>
                {tasks.map((task) => (
                  <motion.div
                    key={task.id}
                    variants={listItemVariants}
                    initial="hidden"
                    animate="visible"
                    exit={{ opacity: 0, x: -20, transition: { duration: 0.2 } }}
                    layout
                    whileHover={{ borderColor: COLORS.cardBorderHover }}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '16px 20px', borderRadius: 'var(--radius-2xl)',
                      background: COLORS.cardBg,
                      border: '1px solid ' + COLORS.cardBorder,
                      gap: 16,
                      transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
                    }}
                  >
                    {/* Left: Icon + Info */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0, flex: 1 }}>
                      <motion.div
                        animate={{
                          color: task.status === 'running' ? COLORS.success : task.status === 'error' ? COLORS.danger :
                            task.triggerType === 'sequence' ? '#a78bfa' : COLORS.textMuted,
                          scale: task.status === 'running' ? [1, 1.05, 1] : 1,
                        }}
                        transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
                        style={{ display: 'flex', flexShrink: 0 }}
                      >
                        {task.status === 'running' ? <Activity size={20} /> :
                         task.status === 'error' ? <AlertCircle size={20} /> :
                         task.triggerType === 'sequence' ? <List size={20} /> :
                         task.triggerType === 'schedule' ? <Clock size={20} /> : <Zap size={20} />}
                      </motion.div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 500, color: COLORS.textPrimary }}>{task.name}</span>
                          <CategoryBadge category={task.category || classifyTask(task.description)} />
                        </div>
                        <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2 }}>{task.description}</div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <TriggerBadge type={task.triggerType} />
                          <span style={{ fontSize: 10, color: COLORS.textMuted }}>
                            {task.triggerType === 'sequence' && task.steps
                              ? `${task.steps.length} 个步骤`
                              : task.triggerCondition}
                          </span>
                          <span style={{ fontSize: 10, color: COLORS.textMuted, display: 'flex', alignItems: 'center', gap: 3 }}>
                            <Clock size={10} /> 上次：{task.lastRun}
                          </span>
                          <StatusBadge status={task.status} />
                        </div>
                      </div>
                    </div>

                    {/* Right: Actions */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                      <Toggle checked={task.enabled} onChange={() => handleToggle(task.id, !task.enabled)} />
                      <motion.button
                        whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.88 }}
                        onClick={() => handleExecuteNow(task.id)}
                        disabled={executingTaskId === task.id}
                        title="立即执行一次"
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          width: 32, height: 32, borderRadius: 10,
                          background: executingTaskId === task.id ? `${HEX_COLORS.accent}15` : 'transparent',
                          border: `1px solid ${COLORS.cardBorder}`,
                          cursor: executingTaskId === task.id ? 'wait' : 'pointer',
                          color: executingTaskId === task.id ? COLORS.accent : COLORS.textMuted,
                          padding: 0,
                          transition: 'all 0.2s ease',
                        }}
                      >
                        {executingTaskId === task.id ? (
                          <motion.span
                            animate={{ rotate: 360 }}
                            transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
                            style={{ display: 'flex' }}
                          >
                            <Activity size={14} />
                          </motion.span>
                        ) : (
                          <Play size={14} />
                        )}
                      </motion.button>
                      <motion.button
                        whileHover={{ scale: 1.15 }} whileTap={{ scale: 0.85 }}
                        onClick={() => handleDelete(task.id)}
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer',
                          color: COLORS.textMuted, padding: 4, display: 'flex',
                        }}
                      >
                        <Trash2 size={15} />
                      </motion.button>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </motion.div>
      </motion.div>

      {/* ------ Add Modal ------ */}
      <AnimatePresence>
        {showModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{
              position: 'fixed', inset: 0, zIndex: 100,
              background: 'rgba(10,10,15,0.65)', backdropFilter: 'blur(12px)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            onClick={() => setShowModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={(e) => e.stopPropagation()}
              style={{
                background: COLORS.cardBg, border: '1px solid ' + COLORS.cardBorder,
                borderRadius: 'var(--radius-2xl)', padding: '28px', width: 520, maxWidth: '90vw',
                maxHeight: '85vh', overflowY: 'auto',
                display: 'flex', flexDirection: 'column', gap: 18,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: COLORS.textPrimary, margin: 0 }}>
                  新建自动化
                </h3>
                <motion.button
                  whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
                  onClick={() => setShowModal(false)}
                  style={{ background: 'none', border: 'none', color: COLORS.textMuted, cursor: 'pointer', padding: 4 }}
                >
                  <X size={18} />
                </motion.button>
              </div>

              {/* Name */}
              <div>
                <label style={labelStyle}>名称</label>
                <input value={newTask.name}
                  onChange={(e) => setNewTask(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="例如：每日备份"
                  style={inputStyle} />
              </div>

              {/* Description */}
              <div>
                <label style={labelStyle}>描述</label>
                <input value={newTask.description}
                  onChange={(e) => setNewTask(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="这个自动化任务做什么？"
                  style={inputStyle} />
                {newTask.description.trim() && (
                  <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 10, color: COLORS.textMuted }}>智能分类：</span>
                    <CategoryBadge category={classifyTask(newTask.description)} />
                    <span style={{ fontSize: 10, color: COLORS.textMuted }}>（根据描述自动推断）</span>
                  </div>
                )}
              </div>

              {/* Trigger Type */}
              <div>
                <label style={labelStyle}>触发类型</label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                  {([
                    { value: 'schedule' as TriggerType, label: '定时', icon: <Timer size={14} /> },
                    { value: 'file_watch' as TriggerType, label: '文件监控', icon: <FileText size={14} /> },
                    { value: 'system_event' as TriggerType, label: '系统事件', icon: <Monitor size={14} /> },
                    { value: 'sequence' as TriggerType, label: '序列', icon: <List size={14} /> },
                  ]).map(opt => (
                    <motion.button
                      key={opt.value}
                      whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                      onClick={() => handleTriggerTypeChange(opt.value)}
                      style={{
                        padding: '10px 6px', borderRadius: 12, cursor: 'pointer',
                        fontFamily: 'inherit', fontSize: 12, fontWeight: 500,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                        border: '1px solid ' + (newTask.triggerType === opt.value ? COLORS.accent : COLORS.cardBorder),
                        background: newTask.triggerType === opt.value ? `${HEX_COLORS.accent}15` : COLORS.bg,
                        color: newTask.triggerType === opt.value ? COLORS.accent : COLORS.textSecondary,
                      }}
                    >
                      {opt.icon} {opt.label}
                    </motion.button>
                  ))}
                </div>
              </div>

              {/* Trigger-Specific Form */}
              <div>
                <label style={labelStyle}>触发配置</label>
                {renderTriggerForm()}
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
                <motion.button
                  whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                  onClick={() => setShowModal(false)}
                  style={{
                    padding: '10px 20px', borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit',
                    background: 'transparent', border: '1px solid ' + COLORS.cardBorder,
                    color: COLORS.textSecondary, fontSize: 13, fontWeight: 500,
                  }}
                >
                  取消
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                  onClick={handleAdd}
                  disabled={!newTask.name.trim() || isAdding}
                  style={{
                    padding: '10px 24px', borderRadius: 12, cursor: newTask.name.trim() ? 'pointer' : 'not-allowed',
                    fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                    background: newTask.name.trim() ? COLORS.accent : 'rgba(255,255,255,0.08)',
                    border: 'none', color: newTask.name.trim() ? '#fff' : COLORS.textMuted,
                  }}
                >
                  {isAdding ? '创建中...' : '创建'}
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    </ErrorBoundary>
  )
}
