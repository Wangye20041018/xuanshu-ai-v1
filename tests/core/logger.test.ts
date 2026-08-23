/**
 * P1 单元测试 — Logger 统一日志系统
 * 来源：src/shared/logger.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Logger, setLogLevel } from '../../src/shared/logger'

describe('Logger — 统一日志系统', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setLogLevel('debug')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('正常路径 — 日志输出', () => {
    it('debug 输出带命名空间和时间戳', () => {
      const log = new Logger('TestModule')
      log.debug('test message', 123)
      expect(console.debug).toHaveBeenCalled()
      const call = (console.debug as any).mock.calls[0]
      expect(call[0]).toContain('[DEBUG]')
      expect(call[0]).toContain('[TestModule]')
    })

    it('info 输出带命名空间', () => {
      const log = new Logger('Chat')
      log.info('连接成功')
      expect(console.info).toHaveBeenCalled()
      const call = (console.info as any).mock.calls[0]
      expect(call[0]).toContain('[INFO]')
      expect(call[0]).toContain('[Chat]')
    })

    it('warn 输出', () => {
      const log = new Logger('RAG')
      log.warn('向量存储接近上限')
      expect(console.warn).toHaveBeenCalled()
    })

    it('error 输出', () => {
      const log = new Logger('IPC')
      log.error('通道注册失败', new Error('test'))
      expect(console.error).toHaveBeenCalled()
    })
  })

  describe('日志级别过滤', () => {
    it('info 级别过滤 debug', () => {
      setLogLevel('info')
      const log = new Logger('Test')
      log.debug('should not appear')
      expect(console.debug).not.toHaveBeenCalled()
    })

    it('warn 级别过滤 debug 和 info', () => {
      setLogLevel('warn')
      const log = new Logger('Test')
      log.debug('no')
      log.info('no')
      expect(console.debug).not.toHaveBeenCalled()
      expect(console.info).not.toHaveBeenCalled()
    })

    it('error 级别只输出 error', () => {
      setLogLevel('error')
      const log = new Logger('Test')
      log.debug('no')
      log.info('no')
      log.warn('no')
      log.error('yes')
      expect(console.debug).not.toHaveBeenCalled()
      expect(console.info).not.toHaveBeenCalled()
      expect(console.warn).not.toHaveBeenCalled()
      expect(console.error).toHaveBeenCalled()
    })

    it('任意级别 error 始终输出', () => {
      setLogLevel('error')
      const log = new Logger('Critical')
      log.error('关键错误')
      expect(console.error).toHaveBeenCalled()
    })
  })

  describe('P3: asyncError 结构化错误日志', () => {
    it('Error 对象输出完整结构化日志', () => {
      const log = new Logger('Home')
      const err = new Error('IPC 调用超时')
      log.asyncError('handleSend', err)

      expect(console.error).toHaveBeenCalled()
      const call = (console.error as any).mock.calls[0]
      const msg = call.join(' ')
      expect(msg).toContain('[ASYNC_ERROR]')
      expect(msg).toContain('[Home]')
      expect(msg).toContain('operation=handleSend')
      expect(msg).toContain('errorType=Error')
      expect(msg).toContain('message=IPC 调用超时')
      expect(msg).toContain('Error: IPC 调用超时')
    })

    it('字符串错误', () => {
      const log = new Logger('Camera')
      log.asyncError('toggle', '权限被拒绝')

      expect(console.error).toHaveBeenCalled()
      const call = (console.error as any).mock.calls[0]
      const msg = call.join(' ')
      expect(msg).toContain('operation=toggle')
      expect(msg).toContain('message=权限被拒绝')
    })

    it('非标准错误对象', () => {
      const log = new Logger('Model')
      log.asyncError('load', { code: 500 })

      expect(console.error).toHaveBeenCalled()
    })
  })
})
