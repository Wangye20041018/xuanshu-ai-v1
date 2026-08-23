"""
玄枢AI - 本地LLM配置文件
环境变量支持: LOCAL_LLM_ENABLED / LOCAL_LLM_PORT / LOCAL_LLM_MODEL_PATH
"""
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass
class LocalLLMConfig:
    """本地DeepSeek-7B模型配置"""

    # === 模型路径 ===
    model_path: str = str(
        Path(os.environ.get(
            "LOCAL_LLM_MODEL_PATH",
            r"D:\模型\主模型\DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf"
        ))
    )

    # === API 服务 ===
    host: str = os.environ.get("LOCAL_LLM_HOST", "127.0.0.1")
    port: int = int(os.environ.get("LOCAL_LLM_PORT", "8080"))

    @property
    def api_base(self) -> str:
        return f"http://{self.host}:{self.port}/v1"

    @property
    def chat_endpoint(self) -> str:
        return f"{self.api_base}/chat/completions"

    @property
    def health_endpoint(self) -> str:
        return f"http://{self.host}:{self.port}/health"

    # === 推理参数 ===
    context_size: int = int(os.environ.get("LOCAL_LLM_CTX_SIZE", "4096"))
    gpu_layers: int = int(os.environ.get("LOCAL_LLM_GPU_LAYERS", "999"))
    threads: int = int(os.environ.get("LOCAL_LLM_THREADS", "4"))
    max_tokens: int = int(os.environ.get("LOCAL_LLM_MAX_TOKENS", "2048"))
    temperature: float = float(os.environ.get("LOCAL_LLM_TEMPERATURE", "0.7"))

    # === 分流阈值 ===
    # 文本长度阈值（字符数），超过走云端
    max_local_text_length: int = int(
        os.environ.get("LOCAL_LLM_TEXT_THRESHOLD", "2000")
    )
    # 长文档阈值（字符数），超过走云端
    long_doc_threshold: int = int(
        os.environ.get("LOCAL_LLM_LONG_DOC_THRESHOLD", "8000")
    )

    # === 服务控制 ===
    enabled: bool = os.environ.get("LOCAL_LLM_ENABLED", "true").lower() == "true"
    startup_timeout: int = int(os.environ.get("LOCAL_LLM_STARTUP_TIMEOUT", "120"))
    health_check_interval: int = int(
        os.environ.get("LOCAL_LLM_HEALTH_INTERVAL", "5")
    )

    # === Fallback ===
    # 本地不可用时回退的云端 API 地址（OpenAI 兼容）
    cloud_api_base: str = os.environ.get(
        "LOCAL_LLM_CLOUD_API",
        "https://api.openai.com/v1"
    )
    cloud_api_key: str = os.environ.get("LOCAL_LLM_CLOUD_KEY", "")
    cloud_model: str = os.environ.get("LOCAL_LLM_CLOUD_MODEL", "gpt-4")

    # === llama.cpp 可执行文件搜索路径 ===
    llama_cpp_search_paths: list = None

    def __post_init__(self):
        self.llama_cpp_search_paths = [
            r"D:\开发2\node_modules\.bin\llama-server.exe",
            r"D:\开发2\node_modules\node-llama-cpp\llama\localBuild\bin\Release\llama-server.exe",
            r"D:\开发2\tools\llama.cpp\build\bin\Release\llama-server.exe",
            # 系统 PATH 中的常见位置
            "llama-server.exe",
        ]


# 全局单例
config = LocalLLMConfig()
