@echo off
:: ============================================================
:: 玄枢AI — 证书一键安装 (用户友好版)
:: 双击即可启动管理员权限安装流程
:: ============================================================
title 玄枢AI — 证书信任安装

echo.
echo    ==========================================
echo        玄枢AI — 代码签名证书安装向导
echo    ==========================================
echo.
echo    此向导将为玄枢AI安装受信任的代码签名证书，
echo    解决 Windows SmartScreen 误拦截问题。
echo.
echo    需要管理员权限，请在弹出的 UAC 窗口中点击"是"。
echo.
pause

:: 获取脚本所在目录
set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%install-cert.ps1"

:: 以管理员权限启动 PowerShell 执行安装脚本
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%PS_SCRIPT%\"' -Verb RunAs -Wait"

echo.
echo    安装完成！您可以关闭此窗口。
echo.
pause
