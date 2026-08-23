#!/usr/bin/env python3
"""剪贴板外挂 — 读取/写入/历史记录"""

import subprocess
import sys
from typing import Dict, Any

_clipboard_history = []


def execute(user_msg: str, **kwargs) -> Dict[str, Any]:
    action = kwargs.get("action", "read")
    text = kwargs.get("text", "")

    try:
        if action == "read":
            return _read_clipboard()
        elif action == "write":
            return _write_clipboard(text)
        elif action == "clear":
            return _clear_clipboard()
        elif action == "history":
            return _get_history()
        else:
            return {"success": False, "error": f"未知操作: {action}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _read_clipboard() -> Dict:
    try:
        result = subprocess.run(
            ["powershell", "-Command", "Get-Clipboard"],
            capture_output=True, text=True, timeout=5
        )
        content = result.stdout.strip()
        if content:
            _clipboard_history.append(content)
            if len(_clipboard_history) > 50:
                _clipboard_history.pop(0)
        return {"success": True, "content": content, "length": len(content)}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _write_clipboard(text: str) -> Dict:
    if not text:
        return {"success": False, "error": "text 不能为空"}
    try:
        process = subprocess.Popen(
            ["powershell", "-Command", "$input | Set-Clipboard"],
            stdin=subprocess.PIPE
        )
        process.communicate(input=text.encode("utf-8"), timeout=5)
        return {"success": True, "written": len(text)}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _clear_clipboard() -> Dict:
    try:
        subprocess.run(
            ["powershell", "-Command", "Set-Clipboard -Value ''"],
            capture_output=True, timeout=5
        )
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _get_history() -> Dict:
    return {
        "success": True,
        "history": _clipboard_history[-20:],
        "count": len(_clipboard_history)
    }
