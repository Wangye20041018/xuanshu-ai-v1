/**
 * 统一的 PowerShell 路径工具
 *
 * Electron 子进程的 PATH 环境变量中可能不包含 System32，
 * 因此必须使用完整路径调用 powershell.exe。
 * 所有需要调用 PowerShell 的模块都应通过此工具获取正确路径。
 */

/** PowerShell 可执行文件的完整路径 */
export const POWERSHELL_EXE: string = process.env.SystemRoot
  ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  : 'powershell'

/** PowerShell 命令行前缀，用于 exec/execSync 等字符串命令 */
export const POWERSHELL_CMD = `"${POWERSHELL_EXE}"`

/** 在 Python 脚本中使用的 PowerShell 路径表达式 */
export const POWERSHELL_PY = `os.path.join(os.environ.get('SystemRoot', 'C:\\\\Windows'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')`