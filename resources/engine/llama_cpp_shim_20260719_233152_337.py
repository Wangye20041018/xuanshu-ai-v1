"""
玄枢 AI Engine v3.1 — llama-cpp-python CUDA Shim
====================================================
当 llama-cpp-python 为 CPU-only 版本时，本 Shim 劫持导入，
将推理请求转发给 CUDA 编译版 llama-server.exe。

架构：
  应用层 → api_server.py → llama_cpp_shim.Llama → llama-server:8081 (CUDA) → 模型

关键设计：
  - API 签名完全兼容 llama-cpp-python 的 Llama 类
  - 支持 stream=True/False、stop tokens、temperature 等
  - 自动管理 llama-server 进程生命周期
  - 完全透明：上层代码无需修改任何调用

使用方法：
  from llama_cpp_shim import Llama  # 替代 from llama_cpp import Llama
"""

import os
import sys
import json
import time
import subprocess
import threading
import requests
import signal
import logging
from pathlib import Path
from typing import Optional, List, Dict, Any, Iterator, Union

logger = logging.getLogger("xuanshu-shim")

# llama-server 可执行文件路径（CUDA 编译版）
DEFAULT_SERVER_EXE = str(Path(__file__).resolve().parent.parent / "resources" / "llama-server.exe")

# 备用路径：开发目录
if not os.path.exists(DEFAULT_SERVER_EXE):
    DEFAULT_SERVER_EXE = str(Path(__file__).resolve().parent.parent.parent / "开发" / "resources" / "llama-server.exe")

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8081


