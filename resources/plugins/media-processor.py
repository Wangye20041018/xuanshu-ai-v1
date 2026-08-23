#!/usr/bin/env python3
"""媒体处理外挂 — ffmpeg 封装"""

import subprocess
import os
import json
import sys
from typing import Dict, Any

# 确定 ffmpeg/ffprobe 路径
_RESOURCES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_FFMPEG = os.path.join(_RESOURCES_DIR, "ffmpeg.exe")
_FFPROBE = os.path.join(_RESOURCES_DIR, "ffprobe.exe")

def _get_ffmpeg() -> str:
    """返回 ffmpeg.exe 路径，优先用 resources 下的"""
    if os.path.exists(_FFMPEG):
        return _FFMPEG
    return "ffmpeg"  # fallback to PATH

def _get_ffprobe() -> str:
    """返回 ffprobe.exe 路径"""
    if os.path.exists(_FFPROBE):
        return _FFPROBE
    return "ffprobe"


def execute(user_msg: str, **kwargs) -> Dict[str, Any]:
    action = kwargs.get("action", "info")
    input_path = kwargs.get("input_path", "")
    output_path = kwargs.get("output_path", "")
    start_time = kwargs.get("start_time", "")
    duration = kwargs.get("duration", "")
    fmt = kwargs.get("format", "")

    if not input_path or not os.path.exists(input_path):
        return {"success": False, "error": f"文件不存在: {input_path}"}

    # 检查 ffmpeg 是否可用
    if action != "info":
        if not _check_ffmpeg():
            return {"success": False, "error": "ffmpeg 未安装或不在 PATH 中"}

    try:
        if action == "info":
            return _media_info(input_path)
        elif action == "convert":
            return _convert(input_path, output_path, fmt)
        elif action == "trim":
            return _trim(input_path, output_path, start_time, duration)
        elif action == "extract_audio":
            return _extract_audio(input_path, output_path, fmt)
        elif action == "compress":
            return _compress(input_path, output_path)
        elif action == "concat":
            return {"success": False, "error": "concat 需要文件列表，暂未实现"}
        else:
            return {"success": False, "error": f"未知操作: {action}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _check_ffmpeg() -> bool:
    try:
        subprocess.run([_get_ffmpeg(), "-version"], capture_output=True, timeout=5)
        return True
    except Exception:
        return False


def _run_ffmpeg(args: list) -> Dict:
    try:
        result = subprocess.run(
            [_get_ffmpeg(), "-y", "-hide_banner"] + args,
            capture_output=True, text=True, timeout=300
        )
        return {
            "success": result.returncode == 0,
            "stderr": result.stderr[-500:] if result.stderr else "",
            "returncode": result.returncode
        }
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "ffmpeg 执行超时"}


def _media_info(path: str) -> Dict:
    """获取媒体信息（使用 ffprobe）"""
    try:
        result = subprocess.run(
            [_get_ffprobe(), "-v", "quiet", "-print_format", "json",
             "-show_format", "-show_streams", path],
            capture_output=True, text=True, timeout=15
        )
        if result.returncode == 0:
            info = json.loads(result.stdout)
            fmt = info.get("format", {})
            streams = info.get("streams", [])
            return {
                "success": True,
                "info": {
                    "format": fmt.get("format_name"),
                    "duration": fmt.get("duration", "unknown"),
                    "size_mb": round(float(fmt.get("size", 0)) / (1024**2), 2),
                    "streams": [
                        {
                            "type": s.get("codec_type"),
                            "codec": s.get("codec_name", "unknown")
                        }
                        for s in streams
                    ]
                }
            }
        return {"success": False, "error": "ffprobe 执行失败"}
    except FileNotFoundError:
        # 兜底：仅返回文件大小
        return {
            "success": True,
            "info": {
                "size_mb": round(os.path.getsize(path) / (1024**2), 2),
                "path": path
            }
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def _convert(input_path: str, output_path: str, fmt: str) -> Dict:
    if not output_path:
        base, _ = os.path.splitext(input_path)
        ext = fmt if fmt else "mp4"
        output_path = f"{base}_converted.{ext}"
    result = _run_ffmpeg(["-i", input_path, output_path])
    result["output"] = output_path
    return result


def _trim(input_path: str, output_path: str, start: str, duration: str) -> Dict:
    if not output_path:
        base, ext = os.path.splitext(input_path)
        output_path = f"{base}_trimmed{ext}"
    if not start or not duration:
        return {"success": False, "error": "start_time 和 duration 不能为空"}
    result = _run_ffmpeg([
        "-ss", start, "-i", input_path,
        "-t", duration, "-c", "copy", output_path
    ])
    result["output"] = output_path
    return result


def _extract_audio(input_path: str, output_path: str, fmt: str) -> Dict:
    if not output_path:
        base, _ = os.path.splitext(input_path)
        ext = fmt if fmt else "mp3"
        output_path = f"{base}_audio.{ext}"
    result = _run_ffmpeg([
        "-i", input_path, "-vn", "-acodec",
        "libmp3lame" if fmt == "mp3" else "copy", output_path
    ])
    result["output"] = output_path
    return result


def _compress(input_path: str, output_path: str) -> Dict:
    if not output_path:
        base, ext = os.path.splitext(input_path)
        output_path = f"{base}_compressed{ext}"
    result = _run_ffmpeg([
        "-i", input_path, "-vcodec", "libx264",
        "-crf", "28", "-preset", "fast", output_path
    ])
    result["output"] = output_path
    return result
