/**
 * 自动化任务持久化引擎
 * 提供定时任务的 CRUD + 执行 + 智能分类 + 序列执行
 */
import { app, ipcMain, shell, Notification } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { spawn } from 'child_process'

interface TaskCard {
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

function tasksDir(): string {
  const dir = join(app.getPath('userData'), 'automation-tasks')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function loadAll(): TaskCard[] {
  const dir = tasksDir()
  const files = readdirSync(dir).filter(f => f.endsWith('.json'))
  return files.map(f => {
    try { return JSON.parse(readFileSync(join(dir, f), 'utf-8')) as TaskCard }
    catch { return null }
  }).filter(Boolean) as TaskCard[]
}

/** M-08 修复：异步加载全部任务，避免 30 秒轮询时同步 I/O 阻塞主进程 */
async function loadAllAsync(): Promise<TaskCard[]> {
  const dir = tasksDir()
  const files = await readdir(dir)
  const tasks = await Promise.all(
    files
      .filter(f => f.endsWith('.json'))
      .map(async f => {
        try { return JSON.parse(await readFile(join(dir, f), 'utf-8')) as TaskCard }
        catch { return null }
      })
  )
  return tasks.filter(Boolean) as TaskCard[]
}

/** M-22 修复：任务 ID 白名单校验，防止路径遍历 */
function validateTaskId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id) && !id.includes('..')
}

function saveOne(task: TaskCard): void {
  // M-22 修复：非法 ID 拒绝落盘
  if (!validateTaskId(task.id)) return
  writeFileSync(join(tasksDir(), `${task.id}.json`), JSON.stringify(task, null, 2))
}

function deleteOne(id: string): void {
  // M-22 修复：非法 ID 拒绝删除
  if (!validateTaskId(id)) return
  const p = join(tasksDir(), `${id}.json`)
  if (existsSync(p)) unlinkSync(p)
}

/* ========== Smart Classification ========== */
export function classifyDescription(description: string): string {
  const d = description.toLowerCase()
  if (/文件|文件夹|整理|清理/.test(d)) return 'file'
  if (/系统|设置|更新|重启/.test(d)) return 'system'
  if (/备份|同步|上传|下载/.test(d)) return 'sync'
  if (/提醒|通知|消息|发送/.test(d)) return 'notification'
  return 'other'
}

/* ========== Run Sequence with Retry & Fallback ========== */

/**
 * S3 修复：安全解析命令字符串为可执行文件 + 参数数组
 * 支持双引号参数，拒绝 shell 元字符注入 */
