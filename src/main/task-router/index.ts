﻿/**
 * task-router 路由中枢（v12.0，单模型常驻 + 上下文压缩）
 *
 * 职责（轻量常驻、零显存）：
 *   接收 RouteSignal → classifyIntent() → 上下文压缩 → selectTier() → ensureTier()。
 *
 * v12.0 变更：
 *   - 插入上下文压缩步骤：消息 → embed → 检索 → 拼装 → 推理
 *   - contextManager 在 route() 中完成消息嵌入和历史检索，
 *     拼装结果通过 lastAssembly 暴露给下游（如 model-manager.generateResponse）
 */

import { modelManager } from '../model-manager'
import { contextManager } from '../context-manager'
import { Tier, TierResult, RouteSignal, IntentClass, GpuState } from './signals'
import { classifyIntent } from './rules'
import { logger } from '../../shared/logger'
import { tandemManager } from '../tandem-manager'

class TaskRouter {
  /** 最近一次路由结果（供 IPC 查询） */
  private lastResult: TierResult | null = null
  /** 最近一次拼装结果（供推理引擎使用） */
  private lastAssembly: import('../context-manager/types').AssemblyResult | null = null

  /**
   * 主入口：消息 → embed → 检索 → 拼装 → 选档 → 确保模型就位。
   * 非阻塞语义：任何内部异常都被吞掉，保证聊天主链路不被路由拖垮。
   */
  async route(signal: RouteSignal): Promise<TierResult> {
    try {
      // === v12.0 上下文压缩 ===
      if (signal.text) {
        try {
          const assemblyResult = await contextManager.assemble(
            { role: 'user', content: signal.text },
            undefined
          )
          this.lastAssembly = assemblyResult
          logger.debug(
            `[TaskRouter] 上下文拼装完成: ` +
            `召回=${assemblyResult.retrievedCount} 窗口=${assemblyResult.windowRounds}轮 ` +
            `估算tokens=${assemblyResult.estimatedTokens} 截断=${assemblyResult.truncated}`
          )
        } catch (ctxErr) {
          logger.warn('[TaskRouter] 上下文压缩失败（回退原始消息）:', ctxErr)
          this.lastAssembly = null
        }
      }

      const intent: IntentClass = classifyIntent(signal)
      const tier: Tier = this.selectTier(intent)

      const fromModel = modelManager.getLoadedModel()?.modelId ?? null
      const before: GpuState = modelManager.getGpuModelType()

      const { swapped, toModel } = await this.ensureTier(tier)
      const after: GpuState = modelManager.getGpuModelType()

      const reason = this.buildReason(intent, tier)
      const result: TierResult = {
        tier,
        intent,
        swapped,
        fromModel,
        toModel,
        reason,
      }
      this.lastResult = result

      this.emitState(after, tier, reason)
      this.emitToast(before, after, tier)
      return result
    } catch (error) {
      logger.error('[TaskRouter] route error:', error)
      const fallback: TierResult = {
        tier: 'fast',
        intent: 'chat',
        swapped: false,
        fromModel: modelManager.getLoadedModel()?.modelId ?? null,
        toModel: modelManager.getLoadedModel()?.modelId ?? null,
        reason: '路由异常，回退快档',
      }
      this.lastResult = fallback
      return fallback
    }
  }

  /**
   * v11.0 选档：图片→vision；其余统一 fast（单模型常驻，无质量档）。
   * v12.2：img→vision 档位；vision 时 ensureTier 会走 swapToVision（内置主模型多模态检测）。
   * 意图分类（reasoning/math/longdoc/code）保留用于日志/前端提示，不再影响档位。
   */
  private selectTier(intent: IntentClass): Tier {
    if (intent === 'image') return 'vision'
    return 'fast'
  }

  /**
   * 确保目标档位已就位。
   * v11.0 单模型常驻，无需 quality 换载逻辑。
   * v12.2：vision 档位由 swapToVision 统一处理（含主模型多模态检测）。
   */
  private async ensureTier(tier: Tier): Promise<{ swapped: boolean; toModel: string | null }> {
    const cur = modelManager.getGpuModelType()

    if (tier === 'fast') {
      if (cur === 'main' || cur === 'vision') {
        return { swapped: false, toModel: modelManager.getLoadedModel()?.modelId ?? null }
      }
      // M-14 修复：tandem 常驻引擎（llama-server，端口 8082）已运行模型时，
      // 直接视为已就绪并复用，避免 modelManager 重复 loadModel 触发
      // 二次显存占用失败（ERR_UNHANDLED_ERROR）与后续窗口崩溃。
      // 注意：tandem 加载的主模型由 tandem 引擎管理，modelManager 的
      // gpuModelType 不会感知，因此必须在此显式探测。
      try {
        // M-20 修复：require('../tandem-manager') 在生产构建(out)下找不到模块
        // （electron-vite 会将 tandem-manager 打进主 bundle，CommonJS require 运行时解析失败），
        // 与其他模块统一改用 await import 动态加载，构建期会被正确转译为 bundle 引用。
        const states = tandemManager.getServerStates()
        const running = states.find((s: any) => s.status === 'running' && s.port)
        if (running) {
          logger.debug(
            `[TaskRouter] tandem 引擎已运行模型 ${running.modelId} (端口 ${running.port})，跳过 modelManager 重复加载`
          )
          return { swapped: false, toModel: running.modelId }
        }
      } catch (e) {
        logger.warn(`[TaskRouter] tandem 状态探测失败（忽略，走默认加载路径）: ${e}`)
      }
      // null：尝试加载默认主模型
      const mainId = modelManager.getDefaultMainModelId()
      if (!mainId) {
        logger.warn('[TaskRouter] 默认主模型未注册，跳过加载（等待 model-manager 初始化）')
        return { swapped: false, toModel: null }
      }
      const ok = await modelManager.loadModel(mainId)
      return { swapped: ok, toModel: modelManager.getLoadedModel()?.modelId ?? null }
    }

    // vision：由 swapToVision 统一处理（含主模型多模态检测→无需切换）
    if (tier === 'vision') {
      const ok = await modelManager.swapToVision()
      return { swapped: ok, toModel: modelManager.getLoadedModel()?.modelId ?? null }
    }

    // 理论上不可达
    return { swapped: false, toModel: modelManager.getLoadedModel()?.modelId ?? null }
  }

