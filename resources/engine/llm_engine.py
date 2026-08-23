#!/usr/bin/env python3
"""
玄枢 AI — LLM 推理引擎
LLM Engine — 管理 llama-server 实例，提供统一推理接口

双模型架构：
  - Quick (7B VL + mmproj): GPU 推理，支持视觉，延迟低
  - Deep  (14B): CPU 推理，推理能力强，适合复杂任务
"""

import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
import traceback
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlparse

try:
    import requests
except ImportError:
    requests = None

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))
RESOURCES_DIR = os.path.dirname(ENGINE_DIR)

def _load_config() -> Dict:
    """加载 config.json —— 尝试多个可能路径"""
    candidates = [
        os.path.join(os.path.dirname(ENGINE_DIR), "engine", "config.json"),
        os.path.join(ENGINE_DIR, "config.json"),
        # 实际路径：D:\开发2\engine\config.json (两层上一级)
        os.path.join(os.path.dirname(os.path.dirname(ENGINE_DIR)), "engine", "config.json"),
    ]
    for config_path in candidates:
        if os.path.exists(config_path):
            with open(config_path, "r", encoding="utf-8") as f:
                return json.load(f)
    return {}

CONFIG = _load_config()

MODEL_7B_PATH  = CONFIG.get("model_7b_path", "")
MODEL_14B_PATH = CONFIG.get("model_14b_path", "")
MMPROJ_PATH    = CONFIG.get("mmproj_path", "")
API_PORT       = CONFIG.get("api_port", 8765)

# llama-server 可执行文件路径
LLAMA_SERVER_EXE = os.path.join(RESOURCES_DIR, "llama-server.exe")
if not os.path.exists(LLAMA_SERVER_EXE):
    LLAMA_SERVER_EXE = "llama-server"  # fallback to PATH

QUICK_PORT = 8766  # 7B VL 专用端口
DEEP_PORT  = 8767  # 14B 专用端口

GPU_LAYERS = CONFIG.get("gpu_layers", -1)
if GPU_LAYERS == -1:
    GPU_LAYERS = 99  # default: all layers on GPU

CONTEXT_SIZE = 32768  # IQ4_XS(5.1G) + q4_0 KV(0.64G@32K) + mmproj(0.88G) ≈ 6.6G, 32K安全


# ---------------------------------------------------------------------------
# 进程管理
# ---------------------------------------------------------------------------
@dataclass
class ServerInstance:
    mode: str
    process: subprocess.Popen
    port: int
    pid: int
    started_at: float = field(default_factory=time.time)


