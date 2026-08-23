/**
 * Simple Dependency Injection Container
 *
 * 轻量 DI 容器，提供服务注册、解析与生命周期管理。
 * 替代硬编码 import，使模块可测试、可替换。
 *
 * @module di-container
 */

type Factory<T = unknown> = (container: DIContainer) => T

interface Registration<T = unknown> {
  token: string
  factory?: Factory<T>
  instance?: T
  singleton: boolean
}

interface RegisterOptions<T = unknown> {
  useFactory: Factory<T>
  singleton?: boolean
}

export class DIContainer {
  private registry = new Map<string, Registration>()

  /**
   * 注册一个服务（支持 useFactory + singleton 模式）
   * @param token - 唯一标识（建议使用 Symbol 或常量字符串）
   * @param options - { useFactory, singleton? }
   */
  register<T>(token: string, options: RegisterOptions<T>): void {
    if (this.registry.has(token)) {
      throw new Error(`[DI] Duplicate registration for token: ${token}`)
    }
    this.registry.set(token, { token, factory: options.useFactory, singleton: options.singleton ?? true })
  }

  /**
   * 注册一个瞬态服务（每次 resolve 都创建新实例）
   */
  registerTransient<T>(token: string, factory: Factory<T>): void {
    if (this.registry.has(token)) {
      throw new Error(`[DI] Duplicate registration for token: ${token}`)
    }
    this.registry.set(token, { token, factory, singleton: false })
  }

  /**
   * 注册一个已存在的实例
   */
  registerInstance<T>(token: string, instance: T): void {
    this.registry.set(token, { token, instance, singleton: true })
  }

  /**
   * 解析服务
   */
  resolve<T>(token: string): T {
    const reg = this.registry.get(token)
    if (!reg) {
      throw new Error(`[DI] Token not registered: ${token}`)
    }

    if (reg.instance !== undefined) {
      return reg.instance as T
    }

    if (!reg.factory) {
      throw new Error(`[DI] No factory for token: ${token}`)
    }

    const instance = reg.factory(this) as T
    if (reg.singleton) {
      reg.instance = instance
    }
    return instance
  }

  /**
   * 检查 token 是否已注册
   */
  has(token: string): boolean {
    return this.registry.has(token)
  }

  /**
   * 清除所有注册（仅用于测试）
   */
  clear(): void {
    this.registry.clear()
  }
}

/** 全局 DI 容器单例 */
export const container = new DIContainer()

// ==================== 常用 Token 常量 ====================

export const DI_TOKENS = {
  CONFIG_STORE: 'config-store',
  LOGGER: 'logger',
  PROCESS_GUARDIAN: 'process-guardian',
  PYTHON_RUNTIME: 'python-runtime',
  VECTOR_STORE: 'vector-store',
  VISION_MODEL: 'vision-model',
  VOICE_ENGINE: 'voice-engine',
  MODEL_MANAGER: 'model-manager',
  EXTERNAL_AI: 'external-ai',
  SEARCH_ENGINE: 'search-engine',
  PERMISSION_MANAGER: 'permission-manager',
  IPC_GUARD: 'ipc-guard',
  SECURE_STORE: 'secure-store',
  DEVICE_OPTIMIZER: 'device-optimizer',
} as const
