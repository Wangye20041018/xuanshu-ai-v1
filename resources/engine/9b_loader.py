"""
玄枢 AI — 9B 引擎加载器
========================
替代现有 7B+14B 投机解码方案，使用单模型 Qwen3.5-9B-Q4_K_M.gguf。

策略:
  - RAM 常驻加载（~5.3GB），推理时切换到 VRAM
  - 配合 brain_runtime 的 system_prompt 注入
  - 兼容现有 api_server.py 的 /v1/chat/completions 接口

Author: 玄枢开发组
Version: 1.0.0
"""

import os
import sys
import time
import json
import threading
from pathlib import Path
from typing import Optional, List, Dict, Any, Generator
from dataclasses import dataclass, field
from datetime import datetime

try:
    from loguru import logger
except ImportError:
    import logging
    logger = logging.getLogger("9b-engine")

# ============================================================================
# 路径配置
# ============================================================================

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# 9B 模型路径（从 config.json 读取 model_7b_path 提取目录，回退到 ../models）
def _load_models_dir():
    config_path = Path(__file__).resolve().parent / "config.json"
    if config_path.exists():
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            model_path = cfg.get("model_7b_path", "")
            if model_path:
                return Path(model_path).parent
        except Exception:
            pass
    return Path(__file__).resolve().parent.parent / "models"

MODELS_DIR = _load_models_dir()
MODEL_9B_PATH = MODELS_DIR / "Qwen3.5-9B-Q4_K_M.gguf"
EMBEDDING_MODEL_PATH = MODELS_DIR / "向量检索-nomic-embed.gguf"
VISION_MODEL_PATH = MODELS_DIR / "Qwen2-VL-2B-Instruct-Q4_K_M.gguf"
MMPROJ_PATH = MODELS_DIR / "mmproj-Qwen2-VL-2B-Instruct-f16.gguf"

# 引擎配置
ENGINE_CONFIG = {
    "model_path": str(MODEL_9B_PATH),
    "n_ctx": 65536,          # 上下文长度 (Qwen3.5原生支持至262K, 先设64K测试)
    "n_gpu_layers": -1,      # -1 = 全部放 GPU（如果 VRAM 够），或具体数字
    "n_threads": 8,          # CPU 线程数
    "temperature": 0.7,
    "top_p": 0.9,
    "top_k": 40,
    "max_tokens": 4096,
    "verbose": False,
}


# ============================================================================
# 数据结构
# ============================================================================

@dataclass
class EngineState:
    """引擎运行时状态"""
    model_loaded: bool = False
    model_path: str = ""
    model_size_mb: float = 0.0
    vram_usage_mb: float = 0.0
    loaded_at: Optional[datetime] = None
    total_tokens_generated: int = 0
    total_requests: int = 0
    last_used: Optional[datetime] = None
    current_brain: Optional[str] = None


@dataclass
class GenerateConfig:
    """生成参数"""
    temperature: float = 0.7
    top_p: float = 0.9
    top_k: int = 40
    max_tokens: int = 4096
    repetition_penalty: float = 1.1
    stop: List[str] = field(default_factory=lambda: ["</s>", "<|im_end|>", "<|endoftext|>"])
    stream: bool = True


# ============================================================================
# 9B Engine
# ============================================================================

