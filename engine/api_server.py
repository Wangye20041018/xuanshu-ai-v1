"""
玄枢 AI Engine v11.2.0 — 动态模型推理引擎 API Server
=====================================================
Flask 服务监听 localhost:8765。

架构：模型由 UI 端动态接入，引擎从 config.json 读取运行时路径。
  - 模型路径: 由 config.json 指定（模型管理模块动态填充）
  - mmproj 路径: config.json 指定（视觉模型投影文件，可选）
  - 推理方式: 优先 GPU，自动回退 CPU

API：
  POST /chat          — 对话接口 {messages, personality, tools}
  GET  /status        — 返回 GPU 显存使用、内存使用、当前吞吐
  POST /mode/switch   — 切换 local/cloud 模式（运行时）
"""

import os
import sys
import json
import time
import uuid
import threading
import traceback
import signal
import queue
import ctypes
from datetime import datetime
from pathlib import Path

# --- 日志 ---
import logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(
            Path(__file__).resolve().parent / "logs" / "api_server_v31.log",
            encoding="utf-8",
        ),
    ],
)
logger = logging.getLogger("xuanshu-api-v31")

# --- 路径常量（必须在任何使用 ENGINE_DIR 的代码之前定义，修复 C-11 启动崩溃） ---
ENGINE_DIR = Path(__file__).resolve().parent          # engine/

(Path(__file__).resolve().parent / "logs").mkdir(exist_ok=True)

try:
    from flask import Flask, request, jsonify, Response, stream_with_context
    from flask_cors import CORS
except ImportError:
    logger.error("flask/flask-cors 未安装。运行: pip install flask flask-cors")
    sys.exit(1)

# --- llama-server CUDA 后端补丁 ---
try:
    sys.path.insert(0, str(ENGINE_DIR))
    from patch_llama_server import (
        local_chat, local_chat_stream_generator, SERVER_AVAILABLE,
    )
    USE_LLAMA_SERVER = SERVER_AVAILABLE
except ImportError:
    USE_LLAMA_SERVER = False
    logger.warning("llama-server 补丁未加载，将使用 CPU llama-cpp-python")

# --- VL 视觉引擎 ---
try:
    from vl_engine import vl_chat, vl_status, _has_image
    VL_ENGINE_AVAILABLE = True
except ImportError:
    VL_ENGINE_AVAILABLE = False
    logger.warning("vl_engine 未加载，图片理解不可用")
    def _has_image(msgs): return False
    def vl_chat(msgs, **kw): return "[VL] 引擎不可用"
    def vl_status(): return {"available": False}

# --- 外部导入（保留原有模块兼容） ---
try:
    from mode_router import ModeRouter
except ImportError:
    ModeRouter = None
    logger.warning("mode_router 未加载，将使用默认路由")

try:
    from memory_guardian import MemoryGuardian
except ImportError:
    MemoryGuardian = None
    logger.warning("memory_guardian 未加载，内存监控禁用")

# ============================================================================
# 路径常量（pathlib 跨平台）
# ============================================================================
# ENGINE_DIR 已在文件顶部定义（修复 C-11：防止第 55 行 NameError 启动崩溃）
PROJECT_ROOT = ENGINE_DIR.parent                      # 项目根目录
VERSION_PATH = PROJECT_ROOT / "VERSION"
RESOURCES_DIR = ENGINE_DIR / "resources"
MODELS_DIR = RESOURCES_DIR / "models"

# 模型路径
MODEL_9B_PATH   = str(MODELS_DIR / "qwen3.5-9b.gguf")
MODEL_7B_MMPROJ    = str(MODELS_DIR / "mmproj-Qwen2-VL-2B-Instruct-f16.gguf")
MODEL_14B_PATH     = ""         # 14B 验证模型已移除，由 config.json 管理

DRAFT_LEN          = 4          # 草稿 token 数（投机解码已禁用）
CONTEXT_14B        = 32768      # 上下文窗口（保留兼容）
LLAMA_CPP_DIR      = str(RESOURCES_DIR)  # llama-server.exe / llama-cli.exe 所在

# --- 从 config.json 读取覆盖 ---
# --- config.json Schema ---
_CONFIG_SCHEMA = {
    "model_7b_path":       {"type": str,  "default": "",    "required": False},
    "model_14b_path":      {"type": str,  "default": "",    "required": False},
    "mmproj_path":         {"type": str,  "default": "",    "required": False},
    "embedding_model_path":{"type": str,  "default": "",    "required": False},
    "model_dir":           {"type": str,  "default": "",    "required": False},
    "api_port":            {"type": int,  "default": 8765,  "required": True},
    "speculative_k":       {"type": int,  "default": 4,     "required": False},
    "tts_enabled":         {"type": bool, "default": True,  "required": False},
    "wechat_relay_enabled":{"type": bool, "default": False, "required": False},
    "version":             {"type": str,  "default": "11.2.0", "required": False},
}


def _validate_config(cfg: dict, schema: dict, source: str = "config.json") -> dict:
    """Schema-aware config validator.

    - Missing required fields → prints error, fills default.
    - Wrong type for typed fields → prints warning, falls back to default.
    - Prints "配置校验通过" on success.
    """
    validated = {}
    errors = []

    for key, spec in schema.items():
        raw = cfg.get(key)

        # Missing required field
        if raw is None:
            if spec["required"]:
                errors.append(f"[必需字段缺失] {key} — 使用默认值 {spec['default']!r}")
            validated[key] = spec["default"]
            continue

        # Type check
        expected_type = spec["type"]
        if expected_type is bool:
            # bool must be checked before int (bool is subclass of int)
            if not isinstance(raw, bool):
                errors.append(f"[类型无效] {key}: 期望 bool，实际 {type(raw).__name__} — 回退默认值 {spec['default']!r}")
                validated[key] = spec["default"]
                continue
        elif expected_type is int:
            if isinstance(raw, bool) or not isinstance(raw, int):
                errors.append(f"[类型无效] {key}: 期望 int，实际 {type(raw).__name__} — 回退默认值 {spec['default']!r}")
                validated[key] = spec["default"]
                continue
        elif not isinstance(raw, expected_type):
            errors.append(f"[类型无效] {key}: 期望 {expected_type.__name__}，实际 {type(raw).__name__} — 回退默认值 {spec['default']!r}")
            validated[key] = spec["default"]
            continue

        validated[key] = raw

    if errors:
        for err in errors:
            logger.warning(f"[{source}] {err}")
    else:
        logger.info(f"[{source}] 配置校验通过")

    return validated


