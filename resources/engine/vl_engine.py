"""
玄枢 AI Engine v3.1 — VL 视觉理解引擎
=====================================
使用 Qwen2-VL-2B (Q4_K_M) + mmproj，通过 llama-cpp-python 在 CPU 上运行。
作为 /chat 端点中图片请求的独立处理路径。

架构：检测到 image_url → 路由到本模块 → CPU 推理 → 返回文本
"""
import os
import sys
import json
import base64
import time
import tempfile
import logging
import threading
from pathlib import Path
from typing import Optional

logger = logging.getLogger("xuanshu-vl")

# ============================================================================
# 模型路径（从 config.json 读取，硬编码回退）
# ============================================================================
VL_MODEL_PATH = str(Path(__file__).resolve().parent / "resources" / "models" / "Qwen2-VL-2B-Instruct-Q4_K_M.gguf")
VL_MMPROJ_PATH = str(Path(__file__).resolve().parent / "resources" / "models" / "mmproj-Qwen2-VL-2B-Instruct-f16.gguf")

def _load_config_paths():
    config_path = Path(__file__).resolve().parent / "config.json"
    if config_path.exists():
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            return {
                "vision_model_path": cfg.get("vision_model_path", ""),
                "mmproj_path": cfg.get("mmproj_path", ""),
            }
        except Exception:
            pass
    return {}

_cfg = _load_config_paths()
if _cfg.get("vision_model_path"):
    VL_MODEL_PATH = _cfg["vision_model_path"]
if _cfg.get("mmproj_path"):
    VL_MMPROJ_PATH = _cfg["mmproj_path"]

# ============================================================================
# VL 模型实例（线程安全懒加载）
# ============================================================================
_vl_llm = None
_vl_lock = threading.Lock()
VL_AVAILABLE = False

def _init_vl_model() -> bool:
    """初始化 2B VL 模型（CPU）"""
    global _vl_llm, VL_AVAILABLE

    if _vl_llm is not None:
        return True

    with _vl_lock:
        if _vl_llm is not None:
            return True

        if not os.path.exists(VL_MODEL_PATH):
            logger.error(f"VL 模型不存在: {VL_MODEL_PATH}")
            return False
        if not os.path.exists(VL_MMPROJ_PATH):
            logger.error(f"mmproj 不存在: {VL_MMPROJ_PATH}")
            return False

        try:
            from llama_cpp import Llama
            logger.info(f"加载 VL 模型 (CPU): {VL_MODEL_PATH}")
            _vl_llm = Llama(
                model_path=VL_MODEL_PATH,
                mmproj=VL_MMPROJ_PATH,
                n_ctx=4096,
                n_gpu_layers=0,   # 纯 CPU
                verbose=False,
            )
            VL_AVAILABLE = True
            logger.info("VL 模型加载完成 (Qwen2-VL-2B, CPU)")
            return True
        except ImportError:
            logger.error("llama-cpp-python 未安装，VL 不可用")
            return False
        except Exception as e:
            logger.error(f"VL 模型加载失败: {e}")
            return False


def _has_image(messages: list) -> bool:
    """检测消息列表中是否包含图片"""
    for msg in messages:
        content = msg.get("content", "")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    return True
        elif isinstance(content, str) and ("data:image" in content or content.startswith("http")):
            # 纯文本中的图片标记
            pass
    return False


def _extract_images_and_save(messages: list) -> list:
    """提取消息中的 base64 图片并保存为临时文件，返回处理后的消息列表"""
    temp_dir = Path(tempfile.gettempdir()) / "xuanshu_vl"
    temp_dir.mkdir(exist_ok=True)
    processed = []

    for msg in messages:
        content = msg.get("content", "")
        role = msg.get("role", "user")

        if isinstance(content, list):
            new_content = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    image_url = part.get("image_url", {}).get("url", "")
                    if image_url.startswith("data:image"):
                        # Base64 图片 → 保存为临时文件
                        header, b64_data = image_url.split(",", 1)
                        ext = "png"
                        if "jpeg" in header or "jpg" in header:
                            ext = "jpg"
                        elif "webp" in header:
                            ext = "webp"

                        fname = f"vl_{int(time.time()*1000)}_{hash(b64_data[:20])%10000:04d}.{ext}"
                        fpath = temp_dir / fname
                        with open(fpath, "wb") as f:
                            f.write(base64.b64decode(b64_data))
                        new_content.append({
                            "type": "image_url",
                            "image_url": {"url": f"file:///{fpath.as_posix()}"}
                        })
                    elif image_url.startswith("http") or image_url.startswith("file://"):
                        new_content.append(part)
                else:
                    new_content.append(part)
            processed.append({"role": role, "content": new_content})
        else:
            processed.append(msg)

    return processed


def vl_chat(messages: list, max_tokens: int = 512) -> str:
    """VL 视觉对话

    Args:
        messages: OpenAI 格式消息列表，含 image_url
        max_tokens: 最大输出 token 数

    Returns:
        str: 模型回复文本
    """
    if not _has_image(messages):
        return "[VL] 消息中未检测到图片"

    if not _init_vl_model():
        return "[VL] 模型未加载，请检查 Qwen2-VL-2B 模型文件"

    try:
        processed = _extract_images_and_save(messages)
        result = _vl_llm.create_chat_completion(
            messages=processed,
            max_tokens=max_tokens,
            temperature=0.1,
            top_p=0.9,
            stop=["</s>", "<|im_end|>", "<|endoftext|>"],
        )
        content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        return content.strip() if content else "[VL] 模型未返回内容"
    except Exception as e:
        logger.error(f"VL 推理失败: {e}")
        return f"[VL] 推理失败: {e}"


def vl_status() -> dict:
    """返回 VL 引擎状态"""
    return {
        "available": VL_AVAILABLE,
        "model_path": VL_MODEL_PATH,
        "mmproj_path": VL_MMPROJ_PATH,
        "model_exists": os.path.exists(VL_MODEL_PATH),
        "mmproj_exists": os.path.exists(VL_MMPROJ_PATH),
    }
