# build-all.ps1 - 玄枢AI 双目标构建脚本
# NSIS 安装版：全量资源（~3.3GB），安装到磁盘，无需每次解压
# Portable 便携版：轻量核心（~250MB），重型资源独立配套包
#
# 用法: .\scripts\build-all.ps1 [-skipNsis] [-skipPortable]

param(
  [switch]$skipNsis,
  [switch]$skipPortable
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Set-Location $root

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " 玄枢AI 双目标构建" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# ============================================
# Step 0: 编译 TypeScript
# ============================================
Write-Host "`n[0/4] 编译 TypeScript..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) { throw "TypeScript 编译失败" }
Write-Host "  编译完成" -ForegroundColor Green

# ============================================
# Step 1: 构建 NSIS 安装版（全量资源）
# ============================================
if (-not $skipNsis) {
  Write-Host "`n[1/4] 构建 NSIS 安装版（全量资源 ~3.3GB）..." -ForegroundColor Yellow
  npx electron-builder --win nsis
  if ($LASTEXITCODE -ne 0) { throw "NSIS 构建失败" }
  
  $nsisFile = Get-ChildItem -Path "__app_pkg__" -Filter "XuanShuAI_Setup_*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($nsisFile) {
    Write-Host "  NSIS 安装版: $($nsisFile.Name) ($([math]::Round($nsisFile.Length/1MB, 2)) MB)" -ForegroundColor Green
  }
}

# ============================================
# Step 2: 构建 Portable 便携版（轻量核心）
# ============================================
if (-not $skipPortable) {
  Write-Host "`n[2/4] 构建 Portable 便携版（轻量核心 ~250MB）..." -ForegroundColor Yellow
  npx electron-builder --config electron-builder.portable.yml --win portable
  if ($LASTEXITCODE -ne 0) { throw "Portable 构建失败" }
  
  $portableFile = Get-ChildItem -Path "__app_pkg__" -Filter "XuanShuAI_*_Portable.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($portableFile) {
    Write-Host "  Portable 核心: $($portableFile.Name) ($([math]::Round($portableFile.Length/1MB, 2)) MB)" -ForegroundColor Green
  }
}

# ============================================
# Step 3: 打包便携版重型资源配套包
# ============================================
if (-not $skipPortable) {
  Write-Host "`n[3/4] 打包便携版重型资源配套包..." -ForegroundColor Yellow
  
  $depsDir = "__app_pkg__\portable-deps"
  $depsResources = "$depsDir\resources"
  
  # 清理旧文件
  if (Test-Path $depsDir) { Remove-Item -Recurse -Force $depsDir }
  New-Item -ItemType Directory -Path $depsResources -Force | Out-Null
  
  # Python 运行时 (~1,758 MB)
  Write-Host "  复制 Python 运行时..." -ForegroundColor Gray
  Copy-Item -Recurse "resources\python" "$depsResources\python"
  
  # CUDA DLLs (~1,096 MB)
  Write-Host "  复制 CUDA DLLs..." -ForegroundColor Gray
  $cudaFiles = @(
    "cublas64_12.dll", "cublasLt64_12.dll",
    "ggml-cuda.dll"
  )
  foreach ($f in $cudaFiles) {
    $src = "resources\$f"
    if (Test-Path $src) { Copy-Item $src "$depsResources\$f" }
  }
  
  # FFmpeg (~165 MB)
  Write-Host "  复制 FFmpeg..." -ForegroundColor Gray
  $ffmpegFiles = @(
    "ffmpeg.exe", "ffplay.exe", "ffprobe.exe"
  )
  foreach ($f in $ffmpegFiles) {
    $src = "resources\$f"
    if (Test-Path $src) { Copy-Item $src "$depsResources\$f" }
  }
  Get-ChildItem "resources" -Filter "av*.dll" | ForEach-Object {
    Copy-Item $_.FullName "$depsResources\$($_.Name)"
  }
  
  # 打包为 zip
  Write-Host "  创建 deps.zip..." -ForegroundColor Gray
  $depsZip = "__app_pkg__\XuanShuAI_Portable_Deps.zip"
  if (Test-Path $depsZip) { Remove-Item $depsZip }
  Compress-Archive -Path "$depsDir\*" -DestinationPath $depsZip
  
  $depsSize = [math]::Round((Get-Item $depsZip).Length/1MB, 2)
  Write-Host "  Portable 配套包: XuanShuAI_Portable_Deps.zip ($depsSize MB)" -ForegroundColor Green
  
  # 清理临时目录
  Remove-Item -Recurse -Force $depsDir
}

# ============================================
# Step 4: 汇总报告
# ============================================
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host " 构建完成" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Get-ChildItem "__app_pkg__" -Filter "XuanShuAI_*" | ForEach-Object {
  $size = [math]::Round($_.Length/1MB, 2)
  Write-Host "  $($_.Name) ($size MB)" -ForegroundColor White
}
Write-Host ""
Write-Host "便携版使用说明:" -ForegroundColor Yellow
Write-Host "  1. 将 XuanShuAI_*_Portable.exe 放到任意目录" -ForegroundColor Gray
Write-Host "  2. 解压 XuanShuAI_Portable_Deps.zip 到同级目录" -ForegroundColor Gray
Write-Host "  3. 确保目录结构为: your-dir/" -ForegroundColor Gray
Write-Host "       XuanShuAI_*_Portable.exe" -ForegroundColor Gray
Write-Host "       resources/python/" -ForegroundColor Gray
Write-Host "       resources/cublas64_12.dll" -ForegroundColor Gray
Write-Host "       ..." -ForegroundColor Gray
Write-Host "  4. 运行 Portable.exe 即可" -ForegroundColor Gray
