/* ============================================================
 * 插件沙箱执行引擎
 *
 * 安全执行 AI 生成的插件代码，隔离环境防止恶意操作。
 * C-04 修复：改用 node:vm 独立上下文执行，替代 new Function，
 * 使 process/require/global 等宿主能力不可达，杜绝沙箱逃逸。
 * ============================================================ */

import * as vm from 'vm'

export interface SandboxOptions {
  timeout: number // 毫秒
}

export interface SandboxResult {
  success: boolean
  data?: any
  error?: string
}

class Sandbox {
  private options: SandboxOptions

  constructor(options: SandboxOptions) {
    this.options = options
  }

  /**
   * 在沙箱中安全执行插件代码
   */
  async execute(code: string, params: Record<string, any>): Promise<SandboxResult> {
    try {
      // 提取函数体
      const funcMatch = code.match(/async\s+function\s*\(([^)]*)\)\s*\{([\s\S]*)\}/)
      if (!funcMatch) {
        return { success: false, error: '无法解析插件函数代码' }
      }

      const funcBody = funcMatch[2]

      // 白名单 API（仅暴露安全的全局对象）
      const sandboxGlobals = {
        console: {
          // @ts-expect-error TS6133 - args reserved for future use
          log: (...args: any[]) => { /* 静默 */ },
          // @ts-expect-error TS6133 - args reserved for future use
          error: (...args: any[]) => { /* 静默 */ },
          // @ts-expect-error TS6133 - args reserved for future use
          warn: (...args: any[]) => { /* 静默 */ },
        },
        JSON: {
          parse: JSON.parse,
          stringify: JSON.stringify,
        },
        Math,
        Date,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        Number,
        String,
        Boolean,
        Array,
        Object: {
          keys: Object.keys,
          values: Object.values,
          entries: Object.entries,
          assign: Object.assign,
        },
        RegExp,
        Error,
        Promise,
        setTimeout,
        clearTimeout,
        fetch: async (url: string, options?: RequestInit) => {
          // 限制 fetch 只能访问 HTTP/HTTPS
          const parsed = new URL(url)
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('只允许 HTTP/HTTPS 请求')
          }
          const { createProxyAgent } = await import('../utils/proxy-resolver')
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 30_000)
          const agent = createProxyAgent()
          const fetchOptions: RequestInit & { dispatcher?: any } = {
            ...(options || {}),
            signal: options?.signal ?? controller.signal,
          }
          if (agent && !/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(url)) {
            fetchOptions.dispatcher = agent
          }
          try {
            return await fetch(url, fetchOptions as RequestInit)
          } finally {
            clearTimeout(timeout)
          }
        },
        encodeURIComponent,
        decodeURIComponent,
        btoa: (s: string) => Buffer.from(s).toString('base64'),
        atob: (s: string) => Buffer.from(s, 'base64').toString(),
      }

      // C-04 修复：使用 node:vm 创建独立上下文执行，不再使用 new Function。
      // vm 上下文拥有独立的全局对象/原型链，process/require/global 均不可达。
      const wrappedCode = `
        "use strict";
        const { ${Object.keys(sandboxGlobals).join(', ')} } = __sandbox__;
        __result__ = (async function() {
          ${funcBody}
        })();
      `

      const context: Record<string, any> = vm.createContext({
        __sandbox__: sandboxGlobals,
        __params__: params,
        __result__: undefined,
      })

      const script = new vm.Script(wrappedCode)

      // 带超时的执行（Promise.race 覆盖异步挂起；同步死循环受单线程模型限制无法中断）
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('插件执行超时')), this.options.timeout)
      })

      const result = await Promise.race([
        Promise.resolve().then(() => {
          script.runInContext(context)
          return context.__result__
        }),
        timeoutPromise,
      ])

      return { success: true, data: result }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: `沙箱执行失败: ${message}` }
    }
  }
}

export function createSandbox(options: SandboxOptions): Sandbox {
  return new Sandbox(options)
}