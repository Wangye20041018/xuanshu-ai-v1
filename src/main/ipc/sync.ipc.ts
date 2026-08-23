/**
 * sync.ipc.ts — 手机同步 / WebRTC 通信模块
 *
 * 【状态：未实现】
 * 当前模块仅提供频道配置管理（channel list/enable/disable）和状态查询，
 * WebRTC 连接（sync:connect）、消息收发（sync:send-message）均返回桩响应。
 * 实际手机同步功能已通过 mobile-channel 模块实现，本模块留待后续 WebRTC 方案落地。
 */
import { ipcMain } from 'electron'
import { getStore } from './config.ipc'
import { logger } from '../../shared/logger'

interface PhoneChannel {
  id: string
  name: string
  description: string
  enabled: boolean
  status: 'ready' | 'pending' | 'error'
}

let isConnected = false

export function setupSyncHandlers(): void {
  ipcMain.handle('sync:channel:list', () => {
    try {
      const store = getStore()
      const channels = store.get('phoneChannels') || {}
      return Object.entries(channels).map(([id, enabled]) => {
        const channelInfo: Record<string, { name: string; description: string }> = {
          voice: { name: '语音通话', description: '手机与玄枢进行实时语音对话' },
          text: { name: '文字消息', description: '手机发送文字，玄枢处理并回复' },
          notification: { name: '通知推送', description: '玄枢向手机推送重要通知' },
          screen: { name: '屏幕共享', description: '手机查看玄枢屏幕画面' },
          control: { name: '远程控制', description: '手机远程控制玄枢执行操作' },
          data: { name: '数据同步', description: '同步记忆、笔记等到手机端' }
        }

        return {
          id,
          name: channelInfo[id]?.name || id,
          description: channelInfo[id]?.description || '',
          enabled,
          status: ['voice', 'text', 'notification', 'data'].includes(id) ? 'ready' : 'pending'
        } as PhoneChannel
      })
    } catch (error) {
      logger.error('sync:channel:list error:', error)
      return []
    }
  })

  ipcMain.handle('sync:channel:enable', (_event, channelId: string) => {
    try {
      const store = getStore()
      const channels = store.get('phoneChannels') || {}
      channels[channelId] = true
      store.set('phoneChannels', channels)
      return true
    } catch (error) {
      logger.error('sync:channel:enable error:', error)
      return false
    }
  })

  ipcMain.handle('sync:channel:disable', (_event, channelId: string) => {
    try {
      const store = getStore()
      const channels = store.get('phoneChannels') || {}
      channels[channelId] = false
      store.set('phoneChannels', channels)
      return true
    } catch (error) {
      logger.error('sync:channel:disable error:', error)
      return false
    }
  })

  ipcMain.handle('sync:connect', async (_event, _offer?: RTCSessionDescriptionInit) => {
    try {
      // Try to initialize WebRTC connection
      return { success: false, message: 'WebRTC connection not yet initialized. Use mobile channel instead.' }
    } catch (e) {
      logger.error('sync:connect 内部错误:', e)
      return { success: false, message: '同步连接遇到内部错误' }
    }
  })

  ipcMain.handle('sync:disconnect', () => {
    try {
      isConnected = false
      return true
    } catch (error) {
      logger.error('sync:disconnect error:', error)
      return false
    }
  })

  ipcMain.handle('sync:status', () => {
    try {
      const store = getStore()
      return {
        connected: isConnected,
        channels: store.get('phoneChannels')
      }
    } catch (error) {
      logger.error('sync:status error:', error)
      return { connected: false, channels: {} }
    }
  })

  ipcMain.handle('sync:send-message', (_event, _message: string) => {
    try { return { success: false, message: 'Sync messaging through WebRTC is not yet supported. Use mobile channel.' } }
    catch (e) {
      logger.error('sync:send-message 内部错误:', e)
      return { success: false, message: '同步操作遇到内部错误' }
    }
  })
}