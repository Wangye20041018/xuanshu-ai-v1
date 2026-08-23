#!/usr/bin/env python3
"""系统监控外挂 — CPU/GPU/内存/磁盘/网络"""

import time
from typing import Dict, Any

try:
    import psutil
except ImportError:
    psutil = None


def execute(user_msg: str, **kwargs) -> Dict[str, Any]:
    target = kwargs.get("target", "all")
    try:
        if target == "cpu":
            return _cpu_info()
        elif target == "memory":
            return _memory_info()
        elif target == "disk":
            return _disk_info()
        elif target == "network":
            return _network_info()
        elif target == "gpu":
            return _gpu_info()
        elif target == "all":
            return {
                "success": True,
                "cpu": _cpu_info().get("cpu"),
                "memory": _memory_info().get("memory"),
                "disk": _disk_info().get("disk"),
                "network": _network_info().get("network"),
                "gpu": _gpu_info().get("gpu")
            }
        else:
            return {"success": False, "error": f"未知目标: {target}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _cpu_info() -> Dict:
    if not psutil:
        return {"success": False, "error": "psutil not installed"}
    cpu = {
        "percent": psutil.cpu_percent(interval=0.5),
        "count": psutil.cpu_count(logical=True),
        "physical": psutil.cpu_count(logical=False),
        "freq": psutil.cpu_freq()._asdict() if psutil.cpu_freq() else None
    }
    return {"success": True, "cpu": cpu}


def _memory_info() -> Dict:
    if not psutil:
        return {"success": False, "error": "psutil not installed"}
    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    return {
        "success": True,
        "memory": {
            "total_gb": round(mem.total / (1024**3), 1),
            "available_gb": round(mem.available / (1024**3), 1),
            "used_gb": round(mem.used / (1024**3), 1),
            "percent": mem.percent,
            "swap_total_gb": round(swap.total / (1024**3), 1),
            "swap_used_gb": round(swap.used / (1024**3), 1)
        }
    }


def _disk_info() -> Dict:
    if not psutil:
        return {"success": False, "error": "psutil not installed"}
    partitions = []
    for p in psutil.disk_partitions():
        try:
            usage = psutil.disk_usage(p.mountpoint)
            partitions.append({
                "device": p.device,
                "mountpoint": p.mountpoint,
                "fstype": p.fstype,
                "total_gb": round(usage.total / (1024**3), 1),
                "used_gb": round(usage.used / (1024**3), 1),
                "free_gb": round(usage.free / (1024**3), 1),
                "percent": round(usage.used / usage.total * 100, 1)
            })
        except Exception:
            pass
    return {"success": True, "disk": {"partitions": partitions}}


def _network_info() -> Dict:
    if not psutil:
        return {"success": False, "error": "psutil not installed"}
    net = psutil.net_io_counters()
    return {
        "success": True,
        "network": {
            "bytes_sent_mb": round(net.bytes_sent / (1024**2), 1),
            "bytes_recv_mb": round(net.bytes_recv / (1024**2), 1),
            "packets_sent": net.packets_sent,
            "packets_recv": net.packets_recv
        }
    }


def _gpu_info() -> Dict:
    try:
        import subprocess
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            parts = result.stdout.strip().split(",")
            return {
                "success": True,
                "gpu": {
                    "name": parts[0].strip(),
                    "utilization": int(parts[1].strip()),
                    "memory_used_mb": int(parts[2].strip()),
                    "memory_total_mb": int(parts[3].strip()),
                    "temperature": int(parts[4].strip())
                }
            }
    except Exception:
        pass
    return {"success": True, "gpu": {"status": "unavailable"}}
