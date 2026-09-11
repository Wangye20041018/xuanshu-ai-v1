import { ipcMain, BrowserWindow, screen, dialog } from 'electron'
import { exec } from 'child_process'
import { promisify } from 'util'
import { POWERSHELL_EXE } from '../utils/powershell'
import { logger } from '../../shared/logger'
import { notifyControlStart, notifyControlFinish } from '../control-state'
import * as visualAgentModule from '../visual-agent'
import { UIAExecutor, UIAScanner, VisionQualityInspector } from '../ui-automation'
import { commandPolicy } from '../permission/command-policy'
import { authorization } from '../permission/authorization'

const execAsync = promisify(exec)

/** 子进程默认超时与输出上限（防止僵尸进程与内存泄漏） */
const SPAWN_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

// C-05 修复：spawn + shell:false + 参数数组执行白名单命令，杜绝 cmd.exe 元字符注入
function runSpawn(exe: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process') as any
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      if (!settled) { settled = true; reject(new Error('命令执行超时')) }
    }, SPAWN_TIMEOUT_MS)
    child.stdout.on('data', (d: Buffer) => { if (stdout.length < MAX_OUTPUT_BYTES) stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < MAX_OUTPUT_BYTES) stderr += d.toString() })
    child.on('close', (code: number) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr || `Exit code: ${code}`))
    })
    child.on('error', (err: Error) => {
      clearTimeout(timer)
      if (!settled) { settled = true; reject(err) }
    })
  })
}

/** UIA 变更类命令二次确认（ui-execute / ui-click / ui-type） */
async function confirmUIAction(actionLabel: string, detail: string): Promise<boolean> {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return false
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: '电脑控制确认',
      message: `玄枢即将执行「${actionLabel}」`,
      detail: `${detail}\n该操作会直接作用于您的电脑。如非本人发起，请点击取消。`,
      buttons: ['允许', '取消'],
      defaultId: 1,
      cancelId: 1,
    })
    return response === 0
  } catch {
    return false
  }
}

