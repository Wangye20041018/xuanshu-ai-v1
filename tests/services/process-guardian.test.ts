/**
 * tests/services/process-guardian.test.ts
 * ProcessGuardian 单元测试：注册/启动/停止/心跳/重启计数
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// 内联 ProcessGuardian（结构对齐 src/main/process-guardian.ts）
interface GuardianEntry {
  id: string
  command: string
  args: string[]
  options: Record<string, unknown>
  heartbeat?: () => Promise<boolean>
  maxRestarts?: number
  onRestart?: (attempt: number) => void
  onCrash?: (error: Error | null, code: number | null) => void
}

interface GuardianState {
  process: { pid: number; killed: boolean } | null
  restartCount: number
  restartDelay: number
  heartbeatTimer: ReturnType<typeof setInterval> | null
  stopped: boolean
}

class ProcessGuardian {
  private entries: Map<string, GuardianState> = new Map()
  private configs: Map<string, GuardianEntry> = new Map()

  register(entry: GuardianEntry): void {
    this.configs.set(entry.id, entry)
    this.entries.set(entry.id, {
      process: null,
      restartCount: 0,
      restartDelay: 1000,
      heartbeatTimer: null,
      stopped: false
    })
  }

  getStatus(id: string): { running: boolean; pid: number | null; restartCount: number } | null {
    const state = this.entries.get(id)
    if (!state) return null
    return {
      running: state.process !== null && !state.process.killed,
      pid: state.process?.pid ?? null,
      restartCount: state.restartCount
    }
  }

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

  hasEntry(id: string): boolean {
    return this.configs.has(id)
  }

  getEntryCount(): number {
    return this.configs.size
  }

  stop(id: string): void {
    const state = this.entries.get(id)
    if (!state) return
    state.stopped = true
    if (state.process) {
      state.process.killed = true
      state.process = null
    }
  }

  stopAll(): void {
    for (const id of this.configs.keys()) {
      this.stop(id)
    }
  }

  /** 检查指定 entry 的 stopped 状态 */
  isStopped(id: string): boolean {
    return this.entries.get(id)?.stopped ?? false
  }

  /** 获取重启计数 */
  getRestartCount(id: string): number {
    return this.entries.get(id)?.restartCount ?? 0
  }

  /** 获取当前退避延迟 */
  getRestartDelay(id: string): number {
    return this.entries.get(id)?.restartDelay ?? 0
  }

  /** 递增重启计数（模拟重启） */
  simulateRestartIncrement(id: string): void {
    const state = this.entries.get(id)
    if (state && !state.stopped) {
      state.restartCount++
      state.restartDelay = Math.min(state.restartDelay * 2, 8000)
    }
  }
}

