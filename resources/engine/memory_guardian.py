"""
玄枢 AI Engine — Memory Guardian
==================================
Manages system RAM for stable verification model (14B) operation.

Strategy:
  - Pre-clean: Before loading 14B model, scan all user processes and kill
    non-essential ones to free RAM (browsers, chat apps, media players, dev tools).
    WHITELIST: xuanshu itself, llama.cpp, explorer.exe, security software.

  - Runtime monitoring: Three waterline levels
      26 GB (🟢 SAFE)   — normal operation
      28 GB (🟡 WARN)   — notify user, prepare to free
      30 GB (🔴 KILL)   — force kill non-essential processes

  - Scheduled queue: Parse tasks, start software on demand, kill after use,
    start next task. Windows system ~3-4 GB is accounted for.

Hardware baseline: RTX 4060 6GB VRAM + 32GB RAM, Windows 11
"""

import os
import sys
import time
import json
import threading
from pathlib import Path
from typing import List, Dict, Optional, Tuple, Set

try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False

try:
    from loguru import logger
except ImportError:
    import logging
    logger = logging.getLogger("memory-guardian")


# ============================================================================
# Process Whitelist / Blacklist
# ============================================================================

# Processes that MUST NOT be killed
# BUG-011: llama-server / python / ollama 已显式加入白名单，防止推理进程被误杀
WHITELIST_NAMES: Set[str] = {
    # OS critical
    "explorer.exe", "dwm.exe", "csrss.exe", "winlogon.exe",
    "smss.exe", "services.exe", "lsass.exe", "svchost.exe",
    "taskhostw.exe", "wininit.exe", "spoolsv.exe",
    "system", "system idle process", "registry",
    # Security
    "msmpeng.exe", "securityhealthservice.exe",
    "securityhealthsystray.exe",
    # Xuanshu & ML
    "xuanshu", "llama.cpp", "llama-server", "python",
    "ollama", "ollama.exe",
    # Essential UI
    "shellexperiencehost.exe", "startmenuexperiencehost.exe",
    "taskmgr.exe", "sihost.exe", "ctfmon.exe",
    # Drivers / audio
    "audiodg.exe", "nvcontainer.exe", "nvdisplay.container.exe",
}

# Process name prefixes that are safe to kill (non-essential)
KILLABLE_PREFIXES: List[str] = [
    "chrome", "firefox", "msedge", "brave", "opera",    # browsers
    "wechat", "weixin", "wxwork",                        # chat
    "dingtalk", "feishu",                                # collaboration
    "telegram", "discord", "slack",                      # messaging
    "spotify", "qqmusic", "netease",                     # music
    "vlc", "potplayer", "mpc",                           # media players
    "code", "devenv", "idea", "pycharm",                 # IDEs (background)
    "notepad++", "sublime_text",                         # editors
    "obs64", "obs",                                      # streaming
    "steam", "epicgames",                                # game platforms
    "thunder", "baidunetdisk",                           # downloaders
    "onenote", "evernote",                               # notes
    "figma", "photoshop",                                # design tools (background)
]

# Known high-memory processes to target first
HIGH_MEMORY_TARGETS: List[Tuple[str, str]] = [
    ("chrome.exe", "Google Chrome"),
    ("msedge.exe", "Microsoft Edge"),
    ("firefox.exe", "Firefox"),
    ("Code.exe", "VS Code"),
    ("devenv.exe", "Visual Studio"),
    ("WeChat.exe", "微信"),
    ("WXWork.exe", "企业微信"),
]


# ============================================================================
# MemoryGuardian
# ============================================================================

