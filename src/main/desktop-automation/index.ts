/**
 * 桌面自动化桥接 — Electron 主进程 ↔ Python desktop_automation.py
 *
 * 产品级安全加固：
 *  - execPython 统一超时 / 输出上限 / 子进程清理，杜绝僵尸进程与内存泄漏
 *  - 高危操作（提权、注册表写删、服务启停、进程结束、计划任务、环境变量）需管理员校验 + 用户二次确认
 *  - 控制类操作通过 control-state 广播驱动全屏「控制电脑」特效
 */
import { ipcMain, app, dialog, BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'
import { getPortableDepotPath } from '../utils/resource-resolver'
import { permissionManager } from '../permission'
import { notifyControlStart, notifyControlFinish } from '../control-state'
import { logger } from '../../shared/logger'

/** 子进程默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 60_000
/** stdout/stderr 累计上限，防止恶意脚本刷爆内存 */
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024

function getPaths(): { python: string; script: string } | null {
  const portableDepot = getPortableDepotPath()
  const candidates = [
    { python: join(process.resourcesPath, 'python/python.exe'), script: join(process.resourcesPath, 'python/desktop_automation.py') },
    { python: join(__dirname, '../../../resources/python/python.exe'), script: join(__dirname, '../../../resources/python/desktop_automation.py') },
    { python: join(__dirname, '../../../../resources/python/python.exe'), script: join(__dirname, '../../../../resources/python/desktop_automation.py') }
  ]
  if (portableDepot) {
    candidates.push({ python: join(portableDepot, 'python/python.exe'), script: join(portableDepot, 'python/desktop_automation.py') })
  }
  for (const c of candidates) {
    if (existsSync(c.python) && existsSync(c.script)) {
      return c
    }
  }
  return null
}

interface ExecOptions {
  /** 非空表示这是一个「控制电脑」动作，用于驱动特效 overlay */
  control?: string
  timeoutMs?: number
}

function execPython(cmd: string, args: string[], opts: ExecOptions = {}): Promise<{ success: boolean; data?: any; error?: string }> {
  return new Promise((resolve) => {
    const paths = getPaths()
    if (!paths) {
      resolve({ success: false, error: 'desktop_automation.py 或 python.exe 未找到' })
      return
    }
    const allArgs = [paths.script, cmd, ...args]
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(paths.python, allArgs, { windowsHide: true })
    } catch (err: any) {
      resolve({ success: false, error: `启动失败: ${err?.message || err}` })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (result: { success: boolean; data?: any; error?: string }) => {
      if (settled) return
      settled = true
      if (opts.control) notifyControlFinish()
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    timer = setTimeout(() => {
      logger.warn(`[DesktopAutomation] 子进程超时(${opts.timeoutMs || DEFAULT_TIMEOUT_MS}ms)，强制终止: ${cmd}`)
      try { proc.kill() } catch { /* 已退出 */ }
      finish({ success: false, error: `操作超时（${opts.timeoutMs || DEFAULT_TIMEOUT_MS}ms）：${cmd}` })
    }, opts.timeoutMs || DEFAULT_TIMEOUT_MS)

    if (opts.control) notifyControlStart(opts.control)

    proc.stdout!.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += d.toString('utf-8')
    })
    proc.stderr!.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += d.toString('utf-8')
    })
    proc.on('error', (err) => {
      finish({ success: false, error: err.message })
    })
    proc.on('close', (code) => {
      if (code !== 0) {
        finish({ success: false, error: (stderr || `退出码 ${code}`).slice(0, 2000) })
        return
      }
      try {
        const data = stdout.trim() ? JSON.parse(stdout.trim() || '{}') : {}
        finish({ success: true, data })
      } catch {
        finish({ success: true, data: stdout.trim() || 'ok' })
      }
    })
  })
}

/* ==================== 高危操作防护 ==================== */

/** 高危动作元信息：label 用于确认对话框，needsAdmin 表示需要管理员权限 */
interface RiskMeta {
  label: string
  needsAdmin: boolean
}

const RISK_ACTIONS: Record<string, RiskMeta> = {
  'desktop-automation:elevate-self': { label: '以管理员身份重启玄枢', needsAdmin: false },
  'desktop-automation:run-elevated': { label: '以管理员身份运行程序', needsAdmin: false },
  'desktop-automation:registry-write': { label: '写入注册表', needsAdmin: true },
  'desktop-automation:registry-delete': { label: '删除注册表项', needsAdmin: true },
  'desktop-automation:service-start': { label: '启动系统服务', needsAdmin: true },
  'desktop-automation:service-stop': { label: '停止系统服务', needsAdmin: true },
  'desktop-automation:process-kill': { label: '结束进程', needsAdmin: false },
  'desktop-automation:task-schedule': { label: '创建计划任务', needsAdmin: true },
  'desktop-automation:env-var-set': { label: '修改环境变量', needsAdmin: false },
}

