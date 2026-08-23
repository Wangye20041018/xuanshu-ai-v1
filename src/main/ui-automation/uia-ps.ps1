<# 
  UIA PowerShell 核心脚本
  使用 System.Windows.Automation 提供 Windows 原生 UI Automation 能力
  所有函数通过 JSON 传参/返参，输出到 stdout
#>

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$ErrorActionPreference = "Stop"

# ============================================================
# 工具函数
# ============================================================

function ConvertTo-UIAElementJson {
  param($element, [int]$depth = 0, [int]$maxDepth = 10)
  
  if ($null -eq $element -or $depth -ge $maxDepth) {
    return $null
  }
  
  try {
    $current = [System.Windows.Automation.AutomationElement]::FromHandle($element.Current.NativeWindowHandle)
  } catch {
    $current = $element
  }
  
  if ($null -eq $current) { return $null }
  
  $rect = $current.Current.BoundingRectangle
  $obj = @{
    name          = if ($current.Current.Name) { $current.Current.Name } else { "" }
    controlType   = $current.Current.ControlType.ProgrammaticName -replace "ControlType\.", ""
    automationId  = if ($current.Current.AutomationId) { $current.Current.AutomationId } else { "" }
    className     = if ($current.Current.ClassName) { $current.Current.ClassName } else { "" }
    boundingRect  = @{
      x = [math]::Round($rect.X, 0)
      y = [math]::Round($rect.Y, 0)
      w = [math]::Round($rect.Width, 0)
      h = [math]::Round($rect.Height, 0)
    }
    isEnabled     = $current.Current.IsEnabled
    isVisible     = !$current.Current.IsOffscreen
    children      = @()
  }
  
  if ($depth -lt $maxDepth) {
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $child = $walker.GetFirstChild($current)
    while ($null -ne $child) {
      $childObj = ConvertTo-UIAElementJson -element $child -depth ($depth + 1) -maxDepth $maxDepth
      if ($null -ne $childObj) {
        $obj.children += $childObj
      }
      $child = $walker.GetNextSibling($child)
    }
  }
  
  return $obj
}

function Resolve-UIAWindow {
  param([string]$windowTitle)
  
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, $windowTitle
  )
  $window = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  
  if ($null -eq $window) {
    # 宽松匹配：部分标题
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Window
    )
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    foreach ($w in $windows) {
      if ($w.Current.Name -like "*$windowTitle*") {
        $window = $w
        break
      }
    }
  }
  
  return $window
}

function Build-UIAAndCondition {
  param(
    [string]$name = "",
    [string]$controlType = "",
    [string]$automationId = ""
  )
  
  $conditions = @()
  
  if ($name) {
    $conditions += New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty, $name
    )
  }
  if ($controlType) {
    $ct = [System.Windows.Automation.ControlType]::LookupById(
      [System.Windows.Automation.ControlType]::$controlType.Id
    )
    if ($null -ne $ct) {
      $conditions += New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ct
      )
    }
  }
  if ($automationId) {
    $conditions += New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $automationId
    )
  }
  
  if ($conditions.Count -eq 0) { return $null }
  if ($conditions.Count -eq 1) { return $conditions[0] }
  
  return New-Object System.Windows.Automation.AndCondition($conditions)
}

# ============================================================
# 公开函数
# ============================================================

function Get-UIAWindowTree {
  param([string]$windowTitle)
  
  try {
    $window = Resolve-UIAWindow -windowTitle $windowTitle
    if ($null -eq $window) {
      Write-Output (ConvertTo-Json @{ error = "Window not found: $windowTitle" })
      return
    }
    
    $tree = ConvertTo-UIAElementJson -element $window -depth 0 -maxDepth 10
    if ($null -eq $tree) {
      Write-Output (ConvertTo-Json @{ error = "Failed to build tree for: $windowTitle" })
      return
    }
    
    Write-Output ($tree | ConvertTo-Json -Depth 15 -Compress)
  } catch {
    Write-Output (ConvertTo-Json @{ error = "Get-UIAWindowTree failed: $_" })
  }
}

