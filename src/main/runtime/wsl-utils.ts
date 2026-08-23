import { spawn } from 'child_process'

/**
 * WSL2 工具函数集合（SGLang on WSL2 集成）
 * 纯函数模块，无副作用，便于单测。
 * 仅使用 Node 内置模块（child_process / fs / path），不引入第三方依赖。
 */

export interface WSLExecResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * 将 Windows 绝对路径翻译为 WSL 路径。
 * 例: E:\a\b.gguf -> /mnt/e/a/b.gguf
 * 规则：盘符取首字母小写；反斜杠转正斜杠；保留其余（含中文/空格，UTF-8）
 */
export function translateWindowsPathToWSL(winPath: string): string {
  const normalized = winPath.replace(/\\/g, '/')
  const m = normalized.match(/^([A-Za-z]):\/(.*)$/)
  if (!m) return normalized // 已经是 linux 路径则原样返回
  const drive = m[1].toLowerCase()
  return `/mnt/${drive}/${m[2]}`
}

/**
 * 逆操作：将 WSL 路径翻译回 Windows 路径。
 * 例: /mnt/e/a/b.gguf -> E:/a/b.gguf
 */
export function translateWSLPathToWindows(wslPath: string): string {
  const m = wslPath.match(/^\/mnt\/([a-z])\/(.*)$/)
  if (!m) return wslPath
  return `${m[1].toUpperCase()}:/${m[2]}`
}

/**
 * 将 linux 参数列表包成经 wsl.exe 执行的命令。
 * 例: ['python3','-m','sglang.launch_server',...] -> ['wsl.exe','-e','python3','-m','sglang.launch_server',...]
 */
export function buildWSLCommand(linuxArgs: string[]): string[] {
  return ['wsl.exe', '-e', ...linuxArgs]
}

/**
 * 经 wsl.exe 执行 linux 命令，返回 stdout/stderr/退出码。
 * 注意：本函数只 resolve 不 reject —— 任何异常都被捕获并体现在返回结果里。
 */
export function runWSLCommand(args: string[], opts?: { timeoutMs?: number }): Promise<WSLExecResult> {
  return new Promise((resolve) => {
    const child = spawn('wsl.exe', ['-e', ...args], { stdio: 'pipe', windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: -1, stdout, stderr: stderr + '\n[timeout]' })
    }, opts?.timeoutMs ?? 30000)
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
    child.on('error', (err: Error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: err.message })
    })
  })
}