export function parseCommand(cmdStr: string): string[] {
  const parts: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < cmdStr.length; i++) {
    const ch = cmdStr[i]
    if (ch === '"') {
      inQuotes = !inQuotes
    } else if (ch === ' ' && !inQuotes) {
      if (current) { parts.push(current); current = '' }
    } else {
      current += ch
    }
  }
  if (current) parts.push(current)
  // 安全检查：拒绝含 shell 元字符的单个参数
  const dangerous = /[;&|`$(){}[\]#~!<>*?\\]/
  for (const p of parts) {
    if (dangerous.test(p)) {
      throw new Error(`命令包含不安全字符，已拒绝执行: ${p}`)
    }
  }
  return parts
}

async function executeStepWithRetry(
  step: SequenceStep,
  stepIndex: number,
  totalSteps: number
): Promise<{ success: boolean; result: string }> {
  const maxRetries = step.retryCount ?? 0
  const retryDelay = step.retryDelay ?? 2
  const prefix = `[步骤 ${stepIndex + 1}/${totalSteps}]`
  let lastError = ''

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptLabel = attempt > 0 ? ` (重试 ${attempt}/${maxRetries})` : ''
    try {
      switch (step.action) {
        case 'open_app': {
          const openResult = await shell.openPath(step.params)
          if (openResult) throw new Error(`打开应用失败: ${openResult}`)
          return { success: true, result: `${prefix}${attemptLabel} 已打开: ${step.params}` }
        }
        case 'run_command': {
          // S3 修复：使用 spawn 替代 exec，禁止 shell 注入
          const output = await new Promise<string>((resolve, reject) => {
            const args = parseCommand(step.params)
            if (!args.length) return reject(new Error('空命令'))
            const [cmd, ...cmdArgs] = args
            const child = spawn(cmd, cmdArgs, {
              timeout: step.timeout * 1000,
              windowsHide: true,
              shell: false,  // 禁用 shell 防止注入
            })
            let stdout = ''
            let stderr = ''
            child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
            child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
            child.on('error', reject)
            child.on('close', (code) => {
              if (code !== 0) reject(new Error(stderr.trim() || `exit code ${code}`))
              else resolve(stdout.trim() || '(无输出)')
            })
          })
          return { success: true, result: `${prefix}${attemptLabel} 命令执行成功: ${output}` }
        }
        case 'send_message': {
          const notification = new Notification({ title: '自动化任务', body: step.params })
          notification.show()
          return { success: true, result: `${prefix}${attemptLabel} 已发送通知: ${step.params}` }
        }
        case 'wait': {
          const waitMs = (step.timeout || 1) * 1000
          await new Promise<void>(resolve => setTimeout(resolve, waitMs))
          return { success: true, result: `${prefix}${attemptLabel} 等待 ${step.timeout || 1} 秒完成` }
        }
        case 'condition': {
          const expr = step.params.trim()
          let conditionResult = false
          try {
            const match = expr.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/)
            if (match) {
              const [, left, op, right] = match
              const lv = isNaN(Number(left)) ? left : Number(left)
              const rv = isNaN(Number(right)) ? right : Number(right)
              switch (op) {
                case '==': conditionResult = lv === rv; break
                case '!=': conditionResult = lv !== rv; break
                case '>=': conditionResult = Number(lv) >= Number(rv); break
                case '<=': conditionResult = Number(lv) <= Number(rv); break
                case '>': conditionResult = Number(lv) > Number(rv); break
                case '<': conditionResult = Number(lv) < Number(rv); break
              }
            }
          } catch { /* ignore eval errors */ }
          if (!conditionResult) {
            return { success: false, result: `${prefix} 条件不满足"${expr}"，终止序列` }
          }
          return { success: true, result: `${prefix}${attemptLabel} 条件判断 "${expr}" => true` }
        }
        default:
          return { success: false, result: `${prefix} 未知操作类型: ${(step as any).action}` }
      }
    } catch (err: any) {
      lastError = err?.message || String(err)
      if (attempt < maxRetries) {
        const delayS = retryDelay * Math.pow(2, attempt)
        await new Promise<void>(r => setTimeout(r, delayS * 1000))
        continue
      }
    }
  }

  // 重试耗尽，走 fallback
  const fallback = step.fallbackAction ?? 'abort'
  if (fallback === 'skip') {
    return { success: true, result: `${prefix} 失败已跳过: ${lastError}` }
  }
  return { success: false, result: `${prefix} 执行失败(已重试${maxRetries}次): ${lastError}` }
}

async function runSequence(steps: SequenceStep[]): Promise<{ success: boolean; results: string[] }> {
  const results: string[] = []
  for (let i = 0; i < steps.length; i++) {
    const { success, result } = await executeStepWithRetry(steps[i], i, steps.length)
    results.push(result)
    if (!success) {
      return { success: false, results }
    }
  }
  return { success: true, results }
}

/* ========== Trigger Condition Parsing & Scheduling ========== */

interface ParsedTrigger {
  kind: 'once' | 'daily' | 'weekly' | 'monthly' | 'cron'
  when?: Date            // once: 具体时间
  time?: string          // daily/weekly/monthly: HH:mm
  dayOfWeek?: number     // weekly: 0-6
  dayOfMonth?: number    // monthly: 1-31
  cron?: string          // cron: 5 字段表达式
}

function parseTriggerCondition(cond: string | undefined): ParsedTrigger | null {
  if (!cond) return null
  const c = cond.trim()
  if (c.startsWith('at:')) {
    const d = new Date(c.slice(3))
    if (!isNaN(d.getTime())) return { kind: 'once', when: d }
    return null
  }
  if (c.startsWith('daily:')) {
    const time = c.slice(6)
    if (/^\d{1,2}:\d{2}$/.test(time)) return { kind: 'daily', time }
    return null
  }
  if (c.startsWith('weekly:')) {
    const m = c.match(/^weekly:(\d):(\d{1,2}:\d{2})$/)
    if (m) return { kind: 'weekly', dayOfWeek: Number(m[1]), time: m[2] }
    return null
  }
  if (c.startsWith('monthly:')) {
    const m = c.match(/^monthly:(\d{1,2}):(\d{1,2}:\d{2})$/)
    if (m) return { kind: 'monthly', dayOfMonth: Number(m[1]), time: m[2] }
    return null
  }
  // 兼容纯 5 字段 cron 表达式
  if (/^[\d*,\-/]+\s+[\d*,\-/]+\s+[\d*,\-/]+\s+[\d*,\-/]+\s+[\d*,\-/]+$/.test(c)) {
    return { kind: 'cron', cron: c }
  }
  return null
}

function cronFieldMatches(value: number, field: string): boolean {
  if (field === '*') return true
  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [base, stepStr] = part.split('/')
      const step = Number(stepStr)
      if (base === '*') { if (value % step === 0) return true; continue }
      const [a, b] = base.split('-').map(Number)
      const start = a ?? 0
      const end = b ?? start
      if (value >= start && value <= end && (value - start) % step === 0) return true
    } else if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number)
      if (value >= a && value <= b) return true
    } else if (Number(part) === value) {
      return true
    }
  }
  return false
}

function triggerMatchesNow(t: ParsedTrigger, now: Date): boolean {
  const minute = now.getMinutes()
  const hour = now.getHours()
  const day = now.getDate()
  const month = now.getMonth() + 1
  const dow = now.getDay()
  switch (t.kind) {
    case 'once':
      return !!t.when && t.when.getTime() <= now.getTime() && now.getTime() - t.when.getTime() < 60_000
    case 'daily': {
      if (!t.time) return false
      const [h, m] = t.time.split(':').map(Number)
      return hour === h && minute === m
    }
    case 'weekly': {
      if (t.dayOfWeek === undefined || !t.time) return false
      if (dow !== t.dayOfWeek) return false
      const [h, m] = t.time.split(':').map(Number)
      return hour === h && minute === m
    }
    case 'monthly': {
      if (t.dayOfMonth === undefined || !t.time) return false
      if (day !== t.dayOfMonth) return false
      const [h, m] = t.time.split(':').map(Number)
      return hour === h && minute === m
    }
    case 'cron': {
      if (!t.cron) return false
      const parts = t.cron.trim().split(/\s+/)
      if (parts.length !== 5) return false
      return cronFieldMatches(minute, parts[0]) &&
        cronFieldMatches(hour, parts[1]) &&
        cronFieldMatches(day, parts[2]) &&
        cronFieldMatches(month, parts[3]) &&
        cronFieldMatches(dow, parts[4])
    }
    default:
      return false
  }
}

function computeNextRun(t: ParsedTrigger, from: Date): string {
  const d = new Date(from)
  // M-09 修复：搜索范围从 370 天缩减到 7 天，避免主进程长阻塞
  const MAX_MINUTES = 60 * 24 * 7
  for (let i = 0; i < MAX_MINUTES; i++) {
    d.setSeconds(0, 0)
    if (triggerMatchesNow(t, d) && d.getTime() > from.getTime()) {
      return d.toLocaleString()
    }
    d.setMinutes(d.getMinutes() + 1)
  }
  // 7 天内无匹配（如特殊 Cron），返回默认明天
  return new Date(from.getTime() + 24 * 3600_000).toLocaleString()
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null

function executeTaskPayload(task: TaskCard): Promise<{ success: boolean; result: string }> {
  if (task.steps && task.steps.length > 0) {
    return runSequence(task.steps).then(r => ({
      success: r.success,
      result: r.results.join('\n')
    }))
  }
  // 无步骤任务：作为提醒通知
  const notification = new Notification({
    title: task.name || '自动化任务',
    body: task.description || '定时任务触发',
    silent: false
  })
  notification.show()
  return Promise.resolve({ success: true, result: `已发送提醒: ${task.description || task.name}` })
}

function startScheduler(): void {
  if (schedulerTimer) return
  // M-08 修复：轮询改为异步读取，不再同步阻塞主进程
  schedulerTimer = setInterval(async () => {
    try {
      const now = new Date()
      const tasks = await loadAllAsync()
      for (const t of tasks) {
        if (!t.enabled) continue
        const parsed = parseTriggerCondition(t.triggerCondition ?? t.cron)
        if (!parsed) continue
        if (!triggerMatchesNow(parsed, now)) continue
        // 到点执行
        executeTaskPayload(t).then(res => {
          t.lastRun = new Date().toLocaleString()
          t.runCount = (t.runCount || 0) + 1
          t.lastStatus = res.success ? 'success' : 'failed'
          if (parsed.kind === 'once') {
            // 一次性任务执行后自动停用
            t.enabled = false
            t.status = 'stopped'
          } else {
            t.status = res.success ? 'running' : 'error'
          }
          const nextParsed = parseTriggerCondition(t.triggerCondition ?? t.cron)
          t.nextRun = nextParsed ? computeNextRun(nextParsed, new Date()) : '--'
          saveOne(t)
        }).catch(() => {
          t.lastRun = new Date().toLocaleString()
          t.lastStatus = 'failed'
          t.status = 'error'
          saveOne(t)
        })
      }
    } catch (e) {
      // 调度器自身异常不影响主进程
    }
  }, 30_000)
}

/* ========== IPC Registration ========== */
export function setupAutomationHandlers(): void {
  startScheduler()
  ipcMain.handle('automation:list', () => { try { return loadAll() } catch (e) { return [] } })

  ipcMain.handle('automation:save', (_e, task: TaskCard) => { try { saveOne(task); return true } catch (e) { return false } })

  ipcMain.handle('automation:delete', (_e, id: string) => { try { deleteOne(id); return true } catch (e) { return false } })

  ipcMain.handle('automation:toggle', (_e, id: string, enabled: boolean) => { try { const tasks = loadAll(); const t = tasks.find(x => x.id === id); if (t) { t.enabled = enabled; saveOne(t) }; return true } catch (e) { return false } })

  // D1: 智能分类
  ipcMain.handle('automation:classify', (_e, description: string) => {
    try { return classifyDescription(description) } catch { return 'other' }
  })

  // D2: 序列任务执行
  ipcMain.handle('automation:run-sequence', async (_e, steps: SequenceStep[]) => {
    try {
      if (!Array.isArray(steps) || steps.length === 0) {
        return { success: false, results: ['无步骤可执行'] }
      }
      return await runSequence(steps)
    } catch (e: any) {
      return { success: false, results: [`序列执行异常: ${e?.message || String(e)}`] }
    }
  })

  // 启用任务（渲染层 automation:start 断链修复）
  ipcMain.handle('automation:start', (_e, id: string) => {
    try {
      const tasks = loadAll()
      const t = tasks.find(x => x.id === id)
      if (!t) return { success: false, error: '任务不存在' }
      t.enabled = true
      t.status = 'running'
      saveOne(t)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: `启用失败: ${e?.message || String(e)}` }
    }
  })

  // 停用任务（渲染层 automation:stop 断链修复）
  ipcMain.handle('automation:stop', (_e, id: string) => {
    try {
      const tasks = loadAll()
      const t = tasks.find(x => x.id === id)
      if (!t) return { success: false, error: '任务不存在' }
      t.enabled = false
      t.status = 'stopped'
      saveOne(t)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: `停用失败: ${e?.message || String(e)}` }
    }
  })

  // 立即执行（渲染层 automation:execute 断链修复）
  ipcMain.handle('automation:execute', async (_e, id: string) => {
    try {
      const tasks = loadAll()
      const t = tasks.find(x => x.id === id)
      if (!t) return { success: false, error: '任务不存在' }
      const result = await executeTaskPayload(t)
      t.lastRun = new Date().toLocaleString()
      t.runCount = (t.runCount || 0) + 1
      t.lastStatus = result.success ? 'success' : 'failed'
      saveOne(t)
      return { success: result.success, error: result.success ? undefined : result.result || '部分步骤执行失败' }
    } catch (e: any) {
      return { success: false, error: `执行异常: ${e?.message || String(e)}` }
    }
  })
}