def _load_config_paths():
    config_path = Path(__file__).resolve().parent / "config.json"
    if config_path.exists():
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            return _validate_config(cfg, _CONFIG_SCHEMA, "config.json")
        except json.JSONDecodeError as e:
            logger.error(f"config.json 解析失败: {e}")
        except Exception as e:
            logger.warning(f"读取 config.json 失败: {e}")
    else:
        logger.info("config.json 未找到，使用全量默认值")
    # Fallback: all defaults
    return {k: v["default"] for k, v in _CONFIG_SCHEMA.items()}

_config = _load_config_paths()
if _config.get("model_7b_path"):
    MODEL_9B_PATH = _config["model_7b_path"]
if _config.get("model_14b_path"):
    MODEL_14B_PATH = _config["model_14b_path"]
if _config.get("mmproj_path"):
    MODEL_7B_MMPROJ = _config["mmproj_path"]
if _config.get("speculative_k"):
    DRAFT_LEN = _config["speculative_k"]
API_PORT = _config.get("api_port", 8765)

# ============================================================================
# Flask App
# ============================================================================
app = Flask(__name__)
# S2 修复：限制 CORS 仅允许本地来源，禁止任意跨域访问
CORS(app, resources={
    r"/*": {
        # M-24 修复：移除 "file://" 来源，仅允许本地开发/打包来源
        "origins": ["http://localhost:5173", "http://localhost:3000", "app://."],
        "methods": ["GET", "POST"],
        "allow_headers": ["Content-Type"],
        "max_age": 3600
    }
})


# ============================================================================
# 统一错误处理
# ============================================================================
@app.errorhandler(404)
def not_found(e):
    return jsonify({"error": "not_found", "message": "端点不存在"}), 404


@app.errorhandler(500)
def internal_error(e):
    return jsonify({"error": "internal_error", "message": "服务器内部错误"}), 500


@app.errorhandler(Exception)
def unexpected_error(e):
    # C-14 修复：异常细节只写入日志，不向客户端暴露内部路径/堆栈
    logger.exception(f"Unhandled error: {e}")
    return jsonify({
        "error": "unexpected",
        "message": "服务内部错误，请稍后重试",
        "error_id": uuid.uuid4().hex[:8],
    }), 500

# ============================================================================
# 全局状态
# ============================================================================
class ServerState:
    def __init__(self):
        self.current_mode: str = "local"      # "local" | "cloud"
        self.active_persona: str = "default"
        self.active_plugins: list = []
        self.start_time: float = time.time()
        self.total_requests: int = 0
        self.streaming_enabled: bool = True
        self.draft_loaded: bool = False       # 7B VL 是否加载
        self.verify_loaded: bool = False      # 14B 是否加载
        self.throughput_tokens: int = 0
        self.throughput_elapsed: float = 0.0
        self.throughput_lock = threading.Lock()
        # Cloud API 配置（从 config.json 读取，运行时可用）
        self.cloud_api_key: str = ""
        self.cloud_api_url: str = ""
        self.cloud_model_name: str = ""

state = ServerState()

# ============================================================================
# llama.cpp Python 绑定（llama-cpp-python）
# ============================================================================
_draft_llm = None       # 7B VL 实例
_verify_llm = None      # 14B 实例
_llm_lock = threading.Lock()

def _load_draft_model():
    """加载 7B 模型到 GPU"""
    global _draft_llm
    if USE_LLAMA_SERVER:
        logger.info("使用外部 llama-server CUDA 后端，跳过内部模型加载")
        return True
    if _draft_llm is not None:
        return True

    if not os.path.exists(MODEL_9B_PATH):
        logger.error(f"9B 模型不存在: {MODEL_9B_PATH}")
        return False

    # 从 config.json 读取 gpu_layers 配置
    gpu_layers = 99
    config_path = Path(__file__).resolve().parent / "config.json"
    if config_path.exists():
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            gl = cfg.get("gpu_layers", -1)
            if gl != -1:
                gpu_layers = gl
        except Exception:
            pass

    try:
        # 优先级：CUDA Shim > CUDA llama-cpp-python > CPU llama-cpp-python
        from llama_cpp_shim import get_shim_available, Llama as ShimLlama
        use_shim = get_shim_available()
        if use_shim:
            Llama = ShimLlama
            logger.info("使用 llama-server CUDA Shim（GPU 加速）")
        else:
            import llama_cpp
            from llama_cpp import Llama
            if not llama_cpp.llama_supports_gpu_offload():
                logger.warning("llama-cpp-python 为 CPU-only，将使用 CPU 推理（速度较慢）")
            else:
                logger.info("使用 llama-cpp-python CUDA 原生绑定")

        # 优先使用 9B 模型路径（config.json 中的 model_path），回退到 model_7b_path
        model_to_load = MODEL_9B_PATH
        config_path = Path(__file__).resolve().parent / "config.json"
        if config_path.exists():
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
                mp = cfg.get("model_path", "")
                if mp and os.path.exists(mp):
                    model_to_load = mp
            except Exception:
                pass

        logger.info(f"正在加载推理模型到 GPU (ngl={gpu_layers}) ...")
        _draft_llm = Llama(
            model_path=model_to_load,
            n_ctx=8192,
            n_gpu_layers=gpu_layers,
            verbose=False,
        )
        state.draft_loaded = True
        logger.info(f"推理模型加载完成（{'GPU' if use_shim else 'CPU/GPU'}）")
        return True
    except ImportError:
        logger.error("llama-cpp-python 未安装。运行: pip install llama-cpp-python")
        return False
    except Exception as e:
        logger.error(f"加载推理模型失败: {e}")
        return False

def _load_verify_model():
    """加载 14B 纯文本模型到 CPU"""
    if USE_LLAMA_SERVER:
        logger.info("外部 llama-server 模式，跳过 14B 模型加载")
        return False
    global _verify_llm
    if _verify_llm is not None:
        return True

    if not os.path.exists(MODEL_14B_PATH):
        logger.error(f"14B 模型不存在: {MODEL_14B_PATH}")
        return False

    try:
        try:
            from llama_cpp import Llama
        except ImportError:
            from llama_cpp_shim import Llama
        logger.info("正在加载 14B 验证模型到 CPU ...")
        _verify_llm = Llama(
            model_path=MODEL_14B_PATH,
            n_ctx=CONTEXT_14B,
            n_gpu_layers=0,           # 纯 CPU
            verbose=False,
        )
        state.verify_loaded = True
        logger.info("14B 验证模型加载完成（CPU）")
        return True
    except ImportError:
        logger.error("llama-cpp-python 未安装。")
        return False
    except Exception as e:
        logger.error(f"加载 14B 失败: {e}")
        return False

def _unload_models():
    """优雅卸载所有模型"""
    global _draft_llm, _verify_llm
    with _llm_lock:
        if _draft_llm:
            logger.info("卸载 7B VL 草稿模型 ...")
            del _draft_llm
            _draft_llm = None
            state.draft_loaded = False
        if _verify_llm:
            logger.info("卸载 14B 验证模型 ...")
            del _verify_llm
            _verify_llm = None
            state.verify_loaded = False
    logger.info("所有模型已卸载")

