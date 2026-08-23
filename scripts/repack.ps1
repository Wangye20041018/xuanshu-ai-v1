$logFile = "E:\开发\pack_result.txt"
"=== 玄枢AI 打包开始 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Out-File $logFile -Encoding UTF8

try {
    Set-Location E:\开发
    npx electron-builder --win --publish=never *>> $logFile
    "=== 打包完成 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Out-File $logFile -Append -Encoding UTF8
} catch {
    "=== 异常: $_ ===" | Out-File $logFile -Append -Encoding UTF8
}
