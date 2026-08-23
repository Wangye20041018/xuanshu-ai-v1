/**
 * Resilience 中间件单元测试
 */
import { describe, it, expect, vi } from 'vitest'
import { CircuitBreaker, withRetry, withTimeout, Bulkhead } from '../../src/main/utils/resilience'

describe('CircuitBreaker', () => {
  it('should pass through successful calls', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 60000, halfOpenMaxRequests: 1 })
    const result = await cb.execute(async () => 'ok')
    expect(result).toBe('ok')
    expect(cb.getState()).toBe('CLOSED')
  })

  it('should open circuit after threshold failures', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeout: 60000, halfOpenMaxRequests: 1 })

    for (let i = 0; i < 2; i++) {
      await cb.execute(async () => { throw new Error('fail') }).catch(() => {})
    }

    expect(cb.getState()).toBe('OPEN')
  })

  it('should reject calls when open', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeout: 60000, halfOpenMaxRequests: 1 })

    await cb.execute(async () => { throw new Error('fail') }).catch(() => {})

    await expect(cb.execute(async () => 'ok')).rejects.toThrow(/OPEN/)
  })

  it('should transition to half-open after timeout', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeout: 10, halfOpenMaxRequests: 1 })

    await cb.execute(async () => { throw new Error('fail') }).catch(() => {})
    expect(cb.getState()).toBe('OPEN')

    await new Promise((r) => setTimeout(r, 15))

    await cb.execute(async () => 'recovered')
    expect(cb.getState()).toBe('CLOSED')
  })
})

describe('withRetry', () => {
  it('should succeed on first attempt', async () => {
    const result = await withRetry(async () => 'ok', {
      maxRetries: 3,
      initialBackoff: 10,
      backoffMultiplier: 2,
      maxBackoff: 1000,
    })
    expect(result).toBe('ok')
  })

  it('should retry and eventually succeed', async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        if (calls < 3) throw new Error('fail')
        return 'recovered'
      },
      { maxRetries: 5, initialBackoff: 10, backoffMultiplier: 2, maxBackoff: 1000 },
    )
    expect(result).toBe('recovered')
    expect(calls).toBe(3)
  })

  it('should throw after exhausting retries', async () => {
    await expect(
      withRetry(
        async () => { throw new Error('permanent') },
        { maxRetries: 2, initialBackoff: 10, backoffMultiplier: 2, maxBackoff: 1000 },
      ),
    ).rejects.toThrow('permanent')
  })

  it('should respect retryableError predicate', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new Error('non-retryable')
        },
        {
          maxRetries: 3,
          initialBackoff: 10,
          backoffMultiplier: 2,
          maxBackoff: 1000,
          retryableError: () => false,
        },
      ),
    ).rejects.toThrow('non-retryable')
    expect(calls).toBe(1) // 不重试
  })
})

describe('withTimeout', () => {
  it('should resolve if promise completes in time', async () => {
    const result = await withTimeout(Promise.resolve('ok'), { timeout: 1000 })
    expect(result).toBe('ok')
  })

  it('should reject if promise exceeds timeout', async () => {
    await expect(
      withTimeout(
        new Promise((r) => setTimeout(r, 200)),
        { timeout: 10 },
      ),
    ).rejects.toThrow(/Timeout/)
  })
})

describe('Bulkhead', () => {
  it('should allow concurrent execution within limit', async () => {
    const bh = new Bulkhead({ maxConcurrent: 2, maxQueue: 0 })
    const results = await Promise.all([
      bh.execute(async () => 'a'),
      bh.execute(async () => 'b'),
    ])
    expect(results).toEqual(['a', 'b'])
  })

  it('should reject when queue is full', async () => {
    const bh = new Bulkhead({ maxConcurrent: 1, maxQueue: 0 })

    // 占满并发槽位
    const slow = bh.execute(async () => new Promise<string>((r) => setTimeout(() => r('slow'), 100)))

    await expect(
      bh.execute(async () => 'overflow'),
    ).rejects.toThrow(/Queue full/)
  })
})
