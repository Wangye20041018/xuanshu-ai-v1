/**
 * sensory-bus.ts — 感官总线 v1.0（多感官架构核心）
 *
 * 职责：
 * - 统一六路感官（视觉/听觉/身体/环境/数字/生理预留）的事件入口
 * - 归一化事件流：任何源都转为 SensoryEvent，带时间戳与置信度
 * - 多源订阅与分发：下游（状态推理/情境引擎）统一订阅，不关心来源
 * - 分级采样调度：高成本感官按需唤醒（事件驱动优先，能耗控制）
 * - 隐私开关：一键隐私模式关闭全部感知通道
 */

import { createLogger } from '../../shared/logger'

const logger = createLogger('SensoryBus')

/** 感官通道类型 */
export type SensoryChannel =
  | 'vision'      // 视觉：摄像头（手势/姿态/表情/视线/在场）
  | 'audio'       // 听觉：环境音（音乐/敲门/他人说话）
  | 'body'        // 身体：键鼠活动/输入节奏
  | 'environment' // 环境：时间/日程/系统状态
  | 'digital'     // 数字：剪贴板/通知/文件活动/网络
  | 'physio'      // 生理（预留）：手环/手表/心率

/** 事件类型（统一词表，各源按此上报） */
export type SensoryEventType =
  | 'gesture'        // 手势识别结果
  | 'face'           // 表情/注视
  | 'presence'       // 人在/离开
  | 'posture'        // 坐姿
  | 'input'          // 键鼠输入活动
  | 'idle'           // 无输入（空闲）
  | 'window'         // 窗口/应用切换
  | 'audio_output'   // 系统音频输出（播放中）
  | 'audio_input'    // 环境音输入
  | 'time'           // 时间信号（时段）
  | 'clipboard'      // 剪贴板活动
  | 'notification'   // 系统通知
  | 'file_activity'  // 文件活动
  | 'network'        // 网络活动
  | 'physio_data'    // 生理数据（预留）

/** 归一化感官事件 */
export interface SensoryEvent {
  channel: SensoryChannel
  type: SensoryEventType
  ts: number
  /** 事件置信度 0-1 */
  confidence: number
  /** 事件负载（各源自定义结构化数据） */
  payload?: Record<string, unknown>
}

/** 通道开关与采样级别 */
export interface ChannelConfig {
  enabled: boolean
  /** 采样级别：off=关闭 low=低频(1fps 在场检测) high=全帧率 */
  sampling: 'off' | 'low' | 'high'
}

/** 隐私模式：true 时全部通道关闭，退回纯对话 */
export type PrivacyMode = 'off' | 'on'

type EventListener = (event: SensoryEvent) => void

/**
 * SensoryBus — 单例感官总线
 */
export class SensoryBus {
  private listeners: EventListener[] = []
  private channels: Record<SensoryChannel, ChannelConfig> = {
    vision:       { enabled: false, sampling: 'off' },
    audio:        { enabled: false, sampling: 'off' },
    body:         { enabled: true,  sampling: 'high' },  // 系统信号零成本常开
    environment:  { enabled: true,  sampling: 'high' },  // 时间/系统状态零成本常开
    digital:      { enabled: true,  sampling: 'high' },  // 剪贴板/通知零成本常开
    physio:       { enabled: false, sampling: 'off' },   // 预留
  }
  private privacy: PrivacyMode = 'off'
  private lastEventAt: Record<SensoryEventType, number> = {} as Record<SensoryEventType, number>

  /* ==================== 订阅 ==================== */

  subscribe(listener: EventListener): () => void {
    this.listeners.push(listener)
    return () => {
      const idx = this.listeners.indexOf(listener)
      if (idx >= 0) this.listeners.splice(idx, 1)
    }
  }

  /* ==================== 事件注入 ==================== */

  /**
   * 注入归一化事件。隐私模式下除 environment 外全部丢弃。
   */
  emit(event: SensoryEvent): void {
    if (this.privacy === 'on' && event.channel !== 'environment') return
    const cfg = this.channels[event.channel]
    if (!cfg || !cfg.enabled) return

    this.lastEventAt[event.type] = event.ts
    for (const listener of this.listeners) {
      try { listener(event) } catch (e: any) { logger.error(`[SensoryBus] 监听器异常: ${e.message}`) }
    }
  }

  /** 便捷：某事件类型最近一次触发时间（用于空闲/活跃判断） */
  lastSeen(type: SensoryEventType): number {
    return this.lastEventAt[type] ?? 0
  }

  /* ==================== 通道配置 ==================== */

  getChannel(channel: SensoryChannel): ChannelConfig {
    return { ...this.channels[channel] }
  }

  setChannel(channel: SensoryChannel, patch: Partial<ChannelConfig>): void {
    const cfg = this.channels[channel]
    if (patch.enabled !== undefined) cfg.enabled = patch.enabled
    if (patch.sampling !== undefined) cfg.sampling = patch.sampling
    logger.info(`[SensoryBus] 通道配置: ${channel} -> ${JSON.stringify(cfg)}`)
  }

  /** 是否有任何高成本通道处于活动状态（用于能耗统计） */
  hasActiveSensors(): boolean {
    return (this.channels.vision.enabled && this.channels.vision.sampling !== 'off') ||
           (this.channels.audio.enabled && this.channels.audio.sampling !== 'off')
  }

  /* ==================== 隐私模式 ==================== */

  setPrivacy(mode: PrivacyMode): void {
    this.privacy = mode
    if (mode === 'on') {
      // 一键隐私：关闭视觉/听觉等敏感通道，保留零成本系统信号
      this.setChannel('vision', { enabled: false, sampling: 'off' })
      this.setChannel('audio', { enabled: false, sampling: 'off' })
      this.setChannel('physio', { enabled: false, sampling: 'off' })
    }
    logger.info(`[SensoryBus] 隐私模式: ${mode}`)
  }

  getPrivacy(): PrivacyMode {
    return this.privacy
  }
}

export const sensoryBus = new SensoryBus()
