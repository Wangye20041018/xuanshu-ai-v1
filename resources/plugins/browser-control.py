#!/usr/bin/env python3
"""浏览器操控外挂 — 打开URL/搜索/截图"""

import subprocess
import sys
from typing import Dict, Any


def execute(user_msg: str, **kwargs) -> Dict[str, Any]:
    action = kwargs.get("action", "open")
    url = kwargs.get("url", "")
    query = kwargs.get("query", "")

    try:
        if action == "open":
            return _open_url(url)
        elif action == "search":
            return _search_web(query)
        elif action == "screenshot":
            return {"success": False, "error": "截图功能需要浏览器扩展支持"}
        else:
            return {"success": False, "error": f"未知操作: {action}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _open_url(url: str) -> Dict:
    if not url:
        return {"success": False, "error": "URL 不能为空"}
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    try:
        subprocess.run(["start", url], shell=True, check=True)
        return {"success": True, "url": url, "action": "opened in default browser"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _search_web(query: str) -> Dict:
    if not query:
        return {"success": False, "error": "搜索关键词不能为空"}
    import urllib.parse
    url = f"https://www.bing.com/search?q={urllib.parse.quote(query)}"
    return _open_url(url)
