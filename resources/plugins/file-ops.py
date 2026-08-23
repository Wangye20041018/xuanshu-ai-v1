#!/usr/bin/env python3
"""文件管理外挂 — 搜索/移动/复制/删除/批量重命名"""

import os
import shutil
import fnmatch
from typing import Dict, Any, List
from datetime import datetime


def execute(user_msg: str, **kwargs) -> Dict[str, Any]:
    """执行文件操作"""
    action = kwargs.get("action", "list")
    source = kwargs.get("source", os.path.expanduser("~"))
    destination = kwargs.get("destination", "")
    pattern = kwargs.get("pattern", "*")
    recursive = kwargs.get("recursive", False)

    try:
        if action == "list":
            return _list_files(source, pattern, recursive)
        elif action == "search":
            return _search_files(source, pattern, recursive)
        elif action == "move":
            return _move_files(source, destination)
        elif action == "copy":
            return _copy_files(source, destination)
        elif action == "delete":
            return _delete_files(source)
        elif action == "rename":
            return _rename_files(source, destination)
        else:
            return {"success": False, "error": f"未知操作: {action}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _list_files(path: str, pattern: str, recursive: bool) -> Dict:
    files = []
    try:
        if recursive:
            for root, dirs, filenames in os.walk(path):
                for f in filenames:
                    if fnmatch.fnmatch(f, pattern):
                        fp = os.path.join(root, f)
                        files.append(_file_info(fp))
        else:
            for f in os.listdir(path):
                if fnmatch.fnmatch(f, pattern):
                    fp = os.path.join(path, f)
                    if os.path.isfile(fp):
                        files.append(_file_info(fp))
    except PermissionError:
        return {"success": False, "error": f"无权限访问: {path}"}

    return {"success": True, "files": files, "count": len(files)}


def _search_files(path: str, pattern: str, recursive: bool) -> Dict:
    return _list_files(path, f"*{pattern}*", recursive)


def _move_files(source: str, dest: str) -> Dict:
    if not os.path.exists(source):
        return {"success": False, "error": f"源不存在: {source}"}
    try:
        shutil.move(source, dest)
        return {"success": True, "source": source, "destination": dest}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _copy_files(source: str, dest: str) -> Dict:
    if not os.path.exists(source):
        return {"success": False, "error": f"源不存在: {source}"}
    try:
        if os.path.isdir(source):
            shutil.copytree(source, dest, dirs_exist_ok=True)
        else:
            shutil.copy2(source, dest)
        return {"success": True, "source": source, "destination": dest}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _delete_files(path: str) -> Dict:
    if not os.path.exists(path):
        return {"success": False, "error": f"文件不存在: {path}"}
    try:
        if os.path.isdir(path):
            shutil.rmtree(path)
        else:
            os.remove(path)
        return {"success": True, "deleted": path}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _rename_files(source: str, new_name: str) -> Dict:
    if not os.path.exists(source):
        return {"success": False, "error": f"源不存在: {source}"}
    dest = os.path.join(os.path.dirname(source), new_name)
    try:
        os.rename(source, dest)
        return {"success": True, "old": source, "new": dest}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _file_info(path: str) -> Dict:
    stat = os.stat(path)
    return {
        "name": os.path.basename(path),
        "path": path,
        "size": stat.st_size,
        "size_mb": round(stat.st_size / (1024 * 1024), 2),
        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
        "is_dir": os.path.isdir(path)
    }