# ============================================================================
# 投机解码核心
# ============================================================================
def _speculative_generate(messages: list, max_tokens: int = 2048,
                          temperature: float = 0.7, top_p: float = 0.9,
                          top_k: int = 40, repetition_penalty: float = 1.1,
                          min_p: float = -1.0, frequency_penalty: float = 0.0,
                          presence_penalty: float = 0.0, seed: str = "") -> str:
    """
    全量生成后验证模式（非标准投机解码，已弃用）。

    自 v11.2.0 起，投机解码已禁用，verify_14b 模型已移除。
    当前实际行为：7B 全量生成全部 token，随后可选 14B 验证输出。

    已知限制：受限于 llama-server 的 /completion API 不支持投机解码端点，
    无法实现 token-by-token 的标准投机解码。后续改进方向：
    (1) 升级到 llama.cpp 的 speculative 端点 (--draft-model)；
    (2) 或迁移至 vLLM/SGLang 原生投机解码后端。

    计划在 v12.0 移除此函数，届时统一走 _fallback_single_generate。
    """
    if _draft_llm is None or _verify_llm is None:
        return _fallback_single_generate(messages, max_tokens, temperature, top_p)

    # 构建 prompt（仅文本，不含图片时）
    prompt = _build_prompt_from_messages(messages)

    result_tokens = []
    draft_pos = 0

    # 简化投机循环：全量生成后验证
    try:
        # 7B GPU 快速生成
        draft_output = _draft_llm(
            prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            stop=["</s>", "<|im_end|>", "<|endoftext|>"],
            echo=False,
        )
        draft_text = draft_output["choices"][0]["text"] if draft_output.get("choices") else ""

        # 为准确起见，用 14B 生成作为最终输出（投机验证）
        verify_output = _verify_llm(
            prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            stop=["</s>", "<|im_end|>", "<|endoftext|>"],
            echo=False,
        )
        verify_text = verify_output["choices"][0]["text"] if verify_output.get("choices") else ""

        # 简单策略：优先 14B 输出（更可靠），但长度不足时用 7B 补全
        final_text = verify_text if len(verify_text) > 0 else draft_text

        # 更新吞吐统计（M-03 修复：记录本次生成完成时间戳，不再累加绝对时间戳）
        with state.throughput_lock:
            state.throughput_tokens += len(final_text.split())
            state.throughput_elapsed = time.time()

        return final_text
    except Exception as e:
        logger.error(f"投机解码失败: {e}")
        return _fallback_single_generate(messages, max_tokens, temperature, top_p)

def _fallback_single_generate(messages: list, max_tokens: int,
                               temperature: float, top_p: float) -> str:
    """降级方案：仅用已加载的单一模型生成（内部使用流式以提升 GPU 推理速度）"""
    llm = _draft_llm or _verify_llm
    if llm is None:
        return "[错误] 没有可用模型"

    prompt = _build_prompt_from_messages(messages)
    try:
        # 使用流式模式以获得更高吞吐（尤其 CUDA Shim 后端差异达 8x）
        stream = llm(
            prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            stop=["</s>", "<|im_end|>", "<|endoftext|>"],
            stream=True,
            echo=False,
        )
        result_parts = []
        for item in stream:
            choices = item.get("choices", [])
            if choices:
                result_parts.append(choices[0].get("text", ""))
        return "".join(result_parts)
    except Exception as e:
        logger.error(f"单模型生成失败: {e}")
        return "[错误] 推理失败"

def _build_prompt_from_messages(messages: list) -> str:
    """将 OpenAI 格式 messages 转为 Qwen2.5 的 chatml 格式"""
    parts = []
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role == "system":
            parts.append(f"<|im_start|>system\n{content}<|im_end|>")
        elif role == "user":
            parts.append(f"<|im_start|>user\n{content}<|im_end|>")
        elif role == "assistant":
            parts.append(f"<|im_start|>assistant\n{content}<|im_end|>")
    parts.append("<|im_start|>assistant\n")
    return "\n".join(parts)

# ============================================================================
# Cloud API 插入点
# ============================================================================
def _cloud_chat(messages: list) -> str:
    """Cloud 模式：7B VL 做视觉翻译，文本送用户自配 API"""
    import urllib.request

    api_url = state.cloud_api_url or os.environ.get("CLOUD_API_URL", "")
    api_key = state.cloud_api_key or os.environ.get("CLOUD_API_KEY", "")
    model_name = state.cloud_model_name or os.environ.get("CLOUD_MODEL_NAME", "")

    if not api_url:
        # 尝试从 config.json 读取
        config_path = Path(__file__).resolve().parent / "config.json"
        if config_path.exists():
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
                api_url = cfg.get("api_url", api_url)
                api_key = cfg.get("api_key", api_key)
                model_name = cfg.get("model_name", model_name)
            except Exception:
                pass

    if not api_url:
        return "[Cloud 模式] 未配置 API 地址，请在设置页填写 Cloud API 配置"

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    body = {
        "model": model_name or "gpt-4",
        "messages": messages,
        "temperature": 0.7,
        "max_tokens": 2048,
    }
    try:
        req = urllib.request.Request(api_url, data=json.dumps(body).encode(), headers=headers)
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read())
        return result["choices"][0]["message"]["content"]
    except Exception as e:
        logger.error(f"Cloud API 请求失败: {e}")
        return f"[Cloud 模式] API 调用失败: {e}"

# ============================================================================
# 系统信息
# ============================================================================
def _get_gpu_info() -> dict:
    info = {"available": False, "name": "Unknown", "memory_total_mb": 0,
            "memory_used_mb": 0, "memory_free_mb": 0, "utilization_pct": 0, "temperature_c": 0}
    try:
        import GPUtil
        gpus = GPUtil.getGPUs()
        if gpus:
            g = gpus[0]
            info["available"] = True
            info["name"] = g.name
            info["memory_total_mb"] = int(g.memoryTotal)
            info["memory_used_mb"] = int(g.memoryUsed)
            info["memory_free_mb"] = int(g.memoryFree)
            info["utilization_pct"] = int(g.load * 100)
            info["temperature_c"] = int(g.temperature)
    except ImportError:
        pass
    except Exception as e:
        logger.warning(f"GPU 信息获取失败: {e}")
    return info