function Find-UIAElement {
  param(
    [string]$windowTitle,
    [string]$name = "",
    [string]$controlType = "",
    [string]$automationId = ""
  )
  
  try {
    $scope = [System.Windows.Automation.TreeScope]::Descendants
    $searchRoot = [System.Windows.Automation.AutomationElement]::RootElement
    
    if ($windowTitle) {
      $win = Resolve-UIAWindow -windowTitle $windowTitle
      if ($null -eq $win) {
        Write-Output (ConvertTo-Json @{ error = "Window not found: $windowTitle"; found = $false })
        return
      }
      $searchRoot = $win
    }
    
    $cond = Build-UIAAndCondition -name $name -controlType $controlType -automationId $automationId
    if ($null -eq $cond) {
      Write-Output (ConvertTo-Json @{ error = "No search conditions provided"; found = $false })
      return
    }
    
    $element = $searchRoot.FindFirst($scope, $cond)
    if ($null -eq $element) {
      Write-Output (ConvertTo-Json @{ found = $false; error = "Element not found" })
      return
    }
    
    $rect = $element.Current.BoundingRectangle
    Write-Output (ConvertTo-Json @{
      found        = $true
      name         = if ($element.Current.Name) { $element.Current.Name } else { "" }
      controlType  = $element.Current.ControlType.ProgrammaticName -replace "ControlType\."
      automationId = if ($element.Current.AutomationId) { $element.Current.AutomationId } else { "" }
      className    = if ($element.Current.ClassName) { $element.Current.ClassName } else { "" }
      boundingRect = @{
        x = [math]::Round($rect.X, 0)
        y = [math]::Round($rect.Y, 0)
        w = [math]::Round($rect.Width, 0)
        h = [math]::Round($rect.Height, 0)
      }
      isEnabled    = $element.Current.IsEnabled
    })
  } catch {
    Write-Output (ConvertTo-Json @{ found = $false; error = "Find-UIAElement failed: $_" })
  }
}

function Invoke-UIAElement {
  param(
    [string]$windowTitle,
    [string]$name = "",
    [string]$controlType = "",
    [string]$automationId = "",
    [string]$action
  )
  
  try {
    $scope = [System.Windows.Automation.TreeScope]::Descendants
    $searchRoot = [System.Windows.Automation.AutomationElement]::RootElement
    
    if ($windowTitle) {
      $win = Resolve-UIAWindow -windowTitle $windowTitle
      if ($null -eq $win) {
        Write-Output (ConvertTo-Json @{ success = $false; error = "Window not found: $windowTitle" })
        return
      }
      $searchRoot = $win
    }
    
    $cond = Build-UIAAndCondition -name $name -controlType $controlType -automationId $automationId
    if ($null -eq $cond) {
      Write-Output (ConvertTo-Json @{ success = $false; error = "No search conditions provided" })
      return
    }
    
    $element = $searchRoot.FindFirst($scope, $cond)
    if ($null -eq $element) {
      Write-Output (ConvertTo-Json @{ success = $false; error = "Element not found" })
      return
    }
    
    if (-not $element.Current.IsEnabled) {
      Write-Output (ConvertTo-Json @{ success = $false; error = "Element is disabled" })
      return
    }
    
    switch ($action) {
      "click" {
        try {
          $invokePattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
          $invokePattern.Invoke()
        } catch {
          # 降级：通过坐标点击
          $rect = $element.Current.BoundingRectangle
          $cx = [math]::Round($rect.X + $rect.Width / 2, 0)
          $cy = [math]::Round($rect.Y + $rect.Height / 2, 0)
          Add-Type -AssemblyName System.Windows.Forms
          [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($cx, $cy)
          Add-Type -MemberDefinition @'
[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int cButtons, int dwExtraInfo);
'@ -Name "Win32Mouse" -Namespace "NS"
          [NS.Win32Mouse]::mouse_event(0x0002, 0, 0, 0, 0)  # MOUSEEVENTF_LEFTDOWN
          Start-Sleep -Milliseconds 50
          [NS.Win32Mouse]::mouse_event(0x0004, 0, 0, 0, 0)  # MOUSEEVENTF_LEFTUP
        }
      }
      "invoke" {
        $invokePattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $invokePattern.Invoke()
      }
      "expand" {
        $expandPattern = $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        $expandPattern.Expand()
      }
      "collapse" {
        $expandPattern = $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        $expandPattern.Collapse()
      }
      "select" {
        $selectPattern = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        $selectPattern.Select()
      }
      "scrollIntoView" {
        $scrollPattern = $element.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern)
        $scrollPattern.ScrollIntoView()
      }
      default {
        Write-Output (ConvertTo-Json @{ success = $false; error = "Unknown action: $action" })
        return
      }
    }
    
    Write-Output (ConvertTo-Json @{ success = $true; action = $action })
  } catch {
    Write-Output (ConvertTo-Json @{ success = $false; error = "Invoke-UIAElement failed: $_" })
  }
}

