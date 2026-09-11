/**
 * 紧急暂停（三级闸门第 ③ 级，最高优先级中断）
 *
 * 全局快捷键 Ctrl+Shift+F12（备选 Ctrl+Shift+Escape）：
 *   触发后 abort 所有运行中的 visual-agent 任务 + 取消所有 ReAct 智能体，
 *   并向渲染层广播 control:panic，overlay 进入「已暂停」态。
 *
 * 设计理由：Ctrl+Shift+Escape 与系统任务管理器冲突，默认 Ctrl+Shift+F12。
 *
 * @module main/agent/panic-stop
 */

import { globalShortcut, ipcMain } from 'electron'
import { logger } from '../../shared/logger'
import { stopAllAgents } from './agent-runtime'
import { sendToAllWindows } from '../utils/broadcast'
import { notifyControlFinish } from '../control-state'
import { visualAgent } from '../visual-agent'

/** 默认快捷键（可与系统任务管理器区分开） */
export const PANIC_ACCELERATOR = 'Ctrl+Shift+F12'

let registered = false

/** 中断所有控制任务 + 广播已暂停 */
export async function triggerPanicStop(): Promise<void> {
  logger.warn('[PanicStop] 紧急暂停触发，中断所有控制任务')

  // ① 取消所有运行中的智能体 ReAct 循环
  try {
    stopAllAgents()
  } catch (e) {
    logger.error(`[PanicStop] 取消智能体失败: ${e instanceof Error ? e.message : String(e)}`)
  }

  // ② abort 运行中的 visual-agent 任务
  try {
    visualAgent.cancel()
  } catch (e) {
    logger.error(`[PanicStop] 取消视觉代理失败: ${e instanceof Error ? e.message : String(e)}`)
  }

  // ③ 结束控制状态（overlay 渐隐）
  try {
    notifyControlFinish('done')
  } catch {
    /* ignore */
  }

  // ④ 广播已暂停（overlay 展示「已暂停」态）
  sendToAllWindows('control:panic', { ts: Date.now() })
  logger.info('[PanicStop] 紧急暂停完成')
}

/**
 * 注册全局快捷键（应用 ready 后调用）。
 * 幂等：重复调用不重复注册。
 */
export function setupPanicStop(): void {
  if (registered) return
  try {
    const ok = globalShortcut.register(PANIC_ACCELERATOR, () => {
      void triggerPanicStop()
    })
    registered = ok
    if (!ok) {
      logger.warn(`[PanicStop] 全局快捷键注册失败: ${PANIC_ACCELERATOR}（可能被占用）`)
    } else {
      logger.info(`[PanicStop] 已注册紧急暂停快捷键: ${PANIC_ACCELERATOR}`)
    }
  } catch (e) {
    logger.error(`[PanicStop] 注册异常: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 注销快捷键（应用退出时调用） */
export function teardownPanicStop(): void {
  try {
    globalShortcut.unregister(PANIC_ACCELERATOR)
    registered = false
  } catch {
    /* ignore */
  }
}

/** 注册 panic IPC handler（renderer 按钮触发） */
export function setupPanicHandlers(): void {
  ipcMain.handle('agent:panic', async () => {
    await triggerPanicStop()
    return { success: true }
  })
}
