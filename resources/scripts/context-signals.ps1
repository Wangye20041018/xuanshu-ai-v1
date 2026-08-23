# context-signals.ps1 — 情境信号采集（M1 系统信号源）
# 常驻轮询：用户输入空闲时长 + 前台窗口标题，每 2s 输出一行 JSON
# 零依赖：user32 GetLastInputInfo / GetForegroundWindow / GetWindowText

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class XS_Native {
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
}
"@

function Get-JsonLine {
  $lii = New-Object XS_Native+LASTINPUTINFO
  $lii.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($lii)
  [XS_Native]::GetLastInputInfo([ref]$lii) | Out-Null
  $idleMs = [Environment]::TickCount - $lii.dwTime
  $hwnd = [XS_Native]::GetForegroundWindow()
  $title = ''
  if ($hwnd -ne [IntPtr]::Zero) {
    $sb = New-Object System.Text.StringBuilder 512
    [XS_Native]::GetWindowText($hwnd, $sb, 512) | Out-Null
    $title = $sb.ToString()
  }
  $titleJson = $title | ConvertTo-Json -Compress
  Write-Output ("{{""idle"":{0},""window"":{1}}}" -f $idleMs, $titleJson)
}

while ($true) {
  try {
    Get-JsonLine
  } catch {
    Write-Output '{"idle":-1,"window":"error"}'
  }
  Start-Sleep -Milliseconds 2000
}
