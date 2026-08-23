/**
 * DIContainer 单元测试
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { DIContainer, container, DI_TOKENS } from '../../src/main/utils/di-container'

describe('DIContainer', () => {
  let di: DIContainer

  beforeEach(() => {
    di = new DIContainer()
  })

  it('should register and resolve a singleton', () => {
    di.register('test', { useFactory: () => ({ value: 42 }) })
    const a = di.resolve<{ value: number }>('test')
    const b = di.resolve<{ value: number }>('test')
    expect(a.value).toBe(42)
    expect(a).toBe(b)
  })

  it('should register and resolve a transient', () => {
    di.registerTransient('test', () => ({ value: 42 }))
    const a = di.resolve<{ value: number }>('test')
    const b = di.resolve<{ value: number }>('test')
    expect(a).not.toBe(b)
  })

  it('should register and resolve an instance', () => {
    const instance = { value: 100 }
    di.registerInstance('test', instance)
    expect(di.resolve('test')).toBe(instance)
  })

  it('should throw on unregistered token', () => {
    expect(() => di.resolve('nonexistent')).toThrow(/not registered/)
  })

  it('should throw on duplicate registration', () => {
    di.register('test', { useFactory: () => ({}) })
    expect(() => di.register('test', { useFactory: () => ({}) })).toThrow(/Duplicate/)
  })

  it('should correctly report has()', () => {
    expect(di.has('test')).toBe(false)
    di.register('test', { useFactory: () => ({}) })
    expect(di.has('test')).toBe(true)
  })

  it('should clear all registrations', () => {
    di.register('test', { useFactory: () => ({}) })
    di.clear()
    expect(di.has('test')).toBe(false)
  })

  it('should export DI_TOKENS constants', () => {
    expect(DI_TOKENS.CONFIG_STORE).toBe('config-store')
    expect(DI_TOKENS.PROCESS_GUARDIAN).toBe('process-guardian')
    expect(DI_TOKENS.PYTHON_RUNTIME).toBe('python-runtime')
  })

  it('global container should be a DIContainer instance', () => {
    expect(container).toBeInstanceOf(DIContainer)
  })
})
