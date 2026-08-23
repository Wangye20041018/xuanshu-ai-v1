$ErrorActionPreference = "Continue"
$projectRoot = "E:\开发"
$logFile = Join-Path $projectRoot "build_log.txt"

# 清理旧日志
if (Test-Path $logFile) { Remove-Item $logFile -Force }
New-Item -Path $logFile -ItemType File -Force | Out-Null

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content -Path $logFile -Value "[$timestamp] 玄枢AI 打包开始" -Encoding UTF8

try {
    Set-Location $projectRoot
    
    # 使用 npx 调用 electron-builder
    $proc = Start-Process -FilePath "npx" -ArgumentList "electron-builder","--win","--publish=never" -NoNewWindow -RedirectStandardOutput $logFile -RedirectStandardError $logFile -Wait -PassThru
    
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $logFile -Value "[$timestamp] 打包完成，退出码: $($proc.ExitCode)" -Encoding UTF8
    
    # 列出输出文件
    $outputDir = Join-Path $projectRoot "__app_pkg__"
    if (Test-Path $outputDir) {
        Add-Content -Path $logFile -Value "--- 输出文件 ---" -Encoding UTF8
        Get-ChildItem $outputDir -Recurse -File | ForEach-Object {
            $sizeMB = [math]::Round($_.Length / 1MB, 2)
            Add-Content -Path $logFile -Value "$($_.Name)  |  $sizeMB MB" -Encoding UTF8
        }
    }
} catch {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $logFile -Value "[$timestamp] 打包异常: $_" -Encoding UTF8
}
