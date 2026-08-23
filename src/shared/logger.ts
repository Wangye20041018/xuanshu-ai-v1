/**
 * Logger — 统一日志系统
 *
 * 支持日志级别过滤、模块命名空间、生产模式静默。
 * 可扩展为写入文件或上报远程日志服务。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const isDev = process.env.NODE_ENV !== 'production'

let minLevel: LogLevel = isDev ? 'debug' : 'info'

export function setLogLevel(level: LogLevel): void {
  minLevel = level
}

function shouldLog(level: LogLevel): boolean {
  return (LEVEL_PRIORITY[level] ?? 0) >= (LEVEL_PRIORITY[minLevel] ?? 0)
}

function formatMessage(namespace: string, level: LogLevel, args: unknown[]): unknown[] {
  const timestamp = new Date().toISOString()
  return [`[${timestamp}] [${level.toUpperCase()}] [${namespace}]`, ...args]
}

export class Logger {
  constructor(private namespace: string) {}

  debug(...args: unknown[]): void {
    if (shouldLog('debug')) console.debug(...formatMessage(this.namespace, 'debug', args))
  }

  info(...args: unknown[]): void {
    if (shouldLog('info')) console.info(...formatMessage(this.namespace, 'info', args))
  }

  warn(...args: unknown[]): void {
    if (shouldLog('warn')) console.warn(...formatMessage(this.namespace, 'warn', args))
  }

  error(...args: unknown[]): void {
    console.error(...formatMessage(this.namespace, 'error', args))
  }

  /** 结构化异步错误日志（P3 增强） */
  asyncError(operation: string, err: unknown): void {
    const ts = new Date().toISOString()
    const errObj = err instanceof Error ? err : (typeof err === 'string' ? new Error(err) : null)
    const errorType = errObj?.constructor.name ?? typeof err
    const message = errObj?.message ?? String(err)
    const stack = errObj?.stack ?? ''
    console.error(
      `[${ts}] [ASYNC_ERROR] [${this.namespace}]`,
      `operation=${operation}`,
      `errorType=${errorType}`,
      `message=${message}`,
      stack ? `\n${stack}` : '',
    )
  }
}

/** 向后兼容的全局 logger（L-10 修复：复用单例，避免每次调用新建 Logger 实例） */
const globalLogger = new Logger('global')
export const logger = {
  debug: (...args: unknown[]) => globalLogger.debug(...args),
  info: (...args: unknown[]) => globalLogger.info(...args),
  warn: (...args: unknown[]) => globalLogger.warn(...args),
  error: (...args: unknown[]) => globalLogger.error(...args),
}

/** 创建带命名空间的 Logger 实例 */
export function createLogger(namespace: string): Logger {
  return new Logger(namespace)
}
