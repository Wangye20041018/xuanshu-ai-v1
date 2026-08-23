/**
 * ProcessGuardian — 子进程守护与自动重启
 *
 * 职责：
 *   - spawn 子进程 → 监听 exit → 指数退避自动重启（1s/2s/4s/8s，上限 5 次）
 *   - 心跳检测（每 30s ping），心跳丢失触发重启
 *   - 统一管理关键子进程：llama-server / piper.exe / Python 唤醒检测 / SGLang server
 */

import { spawn, ChildProcess, SpawnOptions } from 'child_process'
import { createLogger } from './utils/logging'

const logger = createLogger('ProcessGuardian')

/* ==================== 类型定义 ==================== */

export interface GuardianEntry {
  /** 进程标识（用于日志和查询） */
  id: string
  /** 可执行文件路径或命令 */
  command: string
  /** 命令行参数 */
  args: string[]
  /** spawn 选项 */
  options: SpawnOptions
  /** 心跳检测函数：返回 true 表示健康，false 表示失联 */
  heartbeat?: () => Promise<boolean>
  /** 最大重启次数，默认 5 */
  maxRestarts?: number
  /** 重启时回调 */
  onRestart?: (attempt: number) => void
  /** 进程崩溃回调 */
  onCrash?: (error: Error | null, code: number | null) => void
}

interface GuardianState {
  process: ChildProcess | null
  restartCount: number
  restartDelay: number       // 当前退避延迟 ms
  heartbeatTimer: ReturnType<typeof setInterval> | null
  stopped: boolean           // 是否已被主动停止
}

/* ==================== ProcessGuardian 类 ==================== */

export class ProcessGuardian {
  private entries: Map<string, GuardianState> = new Map()
  private configs: Map<string, GuardianEntry> = new Map()

  /** 注册一个子进程 */
  register(entry: GuardianEntry): void {
    this.configs.set(entry.id, entry)
    this.entries.set(entry.id, {
      process: null,
      restartCount: 0,
      restartDelay: 1000,
      heartbeatTimer: null,
      stopped: false
    })
    logger.info(`[ProcessGuardian] 已注册: ${entry.id}`)
  }

  /** 启动所有已注册的子进程 */
  async startAll(): Promise<void> {
    logger.info(`[ProcessGuardian] 启动全部 ${this.configs.size} 个子进程...`)
    for (const id of this.configs.keys()) {
      await this.start(id)
    }
  }

  /** 启动单个子进程 */
  async start(id: string): Promise<ChildProcess | null> {
    const config = this.configs.get(id)
    if (!config) {
      logger.error(`[ProcessGuardian] 未注册的子进程: ${id}`)
      return null
    }

    const state = this.entries.get(id)!
    if (state.stopped) {
      logger.debug(`[ProcessGuardian] ${id} 已被主动停止，跳过启动`)
      return null
    }

    logger.info(`[ProcessGuardian] 正在启动: ${id} | ${config.command} ${config.args.join(' ')}`)

    try {
      const proc = spawn(config.command, config.args, config.options)
      state.process = proc

      proc.on('spawn', () => {
        logger.info(`[ProcessGuardian] ${id} 进程已启动 (pid=${proc.pid})`)
      })

      proc.on('exit', (code, signal) => {
        logger.warn(`[ProcessGuardian] ${id} 进程退出: code=${code} signal=${signal}`)
        this.handleExit(id, code, signal)
      })

      proc.on('error', (err) => {
        logger.error(`[ProcessGuardian] ${id} 进程错误: ${err.message}`)
        config.onCrash?.(err, null)
      })

      // 标准输出/错误重定向到日志（静默模式）
      if (proc.stdout) {
        proc.stdout.on('data', (data: Buffer) => {
          logger.debug(`[${id}] ${data.toString().trim()}`)
        })
      }
      if (proc.stderr) {
        proc.stderr.on('data', (data: Buffer) => {
          logger.warn(`[${id}] ${data.toString().trim()}`)
        })
      }

      // 启动心跳检测
      this.startHeartbeat(id)

      return proc
    } catch (err: any) {
      logger.error(`[ProcessGuardian] ${id} 启动失败: ${err.message}`)
      config.onCrash?.(err, null)
      // 启动失败也走退避重试
      this.scheduleRestart(id)
      return null
    }
  }

