#!/usr/bin/env python3
"""快捷启动外挂 — 启动软件/打开文件夹/执行命令"""

import subprocess
import os
import sys
from typing import Dict, Any


def execute(user_msg: str, **kwargs) -> Dict[str, Any]:
    action = kwargs.get("action", "launch")
    target = kwargs.get("target", "")

    if not target:
        return {"success": False, "error": "target 不能为空"}

    try:
        if action == "launch":
            return _launch(target)
        elif action == "open_folder":
            return _open_folder(target)
        elif action == "run_cmd":
            return _run_cmd(target)
        else:
            return {"success": False, "error": f"未知操作: {action}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _launch(target: str) -> Dict:
    """启动软件（支持软件名或完整路径）"""
    # 如果是完整路径
    if os.path.exists(target):
        try:
            subprocess.Popen([target], shell=True)
            return {"success": True, "launched": target}
        except Exception as e:
            return {"success": False, "error": str(e)}

    # 尝试用系统命令打开
    try:
        subprocess.Popen(["start", target], shell=True)
        return {"success": True, "launched": target}
    except Exception as e:
        return {"success": False, "error": f"无法启动 {target}: {e}"}


def _open_folder(path: str) -> Dict:
    """打开文件夹"""
    if not os.path.exists(path):
        return {"success": False, "error": f"路径不存在: {path}"}
    try:
        subprocess.Popen(["explorer", path])
        return {"success": True, "opened": path}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _run_cmd(cmd: str) -> Dict:
    """执行系统命令"""
    try:
        result = subprocess.run(
            cmd, shell=True,
            capture_output=True, text=True, timeout=30
        )
        return {
            "success": True,
            "returncode": result.returncode,
            "stdout": result.stdout[:2000],
            "stderr": result.stderr[:2000]
        }
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "命令执行超时（30秒）"}
    except Exception as e:
        return {"success": False, "error": str(e)}