def _get_memory_info() -> dict:
    info = {"total_gb": 0, "used_gb": 0, "free_gb": 0, "percent": 0}
    try:
        import psutil
        mem = psutil.virtual_memory()
        info["total_gb"] = round(mem.total / (1024**3), 2)
        info["used_gb"] = round(mem.used / (1024**3), 2)
        info["free_gb"] = round(mem.available / (1024**3), 2)
        info["percent"] = round(mem.percent, 1)
    except ImportError:
        pass
    except Exception as e:
        logger.warning(f"内存信息获取失败: {e}")
    return info

def _get_cpu_info() -> dict:
    info = {"percent": 0, "count": os.cpu_count() or 0}
    try:
        import psutil
        info["percent"] = round(psutil.cpu_percent(interval=0.1), 1)
    except Exception:
        pass
    return info

def _get_throughput() -> float:
    """获取当前吞吐量（tokens/s）"""
    with state.throughput_lock:
        if state.throughput_elapsed == 0:
            return 0.0
        elapsed = time.time() - state.throughput_elapsed + 0.001
        return round(state.throughput_tokens / max(elapsed, 0.01), 1)

# ============================================================================
# S1 修复：云端凭证管理（从 .env.cloud 读取，不再明文存 config.json）
# ============================================================================
_ENV_CLOUD_PATH = Path(__file__).resolve().parent / ".env.cloud"

