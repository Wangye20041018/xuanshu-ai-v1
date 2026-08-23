# ============================================================
# 玄枢AI — 自签名代码证书生成脚本
# 用途: 生成用于本地签名的自签名证书（个人应用，无需购买 EV 证书）
# 运行: PowerShell (管理员) .\scripts\generate-cert.ps1
# ============================================================

param(
  [string]$CertName = "玄枢AI",
  [string]$Publisher = "玄枢AI",
  [string]$OutputDir = "$PSScriptRoot\..\resources\cert",
  [string]$Password = "xuanshu-cert-2026",
  [int]$ValidYears = 10
)

$ErrorActionPreference = "Stop"
Write-Host "===== 玄枢AI 自签名代码签名证书生成 =====" -ForegroundColor Cyan

# 1. 创建输出目录
if (-not (Test-Path $OutputDir)) {
  New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
  Write-Host "[1/5] 创建证书目录: $OutputDir" -ForegroundColor Green
} else {
  Write-Host "[1/5] 证书目录已存在: $OutputDir" -ForegroundColor Yellow
}

# 2. 生成自签名根证书 (PFX)
$CertPath = Join-Path $OutputDir "xuanshu-root.pfx"
$CertPathCer = Join-Path $OutputDir "xuanshu-root.cer"

$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject "CN=$CertName, O=$Publisher, C=CN" `
  -KeyUsage DigitalSignature `
  -KeyAlgorithm RSA `
  -KeyLength 4096 `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -NotAfter (Get-Date).AddYears($ValidYears) `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3")

Write-Host "[2/5] 自签名证书已生成: $($cert.Thumbprint)" -ForegroundColor Green

# 3. 导出 PFX (含私钥)
$securePassword = ConvertTo-SecureString -String $Password -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $CertPath -Password $securePassword | Out-Null
Write-Host "[3/5] PFX 证书已导出: $CertPath" -ForegroundColor Green

# 4. 导出 CER (公钥，供用户手动安装)
Export-Certificate -Cert $cert -FilePath $CertPathCer | Out-Null
Write-Host "[4/5] CER 证书已导出: $CertPathCer" -ForegroundColor Green

# 5. 安装到当前用户受信任根证书颁发机构
$rootStore = New-Object System.Security.Cryptography.X509Certificates.X509Store("Root", "CurrentUser")
$rootStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
$rootStore.Add($cert)
$rootStore.Close()
Write-Host "[5/5] 证书已安装到 '受信任的根证书颁发机构 (当前用户)'" -ForegroundColor Green

# 6. 同时安装到受信任的发布者
$publisherStore = New-Object System.Security.Cryptography.X509Certificates.X509Store("TrustedPublisher", "CurrentUser")
$publisherStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
$publisherStore.Add($cert)
$publisherStore.Close()
Write-Host "[额外] 证书已安装到 '受信任的发布者 (当前用户)'" -ForegroundColor Green

Write-Host ""
Write-Host "===== 完成 =====" -ForegroundColor Cyan
Write-Host "证书指纹: $($cert.Thumbprint)" -ForegroundColor Yellow
Write-Host "PFX 路径: $CertPath" -ForegroundColor Yellow
Write-Host "CER 路径: $CertPathCer" -ForegroundColor Yellow
Write-Host ""
Write-Host "提示: 运行 'signtool verify /pa <your.exe>' 可验证签名是否生效。" -ForegroundColor Gray