/** 校验当前是否具备管理员权限（失败时返回 false，由调用方给出明确错误） */
async function requireAdminFor(channel: string): Promise<boolean> {
  const meta = RISK_ACTIONS[channel]
  if (!meta?.needsAdmin) return true
  try {
    const isAdmin = await permissionManager.checkAdminPermission()
    if (!isAdmin) {
      logger.warn(`[DesktopAutomation] 拒绝执行 ${channel}：当前无管理员权限`)
      return false
    }
    return true
  } catch {
    return false
  }
}

/** 弹窗二次确认。无可用窗口时默认拒绝，避免无人值守情况下的高危操作。 */
async function confirmRisk(channel: string, extraDetail = ''): Promise<boolean> {
  const meta = RISK_ACTIONS[channel]
  if (!meta) return true
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) {
    logger.warn(`[DesktopAutomation] 无可用窗口，拒绝高危操作: ${channel}`)
    return false
  }
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: '电脑控制确认',
      message: `玄枢即将「${meta.label}」`,
      detail: [
        '该操作会直接作用于您的电脑。',
        extraDetail,
        '如非本人发起，请点击“取消”并检查应用安全。',
      ].filter(Boolean).join('\n'),
      buttons: ['允许', '取消'],
      defaultId: 1,
      cancelId: 1,
    })
    return response === 0
  } catch (e) {
    logger.error(`[DesktopAutomation] 确认对话框异常，拒绝执行: ${e}`)
    return false
  }
}

/** 高危通道统一防护：管理员校验 + 二次确认。返回通过状态与说明。 */
async function guardRisk(channel: string, extraDetail?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await requireAdminFor(channel))) {
    return { ok: false, error: '该操作需要管理员权限，请以管理员身份重启玄枢' }
  }
  if (!(await confirmRisk(channel, extraDetail))) {
    return { ok: false, error: '用户已取消操作' }
  }
  return { ok: true }
}

