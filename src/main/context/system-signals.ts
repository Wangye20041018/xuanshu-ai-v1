/**
 * system-signals.ts — 系统信号源（M1 零成本通道）
 *
 * 通过常驻 PowerShell 轮询 user32（GetLastInputInfo / GetForegroundWindow），
 * 将键鼠活动、空闲、前台窗口事件注入感官总线：
 * - input：用户输入活动（触发 present/focus）
 * - idle：长时间无输入（触发 absent/distracted 倾向）
 * - window：前台窗口切换（触发 video_watching/meeting/focus 情境）
 *
 * 常驻进程生命周期与情境引擎一致，stop() 时终止。
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import path from 'path'
import { sensoryBus } from './sensory-bus'
import { createLogger } from '../../shared/logger'
import { app } from 'electron'

const logger = createLogger('SystemSignals')

interface SignalLine {
  idle: number
  window: string
}

const IDLE_THRESHOLD_MS = 60_000

export class SystemSignals {
  private proc: ChildProcessWithoutNullStreams | null = null
  private lastWindow = ''
  private lastIdle = 0
  private running = false

  start(): void {
    if (this.running) return
    this.running = true

    // 优先使用 extraResources 目录（打包后），开发环境回退到项目 resources
    const candidates = [
      path.join(process.resourcesPath ?? '', 'scripts', 'context-signals.ps1'),
      path.join(app.getAppPath(), 'resources', 'scripts', 'context-signals.ps1'),
      path.join(app.getAppPath(), '..', 'resources', 'scripts', 'context-signals.ps1'),
    ]
    let scriptPath = candidates.find((p) => {
      try { return require('fs').existsSync(p) } catch { return false }
    })
    if (!scriptPath) {
      // 最后兜底：开发目录
      scriptPath = path.join(app.getAppPath(), 'resources', 'scripts', 'context-signals.ps1')
    }

    const powershell = `${process.env['SystemRoot'] || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    try {
      this.proc = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        windowsHide: true,
      })
    } catch (e: any) {
      logger.error(`[SystemSignals] spawn 失败: ${e.message}`)
      this.running = false
      return
    }

    let buf = ''
    this.proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          this.handleLine(JSON.parse(line) as SignalLine)
        } catch {
          /* 忽略脏行 */
        }
      }
    })
    this.proc.stderr.on('data', () => { /* 静默 */ })
    this.proc.on('exit', () => {
      if (this.running) {
        logger.warn('[SystemSignals] 进程退出，尝试重启')
        this.proc = null
        this.start()
      }
    })
    logger.info('[SystemSignals] 已启动')
  }

  stop(): void {
    this.running = false
    if (this.proc) {
      try { this.proc.kill() } catch { /* noop */ }
      this.proc = null
    }
    logger.info('[SystemSignals] 已停止')
  }

  private handleLine(line: SignalLine): void {
    const now = Date.now()
    const idleMs = line.idle

    // 窗口切换事件
    if (line.window && line.window !== this.lastWindow) {
      sensoryBus.emit({
        channel: 'digital',
        type: 'window',
        ts: now,
        confidence: 0.95,
        payload: { app: line.window },
      })
      this.lastWindow = line.window
    }

    // 输入活动：idle 从高值回落（刚操作）或持续低值（正在使用）
    if (idleMs >= 0) {
      const wasIdle = this.lastIdle > IDLE_THRESHOLD_MS
      const nowIdle = idleMs > IDLE_THRESHOLD_MS
      if (wasIdle && !nowIdle) {
        // 重新回到键盘前
        sensoryBus.emit({ channel: 'body', type: 'presence', ts: now, confidence: 0.9, payload: { present: true } })
      }
      if (!nowIdle) {
        sensoryBus.emit({ channel: 'body', type: 'input', ts: now, confidence: 0.8, payload: { idleMs } })
      } else {
        sensoryBus.emit({ channel: 'body', type: 'idle', ts: now, confidence: 0.7, payload: { idleMs } })
      }
      this.lastIdle = idleMs
    }
  }
}

export const systemSignals = new SystemSignals()
