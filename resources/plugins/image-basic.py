#!/usr/bin/env python3
"""图像基础外挂 — 裁剪/缩放/格式转换/压缩（PIL兜底 + 命令行优化）"""

import os
from typing import Dict, Any

try:
    from PIL import Image
except ImportError:
    Image = None


def execute(user_msg: str, **kwargs) -> Dict[str, Any]:
    action = kwargs.get("action", "info")
    input_path = kwargs.get("input_path", "")
    output_path = kwargs.get("output_path", "")
    width = kwargs.get("width")
    height = kwargs.get("height")
    quality = kwargs.get("quality", 85)

    if not input_path or not os.path.exists(input_path):
        return {"success": False, "error": f"文件不存在: {input_path}"}

    try:
        if action == "info":
            return _image_info(input_path)
        elif action == "resize":
            return _resize(input_path, output_path, width, height)
        elif action == "crop":
            return {"success": False, "error": "crop 需要额外参数 (x,y,w,h)"}
        elif action == "convert":
            return _convert(input_path, output_path)
        elif action == "compress":
            return _compress(input_path, output_path, quality)
        else:
            return {"success": False, "error": f"未知操作: {action}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _image_info(path: str) -> Dict:
    if Image:
        try:
            img = Image.open(path)
            return {
                "success": True,
                "info": {
                    "format": img.format,
                    "mode": img.mode,
                    "width": img.width,
                    "height": img.height,
                    "size_mb": round(os.path.getsize(path) / (1024**2), 2)
                }
            }
        except Exception:
            pass
    return {
        "success": True,
        "info": {
            "size_mb": round(os.path.getsize(path) / (1024**2), 2),
            "path": path
        }
    }


def _resize(input_path: str, output_path: str, width: int, height: int) -> Dict:
    if not Image:
        return {"success": False, "error": "PIL/Pillow not installed"}
    if not output_path:
        base, ext = os.path.splitext(input_path)
        output_path = f"{base}_resized{ext}"
    try:
        img = Image.open(input_path)
        img = img.resize((width, height), Image.LANCZOS)
        img.save(output_path)
        return {"success": True, "output": output_path, "size": f"{width}x{height}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _convert(input_path: str, output_path: str) -> Dict:
    if not output_path:
        return {"success": False, "error": "转换需要指定 output_path"}
    if Image:
        try:
            img = Image.open(input_path)
            img.save(output_path)
            return {"success": True, "output": output_path}
        except Exception as e:
            return {"success": False, "error": str(e)}
    return {"success": False, "error": "PIL/Pillow not installed"}


def _compress(input_path: str, output_path: str, quality: int) -> Dict:
    if not Image:
        return {"success": False, "error": "PIL/Pillow not installed"}
    if not output_path:
        base, ext = os.path.splitext(input_path)
        output_path = f"{base}_compressed{ext}"
    try:
        img = Image.open(input_path)
        img.save(output_path, quality=quality, optimize=True)
        return {"success": True, "output": output_path, "quality": quality}
    except Exception as e:
        return {"success": False, "error": str(e)}
