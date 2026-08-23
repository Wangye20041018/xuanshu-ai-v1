@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

:: ============================================================
:: 玄枢AI - 本地 LLM 启动入口
:: 启动顺序：本地 LLM 服务 → 等待就绪 → 启动玄枢AI主程序
:: ============================================================

title 玄枢AI - 本地LLM启动中...

set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."
set "PYTHON=%PROJECT_DIR%\..\..\Marvis\MarvisAgent\1.0.1100.240\runtime\python311\python.exe"

:: 尝试找到 Python
if not exist "%PYTHON%" (
    for %%p in (python python3) do (
        where %%p >nul 2>&1
        if !errorlevel!==0 (
            set "PYTHON=%%p"
            goto :found_python
        )
    )
    echo [错误] 未找到 Python 解释器
    echo 请安装 Python 3.10+ 或设置 PYTHON 环境变量
    pause
    exit /b 1
)
:found_python

echo.
echo ============================================================
echo   玄枢AI - 本地 DeepSeek-7B 启动器
echo ============================================================
echo.
echo   Python: %PYTHON%
echo   项目目录: %PROJECT_DIR%
echo.

:: 服务配置
set LOCAL_LLM_PORT=8080
set LOCAL_LLM_STARTUP_TIMEOUT=120
set ROUTER_PORT=8090

:: ============================================================
:: 阶段 1：启动本地 LLM 推理服务
:: ============================================================
echo [1/3] 启动本地 LLM 推理服务...
echo.

set "LLM_SCRIPT=%PROJECT_DIR%\scripts\start_local_llm.py"

if not exist "%LLM_SCRIPT%" (
    echo [错误] 找不到启动脚本: %LLM_SCRIPT%
    pause
    exit /b 1
)

:: 先检查环境
echo 检查环境...
"%PYTHON%" "%LLM_SCRIPT%" --check-only
if !errorlevel! neq 0 (
    echo [错误] 环境检查未通过
    pause
    exit /b 1
)

:: 后台启动 LLM 服务
echo.
echo 启动 llama.cpp server...
start "玄枢AI-本地LLM" /MIN "%PYTHON%" "%LLM_SCRIPT%" --port %LOCAL_LLM_PORT%

:: ============================================================
:: 阶段 2：等待 LLM 服务就绪
:: ============================================================
echo.
echo [2/3] 等待 LLM 服务就绪 (最多 %LOCAL_LLM_STARTUP_TIMEOUT% 秒)...

set /a waited=0

:wait_loop
timeout /t 3 /nobreak >nul
set /a waited+=3

:: 用 Python 快速检查健康状态
"%PYTHON%" -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:%LOCAL_LLM_PORT%/health', timeout=3)" >nul 2>&1
if !errorlevel!==0 (
    echo.
    echo [OK] 本地 LLM 服务已就绪！耗时 %waited% 秒
    goto :llm_ready
)

if !waited! geq %LOCAL_LLM_STARTUP_TIMEOUT% (
    echo.
    echo [警告] 等待超时 (%LOCAL_LLM_STARTUP_TIMEOUT%秒)
    echo LLM 服务可能仍在加载模型，是否继续启动主程序？
    echo.
    choice /c YN /m "按 Y 继续(无本地LLM)，N 退出: "
    if !errorlevel!==2 exit /b 1
    goto :llm_ready
)

echo   等待中... (!waited!s)
goto :wait_loop

:llm_ready

:: ============================================================
:: 阶段 3：启动任务路由器（可选 HTTP 服务）
:: ============================================================
echo.
echo [3/3] 启动任务路由器...

set "ROUTER_SCRIPT=%PROJECT_DIR%\src\router\task_router.py"

if exist "%ROUTER_SCRIPT%" (
    start "玄枢AI-任务路由器" /MIN "%PYTHON%" "%ROUTER_SCRIPT%" --serve --port %ROUTER_PORT%
    echo [OK] 任务路由器已启动 (端口 %ROUTER_PORT%)
) else (
    echo [警告] 未找到路由器脚本，跳过
)

:: ============================================================
:: 启动玄枢AI主程序
:: ============================================================
echo.
echo ============================================================
echo   启动玄枢AI主程序...
echo ============================================================
echo.
echo   本地 LLM:  http://127.0.0.1:%LOCAL_LLM_PORT%/v1
echo   任务路由器: http://127.0.0.1:%ROUTER_PORT%
echo.

:: 检查是否有编译产出
set "MAIN_EXE=%PROJECT_DIR%\out\main\index.js"
set "DEV_MODE=0"

if exist "%MAIN_EXE%" (
    echo [信息] 发现编译产出，启动生产模式
    cd /d "%PROJECT_DIR%"
    call npm start
) else (
    echo [信息] 未编译，启动开发模式
    cd /d "%PROJECT_DIR%"
    call npm run dev
)

:: 主程序退出后清理
echo.
echo 玄枢AI主程序已退出。正在停止子服务...

:: 停止 LLM 服务
taskkill /FI "WINDOWTITLE eq 玄枢AI-本地LLM*" /T /F >nul 2>&1

:: 停止路由器
taskkill /FI "WINDOWTITLE eq 玄枢AI-任务路由器*" /T /F >nul 2>&1

echo 所有服务已停止。
endlocal
