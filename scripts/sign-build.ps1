# ============================================================
# 玄枢AI — 构建产物签名脚本
# 用途: 在 electron-builder 打包完成后，对未自动签名的 exe/dll 补充签名
# 运行: .\scripts\sign-build.ps1 -BuildDir ".\__app_pkg__"
# ============================================================

param(
  [Parameter(Mandatory=$true)]
  [string]$BuildDir,
  [string]$CertPath = "$PSScriptRoot\..\resources\cert\xuanshu-root.pfx",
  [string]$CertPassword = "xuanshu-cert-2026",
  [string]$TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"
Write-Host "===== 玄枢AI — 构建产物签名 =====" -ForegroundColor Cyan

# 查找 signtool
$signtoolPaths = @(
  "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe",
  "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.0.22000.0\x64\signtool.exe",
  "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.0.20348.0\x64\signtool.exe",
  "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.0.19041.0\x64\signtool.exe",
  "${env:ProgramFiles(x86)}\Windows Kits\10\bin\x64\signtool.exe"
)

$signtool = $null
foreach ($path in $signtoolPaths) {
  if (Test-Path $path) { $signtool = $path; break }
}

if (-not $signtool) {
  Write-Host "[错误] 找不到 signtool.exe，请安装 Windows 10 SDK" -ForegroundColor Red
  Write-Host "下载地址: https://developer.microsoft.com/en-us/windows/downloads/windows-sdk/" -ForegroundColor Yellow
  exit 1
}

Write-Host "[工具] signtool: $signtool" -ForegroundColor Green

# 签名所有 exe 和 dll 文件
$files = Get-ChildItem -Path $BuildDir -Recurse -Include "*.exe", "*.dll" | Where-Object { $_.FullName -notmatch "node_modules|__pycache__" }
$total = $files.Count
$signed = 0

foreach ($file in $files) {
  Write-Host "[签名] ($signed/$total) $($file.Name)" -ForegroundColor Gray
  & $signtool sign /fd SHA256 /f $CertPath /p $CertPassword /tr $TimestampUrl /td SHA256 /v $file.FullName 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $signed++ }
}

Write-Host ""
Write-Host "===== 签名完成: $signed/$total =====" -ForegroundColor Cyan
