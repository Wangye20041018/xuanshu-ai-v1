"""Plugin: Process Manager (process_manager) — Level: Simple"""
import psutil

PRIO_MAP = {"low": psutil.IDLE_PRIORITY_CLASS, "below_normal": psutil.BELOW_NORMAL_PRIORITY_CLASS, "normal": psutil.NORMAL_PRIORITY_CLASS, "above_normal": psutil.ABOVE_NORMAL_PRIORITY_CLASS, "high": psutil.HIGH_PRIORITY_CLASS, "realtime": psutil.REALTIME_PRIORITY_CLASS}

def run(action: str, pid: int = 0, name: str = "", priority: str = "normal") -> dict:
    try:
        if action == "list":
            procs = []
            for p in psutil.process_iter(["pid","name","memory_info","cpu_percent"]):
                try:
                    procs.append({"pid": p.info["pid"], "name": p.info["name"], "mem_mb": round(p.info["memory_info"].rss / 1e6, 1), "cpu_pct": p.info["cpu_percent"]})
                except: pass
            procs.sort(key=lambda x: x["mem_mb"], reverse=True)
            return {"success": True, "count": len(procs), "processes": procs[:50]}
        elif action == "search":
            procs = [{"pid": p.pid, "name": p.name()} for p in psutil.process_iter() if name.lower() in (p.name() or "").lower()]
            return {"success": True, "matches": len(procs), "processes": procs[:30]}
        elif action == "kill":
            if not pid: return {"success": False, "error": "pid required"}
            p = psutil.Process(pid)
            p.terminate()
            return {"success": True, "killed": pid, "name": p.name()}
        elif action == "priority":
            if not pid: return {"success": False, "error": "pid required"}
            p = psutil.Process(pid)
            p.nice(PRIO_MAP.get(priority, psutil.NORMAL_PRIORITY_CLASS))
            return {"success": True, "pid": pid, "priority": priority}
        return {"success": False, "error": f"Unknown action: {action}"}
    except Exception as e:
        return {"success": False, "error": str(e)}