export function setupDesktopAutomationHandlers(): void {
  /* ── 只读 / 被动查询（无需确认与管理权限）── */

  ipcMain.handle('desktop-automation:get-screen-size', async () => {
    return await execPython('get_screen_size', [])
  })

  ipcMain.handle('desktop-automation:get-virtual-screen', async () => {
    return await execPython('get_virtual_screen', [])
  })

  ipcMain.handle('desktop-automation:admin-status', async () => {
    return await execPython('admin_status', [])
  })

  ipcMain.handle('desktop-automation:find-window', async (_e, title?: string) => {
    return await execPython('find_window', title ? [title] : [])
  })

  ipcMain.handle('desktop-automation:find-windows', async (_e, title: string) => {
    return await execPython('find_windows', [title])
  })

  ipcMain.handle('desktop-automation:capture-window', async (_e, hwnd: number, filepath?: string) => {
    const target = filepath || join(app.getPath('userData'), 'screenshots', `shot-${Date.now()}.png`)
    return await execPython('capture_window', [String(hwnd), target])
  })

  ipcMain.handle('desktop-automation:find-on-screen', async (_e, templatePath: string, confidence?: number) => {
    const args = [templatePath]
    if (confidence) args.push(String(confidence))
    return await execPython('find_on_screen', args)
  })

  ipcMain.handle('desktop-automation:get-active-window', async () => {
    return await execPython('get_active_window', [])
  })

  ipcMain.handle('desktop-automation:service-list', async () => {
    return await execPython('service_list', [])
  })

  ipcMain.handle('desktop-automation:service-status', async (_e, name: string) => {
    return await execPython('service_status', [name])
  })

  ipcMain.handle('desktop-automation:registry-read', async (_e, key: string, subkey: string, name?: string) => {
    const cmdArgs = [key, subkey]
    if (name) cmdArgs.push(name)
    return await execPython('registry_read', cmdArgs)
  })

  ipcMain.handle('desktop-automation:ocr-image', async (_e, imagePath: string) => {
    return await execPython('ocr_image', [imagePath])
  })

  ipcMain.handle('desktop-automation:status', () => {
    const paths = getPaths()
    return {
      available: !!paths,
      pythonPath: paths?.python || null,
      scriptPath: paths?.script || null
    }
  })

  /* ── 控制类（驱动全屏特效，但无需逐次确认）── */

  ipcMain.handle('desktop-automation:click-at', async (_e, x: number, y: number, hwnd?: number) => {
    const args = [String(x), String(y)]
    if (hwnd) args.push(String(hwnd))
    return await execPython('click_at', args, { control: '点击屏幕' })
  })

  ipcMain.handle('desktop-automation:type-text', async (_e, text: string) => {
    return await execPython('type_text', [text], { control: '键盘输入' })
  })

  ipcMain.handle('desktop-automation:send-keys', async (_e, keys: string) => {
    return await execPython('send_keys', [keys], { control: '发送按键' })
  })

  ipcMain.handle('desktop-automation:open-app', async (_e, appPath: string) => {
    return await execPython('open_app', [appPath], { control: '打开应用' })
  })

  ipcMain.handle('desktop-automation:show-desktop', async () => {
    return await execPython('show_desktop', [], { control: '显示桌面' })
  })

  ipcMain.handle('desktop-automation:lock-screen', async () => {
    return await execPython('lock_screen', [], { control: '锁定屏幕' })
  })

  ipcMain.handle('desktop-automation:set-volume', async (_e, level: number) => {
    return await execPython('set_volume', [String(level)], { control: '调节音量' })
  })

  /* ── 高危系统级底层权限（电脑的魂，需确认/管理员）── */

  ipcMain.handle('desktop-automation:elevate-self', async () => {
    const guard = await guardRisk('desktop-automation:elevate-self')
    if (!guard.ok) return { success: false, error: guard.error }
    return await execPython('elevate_self', [], { control: '提权重启应用' })
  })

  ipcMain.handle('desktop-automation:run-elevated', async (_e, path: string, args?: string) => {
    const guard = await guardRisk('desktop-automation:run-elevated', `程序：${path}`)
    if (!guard.ok) return { success: false, error: guard.error }
    const cmdArgs = [path]
    if (args) cmdArgs.push(args)
    return await execPython('run_elevated', cmdArgs, { control: `以管理员运行 ${path}` })
  })

  ipcMain.handle('desktop-automation:registry-write', async (_e, key: string, subkey: string, name: string, value: string, valueType?: string) => {
    const guard = await guardRisk('desktop-automation:registry-write', `${key}\\${subkey} ${name}`)
    if (!guard.ok) return { success: false, error: guard.error }
    const cmdArgs = [key, subkey, name, value]
    if (valueType) cmdArgs.push(valueType)
    return await execPython('registry_write', cmdArgs, { control: '写入注册表' })
  })

  ipcMain.handle('desktop-automation:registry-delete', async (_e, key: string, subkey: string, name?: string) => {
    if (!(await requireAdminFor('desktop-automation:registry-delete'))) {
      return { success: false, error: '该操作需要管理员权限' }
    }
    if (!(await confirmRisk('desktop-automation:registry-delete', `${key}\\${subkey} ${name || ''}`))) {
      return { success: false, error: '用户已取消操作' }
    }
    const cmdArgs = [key, subkey]
    if (name) cmdArgs.push(name)
    return await execPython('registry_delete', cmdArgs, { control: '删除注册表项' })
  })

  ipcMain.handle('desktop-automation:service-start', async (_e, name: string) => {
    if (!(await requireAdminFor('desktop-automation:service-start'))) {
      return { success: false, error: '该操作需要管理员权限' }
    }
    if (!(await confirmRisk('desktop-automation:service-start', `服务：${name}`))) {
      return { success: false, error: '用户已取消操作' }
    }
    return await execPython('service_start', [name], { control: `启动服务 ${name}` })
  })

  ipcMain.handle('desktop-automation:service-stop', async (_e, name: string) => {
    if (!(await requireAdminFor('desktop-automation:service-stop'))) {
      return { success: false, error: '该操作需要管理员权限' }
    }
    if (!(await confirmRisk('desktop-automation:service-stop', `服务：${name}`))) {
      return { success: false, error: '用户已取消操作' }
    }
    return await execPython('service_stop', [name], { control: `停止服务 ${name}` })
  })

  ipcMain.handle('desktop-automation:env-var-set', async (_e, name: string, value: string, scope?: string) => {
    if (!(await confirmRisk('desktop-automation:env-var-set', `变量：${name}=${value} (${scope || 'USER'})`))) {
      return { success: false, error: '用户已取消操作' }
    }
    const cmdArgs = [name, value]
    if (scope) cmdArgs.push(scope)
    return await execPython('env_var_set', cmdArgs, { control: '修改环境变量' })
  })

  ipcMain.handle('desktop-automation:process-kill', async (_e, target: string) => {
    if (!(await confirmRisk('desktop-automation:process-kill', `目标：${target}`))) {
      return { success: false, error: '用户已取消操作' }
    }
    return await execPython('process_kill', [target], { control: `结束进程 ${target}` })
  })

  ipcMain.handle('desktop-automation:task-schedule', async (_e, name: string, command: string, trigger?: string, time?: string) => {
    if (!(await requireAdminFor('desktop-automation:task-schedule'))) {
      return { success: false, error: '该操作需要管理员权限' }
    }
    if (!(await confirmRisk('desktop-automation:task-schedule', `任务：${name} → ${command}`))) {
      return { success: false, error: '用户已取消操作' }
    }
    const cmdArgs = [name, command, trigger || 'daily']
    if (time) cmdArgs.push(time)
    return await execPython('task_schedule', cmdArgs, { control: '创建计划任务' })
  })
}