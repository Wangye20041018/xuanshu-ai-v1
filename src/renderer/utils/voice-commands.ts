/**
 * 语音命令意图解析与处理框架
 *
 * 在 Home/index.tsx 的 recognition.onresult 中调用 parseVoiceCommand，
 * 匹配后走 handleVoiceCommand 处理，不发送到聊天。
 */

export interface VoiceCommand {
  intent: 'open_app' | 'search_file' | 'take_screenshot' | 'send_file' | 'open_settings' | 'unknown'
  params: Record<string, string>
}

/**
 * 解析用户语音输入，提取意图和参数
 */
export function parseVoiceCommand(text: string): VoiceCommand | null {
  const t = text.toLowerCase().trim()

  // 打开应用："打开微信"/"启动记事本"/"运行 cmd"
  if (/^(打开|启动|运行)\s*(.+)/.test(t)) {
    return { intent: 'open_app', params: { app: RegExp.$2.trim() } }
  }

  // 截图
  if (/^(截图|截屏|拍照)/.test(t)) {
    return { intent: 'take_screenshot', params: {} }
  }

  // 搜索文件："搜索文件 xxx"/"找 xxx"/"查找文件 xxx"
  if (/^(搜索文件|查找文件|找文件|找)\s*(.+)/.test(t)) {
    return { intent: 'search_file', params: { query: RegExp.$2.trim() } }
  }

  // 发送文件："发送文件 xxx"
  if (/^发送文件\s*(.+)/.test(t)) {
    return { intent: 'send_file', params: { file: RegExp.$1.trim() } }
  }

  // 打开设置
  if (/^(打开设置|设置|系统设置|打开配置)/.test(t)) {
    return { intent: 'open_settings', params: {} }
  }

  return null
}

/**
 * 处理语音命令
 * @param command 解析后的语音命令
 * @param ttsFeedback 可选的 TTS 反馈函数（文本转语音）
 */
export async function handleVoiceCommand(
  command: VoiceCommand,
  ttsFeedback?: (text: string) => void
): Promise<boolean> {
  const speak = ttsFeedback || (() => {})

  try {
    switch (command.intent) {
      case 'open_app': {
        try {
          await (window as any).api.invoke('desktop-automation:open-app', command.params.app)
        } catch {
          try {
            await (window as any).api.invoke('app:launch', { name: command.params.app })
          } catch {
            speak(`暂无法打开${command.params.app}`)
          }
        }
        return true
      }

      case 'take_screenshot': {
        try {
          await (window as any).api.invoke('system:screenshot')
        } catch {
          speak('截图功能暂未开放')
        }
        return true
      }

      case 'search_file': {
        try {
          const res = await (window as any).api.invoke('search:query-files', command.params.query)
          const items: Array<{ path: string; filename: string }> = (res && res.results) || []
          if (items.length > 0) {
            const names = items.slice(0, 3).map((i) => i.filename || i.path.split(/[\\/]/).pop()).join('、')
            speak(`找到 ${items.length} 个相关文件：${names}`)
          } else if (res && res.error) {
            speak('文件搜索暂不可用，请先在设置中建立文件索引')
          } else {
            speak(`未找到与${command.params.query}相关的文件`)
          }
        } catch {
          speak('文件搜索功能暂未开放')
        }
        return true
      }

      case 'send_file': {
        try {
          const res = await (window as any).api.invoke('search:query-files', command.params.file)
          const items: Array<{ path: string; filename: string }> = (res && res.results) || []
          if (items.length > 0) {
            const first = items[0]
            speak(`已找到文件 ${first.filename}，位于 ${first.path}，可在文件管理器中发送`)
          } else if (res && res.error) {
            speak('文件搜索暂不可用，请先在设置中建立文件索引')
          } else {
            speak(`未找到与${command.params.file}相关的文件`)
          }
        } catch {
          speak('文件发送功能暂未开放')
        }
        return true
      }

      case 'open_settings': {
        try {
          await (window as any).api.invoke('window:open-settings')
        } catch {
          // 导航到 Settings 页：通过 router 或直接修改 hash
          // 防御性检查：避免双 hash (/#/#/settings)
          if (typeof window !== 'undefined' && window.location.hash !== '#/settings') {
            window.location.hash = '#/settings'
          }
        }
        return true
      }

      default:
        return false
    }
  } catch {
    speak('该功能暂未开放')
    return false
  }
}