export function setupSystemControlHandlers(): void {
  ipcMain.handle('system:control:get-desktop-info', async (): Promise<{ width: number; height: number; scaleFactor: number }> => {
    try {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      if (win) {
        const primaryDisplay = screen.getPrimaryDisplay()
        return {
          width: primaryDisplay.size.width,
          height: primaryDisplay.size.height,
          scaleFactor: primaryDisplay.scaleFactor
        }
      }
      return { width: 1920, height: 1080, scaleFactor: 1 }
    } catch {
      return { width: 1920, height: 1080, scaleFactor: 1 }
    }
  })

  ipcMain.handle('system:control:get-active-window', async (): Promise<{ title: string; screenWidth: number; screenHeight: number }> => {
    try {
      const { stdout } = await execAsync(
        `"${POWERSHELL_EXE}" -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width"`
      )
      // 使用更简单的方法获取前台窗口标题
      const { stdout: titleOut } = await execAsync(
        `"${POWERSHELL_EXE}" -Command "(Get-Process | Where-Object {$_.MainWindowTitle -ne ''}).MainWindowTitle | Select-Object -First 1"`
      )
      return {
        title: titleOut.trim(),
        screenWidth: parseInt(stdout.trim(), 10) || 1920,
        screenHeight: 1080,
      }
    } catch (e) {
      return { title: '', screenWidth: 1920, screenHeight: 1080 }
    }
  })

  ipcMain.handle('system:control:take-screenshot', async (event): Promise<{ success: boolean; data?: string; error?: string }> => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) {
        return { success: false, error: 'No window found' }
      }
      const image = await win.webContents.capturePage()
      const base64 = image.toPNG().toString('base64')
      return { success: true, data: base64 }
    } catch (error) {
      logger.error('system:control:take-screenshot 内部错误:', error)
      return { success: false, error: '系统控制遇到内部错误' }
    }
  })

  ipcMain.handle('system:control:execute-command', async (_event, command: string): Promise<{ success: boolean; output?: string; error?: string }> => {
    try {
      // v10.4 UI Automation 命令路由（UIA 主力 + 视觉兜底 + 质检）
      // 架构：UIA 主力通路 → 失败视觉兜底 → 视觉质检 → 完整报告
      const uiaCommands = ['ui-scan', 'ui-click', 'ui-type', 'ui-execute', 'ui-inspect']
      const [cmdKey, ...cmdArgs] = command.trim().split(/\s+/)

      // v10.4: 路由 UI Automation 命令
      if (uiaCommands.includes(cmdKey)) {
        let payload: any
        try {
          payload = cmdArgs.length > 0 ? JSON.parse(cmdArgs.join(' ')) : {}
        } catch {
          return { success: false, error: '无效的 UIA 命令参数（需为合法 JSON）' }
        }
        let result: any
        switch (cmdKey) {
          case 'ui-scan':
            result = UIAScanner.scanWindow(payload.windowTitle)
            return { success: true, output: JSON.stringify(result) }

          case 'ui-click': {
            if (!(await confirmUIAction('点击', `目标：${payload.target} 窗口：${payload.windowTitle || '当前'}`))) {
              return { success: false, error: '用户已取消操作' }
            }
            notifyControlStart('UI 点击')
            try {
              result = UIAExecutor.click(payload.target, payload.windowTitle)
              return { success: result.success, output: JSON.stringify(result) }
            } finally {
              notifyControlFinish()
            }
          }

          case 'ui-type': {
            if (!(await confirmUIAction('键盘输入', `目标：${payload.target}`))) {
              return { success: false, error: '用户已取消操作' }
            }
            notifyControlStart('UI 输入')
            try {
              result = UIAExecutor.typeText(payload.target, payload.text, payload.windowTitle)
              return { success: result.success, output: JSON.stringify(result) }
            } finally {
              notifyControlFinish()
            }
          }

          // --- v10.4 新增命令 ---

          case 'ui-execute':
            // 主命令：UIA 执行 → 失败视觉兜底 → 视觉质检 → 返回完整报告
            // payload: { action, target, fallbackDescription, text, windowTitle, expectedState }
            if (!(await confirmUIAction('执行自动化', `动作：${payload.action} 目标：${payload.target}`))) {
              return { success: false, error: '用户已取消操作' }
            }
            notifyControlStart('自动化执行')
            try {
              result = await UIAExecutor.executeWithFallback(
                payload.target,
                payload.action,
                payload.fallbackDescription,
                payload.text,
                payload.windowTitle
              )

              // 如果指定了 expectedState，追加视觉质检
              if (payload.expectedState && result.success) {
                const qualityResult = await VisionQualityInspector.inspect(payload.expectedState)
                return {
                  success: qualityResult.passed,
                  output: JSON.stringify({
                    operation: result,
                    quality: qualityResult
                  })
                }
              }

              return { success: result.success, output: JSON.stringify(result) }
            } finally {
              notifyControlFinish()
            }

          case 'ui-inspect':
            // 纯视觉质检（不执行操作）
            result = await VisionQualityInspector.inspect(
              payload.expectedState,
              payload.beforeScreenshot
            )
            return { success: result.passed, output: JSON.stringify(result) }
        }
      }

      // 动态命令策略（白名单 → 动态命令策略 + 受信命令区）
      // 统一评估入口 evaluateCommand() 判定 builtin / trusted / deny。
      // 安全底线保留：所有命令最终仍走 spawn + shell:false + 参数数组执行，
      // 不拼接 shell 字符串，杜绝 & | ; $ ` 等元字符注入。
      const decision = commandPolicy.evaluateCommand(command)

      if (decision.type === 'deny') {
        authorization.log({ channel: 'system-control', action: 'execute-command', decision: 'deny', detail: decision.reason })
        return { success: false, error: decision.reason }
      }

      // 级别 >= 2（需确认）时二次确认；授权设置页可调级别
      if (decision.level >= 2) {
        const label = decision.type === 'trusted'
          ? `执行受信命令「${decision.command.name}」`
          : `执行命令「${decision.cmdKey}」`
        const detail = decision.type === 'trusted'
          ? `${decision.command.exe} ${decision.command.args.join(' ')}`
          : cmdKey
        if (!(await confirmUIAction(label, detail))) {
          authorization.log({ channel: 'system-control', action: 'execute-command', decision: 'deny', detail: `用户取消: ${detail}` })
          return { success: false, error: '用户已取消操作' }
        }
      }

      // 受信命令区：可执行文件 + 固定参数数组，spawn + shell:false
      if (decision.type === 'trusted') {
        const tc = decision.command
        try {
          const { stdout, stderr } = await runSpawn(tc.exe, tc.args)
          authorization.log({
            channel: 'system-control', action: 'execute-command', level: tc.level,
            decision: 'allow', detail: `受信命令 ${tc.name} → ${tc.exe} ${tc.args.join(' ')}`,
          })
          return { success: true, output: stdout || stderr || `已执行: ${tc.name}` }
        } catch (err: any) {
          authorization.log({
            channel: 'system-control', action: 'execute-command', level: tc.level,
            decision: 'deny', detail: `受信命令执行失败 ${tc.name}: ${err?.message || String(err)}`,
          })
          return { success: false, error: `受信命令执行失败: ${err?.message || String(err)}` }
        }
      }

      // 内置命令（默认放行，级别可在授权设置页调整）
      switch (decision.cmdKey) {
        case 'open-url': {
          const url = cmdArgs.join('')
          if (!/^https?:\/\//i.test(url)) {
            return { success: false, error: 'Invalid URL (仅允许 http/https)' }
          }
          const { shell } = require('electron') as any
          await shell.openExternal(url)
          authorization.log({ channel: 'system-control', action: 'execute-command', level: decision.level, decision: 'allow', detail: `打开链接 ${url}` })
          return { success: true, output: `已打开: ${url}` }
        }
        case 'get-system-info': {
          const { stdout, stderr } = await runSpawn('systeminfo', [])
          authorization.log({ channel: 'system-control', action: 'execute-command', level: decision.level, decision: 'allow', detail: '查询系统信息' })
          return { success: true, output: stdout || stderr }
        }
        case 'get-disk-space': {
          const { stdout, stderr } = await runSpawn(POWERSHELL_EXE, [
            '-NoProfile',
            '-Command',
            'Get-CimInstance Win32_LogicalDisk | Select-Object Caption,Size,FreeSpace | Format-Table -AutoSize',
          ])
          authorization.log({ channel: 'system-control', action: 'execute-command', level: decision.level, decision: 'allow', detail: '查询磁盘空间' })
          return { success: true, output: stdout || stderr }
        }
        case 'check-port': {
          const port = cmdArgs[0] || ''
          if (!/^\d{1,5}$/.test(port)) {
            return { success: false, error: 'Invalid port (仅允许数字端口)' }
          }
          const { stdout } = await runSpawn('netstat', ['-ano'])
          const lines = stdout
            .split(/\r?\n/)
            .filter(l => l.includes(`:${port}`) && /LISTENING|ESTABLISHED/.test(l))
          authorization.log({ channel: 'system-control', action: 'execute-command', level: decision.level, decision: 'allow', detail: `检查端口 ${port}` })
          return { success: true, output: lines.join('\n') || `未找到端口 ${port} 的监听/连接` }
        }
        default:
          return { success: false, error: 'Command not allowed. Only whitelisted commands are permitted.' }
      }
    } catch (error) {
      logger.error('system:control:execute-command 内部错误:', error)
      return { success: false, error: '系统控制遇到内部错误' }
    }
  })

  /* ------ T04: visual-agent IPC 通道 ------ */
  ipcMain.handle('system:control:visual-execute', async (_event, task: any) => {
    try {
      const va = visualAgentModule
      // visualAgent.executeTask 内部已包含人工确认门 + 控制状态广播，无需在此重复
      return await va.visualAgent.executeTask(task)
    } catch (e: any) {
      logger.error('system:control:visual-execute 内部错误:', e)
      return { success: false, steps: [], error: '视觉代理遇到内部错误', screenshot: null }
    }
  })

  ipcMain.handle('system:control:visual-state', () => {
    try {
      const { visualAgent } = require('../visual-agent')
      return { status: visualAgent?.currentTask ? 'busy' : 'idle', taskId: visualAgent?.currentTask?.id || null }
    } catch {
      return { status: 'idle', taskId: null }
    }
  })
}
