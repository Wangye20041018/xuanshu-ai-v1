#!/usr/bin/env python3
"""性能剖析外挂 — 代码profiling/内存分析"""

import os
import sys
from typing import Dict, Any


def execute(user_msg: str, **kwargs) -> Dict[str, Any]:
    action = kwargs.get("action", "profile_script")
    script_path = kwargs.get("script_path", "")
    duration = kwargs.get("duration", 10)

    try:
        if action == "profile_script":
            return _profile_script(script_path)
        elif action == "memory_snapshot":
            return _memory_snapshot()
        elif action == "analyze_log":
            return _analyze_log(script_path)
        else:
            return {"success": False, "error": f"未知操作: {action}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _profile_script(path: str) -> Dict:
    """使用 cProfile 分析脚本"""
    if not path or not os.path.exists(path):
        return {"success": False, "error": f"脚本不存在: {path}"}

    try:
        import cProfile
        import pstats
        import io
        import subprocess

        profiler = cProfile.Profile()
        profiler.enable()

        # 运行目标脚本
        try:
            exec(open(path, encoding="utf-8").read(), {"__name__": "__main__"})
        except Exception as e:
            profiler.disable()
            return {"success": False, "error": f"脚本执行出错: {e}"}

        profiler.disable()
        stream = io.StringIO()
        stats = pstats.Stats(profiler, stream=stream)
        stats.sort_stats("cumulative")
        stats.print_stats(30)

        return {
            "success": True,
            "profile": stream.getvalue(),
            "total_calls": stats.total_calls,
            "total_time": stats.total_tt
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def _memory_snapshot() -> Dict:
    """当前Python进程内存快照"""
    try:
        import psutil
        import tracemalloc

        # 系统内存
        mem = psutil.virtual_memory()
        proc = psutil.Process()

        # Python内存（如果启用了tracemalloc）
        py_mem = {}
        if tracemalloc.is_tracing():
            snapshot = tracemalloc.take_snapshot()
            top = snapshot.statistics("lineno")[:10]
            py_mem = {
                "top_allocations": [
                    {"file": str(s.traceback[-1].filename) if s.traceback else "unknown",
                     "line": s.traceback[-1].lineno if s.traceback else 0,
                     "size_mb": round(s.size / (1024**2), 2),
                     "count": s.count}
                    for s in top
                ]
            }
        else:
            py_mem = {"note": "tracemalloc 未启用，调用 tracemalloc.start() 以追踪"}

        return {
            "success": True,
            "system": {
                "total_gb": round(mem.total / (1024**3), 1),
                "available_gb": round(mem.available / (1024**3), 1),
                "percent": mem.percent
            },
            "process": {
                "rss_mb": round(proc.memory_info().rss / (1024**2), 1),
                "vms_mb": round(proc.memory_info().vms / (1024**2), 1),
                "cpu_percent": proc.cpu_percent()
            },
            "python": py_mem
        }
    except ImportError:
        return {"success": False, "error": "psutil 未安装"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _analyze_log(path: str) -> Dict:
    """分析日志文件"""
    if not path or not os.path.exists(path):
        return {"success": False, "error": f"日志文件不存在: {path}"}

    try:
        with open(path, encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()

        error_lines = [l.strip() for l in lines if "error" in l.lower() or "exception" in l.lower()]
        warn_lines = [l.strip() for l in lines if "warn" in l.lower()]

        # 统计时间分布
        import re
        time_pattern = re.compile(r"(\d{2}:\d{2}:\d{2})")
        time_counts = {}
        for line in lines:
            match = time_pattern.search(line)
            if match:
                hour = match.group(1)[:2]
                time_counts[hour] = time_counts.get(hour, 0) + 1

        return {
            "success": True,
            "stats": {
                "total_lines": len(lines),
                "errors": len(error_lines),
                "warnings": len(warn_lines),
                "time_distribution": dict(sorted(time_counts.items()))
            },
            "sample_errors": error_lines[:10],
            "sample_warnings": warn_lines[:10]
        }
    except Exception as e:
        return {"success": False, "error": str(e)}