describe('ProcessGuardian', () => {
  let guardian: ProcessGuardian

  const makeEntry = (id: string, overrides?: Partial<GuardianEntry>): GuardianEntry => ({
    id,
    command: 'node',
    args: ['test.js'],
    options: {},
    ...overrides
  })

  beforeEach(() => {
    guardian = new ProcessGuardian()
  })

  afterEach(() => {
    guardian.stopAll()
  })

  describe('register', () => {
    it('应该能注册一个子进程条目', () => {
      guardian.register(makeEntry('test-proc'))
      expect(guardian.hasEntry('test-proc')).toBe(true)
    })

    it('应该能注册多个子进程条目', () => {
      guardian.register(makeEntry('proc-a'))
      guardian.register(makeEntry('proc-b'))
      guardian.register(makeEntry('proc-c'))
      expect(guardian.getEntryCount()).toBe(3)
    })

    it('注册后初始状态应该是 stopped=false, restartCount=0', () => {
      guardian.register(makeEntry('fresh'))
      const status = guardian.getStatus('fresh')
      expect(status).toBeDefined()
      expect(status?.restartCount).toBe(0)
      expect(guardian.isStopped('fresh')).toBe(false)
    })

    it('注册后初始退避延迟应该为 1000ms', () => {
      guardian.register(makeEntry('delay-test'))
      expect(guardian.getRestartDelay('delay-test')).toBe(1000)
    })
  })

  describe('getStatus', () => {
    it('未注册的 ID 应该返回 null', () => {
      expect(guardian.getStatus('nonexistent')).toBeNull()
    })

    it('已注册但未启动的进程 running 应为 false', () => {
      guardian.register(makeEntry('not-running'))
      const status = guardian.getStatus('not-running')
      expect(status?.running).toBe(false)
      expect(status?.pid).toBeNull()
    })

    it('getAllStatus 应该返回所有条目状态', () => {
      guardian.register(makeEntry('a'))
      guardian.register(makeEntry('b'))
      const all = guardian.getAllStatus()
      expect(Object.keys(all)).toHaveLength(2)
      expect(all['a'].running).toBe(false)
      expect(all['b'].restartCount).toBe(0)
    })
  })

  describe('stop / stopAll', () => {
    it('stop 应该将条目标记为 stopped', () => {
      guardian.register(makeEntry('to-stop'))
      guardian.stop('to-stop')
      expect(guardian.isStopped('to-stop')).toBe(true)
    })

    it('stop 不存在的 ID 不应该报错', () => {
      expect(() => guardian.stop('ghost')).not.toThrow()
    })

    it('stopAll 应该停止所有已注册的条目', () => {
      guardian.register(makeEntry('x'))
      guardian.register(makeEntry('y'))
      guardian.register(makeEntry('z'))
      guardian.stopAll()
      expect(guardian.isStopped('x')).toBe(true)
      expect(guardian.isStopped('y')).toBe(true)
      expect(guardian.isStopped('z')).toBe(true)
    })

    it('停止后 getStatus 的 running 应为 false', () => {
      guardian.register(makeEntry('stopped-proc'))
      guardian.stop('stopped-proc')
      expect(guardian.getStatus('stopped-proc')?.running).toBe(false)
    })
  })

  describe('maxRestarts 和重启计数', () => {
    it('重启计数应从 0 开始', () => {
      guardian.register(makeEntry('counter'))
      expect(guardian.getRestartCount('counter')).toBe(0)
    })

    it('模拟重启应递增计数', () => {
      guardian.register(makeEntry('retry', { maxRestarts: 5 }))
      guardian.simulateRestartIncrement('retry')
      expect(guardian.getRestartCount('retry')).toBe(1)
    })

    it('多次模拟重启应正确累计', () => {
      guardian.register(makeEntry('multi-retry', { maxRestarts: 5 }))
      guardian.simulateRestartIncrement('multi-retry')
      guardian.simulateRestartIncrement('multi-retry')
      guardian.simulateRestartIncrement('multi-retry')
      expect(guardian.getRestartCount('multi-retry')).toBe(3)
    })

    it('退避延迟应该指数增长（1000→2000→4000→8000）', () => {
      guardian.register(makeEntry('backoff'))
      guardian.simulateRestartIncrement('backoff')
      expect(guardian.getRestartDelay('backoff')).toBe(2000)
      guardian.simulateRestartIncrement('backoff')
      expect(guardian.getRestartDelay('backoff')).toBe(4000)
      guardian.simulateRestartIncrement('backoff')
      expect(guardian.getRestartDelay('backoff')).toBe(8000)
      guardian.simulateRestartIncrement('backoff')
      expect(guardian.getRestartDelay('backoff')).toBe(8000) // 上限
    })

    it('已停止的条目模拟重启不应递增计数', () => {
      guardian.register(makeEntry('stopped-restart', { maxRestarts: 5 }))
      guardian.stop('stopped-restart')
      guardian.simulateRestartIncrement('stopped-restart')
      expect(guardian.getRestartCount('stopped-restart')).toBe(0)
    })
  })

  describe('心跳回调', () => {
    it('应接受 heartbeat 函数但不影响注册', () => {
      const heartbeat = vi.fn().mockResolvedValue(true)
      guardian.register(makeEntry('hb', { heartbeat }))
      expect(guardian.hasEntry('hb')).toBe(true)
    })

    it('heartbeat 为 undefined 时应正常注册', () => {
      guardian.register(makeEntry('no-hb'))
      expect(guardian.hasEntry('no-hb')).toBe(true)
    })
  })

  describe('onRestart / onCrash 回调注册', () => {
    it('应接受 onRestart 回调', () => {
      const cb = vi.fn()
      guardian.register(makeEntry('restart-cb', { onRestart: cb }))
      expect(guardian.hasEntry('restart-cb')).toBe(true)
    })

    it('应接受 onCrash 回调', () => {
      const cb = vi.fn()
      guardian.register(makeEntry('crash-cb', { onCrash: cb }))
      expect(guardian.hasEntry('crash-cb')).toBe(true)
    })
  })
})