class NineBEngine:
    """
    Qwen3.5-9B 推理引擎

    用法:
        engine = NineBEngine()
        engine.load()
        response = engine.generate("你好，请介绍一下自己")
        engine.unload()
    """

    def __init__(self, config: dict = None):
        self.config = {**ENGINE_CONFIG, **(config or {})}
        self.state = EngineState()
        self._llm = None
        self._lock = threading.Lock()
        self._brain_runtime = None  # 延迟导入

    # ----- 模型加载 -----

    def load(self, gpu_layers: int = -1) -> bool:
        """
        加载 9B 模型

        Args:
            gpu_layers: -1 = 自动（全部放 GPU），或指定层数

        Returns:
            是否加载成功
        """
        if self._llm is not None:
            logger.info("模型已加载，跳过")
            return True

        model_path = self.config["model_path"]
        if not os.path.exists(model_path):
            logger.error(f"模型不存在: {model_path}")
            return False

        try:
            from llama_cpp import Llama
        except ImportError:
            logger.error("未安装 llama-cpp-python。运行: pip install llama-cpp-python")
            return False

        logger.info(f"正在加载 9B 模型: {model_path}")

        try:
            self._llm = Llama(
                model_path=model_path,
                n_ctx=self.config["n_ctx"],
                n_gpu_layers=gpu_layers,
                n_threads=self.config["n_threads"],
                verbose=self.config["verbose"],
            )
        except Exception as e:
            logger.error(f"llama-cpp-python 加载失败: {e}")
            # 降级尝试：使用 llama-cpp-python 的 shim
            try:
                from llama_cpp_shim import Llama as LlamaShim
                self._llm = LlamaShim(
                    model_path=model_path,
                    n_ctx=self.config["n_ctx"],
                    n_gpu_layers=gpu_layers,
                    n_threads=self.config["n_threads"],
                    verbose=self.config["verbose"],
                )
            except Exception as e2:
                logger.error(f"shim 加载也失败: {e2}")
                return False

        # 更新状态
        model_size = os.path.getsize(model_path) / (1024 * 1024)
        self.state.model_loaded = True
        self.state.model_path = model_path
        self.state.model_size_mb = model_size
        self.state.loaded_at = datetime.now()
        self.state.last_used = datetime.now()

        logger.info(f"9B 模型加载完成 ({model_size:.0f} MB)")
        return True

    def unload(self):
        """卸载模型，释放内存"""
        with self._lock:
            if self._llm is not None:
                logger.info("卸载 9B 模型...")
                del self._llm
                self._llm = None
            self.state.model_loaded = False
            self.state.model_path = ""
            self.state.loaded_at = None
            logger.info("9B 模型已卸载")

    def is_loaded(self) -> bool:
        """检查模型是否已加载"""
        return self._llm is not None and self.state.model_loaded

    # ----- Brain 集成 -----

    def set_brain(self, brain_id: str):
        """设置当前大脑（会注入对应 system_prompt）"""
        if self._brain_runtime is None:
            from brain_runtime import BrainRuntime
            self._brain_runtime = BrainRuntime()
        self._brain_runtime.activate(brain_id)
        self.state.current_brain = brain_id

    def get_brain_prompt(self) -> Optional[str]:
        """获取当前大脑的运行时 prompt"""
        if self._brain_runtime:
            return self._brain_runtime.get_current_prompt()
        return None

    # ----- 推理 -----

    def _build_chat_prompt(self, messages: List[Dict[str, str]]) -> str:
        """
        构建 Qwen 格式的 chat prompt

        Qwen2.5 格式:
        <|im_start|>system
        {system_prompt}<|im_end|>
        <|im_start|>user
        {message}<|im_end|>
        <|im_start|>assistant
        """
        # 注入大脑 system_prompt
        brain_prompt = self.get_brain_prompt()

        prompt_parts = []
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")

            # 如果是 system 消息且有大脑 prompt，追加
            if role == "system" and brain_prompt:
                content = brain_prompt + "\n\n" + content

            prompt_parts.append(f"<|im_start|>{role}\n{content}<|im_end|>")

        prompt_parts.append("<|im_start|>assistant\n")
        return "\n".join(prompt_parts)

    def generate(
        self,
        messages: List[Dict[str, str]],
        config: GenerateConfig = None,
    ) -> str:
        """
        非流式生成

        Args:
            messages: OpenAI 格式的消息列表
            config: 生成参数

        Returns:
            生成的文本
        """
        if not self.is_loaded():
            return "[错误] 9B 模型未加载"

        cfg = config or GenerateConfig()

        prompt = self._build_chat_prompt(messages)

        with self._lock:
            try:
                output = self._llm(
                    prompt,
                    max_tokens=cfg.max_tokens,
                    temperature=cfg.temperature,
                    top_p=cfg.top_p,
                    top_k=cfg.top_k,
                    repeat_penalty=cfg.repetition_penalty,
                    stop=cfg.stop,
                    echo=False,
                )
            except Exception as e:
                logger.error(f"推理失败: {e}")
                return f"[错误] 推理失败: {e}"

        text = output["choices"][0]["text"] if output.get("choices") else ""
        self.state.total_tokens_generated += len(text.split())
        self.state.total_requests += 1
        self.state.last_used = datetime.now()
        return text

    def generate_stream(
        self,
        messages: List[Dict[str, str]],
        config: GenerateConfig = None,
    ) -> Generator[str, None, None]:
        """
        流式生成

        Yields:
            token 文本块
        """
        if not self.is_loaded():
            yield "[错误] 9B 模型未加载"
            return

        cfg = config or GenerateConfig()
        prompt = self._build_chat_prompt(messages)

        token_count = 0
        with self._lock:
            try:
                for chunk in self._llm(
                    prompt,
                    max_tokens=cfg.max_tokens,
                    temperature=cfg.temperature,
                    top_p=cfg.top_p,
                    top_k=cfg.top_k,
                    repeat_penalty=cfg.repetition_penalty,
                    stop=cfg.stop,
                    echo=False,
                    stream=True,
                ):
                    text = chunk["choices"][0].get("text", "")
                    if text:
                        token_count += 1
                        yield text

                    # 超时保护
                    if token_count >= cfg.max_tokens:
                        break

            except Exception as e:
                logger.error(f"流式推理失败: {e}")
                yield f"\n[流式错误: {e}]"

        self.state.total_tokens_generated += token_count
        self.state.total_requests += 1
        self.state.last_used = datetime.now()

    # ----- 状态查询 -----

    def get_state(self) -> dict:
        """获取引擎状态（供 API 返回）"""
        return {
            "model_loaded": self.state.model_loaded,
            "model_path": self.state.model_path,
            "model_size_mb": self.state.model_size_mb,
            "loaded_at": self.state.loaded_at.isoformat() if self.state.loaded_at else None,
            "total_tokens_generated": self.state.total_tokens_generated,
            "total_requests": self.state.total_requests,
            "last_used": self.state.last_used.isoformat() if self.state.last_used else None,
            "current_brain": self.state.current_brain,
        }

    def get_health(self) -> dict:
        """健康检查"""
        return {
            "status": "ok" if self.is_loaded() else "not_loaded",
            "model": "Qwen3.5-9B-Q4_K_M",
            "vram": f"{self.state.model_size_mb:.0f} MB",
        }


