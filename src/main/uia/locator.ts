/**
 * UIA 定位层 —— 控件树遍历与定位（v10.2，P1-2）
 *
 * 通过 Windows UI Automation 的 TreeWalker 遍历标准控件树，
 * 按 name / automationId / controlType / 部分文本 定位控件坐标。
 *
 * 设计（架构 §6.2 / §8.4）：
 *   - 零新依赖：使用 PowerShell + System.Windows.Automation（Windows 自带）。
 *   - 零显存：不加载任何模型，纯系统 API。
 *   - 覆盖范围：Win32 / WinForms / WPF / Electron 标准控件；UWP/游戏/远程桌面无标准控件 → 返回 null（交由视觉回退）。
 *   - 安全：搜索条件以 base64 JSON 经环境变量传入，避免把用户文本拼进 PowerShell 命令（注入防护）。
 */

import { POWERSHELL_EXE } from '../utils/powershell'

export interface UIACriteria {
  name?: string
  automationId?: string
  controlType?: string
  partialText?: string
}

export interface UIAControl {
  name: string
  automationId: string
  controlType: string
  className?: string
  x: number
  y: number
  width: number
  height: number
}

/**
 * 遍历控件树的 PowerShell 脚本（读取 $env:XS_UIA_CRIT 中的 base64 JSON 作为匹配条件）。
 * 采用显式栈深度优先遍历，限制最大节点数防止卡死；命中第一个即输出 JSON 并退出。
 */
const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$criteria = $null
try {
  $raw = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:XS_UIA_CRIT))
  $criteria = $raw | ConvertFrom-Json
} catch {
  Write-Output '{}'
  exit
}
$root = [System.Windows.Automation.AutomationElement]::RootElement
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
function Match($el) {
  $name = $el.Current.Name
  $aid = $el.Current.AutomationId
  $ct = $el.Current.ControlType.ProgrammaticName
  if ($criteria.name -and $name -eq $criteria.name) { return $true }
  if ($criteria.automationId -and $aid -eq $criteria.automationId) { return $true }
  if ($criteria.partialText -and $name -and $name.Contains($criteria.partialText)) { return $true }
  if ($criteria.controlType -and $ct -eq ('ControlType.' + $criteria.controlType)) { return $true }
  return $false
}
$stack = New-Object System.Collections.Generic.Stack[object]
$stack.Push($root)
$count = 0
$max = 5000
while ($stack.Count -gt 0 -and $count -lt $max) {
  $el = $stack.Pop()
  $count++
  if (Match $el) {
    $r = $el.Current.BoundingRectangle
    $out = [ordered]@{
      name = $el.Current.Name
      automationId = $el.Current.AutomationId
      controlType = $el.Current.ControlType.ProgrammaticName
      className = $el.Current.ClassName
      x = [int]$r.X
      y = [int]$r.Y
      width = [int]$r.Width
      height = [int]$r.Height
    }
    Write-Output ($out | ConvertTo-Json -Compress)
    exit
  }
  $child = $walker.GetFirstChild($el)
  while ($child -ne $null) {
    $stack.Push($child)
    $child = $walker.GetNextSibling($child)
  }
}
Write-Output '{}'
`

/**
 * 调用 PowerShell 遍历控件树，返回首个命中控件（无命中返回 null）。
 * Windows 平台专用；非 Windows 或未找到 PowerShell 时返回 null（交由视觉回退）。
 */
export function uiaLocate(criteria: UIACriteria): Promise<UIAControl | null> {
  return new Promise((resolve) => {
    try {
      // 非 Windows 直接回退
      if (process.platform !== 'win32') {
        resolve(null)
        return
      }
      const { execFile } = require('child_process')
      const b64 = Buffer.from(JSON.stringify(criteria)).toString('base64')
      execFile(
        POWERSHELL_EXE,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_SCRIPT],
        {
          env: { ...process.env, XS_UIA_CRIT: b64 },
          maxBuffer: 4 * 1024 * 1024,
          timeout: 15000,
          windowsHide: true,
        },
        (err: Error | null, stdout: string) => {
          if (err) {
            resolve(null)
            return
          }
          const line = (stdout || '').trim().split('\n').pop() || '{}'
          try {
            const parsed = JSON.parse(line)
            if (parsed && typeof parsed.x === 'number' && parsed.name !== undefined) {
              resolve(parsed as UIAControl)
            } else {
              resolve(null)
            }
          } catch {
            resolve(null)
          }
        },
      )
    } catch {
      resolve(null)
    }
  })
}