class LLMEngine:
    """LLM 推理引擎 —— 管理 llama-server 进程并提供推理 API"""

    def __init__(self):
        self.quick: Optional[ServerInstance] = None
        self.deep: Optional[ServerInstance] = None

    # -------------------------------------------------------------------
    # 启动 / 停止
    # -------------------------------------------------------------------
    def start_quick(self) -> Tuple[bool, str]:
        """启动 Quick 模式 server（7B VL + mmproj, GPU）"""
        if not MODEL_7B_PATH or not os.path.exists(MODEL_7B_PATH):
            return False, f"7B 模型不存在: {MODEL_7B_PATH}"

        if self.quick and self._is_alive(self.quick):
            return True, f"Quick 已在运行 (PID {self.quick.pid}, port {self.quick.port})"

        # 杀掉旧进程
        self._kill_port(QUICK_PORT)
        time.sleep(1)

        cmd = [
            LLAMA_SERVER_EXE,
            "-m", MODEL_7B_PATH,
            "--port", str(QUICK_PORT),
            "--host", "127.0.0.1",
            "-ngl", str(GPU_LAYERS),
            "-c", str(CONTEXT_SIZE),
            "--cache-type-k", "q4_0",   # KV cache量化，6G显存必备
            "--cache-type-v", "q4_0",
        ]

        # 如果有 mmproj，加载视觉投影层
        if MMPROJ_PATH and os.path.exists(MMPROJ_PATH):
            cmd.extend(["--mmproj", MMPROJ_PATH])
            print(f"[Engine] 加载视觉投影层: {MMPROJ_PATH}")

        print(f"[Engine] 启动 Quick 模式: {' '.join(cmd)}")

        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                creationflags=subprocess.CREATE_NO_WINDOW
            )
            self.quick = ServerInstance(mode="quick", process=proc, port=QUICK_PORT, pid=proc.pid)

            # 等待 server 就绪
            if not self._wait_ready(QUICK_PORT, timeout=300):
                return False, "Quick 模式启动超时（120s）"

            return True, f"Quick 已启动 (PID {proc.pid}, port {QUICK_PORT})"

        except Exception as e:
            return False, f"Quick 启动失败: {e}"

    def start_deep(self) -> Tuple[bool, str]:
        """启动 Deep 模式 server（14B, CPU）"""
        if not MODEL_14B_PATH or not os.path.exists(MODEL_14B_PATH):
            return False, f"14B 模型不存在: {MODEL_14B_PATH}"

        if self.deep and self._is_alive(self.deep):
            return True, f"Deep 已在运行 (PID {self.deep.pid}, port {self.deep.port})"

        self._kill_port(DEEP_PORT)
        time.sleep(1)

        cmd = [
            LLAMA_SERVER_EXE,
            "-m", MODEL_14B_PATH,
            "--port", str(DEEP_PORT),
            "--host", "127.0.0.1",
            "-ngl", "0",       # CPU 推理
            "-c", str(CONTEXT_SIZE),
            "-t", str(os.cpu_count() or 8),
        ]

        print(f"[Engine] 启动 Deep 模式: {' '.join(cmd)}")

        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                creationflags=subprocess.CREATE_NO_WINDOW
            )
            self.deep = ServerInstance(mode="deep", process=proc, port=DEEP_PORT, pid=proc.pid)

            if not self._wait_ready(DEEP_PORT, timeout=300):
                return False, "Deep 模式启动超时（300s）"

            return True, f"Deep 已启动 (PID {proc.pid}, port {DEEP_PORT})"
        except Exception as e:
            return False, f"Deep 启动失败: {e}"

    def stop_quick(self):
        if self.quick:
            self._stop_instance(self.quick)
            self.quick = None

    def stop_deep(self):
        if self.deep:
            self._stop_instance(self.deep)
            self.deep = None

    def stop_all(self):
        self.stop_quick()
        self.stop_deep()

    # -------------------------------------------------------------------
    # 推理接口
    # -------------------------------------------------------------------
    def chat_completion(
        self,
        mode: str,
        messages: List[Dict[str, str]],
        stream: bool = False,
        max_tokens: int = 4096,
        temperature: float = 0.7,
        top_p: float = 0.95,
        image_paths: List[str] = None
    ) -> Dict:
        """
        统一的 chat completions 接口

        Args:
            mode: "quick" | "deep"
            messages: OpenAI 兼容的 messages 列表
            stream: 是否流式（当前仅支持非流式）
            max_tokens, temperature, top_p: 推理参数

        Returns:
            {"success": True, "content": "...", "usage": {...}}
        """
        if mode == "quick":
            instance = self.quick
            port = QUICK_PORT
            if not instance or not self._is_alive(instance):
                return {"success": False, "error": "Quick 模式未运行，请先 start_quick()"}
        elif mode == "deep":
            instance = self.deep
            port = DEEP_PORT
            if not instance or not self._is_alive(instance):
                return {"success": False, "error": "Deep 模式未运行，请先 start_deep()"}
        else:
            return {"success": False, "error": f"未知模式: {mode}"}

        # 构建请求
        payload = {
            "messages": messages,
            "stream": False,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "top_p": top_p,
            "cache_prompt": True,
        }

        # 如果有图片，添加到最后一条用户消息
        if image_paths and mode == "quick":
            payload["messages"] = self._build_multimodal_messages(messages, image_paths)

        url = f"http://127.0.0.1:{port}/v1/chat/completions"

        try:
            resp = requests.post(
                url,
                json=payload,
                timeout=300,
                headers={"Content-Type": "application/json"}
            )
            if resp.status_code != 200:
                return {"success": False, "error": f"HTTP {resp.status_code}: {resp.text[:500]}"}

            data = resp.json()
            content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            usage = data.get("usage", {})

            return {
                "success": True,
                "content": content,
                "usage": {
                    "prompt_tokens": usage.get("prompt_tokens", 0),
                    "completion_tokens": usage.get("completion_tokens", 0),
                    "total_tokens": usage.get("total_tokens", 0),
                }
            }

        except requests.exceptions.Timeout:
            return {"success": False, "error": "推理超时（300s）"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def status(self) -> Dict:
        """获取引擎状态"""
        return {
            "quick": {
                "running": bool(self.quick and self._is_alive(self.quick)),
                "pid": self.quick.pid if self.quick else None,
                "port": QUICK_PORT,
                "model": os.path.basename(MODEL_7B_PATH) if MODEL_7B_PATH else "N/A",
                "mmproj": bool(MMPROJ_PATH),
                "device": "GPU",
            },
            "deep": {
                "running": bool(self.deep and self._is_alive(self.deep)),
                "pid": self.deep.pid if self.deep else None,
                "port": DEEP_PORT,
                "model": os.path.basename(MODEL_14B_PATH) if MODEL_14B_PATH else "N/A",
                "device": "CPU",
            }
        }

    # -------------------------------------------------------------------
    # 内部辅助
    # -------------------------------------------------------------------
    def _build_multimodal_messages(
        self, messages: List[Dict], image_paths: List[str]
    ) -> List[Dict]:
        """将图片路径注入到 messages 中（支持 llama.cpp multimodal 格式）"""
        import base64

        images_content = []
        for img_path in image_paths:
            if os.path.exists(img_path):
                with open(img_path, "rb") as f:
                    b64 = base64.b64encode(f.read()).decode("utf-8")
                ext = os.path.splitext(img_path)[1].lower()
                mime_map = {".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                           ".png": "image/png", ".webp": "image/webp",
                           ".gif": "image/gif", ".bmp": "image/bmp"}
                mime = mime_map.get(ext, "image/png")
                images_content.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime};base64,{b64}"}
                })
            else:
                print(f"[Engine] WARN: 图片不存在: {img_path}")

        if not images_content:
            return messages

        # 在与 assistant 最后一条消息对应的 user 消息中加入图片
        new_messages = []
        for i, msg in enumerate(messages):
            if msg["role"] == "user" and i == len(messages) - 1:
                # 最后一条用户消息
                content = [{"type": "text", "text": msg["content"]}] + images_content
                new_messages.append({"role": "user", "content": content})
            else:
                new_messages.append(msg)

        return new_messages

    def _is_alive(self, instance: ServerInstance) -> bool:
        """检查 server 进程是否存活"""
        if not instance or not instance.process:
            return False
        poll = instance.process.poll()
        return poll is None

    def _wait_ready(self, port: int, timeout: int = 120) -> bool:
        """轮询等待 server 就绪"""
        start = time.time()
        while time.time() - start < timeout:
            try:
                resp = requests.get(
                    f"http://127.0.0.1:{port}/health",
                    timeout=2
                )
                if resp.status_code == 200:
                    return True
            except Exception:
                pass
            time.sleep(1)
        return False

    def _kill_port(self, port: int):
        """杀掉占用指定端口的进程（Windows）"""
        try:
            result = subprocess.run(
                ["netstat", "-ano"],
                capture_output=True, text=True, timeout=10
            )
            for line in result.stdout.splitlines():
                if f":{port}" in line and "LISTENING" in line:
                    parts = line.split()
                    pid = parts[-1]
                    try:
                        subprocess.run(["taskkill", "/F", "/PID", pid],
                                     capture_output=True)
                        print(f"[Engine] 已杀掉端口 {port} 上的进程 (PID {pid})")
                    except Exception:
                        pass
        except Exception:
            pass

    def _stop_instance(self, instance: ServerInstance):
        """安全停止 server 实例"""
        try:
            if instance.process:
                if sys.platform == "win32":
                    instance.process.send_signal(signal.CTRL_BREAK_EVENT)
                else:
                    instance.process.terminate()
                try:
                    instance.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    instance.process.kill()
                    instance.process.wait()
        except Exception as e:
            print(f"[Engine] 停止进程时出错: {e}")


# ---------------------------------------------------------------------------
# 测试
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print("===== 玄枢 · LLM 推理引擎 =====")
    print(f"7B 模型: {MODEL_7B_PATH}")
    print(f"14B 模型: {MODEL_14B_PATH}")
    print(f"mmproj: {MMPROJ_PATH}")
    print(f"GPU Layers: {GPU_LAYERS}")
    print()

    engine = LLMEngine()

    # 启动 Quick
    ok, msg = engine.start_quick()
    print(f"Quick: {msg}")

    # 启动 Deep
    ok2, msg2 = engine.start_deep()
    print(f"Deep: {msg2}")

    print()
    print(json.dumps(engine.status(), indent=2, ensure_ascii=False))
