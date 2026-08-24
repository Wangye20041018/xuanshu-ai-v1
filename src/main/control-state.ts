/**
 * control-state — 电脑控制状态广播
 *
 * 玄枢在执行「控制电脑」类操作（移动鼠标点击、键盘输入、注册表写入、
 * 服务启停、进程结束、提权等）时，向渲染进程广播控制状态，用于驱动
 * 全屏控制特效 overlay，让用户始终清楚「AI 此刻正在操作我的电脑」。
 *
 * @module control-state
 */

import { logger } from '../shared/logger'
import { sendToAllWindows } from './utils/broadcast'
import type { ControlPhase } from '../shared/agent-types'

export interface ControlState {
  active: boolean
  /** 正在执行的动作描述（供 overlay 展示） */
  detail: string
  /** 三态：thinking=冷静呼吸蓝 / acting=高频流动紫 / done=渐隐收束 */
  phase: ControlPhase
  ts: number
}

/** 避免同一动作的 active/finish 被高频触发导致渲染层抖动 */
let activeCount = 0
let lastDetail = ''

export function notifyControlStart(detail: string, phase: ControlPhase = 'acting'): void {
  activeCount += 1
  lastDetail = detail
  sendToAllWindows('control:state', { active: true, detail, phase, ts: Date.now() } satisfies ControlState)
  logger.debug(`[ControlState] 开始控制(${phase}): ${detail}`)
}

export function notifyControlFinish(phase: ControlPhase = 'done'): void {
  if (activeCount > 0) activeCount -= 1
  if (activeCount === 0) {
    sendToAllWindows('control:state', { active: false, detail: lastDetail, phase, ts: Date.now() } satisfies ControlState)
    logger.debug(`[ControlState] 结束控制(${phase}): ${lastDetail}`)
  }
}

/** 重置状态（窗口重新加载时调用，避免残留 active 标记） */
export function resetControlState(): void {
  activeCount = 0
  lastDetail = ''
}