def _load_cloud_credentials():
    """从 .env.cloud 文件加载云端 API 凭证到全局状态"""
    if not _ENV_CLOUD_PATH.exists():
        logger.warning("[Cloud] .env.cloud 未找到，云端 API 不可用")
        return
    try:
        with open(_ENV_CLOUD_PATH, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("XUANSHU_CLOUD_API_KEY="):
                    state.cloud_api_key = line.split("=", 1)[1].strip()
                elif line.startswith("XUANSHU_CLOUD_API_URL="):
                    state.cloud_api_url = line.split("=", 1)[1].strip()
                elif line.startswith("XUANSHU_CLOUD_MODEL_NAME="):
                    state.cloud_model_name = line.split("=", 1)[1].strip()
        # 也从 config.json 读取非敏感字段作为兜底
        config_path = Path(__file__).resolve().parent / "config.json"
        if config_path.exists():
            with open(config_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            state.cloud_api_url = state.cloud_api_url or cfg.get("cloud_api_url", "")
            state.cloud_model_name = state.cloud_model_name or cfg.get("cloud_model_name", "")
        logger.info("[Cloud] 凭证加载完成")
    except Exception as e:
        logger.error(f"[Cloud] 凭证加载失败: {e}")

# ============================================================================
# 人格与插件加载
# ============================================================================
_personas_cache: dict = {}
_plugins_cache: dict = {}

def _load_personas() -> dict:
    global _personas_cache
    if _personas_cache:
        return _personas_cache
    personas_dir = Path(__file__).resolve().parent.parent / "personas"
    if not personas_dir.exists():
        return {}
    for fpath in sorted(personas_dir.glob("*.json")):
        try:
            with open(fpath, "r", encoding="utf-8") as f:
                data = json.load(f)
            pid = data.get("id", fpath.stem)
            _personas_cache[pid] = data
        except Exception as e:
            logger.error(f"加载人格文件失败 {fpath.name}: {e}")
    logger.info(f"已加载 {len(_personas_cache)} 个人格")
    return _personas_cache

def _load_plugins() -> dict:
    global _plugins_cache
    if _plugins_cache:
        return _plugins_cache
    plugins_dir = Path(__file__).resolve().parent.parent / "plugins"
    if not plugins_dir.exists():
        return {}
    for fpath in sorted(plugins_dir.glob("*.json")):
        try:
            with open(fpath, "r", encoding="utf-8") as f:
                data = json.load(f)
            pid = data.get("id", fpath.stem)
            _plugins_cache[pid] = data
        except Exception as e:
            logger.error(f"加载插件文件失败 {fpath.name}: {e}")
    logger.info(f"已加载 {len(_plugins_cache)} 个插件")
    return _plugins_cache

def _build_system_prompt(persona_id: str) -> str:
    personas = _load_personas()
    persona = personas.get(persona_id, personas.get("default", {}))
    return persona.get("system_prompt", "You are a helpful AI assistant.")

# ============================================================================
# Stream 生成器
# ============================================================================
def _stream_response(messages: list, max_tokens: int = 2048,
                     temperature: float = 0.7, top_p: float = 0.9,
                     top_k: int = 40, repetition_penalty: float = 1.1,
                     min_p: float = -1.0, frequency_penalty: float = 0.0,
                     presence_penalty: float = 0.0, seed: str = ""):
    """SSE 流式输出"""
    prompt = _build_prompt_from_messages(messages)
    llm = _draft_llm or _verify_llm
    if llm is None:
        yield f"data: {json.dumps({'error': '没有可用模型'})}\n\n"
        yield "data: [DONE]\n\n"
        return

    try:
        stream = llm(
            prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            stop=["</s>", "<|im_end|>", "<|endoftext|>"],
            stream=True,
            echo=False,
        )
        token_count = 0
        for item in stream:
            choices = item.get("choices", [])
            if choices:
                delta = choices[0].get("text", "")
                token_count += 1
                yield f"data: {json.dumps({'choices': [{'delta': {'content': delta}}]})}\n\n"
        yield "data: [DONE]\n\n"
        with state.throughput_lock:
            state.throughput_tokens += token_count
    except Exception as e:
        logger.error(f"流式生成失败: {e}")
        yield f"data: {json.dumps({'error': 'stream_error'})}\n\n"
        yield "data: [DONE]\n\n"

# ============================================================================
# API Routes
# ============================================================================
@app.route("/version", methods=["GET"])
def get_version():
    """返回统一版本号"""
    if VERSION_PATH.exists():
        version = VERSION_PATH.read_text(encoding="utf-8").strip()
    else:
        version = "11.2.0"  # fallback
    return jsonify({"version": version, "engine": "xuanshu-ai", "api_version": "1.0"})

@app.route("/status", methods=["GET"])
def get_status():
    gpu = _get_gpu_info()
    mem = _get_memory_info()
    cpu = _get_cpu_info()
    throughput = _get_throughput()

    uptime_sec = time.time() - state.start_time
    hours, rem = divmod(int(uptime_sec), 3600)
    minutes, seconds = divmod(rem, 60)

    return jsonify({
        "status": "running",
        "uptime": f"{hours:02d}:{minutes:02d}:{seconds:02d}",
        "current_mode": state.current_mode,
        "active_persona": state.active_persona,
        "active_plugins": state.active_plugins,
        "total_requests": state.total_requests,
        "streaming_enabled": state.streaming_enabled,
        "throughput": throughput,
        "throughput_tokens_per_sec": throughput,
        "draft_loaded": state.draft_loaded or USE_LLAMA_SERVER,
        "verify_loaded": state.verify_loaded,
        "gpu": gpu,
        "memory": mem,
        "cpu": cpu,
        "models": {
            "draft_9b": {
                "name": "Qwen3.5-9B",
                "quantization": "Q4_K_M",
                "loaded": state.draft_loaded or USE_LLAMA_SERVER,
                "device": "GPU" if USE_LLAMA_SERVER else "CPU",
                "backend": "llama-server-cuda" if USE_LLAMA_SERVER else "llama-cpp-python",
                "vram_est_gb": 5.5,
            },
            "verify_14b": {
                "name": "Qwen2.5-14B-Instruct (已移除)",
                "quantization": "N/A",
                "loaded": False,
                "device": "N/A",
                "context_window": CONTEXT_14B,
                "note": "14B 验证模型已从 config.json 移除，投机解码已禁用",
            },
        },
        "hardware": {
            "gpu": gpu,
            "cpu": cpu,
            "memory": mem,
        },
        "personas_loaded": len(_load_personas()),
        "plugins_loaded": len(_load_plugins()),
    })

@app.route("/chat", methods=["POST"])
def chat():
    """对话接口

    请求示例:
        {
            "messages": [{"role": "user", "content": "你好"}],
            "mode": "local",
            "stream": false,
            "temperature": 0.7,
            "max_tokens": 2048
        }

    非流式响应示例:
        {
            "role": "assistant",
            "content": "你好！有什么可以帮助你的？",
            "reply": "你好！有什么可以帮助你的？",
            "text": "你好！有什么可以帮助你的？",
            "mode": "local"
        }
    """
    # M-02 修复：Flask threaded=True 下计数器加锁保护
    with state.throughput_lock:
        state.total_requests += 1

    try:
        body = request.get_json(force=True)
    except Exception:
        return jsonify({"error": "invalid_json", "message": "无效的 JSON 请求体"}), 400

    if not body:
        return jsonify({"error": "empty_body", "message": "空请求体"}), 400

    messages = body.get("messages", [])
    if not messages:
        return jsonify({"error": "no_messages", "message": "未提供消息"}), 400

    # M-11 修复：输入长度限制，防止恶意/异常请求导致 OOM
    MAX_MESSAGES = 50
    MAX_MESSAGE_LENGTH = 32000
    if len(messages) > MAX_MESSAGES:
        return jsonify({"error": "too_many_messages",
                        "message": f"消息条数超过上限（{MAX_MESSAGES} 条）"}), 400
    for msg in messages:
        content = msg.get("content", "") if isinstance(msg, dict) else ""
        if isinstance(content, str) and len(content) > MAX_MESSAGE_LENGTH:
            return jsonify({"error": "message_too_long",
                            "message": f"单条消息超过上限（{MAX_MESSAGE_LENGTH} 字符）"}), 400

    # Accept only 'local' or 'cloud', ignore legacy mode values
    mode = body.get("mode", "local")
    if mode not in ("local", "cloud"):
        mode = "local"
    persona_id = body.get("personality", body.get("persona_id", state.active_persona))
    stream = body.get("stream", state.streaming_enabled)
    
    # Inject persona system prompt if not already in messages
    has_system = any(m.get("role") == "system" for m in messages)
    if not has_system and persona_id:
        sys_prompt = _build_system_prompt(persona_id)
        messages = [{"role": "system", "content": sys_prompt}] + messages
    
    max_tokens = body.get("max_tokens", 2048)
    temperature = body.get("temperature", 0.7)
    top_p = body.get("top_p", 0.9)
    top_k = body.get("top_k", 40)
    repetition_penalty = body.get("repetition_penalty", 1.1)
    min_p = body.get("min_p", -1)
    frequency_penalty = body.get("frequency_penalty", 0.0)
    presence_penalty = body.get("presence_penalty", 0.0)
    seed = body.get("seed", "")

    if mode == "cloud":
        # Cloud 模式
        try:
            result_text = _cloud_chat(messages)
            return jsonify({
                "role": "assistant",
                "content": result_text,
                "reply": result_text,
                "text": result_text,
                "mode": "cloud",
            })
        except Exception as e:
            logger.error(f"/chat cloud 模式失败: {e}")
            return jsonify({"error": "chat_failed", "message": str(e)}), 500

    # === VL 图片理解路径（优先检测） ===
    if _has_image(messages):
        try:
            vl_result = vl_chat(messages, max_tokens=max_tokens)
            return jsonify({
                "role": "assistant",
                "content": vl_result,
                "reply": vl_result,
                "text": vl_result,
                "mode": mode,
                "backend": "qwen2-vl-2b-cpu",
            })
        except Exception as e:
            logger.error(f"VL 推理失败: {e}")
            return jsonify({"error": "vl_failed", "message": str(e)}), 500

    # === llama-server CUDA 加速路径 ===
    if USE_LLAMA_SERVER:
        if stream:
            def _llama_stream():
                try:
                    resp = local_chat(messages, max_tokens, temperature, top_p, stream=True)
                    yield from local_chat_stream_generator(resp)
                except Exception as e:
                    logger.error(f"llama-server 流式失败: {e}")
                    yield f"data: {json.dumps({'error': str(e)})}\n\n"
                    yield "data: [DONE]\n\n"
            return Response(
                stream_with_context(_llama_stream()),
                mimetype="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "X-Accel-Buffering": "no",
                    "Connection": "keep-alive",
                },
            )
        else:
            try:
                result_text = local_chat(messages, max_tokens, temperature, top_p, stream=False)
                return jsonify({
                    "role": "assistant",
                    "content": result_text,
                    "reply": result_text,
                    "text": result_text,
                    "mode": mode,
                    "backend": "llama-server-cuda",
                })
            except Exception as e:
                logger.error(f"llama-server 推理失败，回退 CPU: {e}")
                # 不回退，直接报错
                return jsonify({"error": "chat_failed", "message": str(e)}), 500

    # === CPU llama-cpp-python 路径（兜底） ===
    if stream:
        return Response(
            stream_with_context(_stream_response(messages, max_tokens, temperature, top_p,
                top_k, repetition_penalty, min_p, frequency_penalty, presence_penalty, seed)),
            mimetype="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
                "Connection": "keep-alive",
            },
        )
    else:
        try:
            result_text = _speculative_generate(
                messages, max_tokens, temperature, top_p,
                top_k, repetition_penalty, min_p, frequency_penalty,
                presence_penalty, seed
            )
            return jsonify({
                "role": "assistant",
                "content": result_text,
                "reply": result_text,
                "text": result_text,
                "mode": mode,
            })
        except Exception as e:
            logger.error(f"/chat local 模式失败: {e}")
            return jsonify({"error": "chat_failed", "message": str(e)}), 500