class MemoryGuardian:
    """
    Memory management for Xuanshu AI Engine.

    Usage:
        guardian = MemoryGuardian()
        guardian.pre_clean(target_free_gb=4.0)  # before loading 14B
        guardian.monitor()                       # continuous monitoring thread
    """

    # Waterline thresholds (GB)
    SAFE_GB: float = 26.0
    WARN_GB: float = 28.0
    KILL_GB: float = 30.0

    # Windows system overhead estimate
    SYSTEM_OVERHEAD_GB: float = 3.5

    def __init__(self):
        self.total_ram_gb: float = 32.0
        self.waterline: str = "safe"
        self.kill_history: List[Dict] = []
        self.freed_total_gb: float = 0.0
        self.monitoring: bool = False
        self._monitor_thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()

        if not HAS_PSUTIL:
            logger.warning("psutil not installed. Memory monitoring disabled.")
        else:
            mem = psutil.virtual_memory()
            self.total_ram_gb = round(mem.total / (1024**3), 1)

    # ---- Info ----

    def get_memory_info(self) -> Dict:
        """Get current memory usage."""
        if not HAS_PSUTIL:
            return {"total_gb": self.total_ram_gb, "used_gb": 0, "free_gb": 0, "percent": 0}

        mem = psutil.virtual_memory()
        swap = psutil.swap_memory()
        used = round(mem.used / (1024**3), 2)
        available = round(mem.available / (1024**3), 2)
        return {
            "total_gb": self.total_ram_gb,
            "used_gb": used,
            "free_gb": available,
            "percent": round(mem.percent, 1),
            "swap_used_gb": round(swap.used / (1024**3), 2) if swap.total > 0 else 0,
            "effective_used": round(used - self.SYSTEM_OVERHEAD_GB, 2),
            "waterline": self.waterline,
        }

    def get_top_processes(self, top_n: int = 10) -> List[Dict]:
        """Get top N processes by memory usage."""
        if not HAS_PSUTIL:
            return []

        processes = []
        for proc in psutil.process_iter(["pid", "name", "memory_info"]):
            try:
                info = proc.info
                mem_mb = info["memory_info"].rss / (1024**2)
                if mem_mb < 1:  # skip tiny processes
                    continue
                processes.append({
                    "pid": info["pid"],
                    "name": info["name"] or "unknown",
                    "memory_mb": round(mem_mb, 1),
                })
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue

        processes.sort(key=lambda p: p["memory_mb"], reverse=True)
        return processes[:top_n]

    # ---- Pre-clean ----

    def pre_clean(self, target_free_gb: float = 4.0) -> float:
        """
        Scan and kill non-essential processes to free memory before loading 14B.

        Args:
            target_free_gb: How much memory to try to free (GB)

        Returns:
            Amount of memory actually freed (GB)
        """
        if not HAS_PSUTIL:
            logger.warning("Cannot pre-clean: psutil not installed")
            return 0.0

        mem_before = self.get_memory_info()
        freed_bytes = 0

        logger.info(f"Pre-clean: target {target_free_gb} GB, current used: {mem_before['used_gb']} GB")

        # Scan all processes
        candidates: List[Dict] = []
        for proc in psutil.process_iter(["pid", "name", "memory_info", "cmdline"]):
            try:
                info = proc.info
                name = (info["name"] or "").lower()
                pid = info["pid"]

                # Skip whitelisted
                if name in {w.lower() for w in WHITELIST_NAMES}:
                    continue

                # Check killable prefixes
                is_killable = any(name.startswith(p) for p in KILLABLE_PREFIXES)
                if not is_killable:
                    continue

                mem_mb = info["memory_info"].rss / (1024**2)
                if mem_mb < 50:  # skip tiny processes
                    continue

                candidates.append({
                    "pid": pid,
                    "name": info["name"],
                    "memory_mb": mem_mb,
                })
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue

        # Sort by memory (largest first)
        candidates.sort(key=lambda p: p["memory_mb"], reverse=True)

        logger.info(f"Found {len(candidates)} killable processes, top 5: "
                    f"{[(c['name'], round(c['memory_mb'])) for c in candidates[:5]]}")

        # Kill until target reached or candidates exhausted
        for proc_info in candidates:
            if freed_bytes / (1024**3) >= target_free_gb:
                break

            try:
                p = psutil.Process(proc_info["pid"])
                mem_before_kill = p.memory_info().rss
                p.terminate()
                p.wait(timeout=5)
                freed_bytes += mem_before_kill
                self.freed_total_gb += mem_before_kill / (1024**3)
                self.kill_history.append({
                    "pid": proc_info["pid"],
                    "name": proc_info["name"],
                    "memory_freed_mb": round(mem_before_kill / (1024**2), 1),
                    "time": time.time(),
                })
                logger.info(f"Killed: {proc_info['name']} (PID {proc_info['pid']}), "
                            f"freed {mem_before_kill / (1024**2):.0f} MB")
            except psutil.NoSuchProcess:
                continue
            except psutil.AccessDenied:
                logger.debug(f"Access denied: {proc_info['name']}")
                continue
            except Exception as e:
                logger.warning(f"Failed to kill {proc_info['name']}: {e}")
                continue

        freed_gb = round(freed_bytes / (1024**3), 2)
        logger.info(f"Pre-clean complete: freed {freed_gb} GB, "
                    f"total freed this session: {self.freed_total_gb:.2f} GB")
        return freed_gb

    # ---- Monitoring ----

    def check_waterline(self) -> str:
        """Check current memory against waterlines and return status."""
        info = self.get_memory_info()
        used = info["used_gb"]

        if used >= self.KILL_GB:
            self.waterline = "kill"
        elif used >= self.WARN_GB:
            self.waterline = "warn"
        else:
            self.waterline = "safe"

        return self.waterline

    def monitor(self):
        """Continuous memory monitoring (runs in a thread)."""
        self.monitoring = True
        logger.info("MemoryGuardian monitoring started")

        while self.monitoring:
            try:
                waterline = self.check_waterline()

                if waterline == "kill":
                    logger.critical(f"Memory at {self.get_memory_info()['used_gb']} GB — KILL level!")
                    self.pre_clean(target_free_gb=4.0)

                time.sleep(2)

            except Exception as e:
                logger.error(f"Monitor error: {e}")
                time.sleep(5)

    def start_monitoring(self):
        """Start monitoring in background thread."""
        if self._monitor_thread and self._monitor_thread.is_alive():
            return
        self._monitor_thread = threading.Thread(
            target=self.monitor, daemon=True, name="xuanshu-memory-monitor"
        )
        self._monitor_thread.start()

    def stop_monitoring(self):
        """Stop monitoring thread."""
        self.monitoring = False
        if self._monitor_thread:
            self._monitor_thread.join(timeout=5)

    # ---- Stats ----

    def stats(self) -> Dict:
        """Return guardian statistics."""
        return {
            "total_ram_gb": self.total_ram_gb,
            "system_overhead_gb": self.SYSTEM_OVERHEAD_GB,
            "current_waterline": self.waterline,
            "thresholds": {
                "safe_gb": self.SAFE_GB,
                "warn_gb": self.WARN_GB,
                "kill_gb": self.KILL_GB,
            },
            "total_freed_gb": round(self.freed_total_gb, 2),
            "kill_count": len(self.kill_history),
            "last_kills": [
                {
                    "name": k["name"],
                    "freed_mb": k["memory_freed_mb"],
                    "time_ago_sec": round(time.time() - k["time"], 1),
                }
                for k in self.kill_history[-5:]
            ],
        }


# ============================================================================
# Standalone usage
# ============================================================================

def main():
    """Test and display memory status."""
    guardian = MemoryGuardian()
    info = guardian.get_memory_info()
    procs = guardian.get_top_processes(10)

    print("=" * 60)
    print("  玄枢 Memory Guardian")
    print("=" * 60)
    print(f"  Total RAM:      {info['total_gb']} GB")
    print(f"  Used:           {info['used_gb']} GB")
    print(f"  Available:      {info['free_gb']} GB")
    print(f"  Usage:          {info['percent']}%")
    print(f"  Waterline:      {info['waterline'].upper()}")
    print(f"  System overhead: {guardian.SYSTEM_OVERHEAD_GB} GB (estimated)")
    print()
    print("  Top Processes by Memory:")
    print(f"  {'PID':<8} {'Name':<25} {'Memory (MB)':<12}")
    print(f"  {'-'*8} {'-'*25} {'-'*12}")
    for p in procs:
        print(f"  {p['pid']:<8} {p['name']:<25} {p['memory_mb']:<12.1f}")

    print()
    print("  Killable process prefixes:", KILLABLE_PREFIXES)
    print("  Whitelist size:", len(WHITELIST_NAMES))
    print()


if __name__ == "__main__":
    main()
