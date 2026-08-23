$ErrorActionPreference = "Stop"
$logFile = "E:\开发\pack_v2.log"
$startTime = Get-Date

"=== START $($startTime.ToString('yyyy-MM-dd HH:mm:ss')) ===" | Out-File $logFile -Encoding UTF8
"node: $(node --version), npm: $(npm --version)" | Out-File $logFile -Append -Encoding UTF8

Set-Location E:\开发

# Kill any stuck processes
Get-Process -Name "electron-builder","node" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq "" } | Stop-Process -Force -ErrorAction SilentlyContinue

# Run electron-builder
try {
    $proc = Start-Process -FilePath "npx" -ArgumentList "electron-builder","--win","--publish=never","--config.nodeGypRebuild=true" -NoNewWindow -Wait -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"
    $exitCode = $proc
    $endTime = Get-Date
    $duration = ($endTime - $startTime).TotalMinutes
    "=== DONE $($endTime.ToString('yyyy-MM-dd HH:mm:ss')) exit=$exitCode duration=$([math]::Round($duration,1))min ===" | Out-File $logFile -Append -Encoding UTF8
} catch {
    "=== ERROR: $_ ===" | Out-File $logFile -Append -Encoding UTF8
}

# List output files
Get-ChildItem "__app_pkg__\*.exe" -ErrorAction SilentlyContinue | ForEach-Object {
    "$($_.Name) | $([math]::Round($_.Length/1MB, 2))MB | $($_.LastWriteTime)" | Out-File $logFile -Append -Encoding UTF8
}