function Set-UIAText {
  param(
    [string]$windowTitle,
    [string]$name = "",
    [string]$controlType = "",
    [string]$text
  )
  
  try {
    $scope = [System.Windows.Automation.TreeScope]::Descendants
    $searchRoot = [System.Windows.Automation.AutomationElement]::RootElement
    
    if ($windowTitle) {
      $win = Resolve-UIAWindow -windowTitle $windowTitle
      if ($null -eq $win) {
        Write-Output (ConvertTo-Json @{ success = $false; error = "Window not found: $windowTitle" })
        return
      }
      $searchRoot = $win
    }
    
    $cond = Build-UIAAndCondition -name $name -controlType $controlType
    if ($null -eq $cond) {
      Write-Output (ConvertTo-Json @{ success = $false; error = "No search conditions provided" })
      return
    }
    
    $element = $searchRoot.FindFirst($scope, $cond)
    if ($null -eq $element) {
      Write-Output (ConvertTo-Json @{ success = $false; error = "Element not found" })
      return
    }
    
    # 优先 ValuePattern.SetValue
    try {
      $valuePattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $valuePattern.SetValue($text)
      Write-Output (ConvertTo-Json @{ success = $true; method = "ValuePattern" })
      return
    } catch {
      # 降级：聚焦后键盘模拟
      $element.SetFocus()
      Start-Sleep -Milliseconds 100
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait($text)
      Write-Output (ConvertTo-Json @{ success = $true; method = "SendKeys" })
      return
    }
  } catch {
    Write-Output (ConvertTo-Json @{ success = $false; error = "Set-UIAText failed: $_" })
  }
}

function Get-UIAFocusedElement {
  try {
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $focused) {
      Write-Output (ConvertTo-Json @{ error = "No focused element" })
      return
    }
    
    $rect = $focused.Current.BoundingRectangle
    Write-Output (ConvertTo-Json @{
      name         = if ($focused.Current.Name) { $focused.Current.Name } else { "" }
      controlType  = $focused.Current.ControlType.ProgrammaticName -replace "ControlType\."
      automationId = if ($focused.Current.AutomationId) { $focused.Current.AutomationId } else { "" }
      className    = if ($focused.Current.ClassName) { $focused.Current.ClassName } else { "" }
      boundingRect = @{
        x = [math]::Round($rect.X, 0)
        y = [math]::Round($rect.Y, 0)
        w = [math]::Round($rect.Width, 0)
        h = [math]::Round($rect.Height, 0)
      }
      isEnabled    = $focused.Current.IsEnabled
      isFocused    = $focused.Current.HasKeyboardFocus
    })
  } catch {
    Write-Output (ConvertTo-Json @{ error = "Get-UIAFocusedElement failed: $_" })
  }
}

function Wait-ForUIAElement {
  param(
    [string]$windowTitle,
    [string]$name,
    [int]$timeoutMs = 5000
  )
  
  try {
    $elapsed = 0
    $interval = 200
    
    while ($elapsed -lt $timeoutMs) {
      $scope = [System.Windows.Automation.TreeScope]::Descendants
      $searchRoot = [System.Windows.Automation.AutomationElement]::RootElement
      
      if ($windowTitle) {
        $win = Resolve-UIAWindow -windowTitle $windowTitle
        if ($null -ne $win) {
          $searchRoot = $win
        }
      }
      
      $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, $name
      )
      $element = $searchRoot.FindFirst($scope, $cond)
      
      if ($null -ne $element) {
        $rect = $element.Current.BoundingRectangle
        Write-Output (ConvertTo-Json @{
          found        = $true
          name         = $element.Current.Name
          controlType  = $element.Current.ControlType.ProgrammaticName -replace "ControlType\."
          automationId = if ($element.Current.AutomationId) { $element.Current.AutomationId } else { "" }
          className    = if ($element.Current.ClassName) { $element.Current.ClassName } else { "" }
          boundingRect = @{
            x = [math]::Round($rect.X, 0)
            y = [math]::Round($rect.Y, 0)
            w = [math]::Round($rect.Width, 0)
            h = [math]::Round($rect.Height, 0)
          }
          isEnabled    = $element.Current.IsEnabled
        })
        return
      }
      
      Start-Sleep -Milliseconds $interval
      $elapsed += $interval
    }
    
    Write-Output (ConvertTo-Json @{ found = $false; timeoutMs = $timeoutMs })
  } catch {
    Write-Output (ConvertTo-Json @{ found = $false; error = "Wait-ForUIAElement failed: $_" })
  }
}

# ============================================================
# 入口调度
# ============================================================

if ($MyInvocation.ScriptName -ne "" -and $args.Count -gt 0) {
  $cmd = $args[0]
  $params = @{}
  if ($args.Count -gt 1) {
    try {
      $params = $args[1] | ConvertFrom-Json -AsHashtable
    } catch {
      # 非 JSON 参数，忽略
    }
  }
  
  switch ($cmd) {
    "GetTree"        { Get-UIAWindowTree @params }
    "FindElement"    { Find-UIAElement @params }
    "Invoke"         { Invoke-UIAElement @params }
    "SetText"        { Set-UIAText @params }
    "GetFocused"     { Get-UIAFocusedElement }
    "WaitForElement" { Wait-ForUIAElement @params }
    default          { Write-Output (ConvertTo-Json @{ error = "Unknown command: $cmd" }) }
  }
}