@app.route("/mode/switch", methods=["POST"])
def mode_switch():
    """切换 local/cloud 模式

    请求示例:
        {"mode": "cloud"}

    响应示例:
        {"previous": "local", "current": "cloud", "message": "已切换到 cloud 模式", "success": true}
    """
    try:
        body = request.get_json(force=True)
        new_mode = body.get("mode", "")
        if new_mode not in ("local", "cloud"):
            return jsonify({"error": "参数错误", "message": "模式必须为 'local' 或 'cloud'"}), 400

        old_mode = state.current_mode
        state.current_mode = new_mode

        # Cloud 模式切换时读取配置（S1 修复：从 .env.cloud 读取，不再从 config.json 读）
        if new_mode == "cloud":
            _load_cloud_credentials()

        logger.info(f"模式切换: {old_mode} → {new_mode}")
        return jsonify({
            "previous": old_mode,
            "current": new_mode,
            "message": f"已切换到 {new_mode} 模式",
            "success": True,
        })
    except Exception as e:
        return jsonify({"error": "switch_failed", "message": str(e)}), 500

@app.route("/persona", methods=["POST"])
def set_persona():
    try:
        body = request.get_json(force=True)
        pid = body.get("persona_id", body.get("persona", body.get("name", "default")))
        personas = _load_personas()
        # Support lookup by name as well as ID
        if pid not in personas and pid != "default":
            # Try name matching
            for p_id, p_data in personas.items():
                if p_data.get("name", "") == pid:
                    pid = p_id
                    break
        if pid not in personas and pid != "default":
            return jsonify({"error": f"人格 '{pid}' 不存在"}), 404
        state.active_persona = pid
        return jsonify({"active_persona": pid, "success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.route("/personas", methods=["GET"])
def list_personas():
    return jsonify(list(_load_personas().values()))

@app.route("/plugins", methods=["GET"])
def list_plugins():
    return jsonify(list(_load_plugins().values()))

@app.route("/plugin/toggle", methods=["POST"])
def toggle_plugin():
    try:
        body = request.get_json(force=True)
        pid = body.get("plugin_id", body.get("plugin", body.get("name", "")))
        plugins = _load_plugins()
        # Support lookup by name as well as ID
        if pid not in plugins:
            for p_id, p_data in plugins.items():
                if p_data.get("name", "") == pid:
                    pid = p_id
                    break
        if not pid:
            return jsonify({"error": "缺少 plugin_id/plugin/name 参数"}), 400
        if pid not in plugins:
            return jsonify({"error": f"插件 '{pid}' 不存在"}), 404
        enabled = body.get("enabled", True)
        if enabled and pid not in state.active_plugins:
            state.active_plugins.append(pid)
        elif not enabled and pid in state.active_plugins:
            state.active_plugins.remove(pid)
        return jsonify({"active_plugins": state.active_plugins, "success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.route("/settings", methods=["POST"])
def update_settings():
    """接收前端设置持久化（兼容旧接口）"""
    # C-07 修复：白名单过滤，禁止注入任意配置字段
    ALLOWED_SETTINGS = {
        "theme", "language", "voice_name", "tts_enabled", "tts_speed",
        "max_context_length", "temperature", "top_p", "top_k",
        "repetition_penalty", "min_p", "frequency_penalty", "presence_penalty",
        "max_tokens", "seed", "concurrency", "batch_size", "micro_batch",
        "gpu_layers", "threads", "batch_threads", "streaming",
        "auto_launch", "minimize_to_tray", "default_device",
        "search_engines", "inference_version", "k_cache_quant", "v_cache_quant",
    }
    try:
        body = request.get_json(force=True)
        if not isinstance(body, dict):
            return jsonify({"error": "无效的请求体"}), 400
        # 过滤非法字段
        sanitized = {k: v for k, v in body.items() if k in ALLOWED_SETTINGS}
        if not sanitized:
            return jsonify({"error": "没有可保存的合法设置字段"}), 400
        # 将设置保存到 config.json
        config_path = Path(__file__).resolve().parent / "config.json"
        existing = {}
        if config_path.exists():
            with open(config_path, "r", encoding="utf-8") as f:
                existing = json.load(f)
        existing.update(sanitized)
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(existing, f, indent=2, ensure_ascii=False)
        return jsonify({"success": True, "updated": list(sanitized.keys())})
    except Exception as e:
        logger.error(f"保存设置失败: {e}")
        return jsonify({"error": "保存设置失败"}), 400

@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "model": "Qwen3.5-9B (单模型模式)",
    })

@app.route("/search", methods=["POST"])
def search():
    """搜索引擎端点

    请求示例:
        {"query": "Python异步编程最佳实践", "max_results": 5, "engines": ["bing", "google"]}

    响应示例:
        {"results": [{"title": "", "url": "", "snippet": "", "source_engine": ""}], "total": 5, "query": "..."}
    """
    try:
        body = request.get_json(force=True)
        query = body.get("query", "")
        if not query:
            return jsonify({"error": "缺少 query 参数"}), 400
        
        max_results = body.get("max_results", 5)
        engines = body.get("engines", ["bing", "google"])

        from search_engine import SearchEngine
        se = SearchEngine()
        # API 端 engines 是列表，需转为 engine_strategy 字符串
        if isinstance(engines, list):
            if set(engines) == {"bing", "google"} or set(engines) == {"google"}:
                strategy = "tech"
            elif set(engines) == {"bing", "baidu"}:
                strategy = "zh"
            elif len(engines) == 1:
                strategy = engines[0]
            else:
                strategy = "all"
        else:
            strategy = engines
        results = se.search(query, engine_strategy=strategy, max_results=max_results)

        return jsonify({
            "results": [
                {
                    "title": r.title if hasattr(r, 'title') else str(r),
                    "url": r.url if hasattr(r, 'url') else "",
                    "snippet": r.snippet if hasattr(r, 'snippet') else "",
                    "source_engine": r.source_engine if hasattr(r, 'source_engine') else "",
                    "relevance_score": r.relevance_score if hasattr(r, 'relevance_score') else 0,
                } for r in results
            ],
            "total": len(results),
            "query": query,
        })
    except ImportError as e:
        return jsonify({"error": "search_unavailable", "message": f"搜索引擎模块不可用: {e}"}), 503
    except Exception as e:
        logger.error(f"搜索失败: {e}")
        return jsonify({"error": "search_failed", "message": str(e)}), 500

# ============================================================================
# 语音引擎端点
# ============================================================================
@app.route("/voice/status", methods=["GET"])
def voice_status():
    try:
        from voice_engine import VoiceEngine, VOICES
        ve = VoiceEngine()
        available = ve.initialize()
        return jsonify({
            "available": available,
            "engine": "Edge TTS (WinRT)" if available else "pyttsx3 fallback" if ve.is_available() else "none",
            "current_voice": ve.config.voice,
            "voices": [
                {"id": k, "name": v["name"], "gender": v["gender"], "lang": v["lang"]}
                for k, v in VOICES.items()
            ],
            "config": ve.config.to_dict(),
        })
    except Exception as e:
        return jsonify({"available": False, "error": str(e)})

@app.route("/voice/set", methods=["POST"])
def voice_set():
    try:
        from voice_engine import VoiceEngine, VOICES
        body = request.get_json(force=True)
        voice_name = body.get("voice", "xiaoxiao")
        if voice_name not in VOICES:
            return jsonify({"error": "unknown_voice", "available": list(VOICES.keys())}), 400

        ve = VoiceEngine()
        ve.initialize()
        ve.set_voice(voice_name)

        return jsonify({
            "success": True,
            "voice": voice_name,
            "voice_info": VOICES[voice_name],
            "config": ve.config.to_dict(),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# M-12 修复：TTS 引擎全局单例（避免每次请求重复初始化）
_voice_engine_singleton = None

@app.route("/voice/speak", methods=["POST"])
def voice_speak():
    try:
        from voice_engine import VoiceEngine
        # M-12 修复：复用全局单例，避免每次请求重复初始化 TTS 引擎
        global _voice_engine_singleton
        if _voice_engine_singleton is None:
            _voice_engine_singleton = VoiceEngine()
            _voice_engine_singleton.initialize()
        ve = _voice_engine_singleton
        body = request.get_json(force=True)
        text = body.get("text", "")
        voice_name = body.get("voice", "xiaoxiao")

        if not text:
            return jsonify({"error": "缺少 text 参数"}), 400

        if voice_name != ve.config.voice:
            ve.set_voice(voice_name)
        ve.play(text)

        return jsonify({"success": True, "text": text[:50] + ("..." if len(text) > 50 else "")})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/config", methods=["GET"])
def get_config():
    """返回当前 config.json 内容（C-09 修复：过滤敏感凭证字段）"""
    SENSITIVE_KEYS = {
        "wechat_token", "wechat_appsecret", "cloud_api_key",
        "api_secret", "password", "secret", "token",
    }
    config_path = Path(__file__).resolve().parent / "config.json"
    if config_path.exists():
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
        # 过滤敏感字段，仅暴露"是否已配置"
        config_copy = {}
        for k, v in config.items():
            if any(s in k.lower() for s in SENSITIVE_KEYS):
                if v:
                    config_copy[f"{k}_configured"] = True
                continue
            config_copy[k] = v
        return jsonify(config_copy)
    return jsonify({}), 404

# ============================================================================
# TTS 端点 — 文本转语音，返回音频流
# ============================================================================
@app.route("/tts", methods=["POST"])
def tts_synthesize():
    """文本转语音端点

    请求示例:
        {"text": "你好世界", "voice": "xiaoxiao"}

    响应: audio/wav 二进制流
    """
    try:
        body = request.get_json(force=True)
        text = body.get("text", "")
        if not text or not text.strip():
            return jsonify({"error": "缺少 text 参数"}), 400

        voice_name = body.get("voice", "xiaoxiao")

        from voice_engine import VoiceEngine, VOICES
        if voice_name not in VOICES:
            voice_name = "xiaoxiao"

        # M-12 修复：复用全局单例，避免每次请求重复初始化 TTS 引擎
        global _voice_engine_singleton
        if _voice_engine_singleton is None:
            _voice_engine_singleton = VoiceEngine()
        ve = _voice_engine_singleton
        if not ve.initialize():
            return jsonify({"error": "TTS 引擎初始化失败"}), 500

        if voice_name != ve.config.voice:
            ve.set_voice(voice_name)

        import tempfile
        tts_temp_dir = Path(tempfile.gettempdir()) / "xuanshu_tts"
        tts_temp_dir.mkdir(parents=True, exist_ok=True)
        output_path = str(tts_temp_dir / f"api_tts_{int(time.time()*1000)}.wav")

        if ve._tts and ve._tts.synthesize_to_file(text.strip(), output_path):
            from flask import send_file
            response = send_file(output_path, mimetype="audio/wav",
                                 as_attachment=True,
                                 download_name="tts_output.wav")
            # M-14 修复：响应发送完成后清理临时 WAV 文件，防止泄漏
            @response.call_on_close
            def cleanup_tts_file():
                try:
                    if os.path.exists(output_path):
                        os.unlink(output_path)
                except OSError:
                    pass
            return response
        else:
            return jsonify({"error": "语音合成失败"}), 500
    except ImportError as e:
        return jsonify({"error": "voice_engine 模块不可用", "message": str(e)}), 503
    except Exception as e:
        logger.error(f"TTS 失败: {e}")
        return jsonify({"error": "tts_failed", "message": str(e)}), 500

# ============================================================================
# Embeddings 端点 — 文本向量化
# ============================================================================
_emb_model = None
_emb_lock = threading.Lock()
EMB_MODEL_PATH = (
    _config.get("embedding_model_path")
    or str(ENGINE_DIR / "resources" / "models" / "向量检索-nomic-embed.gguf")
)

def _init_emb_model():
    global _emb_model
    if _emb_model is not None:
        return True
    with _emb_lock:
        if _emb_model is not None:
            return True
        if not os.path.exists(EMB_MODEL_PATH):
            logger.error(f"Embedding 模型不存在: {EMB_MODEL_PATH}")
            return False
        try:
            from llama_cpp import Llama
            logger.info(f"加载 Embedding 模型 (CPU): {EMB_MODEL_PATH}")
            _emb_model = Llama(
                model_path=EMB_MODEL_PATH,
                embedding=True,
                n_ctx=512,
                n_gpu_layers=0,
                verbose=False,
            )
            return True
        except Exception as e:
            logger.error(f"Embedding 模型加载失败: {e}")
            return False

@app.route("/embeddings", methods=["POST"])
def embeddings():
    """文本向量化端点

    请求示例:
        {"input": "你好世界", "mode": "local"}

    响应示例:
        {"data": [{"embedding": [0.1, -0.2, ...], "index": 0}], "model": "nomic-embed"}
    """
    try:
        body = request.get_json(force=True)
        text = body.get("input", "")
        if not text:
            return jsonify({"error": "缺少 input 参数"}), 400

        if isinstance(text, list):
            texts = text
        else:
            texts = [text]

        if not _init_emb_model():
            return jsonify({"error": "embedding_model_unavailable",
                            "message": f"模型文件缺失: {EMB_MODEL_PATH}"}), 503

        embeddings = []
        for i, t in enumerate(texts):
            result = _emb_model.embed(t)
            if isinstance(result, list) and len(result) > 0 and isinstance(result[0], list):
                emb = result[0]
            elif isinstance(result, list):
                emb = result
            else:
                emb = result
            embeddings.append({
                "embedding": emb,
                "index": i,
            })

        return jsonify({
            "data": embeddings,
            "model": "nomic-embed-text-v1.5",
            "usage": {"total_tokens": sum(len(t) for t in texts)},
        })
    except Exception as e:
        logger.error(f"Embedding 失败: {e}")
        return jsonify({"error": "embedding_failed", "message": str(e)}), 500

# ============================================================================
# VL 状态端点
# ============================================================================
@app.route("/vl/status", methods=["GET"])
def get_vl_status():
    """返回 VL 视觉引擎状态"""
    return jsonify(vl_status())

# ============================================================================
# 微信消息接入
# ============================================================================
@app.route("/wechat", methods=["GET", "POST"])
def wechat_entry():
    """微信公众号消息入口

    GET:  服务器验证（签名校验）
    POST: 接收用户消息 → AI 推理 → 回复
    """
    config_path = Path(__file__).resolve().parent / "config.json"
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        cfg = {}

    token = cfg.get("wechat_token", "")
    appid = cfg.get("wechat_appid", "")
    secret = cfg.get("wechat_appsecret", "")
    relay_enabled = cfg.get("wechat_relay_enabled", False)

    if not relay_enabled and request.method == "POST":
        return "微信接入未启用", 403

    # --- GET: 服务器验证 ---
    if request.method == "GET":
        import hashlib
        signature = request.args.get("signature", "")
        timestamp = request.args.get("timestamp", "")
        nonce = request.args.get("nonce", "")
        echostr = request.args.get("echostr", "")

        if not all([signature, timestamp, nonce, echostr]):
            return "invalid request", 400

        # 字典序排序 → SHA1
        tmp = sorted([token, timestamp, nonce])
        tmp_str = "".join(tmp)
        sha1 = hashlib.sha1(tmp_str.encode()).hexdigest()

        if sha1 == signature:
            return echostr, 200, {"Content-Type": "text/plain"}
        else:
            logger.warning("微信签名验证失败")
            return "signature mismatch", 403

    # --- POST: 接收消息 ---
    try:
        from wechat_bridge import WechatBridge
    except ImportError:
        logger.error("wechat_bridge 模块未找到")
        return "success", 200  # 返回 success 避免微信重试

    xml_data = request.data
    bridge = WechatBridge()
    msg = bridge.receive_message(xml_data)

    if msg is None:
        return "success", 200

    user_content = msg["content"]
    from_user = msg["from_user"]
    to_user = msg["to_user"]

    logger.info(f"微信消息: [{from_user}] {user_content[:80]}")

    # AI 推理
    try:
        if USE_LLAMA_SERVER:
            reply = local_chat(
                [{"role": "user", "content": user_content}],
                max_tokens=1024,
                temperature=0.7,
                top_p=0.9,
                stream=False,
            )
        else:
            reply = _speculative_generate(
                [{"role": "user", "content": user_content}],
                max_tokens=1024,
                temperature=0.7,
                top_p=0.9,
                top_k=40,
                repetition_penalty=1.1,
            )
    except Exception as e:
        logger.error(f"微信 AI 推理失败: {e}")
        reply = "抱歉，AI 服务暂时不可用，请稍后再试。"

    # 构建被动回复
    reply_xml = bridge.build_reply(to_user=from_user, from_user=to_user, content=reply)
    logger.info(f"微信回复: {reply[:80]}...")

    return reply_xml, 200, {"Content-Type": "application/xml; charset=utf-8"}

@app.route("/config/inference", methods=["POST"])
def update_inference_config():
    """保存推理参数到 config.json"""
    try:
        body = request.get_json(force=True)
        config_path = Path(__file__).resolve().parent / "config.json"
        existing = {}
        if config_path.exists():
            with open(config_path, "r", encoding="utf-8") as f:
                existing = json.load(f)
        # 仅更新推理相关字段
        infer_keys = [
            "inference_version", "k_cache_quant", "v_cache_quant",
            "max_tokens", "temperature", "top_p", "top_k",
            "repetition_penalty", "min_p", "frequency_penalty",
            "presence_penalty", "seed", "concurrency", "batch_size",
            "micro_batch", "gpu_layers", "threads", "batch_threads",
        ]
        for k in infer_keys:
            if k in body:
                existing[k] = body[k]
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(existing, f, indent=2, ensure_ascii=False)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400

# ============================================================================
# 启动与优雅关闭
# ============================================================================
def _print_system_info():
    """启动时打印系统资源信息"""
    gpu = _get_gpu_info()
    mem = _get_memory_info()
    cpu = _get_cpu_info()

    model_file = Path(MODEL_9B_PATH).name if MODEL_9B_PATH else "(未配置)"
    model_exists = os.path.exists(MODEL_9B_PATH) if MODEL_9B_PATH else False

    print("\n" + "=" * 56)
    print("  玄枢 AI Engine v11.2.0 — 动态模型推理引擎")
    print("=" * 56)
    print(f"  GPU:       {gpu['name']} ({gpu['memory_total_mb']} MB)")
    print(f"  显存可用:   {gpu['memory_free_mb']} MB")
    print(f"  系统内存:   {mem['total_gb']} GB (可用 {mem['free_gb']} GB)")
    print(f"  CPU 核心:   {cpu['count']}")
    print("-" * 56)
    print(f"  主模型:     {model_file}")
    print(f"             {'已就绪' if model_exists else '未配置（请通过 UI 模型页接入）'}")
    if MODEL_7B_MMPROJ:
        print(f"  mmproj:     {Path(MODEL_7B_MMPROJ).name}")
    print("=" * 56)

def _signal_handler(sig, frame):
    """SIGINT 处理：卸载模型再退出"""
    logger.info("收到 SIGINT，正在优雅关闭...")
    _unload_models()
    sys.exit(0)

if __name__ == "__main__":
    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    _print_system_info()

    # 尝试加载模型
    logger.info("正在加载推理模型...")
    draft_ok = _load_draft_model()
    verify_ok = _load_verify_model()

    if not draft_ok and not verify_ok:
        logger.warning("没有模型加载成功，API 将以模拟模式运行")

    # 预加载人格和插件
    _load_personas()
    _load_plugins()

    print("\n  API Server 启动: http://localhost:8765")
    print("  按 Ctrl+C 停止服务\n")

    try:
        app.run(host="127.0.0.1", port=8765, debug=False, threaded=True)
    except KeyboardInterrupt:
        logger.info("收到键盘中断信号")
    except Exception as e:
        logger.error(f"API 服务异常退出: {e}\n{traceback.format_exc()}")
    finally:
        _unload_models()
        logger.info("服务已停止")
