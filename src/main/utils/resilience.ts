/**
 * Resilience 中间件 — 弹性工程基础工具
 *
 * 纯 TypeScript 实现，无 Electron/Node 运行时依赖，可在单元测试中直接导入。
 * 提供四个弹性原语：
 *   1. CircuitBreaker — 熔断器：失败次数达阈值后打开，冷却后进入半开试探
 *   2. withRetry      — 重试：指数退避 + 可判断错误是否可重试
 *   3. withTimeout    — 超时：Promise 竞速，超时抛 Timeout 错误
 *   4. Bulkhead       — 舱壁：限制并发数 + 排队上限，防止资源耗尽
 *
 * @module utils/resilience
 */

/* ==================== 熔断器 ==================== */

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface CircuitBreakerOptions {
  /** 连续失败次数达到该阈值后打开熔断 */
  failureThreshold: number
  /** 打开后冷却时长（毫秒），冷却结束进入半开状态 */
  resetTimeout: number
  /** 半开状态下允许并发的试探请求数 */
  halfOpenMaxRequests: number
}

export class CircuitBreaker {
  private readonly failureThreshold: number
  private readonly resetTimeout: number
  private readonly halfOpenMaxRequests: number

  private state: CircuitBreakerState = 'CLOSED'
  private failureCount = 0
  private openedAt = 0
  private halfOpenInFlight = 0

  constructor(options: CircuitBreakerOptions) {
    this.failureThreshold = options.failureThreshold
    this.resetTimeout = options.resetTimeout
    this.halfOpenMaxRequests = options.halfOpenMaxRequests
  }

  /** 读取当前状态；若已打开且冷却结束，惰性切换到半开 */
  getState(): CircuitBreakerState {
    if (this.state === 'OPEN' && Date.now() - this.openedAt >= this.resetTimeout) {
      this.state = 'HALF_OPEN'
      this.halfOpenInFlight = 0
    }
    return this.state
  }

  /** 执行受保护的调用 */
  async execute<T>(fn: () => Promise<T> | T): Promise<T> {
    this.getState()

    if (this.state === 'OPEN') {
      throw new Error('Circuit breaker is OPEN')
    }

    if (this.state === 'HALF_OPEN') {
      // 半开阶段只放行限定数量的试探请求，其余视为仍打开
      if (this.halfOpenInFlight >= this.halfOpenMaxRequests) {
        throw new Error('Circuit breaker is OPEN')
      }
      this.halfOpenInFlight++
    }

    try {
      const result = await fn()
      // 成功：重置失败计数；半开试探成功则闭合
      this.failureCount = 0
      if (this.state === 'HALF_OPEN') {
        this.halfOpenInFlight--
        this.state = 'CLOSED'
      }
      return result
    } catch (err) {
      if (this.state === 'HALF_OPEN') {
        // 半开试探失败：立即重新打开
        this.halfOpenInFlight--
        this.state = 'OPEN'
        this.openedAt = Date.now()
      } else {
        this.failureCount++
        if (this.failureCount >= this.failureThreshold) {
          this.state = 'OPEN'
          this.openedAt = Date.now()
        }
      }
      throw err
    }
  }
}

/* ==================== 重试 ==================== */

export interface RetryOptions {
  /** 最大重试次数（不含首次调用） */
  maxRetries: number
  /** 首次重试退避时长（毫秒） */
  initialBackoff: number
  /** 退避倍增系数 */
  backoffMultiplier: number
  /** 退避上限（毫秒） */
  maxBackoff: number
  /** 判断错误是否可重试；返回 false 则立即抛出，不重试 */
  retryableError?: (error: unknown) => boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function withRetry<T>(fn: () => Promise<T> | T, options: RetryOptions): Promise<T> {
  const { maxRetries, initialBackoff, backoffMultiplier, maxBackoff } = options
  let attempt = 0
  let backoff = initialBackoff

  for (;;) {
    try {
      return await fn()
    } catch (err) {
      // 不可重试错误：立即抛出，不进入退避
      if (options.retryableError && !options.retryableError(err)) {
        throw err
      }
      attempt++
      if (attempt > maxRetries) {
        throw err
      }
      await sleep(backoff)
      backoff = Math.min(backoff * backoffMultiplier, maxBackoff)
    }
  }
}

/* ==================== 超时 ==================== */

export interface TimeoutOptions {
  /** 超时时长（毫秒） */
  timeout: number
}

export function withTimeout<T>(promise: Promise<T>, options: TimeoutOptions): Promise<T> {
  const { timeout } = options
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Operation timed out after ${timeout}ms (Timeout)`))
    }, timeout)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/* ==================== 舱壁 ==================== */

export interface BulkheadOptions {
  /** 最大并发执行数 */
  maxConcurrent: number
  /** 最大排队数（超出立即拒绝） */
  maxQueue: number
}

interface QueueItem {
  resolve: () => void
  reject: (err: Error) => void
}

export class Bulkhead {
  private readonly maxConcurrent: number
  private readonly maxQueue: number
  private active = 0
  private queue: QueueItem[] = []

  constructor(options: BulkheadOptions) {
    this.maxConcurrent = options.maxConcurrent
    this.maxQueue = options.maxQueue
  }

  async execute<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      if (this.queue.length >= this.maxQueue) {
        throw new Error('Bulkhead queue is full (Queue full)')
      }
      await new Promise<void>((resolve, reject) => {
        this.queue.push({ resolve, reject })
      })
    }

    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      const next = this.queue.shift()
      if (next) next.resolve()
    }
  }
}
