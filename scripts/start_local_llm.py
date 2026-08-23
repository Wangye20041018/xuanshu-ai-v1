#!/usr/bin/env python3
"""
玄枢AI - 本地DeepSeek-7B推理启动脚本
检查环境 → 安装依赖/下载llama.cpp → 启动推理服务 → 验证API可用

用法:
    python start_local_llm.py              # 使用默认配置启动
    python start_local_llm.py --port 8081  # 指定端口
    python start_local_llm.py --check-only # 仅检查环境不启动
"""
import sys
import os
import time
import json
import urllib.request
import urllib.error
import subprocess
import signal
import platform
from pathlib import Path

# 将 src 目录加入 Python 路径（确保能导入 config）
SRC_DIR = Path(__file__).resolve().parent.parent / "src"
sys.path.insert(0, str(SRC_DIR))

from config.local_llm_config import config


# ============================================================
# 工具函数
# ============================================================

def log(msg: str, level: str = "INFO"):
    timestamp = time.strftime("%H:%M:%S")
    print(f"[{timestamp}] [{level}] {msg}", flush=True)


def find_llama_server() -> str | None:
    """在常见路径中搜索 llama-server 可执行文件"""
    for path_str in config.llama_cpp_search_paths:
        p = Path(path_str)
        if p.is_file():
            log(f"找到 llama-server: {p}")
            return str(p)

    # 尝试 which
    try:
        result = subprocess.run(
            ["where", "llama-server"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0 and result.stdout.strip():
            found = result.stdout.strip().split("\n")[0].strip()
            log(f"通过 PATH 找到 llama-server: {found}")
            return found
    except Exception:
        pass

    return None


def check_python_deps() -> bool:
    """检查 Python 依赖是否就绪"""
    deps = ["llama_cpp"]
    missing = []
    for dep in deps:
        try:
            __import__(dep)
        except ImportError:
            missing.append(dep)

    if missing:
        log(f"缺失 Python 包: {missing}", "WARN")
        return False
    return True


def install_python_deps() -> bool:
    """安装缺失的 Python 依赖"""
    packages = [
        "llama-cpp-python",
        "uvicorn",
        "requests",
    ]
    log("安装 Python 依赖中...")
    try:
        # 优先尝试预编译 wheel（有 CUDA 支持更佳）
        for pkg in packages:
            log(f"  pip install {pkg}")
            result = subprocess.run(
                [sys.executable, "-m", "pip", "install", pkg, "-q"],
                capture_output=True, text=True, timeout=300
            )
            if result.returncode != 0:
                log(f"  pip install {pkg} 失败: {result.stderr[-200:]}", "ERROR")
                return False
        log("Python 依赖安装完成")
        return True
    except Exception as e:
        log(f"依赖安装异常: {e}", "ERROR")
        return False


def download_llama_server() -> str | None:
    """下载 llama.cpp server 可执行文件到 tools 目录"""
    tools_dir = Path(r"D:\开发2\tools\llama.cpp")
    tools_dir.mkdir(parents=True, exist_ok=True)

    server_path = tools_dir / "llama-server.exe"
    if server_path.is_file():
        log(f"llama-server 已存在于: {server_path}")
        return str(server_path)

    # 多个候选下载源（按优先级）
    download_candidates = [
        # 源1: llama.cpp 官方 release (CUDA 12.4)
        {
            "url": "https://github.com/ggerganov/llama.cpp/releases/download/b4838/llama-b4838-bin-win-cuda-cu12.4-x64.zip",
            "zip_name": "llama-b4838-cu12.4.zip",
        },
        # 源2: CPU only 版本（更小）
        {
            "url": "https://github.com/ggerganov/llama.cpp/releases/download/b4838/llama-b4838-bin-win-avx2-x64.zip",
            "zip_name": "llama-b4838-avx2.zip",
        },
    ]

    for candidate in download_candidates:
        url = candidate["url"]
        zip_name = candidate["zip_name"]
        zip_path = tools_dir / zip_name

        log(f"尝试下载: {url[:80]}...")
        try:
            import urllib.request
            urllib.request.urlretrieve(url, str(zip_path))

            # 解压
            import zipfile
            with zipfile.ZipFile(str(zip_path), "r") as zf:
                for member in zf.namelist():
                    if member.endswith("llama-server.exe"):
                        zf.extract(member, str(tools_dir))
                        extracted = tools_dir / member
                        if extracted != server_path:
                            import shutil
                            shutil.move(str(extracted), str(server_path))
                        log(f"llama-server 解压到: {server_path}")
                        # 清理 zip
                        try:
                            zip_path.unlink()
                        except Exception:
                            pass
                        return str(server_path)

            log(f"ZIP 中未找到 llama-server.exe，尝试下一个源", "WARN")
            try:
                zip_path.unlink()
            except Exception:
                pass

        except Exception as e:
            log(f"下载失败 ({url[:60]}...): {e}", "WARN")
            if zip_path.is_file():
                try:
                    zip_path.unlink()
                except Exception:
                    pass

    return None


def start_llama_server(server_path: str) -> subprocess.Popen | None:
    """启动 llama.cpp server 进程"""
    if not Path(config.model_path).is_file():
        log(f"模型文件不存在: {config.model_path}", "ERROR")
        return None

    cmd = [
        server_path,
        "-m", config.model_path,
        "--host", config.host,
        "--port", str(config.port),
        "--ctx-size", str(config.context_size),
        "--n-gpu-layers", str(config.gpu_layers),
        "--threads", str(config.threads),
        "--chat-template", "chatml",
        "--no-mmap",
    ]

    # 支持通过环境变量传递额外参数
    extra_args = os.environ.get("LOCAL_LLM_EXTRA_ARGS", "")
    if extra_args:
        cmd.extend(extra_args.split())

    log(f"启动命令: {' '.join(cmd)}")

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            creationflags=subprocess.CREATE_NO_WINDOW if platform.system() == "Windows" else 0,
        )
        log(f"llama-server 进程已启动 (PID={proc.pid})")
        return proc
    except Exception as e:
        log(f"启动失败: {e}", "ERROR")
        return None


def verify_api_health(max_wait: int = None, interval: int = None) -> bool:
    """轮询验证 llama.cpp API 是否可用"""
    if max_wait is None:
        max_wait = config.startup_timeout
    if interval is None:
        interval = config.health_check_interval

    health_url = config.health_endpoint
    chat_url = config.chat_endpoint

    log(f"等待服务就绪（最多 {max_wait}s）...")

    start = time.time()
    last_msg = ""

    while time.time() - start < max_wait:
        try:
            # 健康检查
            req = urllib.request.Request(health_url, method="GET")
            with urllib.request.urlopen(req, timeout=5) as resp:
                if resp.status == 200:
                    # 再做一次聊天测试确认模型已加载
                    test_payload = json.dumps({
                        "model": "local-model",
                        "messages": [{"role": "user", "content": "ping"}],
                        "max_tokens": 1,
                        "stream": False,
                    }).encode("utf-8")
                    req2 = urllib.request.Request(
                        chat_url,
                        data=test_payload,
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    try:
                        with urllib.request.urlopen(req2, timeout=15) as resp2:
                            if resp2.status == 200:
                                elapsed = time.time() - start
                                log(f"服务就绪！耗时 {elapsed:.1f}s")
                                return True
                    except Exception:
                        # 聊天测试失败但健康检查通过，可能模型仍在加载
                        msg = "模型加载中..."
                        if msg != last_msg:
                            log(msg)
                            last_msg = msg
        except urllib.error.URLError:
            pass
        except Exception:
            pass

        time.sleep(interval)

    log(f"服务启动超时 ({max_wait}s)", "ERROR")
    return False


def stop_server(proc: subprocess.Popen):
    """优雅停止 llama-server 进程"""
    if proc is None:
        return
    try:
        log("正在停止 llama-server...")
        if platform.system() == "Windows":
            proc.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        log("llama-server 已停止")
    except Exception as e:
        log(f"停止服务时出错: {e}", "WARN")


def print_status():
    """打印最终状态信息"""
    print()
    print("=" * 60)
    print("  玄枢AI - 本地 LLM 服务已启动")
    print("=" * 60)
    print(f"  模型:       {Path(config.model_path).name}")
    print(f"  量化:       Q4_K_M (4-bit)")
    print(f"  API 地址:   {config.api_base}")
    print(f"  聊天端点:   {config.chat_endpoint}")
    print(f"  上下文:     {config.context_size} tokens")
    print(f"  GPU 层数:   {config.gpu_layers}")
    print(f"  线程数:     {config.threads}")
    print("=" * 60)
    print()
    print("示例调用 (curl):")
    print(f'  curl {config.chat_endpoint} ^')
    print(f'    -H "Content-Type: application/json" ^')
    print(f'    -d "{{\\"model\\":\\"local-model\\",\\"messages\\":[{{\\"role\\":\\"user\\",\\"content\\":\\"你好\\"}}]}}"')


# ============================================================
# 主流程
# ============================================================

def main():
    import argparse

    parser = argparse.ArgumentParser(description="玄枢AI - 本地LLM启动脚本")
    parser.add_argument("--port", type=int, default=None, help="API 端口 (默认: 8080)")
    parser.add_argument("--check-only", action="store_true", help="仅检查环境，不启动服务")
    parser.add_argument("--skip-deps", action="store_true", help="跳过依赖检查与安装")
    parser.add_argument("--no-download", action="store_true", help="禁止自动下载 llama.cpp")
    args = parser.parse_args()

    if args.port:
        config.port = args.port

    # ---------- 第 1 步：环境检查 ----------
    log("=" * 50)
    log("玄枢AI - 本地 LLM 启动脚本 v1.0")
    log("=" * 50)

    if not config.enabled:
        log("本地 LLM 已被禁用 (LOCAL_LLM_ENABLED=false)", "WARN")
        sys.exit(0)

    log(f"模型文件: {config.model_path}")
    if not Path(config.model_path).is_file():
        log(f"模型文件不存在！请确认路径", "ERROR")
        sys.exit(1)

    model_size_gb = Path(config.model_path).stat().st_size / (1024 ** 3)
    log(f"模型大小: {model_size_gb:.2f} GB")

    # ---------- 第 2 步：查找/获取 llama-server ----------
    server_path = find_llama_server()

    if server_path is None and not args.no_download:
        log("未找到 llama-server，尝试自动下载...")
        server_path = download_llama_server()

    if server_path is None:
        # 作为最后兜底，尝试通过 Python 包启动
        log("未找到 llama-server 可执行文件", "WARN")
        if not args.skip_deps:
            if not check_python_deps():
                if not install_python_deps():
                    log("无法安装依赖，退出", "ERROR")
                    sys.exit(1)
            log("将通过 llama-cpp-python 启动服务（HTTP server 模式）")
            if args.check_only:
                log("环境检查通过（使用 Python HTTP server 模式）")
                sys.exit(0)
            # 使用 Python 启动
            return start_via_python()

    if args.check_only:
        log(f"环境检查通过: llama-server={server_path}")
        print(f"\n可执行文件: {server_path}")
        print(f"模型: {config.model_path}")
        print(f"端口: {config.port}")
        sys.exit(0)

    # ---------- 第 3 步：启动服务 ----------
    if server_path is None:
        log("无法启动: 没有可用的 llama-server", "ERROR")
        sys.exit(1)

    proc = start_llama_server(server_path)
    if proc is None:
        sys.exit(1)

    # ---------- 第 4 步：验证服务 ----------
    try:
        if verify_api_health():
            print_status()
            log("按 Ctrl+C 停止服务")
            # 等待进程（保持前台运行）
            try:
                proc.wait()
            except KeyboardInterrupt:
                log("收到中断信号")
        else:
            log("服务验证失败，请检查日志", "ERROR")
            # 打印 stderr 尾部
            try:
                stderr_output = proc.stderr.read(1024) if proc.stderr else ""
                if stderr_output:
                    log(f"llama-server stderr:\n{stderr_output[-1000:]}", "ERROR")
            except Exception:
                pass
            stop_server(proc)
            sys.exit(1)
    except KeyboardInterrupt:
        pass
    finally:
        stop_server(proc)


def start_via_python():
    """兜底方案：通过 llama-cpp-python 启动 HTTP server"""
    try:
        from llama_cpp.server.app import create_app
        import uvicorn

        log("通过 llama-cpp-python + uvicorn 启动 HTTP 服务...")

        # 设置环境变量让 llama-cpp-python server 读取
        os.environ["MODEL"] = config.model_path
        os.environ["HOST"] = config.host
        os.environ["PORT"] = str(config.port)
        os.environ["N_CTX"] = str(config.context_size)
        os.environ["N_GPU_LAYERS"] = str(config.gpu_layers)
        os.environ["N_THREADS"] = str(config.threads)

        app = create_app()
        log(f"启动 uvicorn on {config.host}:{config.port}")
        uvicorn.run(app, host=config.host, port=config.port, log_level="info")

    except ImportError as e:
        log(f"Python 模式缺少依赖: {e}", "ERROR")
        log("请手动安装: pip install llama-cpp-python uvicorn", "ERROR")
        sys.exit(1)
    except KeyboardInterrupt:
        log("服务已停止")


if __name__ == "__main__":
    main()
