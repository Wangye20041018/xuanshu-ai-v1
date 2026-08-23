#!/usr/bin/env python3
"""文本处理外挂 — 正则替换/格式转换/编码转换"""

import re
import json
import hashlib
import base64
from typing import Dict, Any


def execute(user_msg: str, **kwargs) -> Dict[str, Any]:
    action = kwargs.get("action", "count")
    text = kwargs.get("text", "")
    pattern = kwargs.get("pattern", "")
    replacement = kwargs.get("replacement", "")

    try:
        if action == "regex_replace":
            return _regex_replace(text, pattern, replacement)
        elif action == "json_format":
            return _json_format(text)
        elif action == "csv_parse":
            return _csv_parse(text)
        elif action == "base64":
            return _base64_encode(text)
        elif action == "md5":
            return _md5_hash(text)
        elif action == "count":
            return _count_text(text)
        else:
            return {"success": False, "error": f"未知操作: {action}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _regex_replace(text: str, pattern: str, replacement: str) -> Dict:
    try:
        result = re.sub(pattern, replacement, text)
        return {"success": True, "result": result, "matches": len(re.findall(pattern, text))}
    except re.error as e:
        return {"success": False, "error": f"正则错误: {e}"}


def _json_format(text: str) -> Dict:
    try:
        parsed = json.loads(text)
        return {"success": True, "result": json.dumps(parsed, ensure_ascii=False, indent=2), "parsed": True}
    except json.JSONDecodeError as e:
        return {"success": False, "error": f"JSON解析错误: {e}"}


def _csv_parse(text: str) -> Dict:
    import csv
    import io
    try:
        reader = csv.reader(io.StringIO(text))
        rows = list(reader)
        return {"success": True, "rows": rows[:100], "total_rows": len(rows)}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _base64_encode(text: str) -> Dict:
    encoded = base64.b64encode(text.encode()).decode()
    return {"success": True, "result": encoded}


def _md5_hash(text: str) -> Dict:
    return {"success": True, "result": hashlib.md5(text.encode()).hexdigest()}


def _count_text(text: str) -> Dict:
    lines = text.split("\n")
    words = text.split()
    return {
        "success": True,
        "chars": len(text),
        "chars_no_space": len(text.replace(" ", "").replace("\n", "")),
        "words": len(words),
        "lines": len(lines),
        "bytes": len(text.encode("utf-8"))
    }
