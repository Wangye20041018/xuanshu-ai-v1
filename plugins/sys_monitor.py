"""
Plugin: System Monitor (sys_monitor)
Level: Simple
"""
import psutil
import os

def run(target: str = "all", format: str = "summary") -> dict:
    try:
        result = {}
        if target in ("cpu", "all"):
            result["cpu"] = {
                "percent": psutil.cpu_percent(interval=0.3),
                "count": os.cpu_count(),
                "freq_mhz": psutil.cpu_freq().current if psutil.cpu_freq() else "N/A",
            }
        if target in ("memory", "all"):
            mem = psutil.virtual_memory()
            result["memory"] = {
                "total_gb": round(mem.total / 1e9, 1),
                "used_gb": round(mem.used / 1e9, 1),
                "available_gb": round(mem.available / 1e9, 1),
                "percent": mem.percent,
            }
        if target in ("disk", "all"):
            disks = []
            for p in psutil.disk_partitions():
                try:
                    usage = psutil.disk_usage(p.mountpoint)
                    disks.append({"mount": p.mountpoint, "total_gb": round(usage.total / 1e9, 1), "used_gb": round(usage.used / 1e9, 1), "percent": usage.percent})
                except Exception:
                    pass
            result["disk"] = disks
        if target in ("network", "all"):
            net = psutil.net_io_counters()
            result["network"] = {"sent_mb": round(net.bytes_sent / 1e6, 1), "recv_mb": round(net.bytes_recv / 1e6, 1)}
        if target in ("gpu", "all"):
            try:
                import GPUtil
                gpus = GPUtil.getGPUs()
                result["gpu"] = [{"name": g.name, "load_pct": g.load * 100, "mem_used_mb": g.memoryUsed, "mem_total_mb": g.memoryTotal, "temp_c": g.temperature} for g in gpus]
            except ImportError:
                result["gpu"] = "GPUtil not installed"
        return {"success": True, "data": result}
    except Exception as e:
        return {"success": False, "error": str(e)}