class LlamaServerProcess:
    """管理 llama-server 进程的单例"""
    _instance = None
    _lock = threading.Lock()
    
    def __init__(self, exe_path: str = DEFAULT_SERVER_EXE):
        self.exe_path = exe_path
        self.host = DEFAULT_HOST
        self.port = DEFAULT_PORT
        self._process: Optional[subprocess.Popen] = None
        self._ready = False
        self._current_model: Optional[str] = None
    
    @classmethod
    def get_instance(cls, exe_path: str = None) -> "LlamaServerProcess":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls(exe_path or DEFAULT_SERVER_EXE)
        return cls._instance
    
    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"
    
    def start(self, model_path: str, n_gpu_layers: int = 99, n_ctx: int = 8192) -> bool:
        """启动 llama-server 并加载模型"""
        if self._ready and self._current_model == model_path:
            return True
        
        # 停止旧实例
        self.stop()
        
        if not os.path.exists(self.exe_path):
            logger.error(f"llama-server.exe 不存在: {self.exe_path}")
            return False
        
        if not os.path.exists(model_path):
            logger.error(f"模型文件不存在: {model_path}")
            return False
        
        args = [
            self.exe_path,
            "-m", model_path,
            "--host", self.host,
            "--port", str(self.port),
            "-ngl", str(n_gpu_layers),
            "-c", str(n_ctx),
        ]
        
        logger.info(f"启动 llama-server (CUDA): {' '.join(args[:5])}...")
        
        try:
            self._process = subprocess.Popen(
                args,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        except Exception as e:
            logger.error(f"启动 llama-server 失败: {e}")
            return False
        
        # 等待服务器就绪（最多 120 秒）
        for i in range(240):
            time.sleep(0.5)
            if self._process.poll() is not None:
                logger.error(f"llama-server 异常退出 (code={self._process.returncode})")
                return False
            try:
                r = requests.get(f"{self.base_url}/health", timeout=2)
                if r.status_code == 200:
                    self._ready = True
                    self._current_model = model_path
                    logger.info(f"llama-server 就绪 (GPU, {model_path})")
                    return True
            except Exception:
                pass
        
        logger.error("llama-server 启动超时")
        self.stop()
        return False
    
    def stop(self):
        if self._process:
            try:
                self._process.terminate()
                self._process.wait(timeout=5)
            except Exception:
                try:
                    self._process.kill()
                except Exception:
                    pass
            self._process = None
        self._ready = False
        self._current_model = None
    
    def is_ready(self) -> bool:
        if not self._ready:
            return False
        try:
            r = requests.get(f"{self.base_url}/health", timeout=2)
            return r.status_code == 200
        except Exception:
            return False


# ============================================================================
# Llama 兼容类 - 完全兼容 llama-cpp-python API
# ============================================================================
class Llama:
    """
    与 llama-cpp-python Llama 类 API 兼容的 shim。

    调用方式完全一致：
        llm = Llama(model_path="model.gguf", n_gpu_layers=99, n_ctx=8192)
        output = llm("Hello", max_tokens=100, temperature=0.7, stream=True)

    内部转发到 llama-server 的 /completion 端点。
    """
    
    def __init__(
        self,
        model_path: str,
        n_gpu_layers: int = 99,
        n_ctx: int = 8192,
        n_batch: int = 512,
        n_threads: Optional[int] = None,
        verbose: bool = False,
        **kwargs
    ):
        self.model_path = model_path
        self.n_gpu_layers = n_gpu_layers
        self.n_ctx = n_ctx
        self.verbose = verbose
        
        # 启动 CUDA llama-server
        self._server = LlamaServerProcess.get_instance()
        if not self._server.start(model_path, n_gpu_layers, n_ctx):
            raise RuntimeError(f"无法启动 llama-server 加载模型: {model_path}")
        
        if verbose:
            logger.info(f"Llama Shim: 模型已通过 llama-server (CUDA) 加载: {model_path}")
    
    def __call__(
        self,
        prompt: str,
        max_tokens: int = 2048,
        temperature: float = 0.7,
        top_p: float = 0.9,
        top_k: int = 40,
        stop: Optional[List[str]] = None,
        stream: bool = False,
        echo: bool = False,
        **kwargs
    ) -> Union[Dict, Iterator[Dict]]:
        """
        推理接口。返回格式与 llama-cpp-python 完全一致。

        非流式: {"choices": [{"text": "..."}]}
        流式:   迭代器，每项 {"choices": [{"text": "..."}]}
        """
        if not self._server.is_ready():
            raise RuntimeError("llama-server 未就绪")
        
        body = {
            "prompt": prompt,
            "n_predict": max_tokens,
            "temperature": temperature,
            "top_p": top_p,
            "top_k": top_k,
            "stream": stream,
        }
        if stop:
            body["stop"] = stop
        
        if stream:
            return self._stream_completion(body)
        else:
            return self._sync_completion(body)
    
    def _sync_completion(self, body: dict) -> dict:
        """同步推理"""
        try:
            r = requests.post(
                f"{self._server.base_url}/completion",
                json=body,
                timeout=300,
            )
            r.raise_for_status()
            data = r.json()
            content = data.get("content", "")
            return {"choices": [{"text": content}]}
        except Exception as e:
            logger.error(f"同步推理失败: {e}")
            return {"choices": [{"text": f"[错误] {e}"}]}
    
    def _stream_completion(self, body: dict) -> Iterator[dict]:
        """流式推理"""
        try:
            r = requests.post(
                f"{self._server.base_url}/completion",
                json=body,
                stream=True,
                timeout=300,
            )
            r.raise_for_status()
            
            for line in r.iter_lines(decode_unicode=True):
                if not line or not line.startswith("data: "):
                    continue
                data_str = line[6:]
                if data_str == "[DONE]":
                    break
                try:
                    chunk = json.loads(data_str)
                    content = chunk.get("content", "")
                    yield {"choices": [{"text": content}]}
                except json.JSONDecodeError:
                    continue
        except Exception as e:
            logger.error(f"流式推理失败: {e}")
            yield {"choices": [{"text": f"[错误] {e}"}]}
    
    def __del__(self):
        # 不在这里关闭 server，因为可能有多个 Llama 实例共享
        pass


# ============================================================================
# 检测函数 - 供 api_server.py 使用
# ============================================================================
def is_gpu_available() -> bool:
    """检测 llama-server (CUDA版) 是否可用"""
    exe = DEFAULT_SERVER_EXE
    if not os.path.exists(exe):
        # 尝试放在 resources 的上一级目录
        alt = str(Path(__file__).resolve().parent / "resources" / "llama-server.exe")
        if os.path.exists(alt):
            exe = alt
        else:
            return False
    
    # 检查是否依赖 CUDA DLL
    exe_dir = os.path.dirname(exe)
    cuda_dll = os.path.join(exe_dir, "ggml-cuda.dll")
    return os.path.exists(cuda_dll)


def get_shim_available() -> bool:
    """Shim 是否可用（llama-server + CUDA DLL + requests）"""
    try:
        import requests
    except ImportError:
        return False
    return is_gpu_available()


# ============================================================================
# 自测
# ============================================================================
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
    
    print(f"llama-server.exe: {os.path.exists(DEFAULT_SERVER_EXE)} ({DEFAULT_SERVER_EXE})")
    print(f"CUDA DLL: {is_gpu_available()}")
    print(f"Shim available: {get_shim_available()}")
    
    if get_shim_available():
        model = r"E:\模型库\Qwen3.5-9B-Q4_K_M.gguf"
        if os.path.exists(model):
            print(f"\n加载模型: {model}")
            llm = Llama(model_path=model, n_gpu_layers=99, n_ctx=4096)
            
            print("\n[测试] 流式推理")
            for chunk in llm("1+1=? 简单回答。", max_tokens=50, temperature=0.7, stream=True):
                text = chunk["choices"][0]["text"]
                print(text, end="", flush=True)
            print("\n")
