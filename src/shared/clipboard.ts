/**
 * 安全的剪贴板写入工具
 * 在非 HTTPS 环境（如 Electron 开发模式）中，navigator.clipboard API 可能不可用，
 * 此时降级使用 document.execCommand('copy')。
 */
export async function safeCopyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // clipboard API 不可用，降级
  }

  // 降级方案：使用 execCommand
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    textarea.style.top = '-9999px'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const success = document.execCommand('copy')
    document.body.removeChild(textarea)
    return success
  } catch {
    return false
  }
}
