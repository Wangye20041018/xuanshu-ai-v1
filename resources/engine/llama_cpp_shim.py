"""
玄枢 AI Engine v3.1 — llama-cpp-python CUDA Shim
====================================================
当 llama-cpp-python 为 CPU-only 版本时，本 Shim 将推理请求转发给
CUDA 编译版 llama-server.exe（locahost:8081）。

完全兼容 llama-cpp-python Llama 类 API：
    llm = Llama(model_path="model.gguf", n_gpu_layers=99)
    output = llm("prompt", max_tokens=100, stream=True)
"""

import os
import json
import time
import subprocess
import threading
import logging
from pathlib import Path
from typing import Optional, List, Dict, Any, Iterator

logger = logging.getLogger("xuanshu-shim")

SERVER_EXE = str(Path(__file__).resolve().parent.parent / "resources" / "llama-server.exe")
HOST = "127.0.0.1"
PORT = 8081
BASE_URL = f"http://{HOST}:{PORT}"

_server_process: Optional[subprocess.Popen] = None
_server_ready = False
_server_model: Optional[str] = None
_server_lock = threading.Lock()
_request_lock = threading.Lock()  # llama-server is single-request


def _ensure_requests():
    try:
        import requests
        return requests
    except ImportError:
        raise ImportError("requests 未安装。运行: pip install requests")


def _start_server(model_path: str, n_gpu_layers: int, n_ctx: int) -> bool:
    global _server_process, _server_ready, _server_model
    
    with _server_lock:
        if _server_ready and _server_model == model_path:
            return True
        
        _stop_server()
        
        if not os.path.exists(SERVER_EXE):
            logger.error(f"llama-server.exe 不存在: {SERVER_EXE}")
            return False
        
        args = [SERVER_EXE, "-m", model_path, "--host", HOST, "--port", str(PORT),
                "-ngl", str(n_gpu_layers), "-c", str(n_ctx)]
        
        logger.info(f"启动 llama-server CUDA: {' '.join(args[:6])}...")
        
        try:
            _server_process = subprocess.Popen(
                args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        except Exception as e:
            logger.error(f"启动失败: {e}")
            return False
        
        requests = _ensure_requests()
        for _ in range(240):
            time.sleep(0.5)
            if _server_process.poll() is not None:
                logger.error(f"llama-server 退出 code={_server_process.returncode}")
                return False
            try:
                r = requests.get(f"{BASE_URL}/health", timeout=2)
                if r.status_code == 200:
                    _server_ready = True
                    _server_model = model_path
                    logger.info("llama-server CUDA 就绪")
                    return True
            except Exception:
                pass
        
        logger.error("启动超时")
        return False


def _stop_server():
    global _server_process, _server_ready, _server_model
    if _server_process:
        try:
            _server_process.terminate()
            _server_process.wait(timeout=5)
        except Exception:
            try:
                _server_process.kill()
            except Exception:
                pass
        _server_process = None
    _server_ready = False
    _server_model = None


def _is_ready() -> bool:
    if not _server_ready:
        return False
    requests = _ensure_requests()
    try:
        return requests.get(f"{BASE_URL}/health", timeout=2).status_code == 200
    except Exception:
        return False


class Llama:
    """llama-cpp-python Llama 兼容接口。内部转发到 llama-server CUDA。"""
    
    def __init__(self, model_path: str, n_gpu_layers: int = 99, n_ctx: int = 8192,
                 n_batch: int = 512, n_threads: Optional[int] = None,
                 mmproj: Optional[str] = None, verbose: bool = False, **kwargs):
        self.model_path = model_path
        self.n_ctx = n_ctx
        self.verbose = verbose
        
        if not _start_server(model_path, n_gpu_layers, n_ctx):
            raise RuntimeError(f"无法加载模型: {model_path}")
    
    def __call__(self, prompt: str, max_tokens: int = 2048, temperature: float = 0.7,
                 top_p: float = 0.9, top_k: int = 40, stop: Optional[List[str]] = None,
                 stream: bool = False, echo: bool = False, **kwargs
                 ) -> Dict[str, Any] | Iterator[Dict[str, Any]]:
        if not _is_ready():
            raise RuntimeError("llama-server 未就绪")
        
        body = {"prompt": prompt, "n_predict": max_tokens, "temperature": temperature,
                "top_p": top_p, "top_k": top_k, "stream": stream}
        if stop:
            body["stop"] = stop
        
        requests = _ensure_requests()
        
        if stream:
            return self._stream(requests, body)
        else:
            return self._sync(requests, body)
    
    def _sync(self, requests, body: dict) -> dict:
        with _request_lock:
            r = requests.post(f"{BASE_URL}/completion", json=body, timeout=300)
        r.raise_for_status()
        data = r.json()
        return {"choices": [{"text": data.get("content", "")}]}
    
    def _stream(self, requests, body: dict) -> Iterator[dict]:
        r = requests.post(f"{BASE_URL}/completion", json=body, stream=True, timeout=300)
        r.raise_for_status()
        for line in r.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data: "):
                continue
            ds = line[6:]
            if ds == "[DONE]":
                break
            try:
                content = json.loads(ds).get("content", "")
                yield {"choices": [{"text": content}]}
            except json.JSONDecodeError:
                continue
    
    def create_chat_completion(self, messages: list, **kwargs) -> dict:
        prompt = self._build_chatml(messages)
        return self(prompt, **kwargs)
    
    def _build_chatml(self, messages: list) -> str:
        parts = []
        for m in messages:
            role = m.get("role", "user")
            content = m.get("content", "")
            parts.append(f"<|im_start|>{role}\n{content}<|im_end|>")
        parts.append("<|im_start|>assistant\n")
        return "\n".join(parts)


# 检测工具
def is_gpu_available() -> bool:
    return os.path.exists(SERVER_EXE) and os.path.exists(
        os.path.join(os.path.dirname(SERVER_EXE), "ggml-cuda.dll"))

def get_shim_available() -> bool:
    try:
        import requests
        return is_gpu_available()
    except ImportError:
        return False