  /** 停止单个子进程 */
  stop(id: string): void {
    const state = this.entries.get(id)
    if (!state) return

    state.stopped = true
    this.stopHeartbeat(id)

    if (state.process) {
      logger.info(`[ProcessGuardian] 停止: ${id} (pid=${state.process.pid})`)
      try {
        if (process.platform === 'win32') {
          // Windows 上优雅停止
          state.process.kill('SIGTERM')
          setTimeout(() => {
            try {
              if (state.process && state.process.pid) {
                const { execSync } = require('child_process')
                execSync(`taskkill /PID ${state.process.pid} /T /F 2>nul`, { timeout: 3000 })
              }
            } catch { /* 忽略 */ }
          }, 3000)
        } else {
          state.process.kill('SIGTERM')
        }
      } catch (e) {
        logger.error(`[ProcessGuardian] 停止 ${id} 失败: ${e}`)
      }
      state.process = null
    }
  }

  /** 停止所有子进程 */
  async stopAll(): Promise<void> {
    logger.info(`[ProcessGuardian] 停止全部子进程...`)
    for (const id of this.configs.keys()) {
      this.stop(id)
    }
  }

  /** 查询子进程状态 */
  getStatus(id: string): { running: boolean; pid: number | null; restartCount: number } | null {
    const state = this.entries.get(id)
    if (!state) return null
    return {
      running: state.process !== null && !state.process.killed,
      pid: state.process?.pid ?? null,
      restartCount: state.restartCount
    }
  }

  /** 获取所有子进程状态 */
  getAllStatus(): Record<string, { running: boolean; pid: number | null; restartCount: number }> {
    const result: Record<string, any> = {}
    for (const [id, state] of this.entries) {
      result[id] = {
        running: state.process !== null && !state.process.killed,
        pid: state.process?.pid ?? null,
        restartCount: state.restartCount
      }
    }
    return result
  }

  /* ==================== 私有方法 ==================== */

  /** 处理进程退出 */
  private handleExit(id: string, code: number | null, signal: string | null): void {
    const state = this.entries.get(id)
    const config = this.configs.get(id)
    if (!state || !config) return

    state.process = null
    this.stopHeartbeat(id)

    if (state.stopped) {
      logger.debug(`[ProcessGuardian] ${id} 已被主动停止，不重启`)
      return
    }

    // 非正常退出（code !== 0 或 signal 不为空）触发回调
    if (code !== 0 || signal) {
      config.onCrash?.(null, code)
    }

    this.scheduleRestart(id)
  }

  /** 指数退避调度重启 */
  private scheduleRestart(id: string): void {
    const state = this.entries.get(id)
    const config = this.configs.get(id)
    if (!state || !config) return

    const maxRestarts = config.maxRestarts ?? 5

    if (state.restartCount >= maxRestarts) {
      logger.error(`[ProcessGuardian] ${id} 已达最大重启次数 (${maxRestarts})，放弃重启`)
      return
    }

    const delay = state.restartDelay
    logger.warn(`[ProcessGuardian] ${id} 将在 ${delay}ms 后重启 (${state.restartCount + 1}/${maxRestarts})`)

    setTimeout(() => {
      if (state.stopped) return

      state.restartCount++
      // 指数退避：1s → 2s → 4s → 8s (上限 8s)
      state.restartDelay = Math.min(state.restartDelay * 2, 8000)

      config.onRestart?.(state.restartCount)
      this.start(id)
    }, delay)
  }

  /** 启动心跳检测 */
  private startHeartbeat(id: string): void {
    const state = this.entries.get(id)
    const config = this.configs.get(id)
    if (!state || !config || !config.heartbeat) return

    // 先清理旧定时器
    this.stopHeartbeat(id)

    state.heartbeatTimer = setInterval(async () => {
      if (state.stopped || !state.process) {
        this.stopHeartbeat(id)
        return
      }

      try {
        const healthy = await config.heartbeat!()
        if (!healthy) {
          logger.warn(`[ProcessGuardian] ${id} 心跳丢失，准备重启`)
          // 重置退避延迟（新故障序列）
          state.restartDelay = 1000
          state.restartCount = 0
          this.stopHeartbeat(id)
          // 杀掉当前进程
          if (state.process && !state.process.killed) {
            try {
              if (process.platform === 'win32' && state.process.pid) {
                const { execSync } = require('child_process')
                execSync(`taskkill /PID ${state.process.pid} /T /F 2>nul`, { timeout: 3000 })
              } else {
                state.process.kill('SIGKILL')
              }
            } catch { /* 忽略 */ }
          }
          state.process = null
          this.scheduleRestart(id)
        }
      } catch {
        logger.debug(`[ProcessGuardian] ${id} 心跳检测异常，忽略`)
      }
    }, 30000)
  }

  /** 停止心跳检测 */
  private stopHeartbeat(id: string): void {
    const state = this.entries.get(id)
    if (state?.heartbeatTimer) {
      clearInterval(state.heartbeatTimer)
      state.heartbeatTimer = null
    }
  }
}

/* ==================== 单例导出 ==================== */
export const processGuardian = new ProcessGuardian()
