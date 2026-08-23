"""Plugin: Performance Profiler (perf_profiler) — Level: Heavy"""
import subprocess, os, sys, time, json, tempfile

def run(action: str, target: str = "", duration: int = 10) -> dict:
    if not target:
        return {"success": False, "error": "Target (script path or PID) required"}
    try:
        if action == "python_profile":
            return _python_profile(target, duration)
        elif action == "memory_profile":
            return _memory_profile(target, duration)
        elif action == "cpu_usage":
            return _cpu_usage(target, duration)
        elif action == "flamegraph":
            return _flamegraph(target, duration)
        return {"success": False, "error": f"Unknown action: {action}"}
    except Exception as e:
        return {"success": False, "error": str(e)}

def _python_profile(script: str, duration: int) -> dict:
    if not os.path.exists(script):
        return {"success": False, "error": "Script not found"}
    tmpfile = tempfile.mktemp(suffix=".prof")
    try:
        cmd = [sys.executable, "-m", "cProfile", "-o", tmpfile, script]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=duration + 30)
        # Parse stats
        import pstats
        stats = pstats.Stats(tmpfile)
        stats.sort_stats("cumulative")
        top = []
        for func, (cc, nc, tt, ct, callers) in list(stats.stats.items())[:20]:
            top.append({"function": f"{func[2]}:{func[0]}({func[1]})", "calls": cc + nc, "total_time": f"{tt:.3f}s", "cumulative_time": f"{ct:.3f}s"})
        return {"success": True, "top_functions": top, "total_functions": len(stats.stats)}
    finally:
        if os.path.exists(tmpfile): os.remove(tmpfile)

def _memory_profile(script: str, duration: int) -> dict:
    try:
        import psutil
        proc = subprocess.Popen([sys.executable, script], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        p = psutil.Process(proc.pid)
        samples = []
        for _ in range(duration):
            try:
                samples.append({"time": len(samples), "rss_mb": round(p.memory_info().rss / 1e6, 1)})
            except: break
            time.sleep(1)
        proc.kill()
        if samples:
            return {"success": True, "peak_mb": max(s["rss_mb"] for s in samples),
                    "avg_mb": round(sum(s["rss_mb"] for s in samples) / len(samples), 1), "samples": samples}
        return {"success": False, "error": "No samples collected"}
    except ImportError:
        return {"success": False, "error": "psutil required: pip install psutil"}

def _cpu_usage(target: str, duration: int) -> dict:
    try:
        import psutil
        if target.isdigit():
            p = psutil.Process(int(target))
            samples = [p.cpu_percent(interval=1) for _ in range(min(duration, 30))]
            return {"success": True, "pid": int(target), "name": p.name(),
                    "avg_cpu": round(sum(samples) / len(samples), 1), "peak_cpu": max(samples)}
        else:
            proc = subprocess.Popen([sys.executable, target], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            p = psutil.Process(proc.pid)
            time.sleep(1)
            samples = [p.cpu_percent(interval=1) for _ in range(min(duration, 30))]
            proc.kill()
            return {"success": True, "avg_cpu": round(sum(samples) / len(samples), 1), "peak_cpu": max(samples)}
    except ImportError:
        return {"success": False, "error": "psutil required: pip install psutil"}

def _flamegraph(target: str, duration: int) -> dict:
    return {"success": False, "error": "Flamegraph generation requires perf (Linux) or py-spy. Install: pip install py-spy"}
