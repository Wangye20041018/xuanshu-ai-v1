#!/usr/bin/env python3
"""进程管理外挂 — 列出/搜索/强杀/优先级调整"""

from typing import Dict, Any

try:
    import psutil
except ImportError:
    psutil = None


def execute(user_msg: str, **kwargs) -> Dict[str, Any]:
    action = kwargs.get("action", "list")
    name = kwargs.get("name", "")
    pid = kwargs.get("pid")

    try:
        if action == "list":
            return _list_processes()
        elif action == "search":
            return _search_processes(name)
        elif action == "kill":
            return _kill_process(pid=pid, name=name)
        elif action == "priority":
            return {"success": False, "error": "优先级调整暂未实现"}
        else:
            return {"success": False, "error": f"未知操作: {action}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _list_processes(limit: int = 20) -> Dict:
    if not psutil:
        return {"success": False, "error": "psutil not installed"}
    procs = []
    for p in sorted(
        psutil.process_iter(["pid", "name", "cpu_percent", "memory_info"]),
        key=lambda x: x.info["memory_info"].rss if x.info["memory_info"] else 0,
        reverse=True
    )[:limit]:
        try:
            procs.append({
                "pid": p.info["pid"],
                "name": p.info["name"],
                "cpu": p.info["cpu_percent"],
                "memory_mb": round(p.info["memory_info"].rss / (1024**2), 1)
            })
        except Exception:
            pass
    return {"success": True, "processes": procs, "count": len(procs)}


def _search_processes(keyword: str) -> Dict:
    if not psutil:
        return {"success": False, "error": "psutil not installed"}
    if not keyword:
        return {"success": False, "error": "搜索关键词不能为空"}
    procs = []
    for p in psutil.process_iter(["pid", "name", "memory_info"]):
        try:
            if keyword.lower() in (p.info["name"] or "").lower():
                procs.append({
                    "pid": p.info["pid"],
                    "name": p.info["name"],
                    "memory_mb": round(p.info["memory_info"].rss / (1024**2), 1)
                })
        except Exception:
            pass
    return {"success": True, "processes": procs, "count": len(procs)}


def _kill_process(pid: int = None, name: str = "") -> Dict:
    if not psutil:
        return {"success": False, "error": "psutil not installed"}
    if pid:
        try:
            p = psutil.Process(pid)
            p.terminate()
            return {"success": True, "killed": f"PID:{pid} ({p.name()})"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    elif name:
        killed = []
        for p in psutil.process_iter(["pid", "name"]):
            try:
                if name.lower() in (p.info["name"] or "").lower():
                    p.terminate()
                    killed.append(f"PID:{p.info['pid']} ({p.info['name']})")
            except Exception:
                pass
        return {"success": True, "killed": killed, "count": len(killed)}
    else:
        return {"success": False, "error": "需要指定 pid 或 name"}
