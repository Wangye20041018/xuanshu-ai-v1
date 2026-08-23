$ErrorActionPreference = "Stop"
$projectRoot = "E:\开发"
$logFile = "$projectRoot\build_log.txt"
$outputDir = "$projectRoot\__app_pkg__"

# 创建 time-stamped 日志
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

try {
    # 清理之前的日志
    if (Test-Path $logFile) { Remove-Item $logFile -Force }

    "[$timestamp] 开始打包..." | Out-File -FilePath $logFile -Encoding UTF8

    # 清理旧的输出目录以节省空间
    if (Test-Path $outputDir) {
        "[$timestamp] 清理旧输出目录..." | Out-File -FilePath $logFile -Append -Encoding UTF8
        Remove-Item $outputDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    "[$timestamp] 构建已完成，直接开始 electron-builder 打包..." | Out-File -FilePath $logFile -Append -Encoding UTF8

    # 运行打包
    Set-Location $projectRoot
    $result = & npx electron-builder --win --publish=never 2>&1

    "[$timestamp] 打包完成" | Out-File -FilePath $logFile -Append -Encoding UTF8
    $result | Out-File -FilePath $logFile -Append -Encoding UTF8

} catch {
    $endTime = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[$timestamp] 打包失败: $_" | Out-File -FilePath $logFile -Append -Encoding UTF8
    throw
}
