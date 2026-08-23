# ============================================================
# 玄枢AI — 证书安装脚本（面向最终用户）
# 用途: 将自签名根证书导入受信任的根证书颁发机构
# 运行: 右键 → 以管理员身份运行 PowerShell，执行此脚本
#       或使用配套的 install-cert.bat 一键启动
# ============================================================

param(
  [string]$CertPath = "$PSScriptRoot\..\resources\cert\xuanshu-root.cer",
  [switch]$Silent = $false
)

$ErrorActionPreference = "Stop"

function Write-Status($msg, $color = "White") {
  if (-not $Silent) { Write-Host $msg -ForegroundColor $color }
}

Write-Status "===== 玄枢AI — 证书信任安装 =====" Cyan

# 检查管理员权限
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Status "[错误] 此脚本需要管理员权限运行！" Red
  Write-Status "请右键此脚本 → '以管理员身份运行 PowerShell'" Yellow
  Start-Sleep -Seconds 3
  exit 1
}

# 检查证书文件是否存在
if (-not (Test-Path $CertPath)) {
  Write-Status "[错误] 找不到证书文件: $CertPath" Red
  Write-Status "请确保已先运行 generate-cert.ps1 生成证书" Yellow
  Start-Sleep -Seconds 3
  exit 1
}

Write-Status "[1/3] 正在加载证书..." Green

# 加载证书
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2
$cert.Import($CertPath)

Write-Status "[2/3] 正在安装到受信任的根证书颁发机构..." Green

# 安装到受信任的根证书颁发机构 (LocalMachine — 所有用户)
$rootStore = New-Object System.Security.Cryptography.X509Certificates.X509Store("Root", "LocalMachine")
$rootStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)

# 检查是否已安装
$existing = $rootStore.Certificates | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
if ($existing) {
  Write-Status "  [跳过] 证书已存在于受信任的根证书颁发机构中" Yellow
} else {
  $rootStore.Add($cert)
  Write-Status "  [成功] 证书已添加到受信任的根证书颁发机构 (LocalMachine)" Green
}
$rootStore.Close()

Write-Status "[3/3] 正在安装到受信任的发布者..." Green

# 安装到受信任的发布者
$publisherStore = New-Object System.Security.Cryptography.X509Certificates.X509Store("TrustedPublisher", "LocalMachine")
$publisherStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)

$existingPub = $publisherStore.Certificates | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
if ($existingPub) {
  Write-Status "  [跳过] 证书已存在于受信任的发布者中" Yellow
} else {
  $publisherStore.Add($cert)
  Write-Status "  [成功] 证书已添加到受信任的发布者 (LocalMachine)" Green
}
$publisherStore.Close()

Write-Status ""
Write-Status "===== 安装完成 =====" Cyan
Write-Status "玄枢AI 的代码签名证书已受信任，不会再触发 SmartScreen 拦截。" Green
Write-Status ""

if (-not $Silent) {
  Write-Status "按任意键退出..." Gray
  $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}
