/**
 * 结构化日志工具 — Logger 类 + createLogger 工厂
 *
 * 特性：
 *   - 四级日志：debug / info / warn / error
 *   - 同时输出到控制台和文件（userData/logs/app-YYYY-MM-DD.log，按天轮转）
 *   - 生产环境默认 info 级别，开发环境 debug 级别
 *   - 向后兼容 createLogger 工厂函数
 */

import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, appendFileSync, readdirSync, unlinkSync } from 'fs'

/* ==================== 类型定义 ==================== */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
}

interface LoggerOptions {
  /** 最低输出级别，低于此级别的日志将被丢弃 */
  level?: LogLevel
  /** 日志文件目录，默认 userData/logs */
  logDir?: string
}

/* ==================== Logger 类 ==================== */

export class Logger {
  private module: string
  private level: LogLevel
  private logDir: string
  private currentDate: string

  constructor(module: string, options: LoggerOptions = {}) {
    this.module = module
    this.level = options.level || (
      process.env.NODE_ENV === 'development' ? 'debug' : 'info'
    )
    this.logDir = options.logDir || join(app.getPath('userData'), 'logs')
    this.currentDate = this.getDateString()
    this.ensureDir()
    // P1 稳定性：启动时清理 7 天前的日志文件，防止无限累积
    this.cleanupOldLogs(7)
  }

  /** 清理 N 天前的 app-*.log / *.bak / *.crash.log 文件（静默失败不影响主流程） */
  private cleanupOldLogs(retainDays: number): void {
    try {
      const cutoff = Date.now() - retainDays * 24 * 3600 * 1000
      for (const f of readdirSync(this.logDir)) {
        if (!/^app-.*\.(log|bak|crash\.log)$/.test(f) && !f.endsWith('.crash.log')) continue
        const p = join(this.logDir, f)
        try {
          const st = require('fs').statSync(p)
          if (st.mtimeMs < cutoff) {
            unlinkSync(p)
          }
        } catch { /* 单个文件清理失败跳过 */ }
      }
    } catch { /* 清理失败不影响主流程 */ }
  }

  /* ---------- 私有方法 ---------- */

  private getDateString(): string {
    const d = new Date()
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  private ensureDir(): void {
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true })
    }
  }

  private getLogFilePath(): string {
    return join(this.logDir, `app-${this.currentDate}.log`)
  }

  private rotateIfNeeded(): void {
    const today = this.getDateString()
    if (today !== this.currentDate) {
      this.currentDate = today
    }
  }

  private format(level: LogLevel, message: string): string {
    const ts = new Date().toISOString()
    return `[${ts}] [${level.toUpperCase()}] [${this.module}] ${message}`
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_VALUES[level] >= LEVEL_VALUES[this.level]
  }

  private write(level: LogLevel, message: string): void {
    if (!this.shouldLog(level)) return

    const formatted = this.format(level, message)

    // 控制台输出
    switch (level) {
      case 'error':
        console.error(formatted)
        break
      case 'warn':
        console.warn(formatted)
        break
      case 'info':
        console.log(formatted)
        break
      case 'debug':
        console.debug(formatted)
        break
    }

    // 文件落盘
    try {
      this.rotateIfNeeded()
      this.ensureDir()
      appendFileSync(this.getLogFilePath(), formatted + '\n', 'utf-8')
    } catch {
      // 日志写入失败不能影响业务 — 静默丢弃
    }
  }

  /* ---------- 公开 API ---------- */

  debug(message: string): void {
    this.write('debug', message)
  }

  info(message: string): void {
    this.write('info', message)
  }

  warn(message: string): void {
    this.write('warn', message)
  }

  error(message: string): void {
    this.write('error', message)
  }
}

/* ==================== 工厂函数 ==================== */

/**
 * 创建带模块名前缀的 Logger 实例
 * @param module 模块名称，用于日志前缀
 */
export function createLogger(module: string): Logger {
  return new Logger(module)
}
