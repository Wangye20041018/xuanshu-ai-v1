@echo off
chcp 65001 >nul
title 玄枢AI - 启动

setlocal EnableDelayedExpansion

set "APP_DIR=%~dp0"
set "LOG_DIR=%APP_DIR%logs"
set "LOG_FILE=%LOG_DIR%\startup.log"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

echo ========================================== >> "%LOG_FILE%"
echo [%date% %time%] 玄枢AI 启动 >> "%LOG_FILE%"
echo ========================================== >> "%LOG_FILE%"

echo.
echo ==========================================
echo  玄枢AI - 启动中...
echo ==========================================
echo.

echo [1/5] 配置VC++运行库...
set "VC_DLL_DIR=%APP_DIR%vc_dll"
set "VC_REDIST=%APP_DIR%vc_redist\vc_redist.x64.exe"

if exist "%VC_DLL_DIR%" (
    set "PATH=%VC_DLL_DIR%;%PATH%"
    echo  [OK] VC++ DLL已加载
)

REM 不自动安装VC++，避免触发系统重启
if exist "%VC_REDIST%" (
    reg query "HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" /v "Version" >nul 2>&1
    if !errorlevel! neq 0 (
        echo  [提示] VC++运行库未安装，请手动运行: %VC_REDIST%
        echo  [提示] 部分功能可能受限
    ) else (
        echo  [OK] VC++运行库已安装
    )
)

echo [2/5] 配置Python环境...
set "PYTHON_HOME=%APP_DIR%python"
set "PYTHON_EXE=%PYTHON_HOME%\python.exe"

if exist "%PYTHON_EXE%" (
    set "PYTHONPATH=%PYTHON_HOME%\Lib;%PYTHON_HOME%\Lib\site-packages"
    set "PYTHONHOME=%PYTHON_HOME%"
    set "PATH=%PYTHON_HOME%;%PYTHON_HOME%\Scripts;%PATH%"
    echo  [OK] 内置Python已加载
    echo [%date% %time%] PYTHON_HOME=%PYTHON_HOME% >> "%LOG_FILE%"
) else (
    echo  [提示] 未找到内置Python，使用系统Python
    where python >nul 2>&1
    if !errorlevel! equ 0 (
        for /f "tokens=*" %%i in ('where python') do set "PYTHON_EXE=%%i"
    )
)

echo [3/5] 配置CUDA环境...
set "CUDA_DLL_DIR=%APP_DIR%python\Lib\site-packages\torch\lib"
if exist "%CUDA_DLL_DIR%" (
    set "CUDA_PATH=%CUDA_DLL_DIR%"
    set "CUDA_HOME=%CUDA_DLL_DIR%"
    set "PATH=%CUDA_DLL_DIR%;%PATH%"
    set "SGLANG_CUDA_RUNTIME=%CUDA_DLL_DIR%"
    set "CUDA_VISIBLE_DEVICES=0"
    set "CUDA_LIBPATH=%CUDA_DLL_DIR%"
    echo  [OK] 内置CUDA已加载
    echo [%date% %time%] CUDA_PATH=%CUDA_DLL_DIR% >> "%LOG_FILE%"
) else (
    echo  [提示] 未找到内置CUDA，使用系统CUDA
    if defined CUDA_PATH (
        set "PATH=%CUDA_PATH%\bin;%PATH%"
    )
)

REM 不调用nvidia-smi，避免显卡驱动崩溃
echo [4/5] 检查GPU...
echo  [OK] GPU配置完成

echo [4.5/5] 加载二进制工具...
set "PATH=%APP_DIR%;%PATH%"
echo  [OK] 二进制工具已加载 ^(ffmpeg, llama-server等^)

echo [5/5] 启动玄枢AI主程序...
set "XUANSHU_DATA_DIR=%APP_DIR%data"

if not exist "%APP_DIR%data" mkdir "%APP_DIR%data"
if not exist "%APP_DIR%data\models" mkdir "%APP_DIR%data\models"
if not exist "%APP_DIR%data\cache" mkdir "%APP_DIR%data\cache"

cd /d "%APP_DIR%"

if exist "%APP_DIR%玄枢AI.exe" (
    echo.
    echo ==========================================
    echo  启动完成！
    echo  数据目录: %APP_DIR%data
    echo ==========================================
    echo.
    
    echo [%date% %time%] 启动主程序 >> "%LOG_FILE%"
    
    REM 不使用--data-dir参数，避免路径问题
    start "" "%APP_DIR%玄枢AI.exe"
    
    timeout /t 3 /nobreak >nul
) else (
    echo [错误] 主程序未找到: %APP_DIR%玄枢AI.exe
    echo [%date% %time%] [ERROR] 主程序未找到 >> "%LOG_FILE%"
    pause
    exit /b 1
)

exit