  private buildReason(intent: IntentClass, tier: Tier): string {
    if (tier === 'vision') {
      const isMulti = modelManager.isMainMultimodal()
      if (isMulti) return '含图片/截图，主模型自带多模态，无需切换'
      return '含图片/截图，切换到辅助视觉模型'
    }
    if (intent === 'code') return '代码任务，主模型处理'
    if (intent === 'reasoning') return '推理/分析任务，主模型处理'
    if (intent === 'math') return '数学任务，主模型处理'
    if (intent === 'longdoc') return '长文档任务，主模型处理'
    return '常规对话，主模型常驻处理'
  }

  /**
   * v12.2 是否为复杂任务（需要调用云端模型/专用推理引擎）。
   * 供 chat.ipc 判断是否降级到云端 API。
   */
  isComplexTask(intent: IntentClass, textLength: number): boolean {
    if (['reasoning', 'math', 'code', 'longdoc'].includes(intent)) return true
    if (textLength > 8000) return true // 超长文本视为复杂
    return false
  }

  /**
   * 对给定 signal 执行意图分类（供 chat.ipc 在 route 前提前判断用）。
   */
  classify(signal: RouteSignal): IntentClass {
    return classifyIntent(signal)
  }

  private emitState(gpuType: GpuState, tier: Tier, reason: string): void {
    try {
      const { BrowserWindow } = require('electron')
      const payload = { gpuType, tier, reason, ts: Date.now() }
      BrowserWindow.getAllWindows().forEach((w: any) => {
        try { w.webContents.send('router:state', payload) } catch (e) { logger.error('[TaskRouter] 发送 router:state 到渲染进程失败:', e) }
      })
    } catch (e) { logger.error('[TaskRouter] emitState 失败:', e) }
  }

  // @ts-expect-error TS6133 - after reserved for future use
  private emitToast(before: GpuState, after: GpuState, tier: Tier): void {
    try {
      if (tier === 'vision' && before === null) {
        this.sendToast('视觉已就绪（Qwen3.5-9B 常驻，未离开对话态）')
      }
    } catch (e) { logger.error('[TaskRouter] emitToast 失败:', e) }
  }

  private sendToast(message: string): void {
    try {
      const { BrowserWindow } = require('electron')
      BrowserWindow.getAllWindows().forEach((w: any) => {
        try { w.webContents.send('router:toast', { message, ts: Date.now() }) } catch (e) { logger.error('[TaskRouter] 发送 router:toast 到渲染进程失败:', e) }
      })
    } catch (e) { logger.error('[TaskRouter] sendToast 失败:', e) }
  }

  getLastResult(): TierResult | null {
    return this.lastResult
  }

  /** 获取最近一次上下文拼装结果（供推理引擎使用拼装后的消息列表） */
  getLastAssembly(): import('../context-manager/types').AssemblyResult | null {
    return this.lastAssembly
  }

  /** 将助手回复添加到历史（推理完成后调用） */
  addToHistory(role: 'user' | 'assistant', content: string): void {
    contextManager.addMessage({ role, content })
  }
}

export const taskRouter = new TaskRouter()

/**
 * 注册 task-router IPC 通道（命名空间 router:*，见架构 §10 对齐点）
 */
export function setupTaskRouterHandlers(): void {
  const { ipcMain } = require('electron')
  ipcMain.handle('router:get-state', () => {
    try {
      return {
        gpuType: modelManager.getGpuModelType(),
        tier: taskRouter.getLastResult()?.tier ?? 'fast',
        loaded: modelManager.getLoadedModel()?.modelId ?? null,
      }
    } catch (e) {
      logger.error('[TaskRouter] router:get-state 失败:', e)
      return { gpuType: null, tier: 'fast', loaded: null }
    }
  })

  // P2-1 预留：用户手动覆盖档位
  // @ts-expect-error TS6133 - tier reserved for future use
  ipcMain.handle('router:request-tier', async (_e: any, tier: Tier) => {
    try {
      const result = await taskRouter.route({ text: '', personaId: undefined } as RouteSignal)
      return result
    } catch (e) {
      logger.error('[TaskRouter] router:request-tier 失败:', e)
      return null
    }
  })
}