# ============================================================================
# 全局单例
# ============================================================================

_engine_instance: Optional[NineBEngine] = None

def get_engine() -> NineBEngine:
    """获取全局引擎单例"""
    global _engine_instance
    if _engine_instance is None:
        _engine_instance = NineBEngine()
    return _engine_instance


# ============================================================================
# CLI / 测试入口
# ============================================================================

def main():
    import argparse

    parser = argparse.ArgumentParser(description="玄枢 9B 引擎 CLI")
    parser.add_argument("action", choices=["load", "unload", "status", "generate"])
    parser.add_argument("--prompt", default="你好，请用一句话介绍自己")
    parser.add_argument("--brain", default=None, help="激活的大脑 ID")
    args = parser.parse_args()

    engine = NineBEngine()

    if args.action == "load":
        success = engine.load()
        print(f"加载结果: {'成功' if success else '失败'}")

    elif args.action == "unload":
        engine.unload()
        print("已卸载")

    elif args.action == "status":
        state = engine.get_state()
        print(json.dumps(state, indent=2, ensure_ascii=False))

    elif args.action == "generate":
        if not engine.is_loaded():
            print("模型未加载，先执行 load")
            engine.load()

        if args.brain:
            engine.set_brain(args.brain)

        print(f"Prompt: {args.prompt}")
        print("---")
        response = engine.generate([
            {"role": "user", "content": args.prompt}
        ])
        print(response)


if __name__ == "__main__":
    main()
