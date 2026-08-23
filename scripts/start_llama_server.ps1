# ============================================================
# llama.cpp Server 启动脚本 v1.0
#
# 用途：后台启动 llama.cpp HTTP Server
# 参数：--n_ctx 8192 --ngl 35 --host 127.0.0.1 --port 8080
# 模型：E:\模型\9B\Qwen3.5-9B-Q4_K_M.gguf
#
# 输出 PID 到文件（E:\开发\scripts\llama_server.pid）
# 日志输出到 E:\开发\scripts\llama_server.log
# ============================================================

param(
    [string]$ModelPath = "E:\模型\9B\Qwen3.5-9B-Q4_K_M.gguf",
    [int]$Port = 8080,
    [int]$Ngl = 35,
    [int]$NCtx = 8192,
    [string]$Host = "127.0.0.1"
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PidFile = Join-Path $ScriptDir "llama_server.pid"
$LogFile = Join-Path $ScriptDir "llama_server.log"

Write-Host "=== llama.cpp Server 启动 ===" -ForegroundColor Cyan
Write-Host "模型: $ModelPath"
Write-Host "参数: --n_ctx $NCtx --ngl $Ngl --host $Host --port $Port"
Write-Host "PID文件: $PidFile"
Write-Host "日志文件: $LogFile"

# === 1. 检查模型文件 ===
if (-not (Test-Path $ModelPath)) {
    Write-Host "错误：模型文件不存在: $ModelPath" -ForegroundColor Red
    exit 1
}

# === 2. Kill 已有进程 ===
if (Test-Path $PidFile) {
    $oldPid = Get-Content $PidFile
    if ($oldPid) {
        try {
            $oldProc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
            if ($oldProc) {
                Write-Host "正在停止已有进程 (PID=$oldPid)..." -ForegroundColor Yellow
                Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 2
            }
        } catch {
            Write-Host "无法停止已有进程: $_" -ForegroundColor Yellow
        }
    }
}

# 也尝试通过端口占用 kill
$portProc = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
if ($portProc) {
    Write-Host "端口 $Port 被占用 (PID=$portProc)，正在释放..." -ForegroundColor Yellow
    Stop-Process -Id $portProc -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

# === 3. 查找 llama.cpp server 可执行文件 ===
$ServerExe = $null
$searchPaths = @(
    "E:\开发\resources\llama-server.exe",
    "E:\开发\resources\llama.cpp\build\bin\Release\llama-server.exe",
    "$env:LOCALAPPDATA\Programs\llama.cpp\llama-server.exe"
)

foreach ($p in $searchPaths) {
    if (Test-Path $p) {
        $ServerExe = $p
        break
    }
}

# 也尝试用 python -m llama_cpp.server
if (-not $ServerExe) {
    Write-Host "llama-server.exe 未找到，尝试 llama-cpp-python server 模式..." -ForegroundColor Yellow
    
    try {
        $pyCheck = python -c "from llama_cpp import server; print('ok')" 2>&1
        if ($pyCheck -match "ok") {
            Write-Host "使用 python -m llama_cpp.server 启动" -ForegroundColor Green
            
            $proc = Start-Process -FilePath "python" `
                -ArgumentList "-m", "llama_cpp.server", `
                    "--model", $ModelPath, `
                    "--n_ctx", $NCtx, `
                    "--ngl", $Ngl, `
                    "--host", $Host, `
                    "--port", $Port `
                -NoNewWindow `
                -RedirectStandardOutput $LogFile `
                -RedirectStandardError $LogFile `
                -PassThru
            
            $proc.Id | Out-File -FilePath $PidFile
            Write-Host "llama.cpp Server 已启动 (PID=$($proc.Id))" -ForegroundColor Green
            Write-Host "等待服务就绪..."
            
            # 等待服务就绪
            $maxWait = 60
            for ($i = 0; $i -lt $maxWait; $i++) {
                try {
                    $response = Invoke-WebRequest -Uri "http://$Host`:$Port/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
                    if ($response.StatusCode -lt 500) {
                        Write-Host "服务已就绪! http://$Host`:$Port" -ForegroundColor Green
                        exit 0
                    }
                } catch { }
                Start-Sleep -Seconds 1
            }
            Write-Host "警告: 服务启动但未在 ${maxWait}s 内就绪" -ForegroundColor Yellow
            exit 0
        }
    } catch {
        Write-Host "llama-cpp-python server 不可用: $_" -ForegroundColor Yellow
    }
}

if (-not $ServerExe) {
    Write-Host "错误: 未找到 llama-server.exe 且 llama-cpp-python server 不可用" -ForegroundColor Red
    Write-Host "请安装: pip install llama-cpp-python[server]" -ForegroundColor Yellow
    exit 1
}

# === 4. 启动 llama-server.exe ===
Write-Host "使用 $ServerExe 启动" -ForegroundColor Green

$proc = Start-Process -FilePath $ServerExe `
    -ArgumentList @(
        "--model", $ModelPath,
        "--n_ctx", $NCtx,
        "--ngl", $Ngl,
        "--host", $Host,
        "--port", $Port
    ) `
    -NoNewWindow `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError $LogFile `
    -PassThru

$proc.Id | Out-File -FilePath $PidFile

Write-Host "llama.cpp Server 已启动 (PID=$($proc.Id))" -ForegroundColor Green
Write-Host "API 地址: http://$Host`:$Port" -ForegroundColor Cyan
Write-Host "健康检查: http://$Host`:$Port/health" -ForegroundColor Cyan
Write-Host ""
Write-Host "停止服务: Get-Process -Id $($proc.Id) | Stop-Process -Force" -ForegroundColor Gray
