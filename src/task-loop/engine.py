"""
Task Loop Core Engine — 状态机驱动的自主执行循环

State machine:
    PLAN ──→ EXECUTE ──→ VALIDATE
                 ↑            │
                 │       ┌────┴────┐
                 │    FAIL        PASS
                 │     │           │
                 └── FIX         DONE
                      │(max retries exceeded)
                      └──→ GIVE_UP

每个状态转换都会产生结构化日志，最终返回 TaskResult。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import traceback
from dataclasses import dataclass, field
from enum import Enum, auto
from pathlib import Path
from typing import Any, Callable, Optional


# ---------------------------------------------------------------------------
# 类型定义
# ---------------------------------------------------------------------------

class LoopState(Enum):
    PLAN = auto()
    EXECUTE = auto()
    VALIDATE = auto()
    FIX = auto()
    DONE = auto()
    GIVE_UP = auto()


@dataclass
class IterationLog:
    """单次迭代的完整记录"""
    index: int
    state: LoopState
    timestamp: float
    script_path: str = ""
    exit_code: int = 0
    stdout: str = ""
    stderr: str = ""
    error_type: str = ""
    fix_applied: str = ""
    duration_ms: float = 0


@dataclass
class TaskResult:
    """任务最终结果"""
    success: bool
    goal: str
    total_iterations: int
    final_state: LoopState
    output: str = ""
    error: str = ""
    logs: list[IterationLog] = field(default_factory=list)
    artifacts: list[str] = field(default_factory=list)  # 产物文件路径列表

    def to_dict(self) -> dict:
        return {
            "success": self.success,
            "goal": self.goal,
            "total_iterations": self.total_iterations,
            "final_state": self.final_state.name,
            "output": self.output[:2000],
            "error": self.error[:1000],
            "artifacts": self.artifacts,
            "logs": [
                {
                    "index": l.index,
                    "state": l.state.name,
                    "script": l.script_path,
                    "exit_code": l.exit_code,
                    "error_type": l.error_type,
                    "fix_applied": l.fix_applied,
                    "duration_ms": l.duration_ms,
                }
                for l in self.logs
            ],
        }


# ---------------------------------------------------------------------------
# 自动修复器
# ---------------------------------------------------------------------------

class AutoFixer:
    """
    针对常见运行时错误的自动修复策略。
    不涉及语义逻辑修复——只处理机械性错误。
    """

    # (错误特征, 修复动作描述, 修复函数)
    FIX_PATTERNS: list[tuple[str, str, Callable]] = []

    @classmethod
    def register_default_patterns(cls):
        """注册内置修复模式"""

        def fix_import_error(stderr: str, script: str) -> Optional[str]:
            """ModuleNotFoundError → 自动 pip install"""
            m = re.search(r"No module named '(\w+)'", stderr)
            if not m:
                return None
            pkg = m.group(1)
            # 常见映射
            known = {
                "Crypto": "pycryptodome",
                "cv2": "opencv-python",
                "PIL": "Pillow",
                "yaml": "pyyaml",
                "bs4": "beautifulsoup4",
                "sklearn": "scikit-learn",
            }
            install_name = known.get(pkg, pkg)
            r = subprocess.run(
                [sys.executable, "-m", "pip", "install", install_name],
                capture_output=True, text=True, timeout=120
            )
            if r.returncode == 0:
                return script  # 脚本不变，重试
            return None

        def fix_syntax_error(stderr: str, script: str) -> Optional[str]:
            """SyntaxError / IndentationError → 尝试修复"""
            # 尝试从 stderr 提取行号
            m = re.search(r'SyntaxError:.*line (\d+)', stderr)
            if not m:
                m = re.search(r'File ".*", line (\d+)', stderr)
            if not m:
                # 没有行号信息时，扫描全文修复中文标点
                lines = script.split('\n')
                fixed_any = False
                for i in range(len(lines)):
                    old = lines[i]
                    lines[i] = re.sub(r'，', ',', lines[i])
                    lines[i] = re.sub(r'；', ';', lines[i])
                    lines[i] = re.sub(r'：', ':', lines[i])
                    lines[i] = re.sub(r'（', '(', lines[i])
                    lines[i] = re.sub(r'）', ')', lines[i])
                    lines[i] = re.sub(r'\u201c', '"', lines[i])  # "
                    lines[i] = re.sub(r'\u201d', '"', lines[i])  # "
                    if lines[i] != old:
                        fixed_any = True
                return '\n'.join(lines) if fixed_any else None
            line_no = int(m.group(1)) - 1
            lines = script.split('\n')
            if line_no >= len(lines):
                return None
            bad_line = lines[line_no]
            # 常见修复
            fixed = bad_line
            fixed = re.sub(r'^\t+', lambda x: ' ' * (4 * len(x.group())), fixed)  # tabs → spaces
            fixed = re.sub(r'，', ',', fixed)  # 中文逗号 → 英文
            fixed = re.sub(r'；', ';', fixed)   # 中文分号 → 英文
            fixed = re.sub(r'：', ':', fixed)   # 中文冒号 → 英文
            fixed = re.sub(r'（', '(', fixed)   # 全角左括号 → 半角
            fixed = re.sub(r'）', ')', fixed)   # 全角右括号 → 半角
            fixed = re.sub(r'“', '"', fixed)   # 全角左引号
            fixed = re.sub(r'”', '"', fixed)   # 全角右引号
            fixed = re.sub(r'\u3002', '.', fixed)  # 。→ .
            fixed = re.sub(r'\uff0c', ',', fixed)  # ，→ ,
            fixed = re.sub(r'\uff01', '!', fixed)  # ！→ !
            fixed = re.sub(r'\uff1f', '?', fixed)  # ？→ ?
            if fixed != bad_line:
                lines[line_no] = fixed
                return '\n'.join(lines)
            return None

        def fix_permission_error(stderr: str, script: str) -> Optional[str]:
            """PermissionError → 添加重试逻辑"""
            if 'PermissionError' not in stderr and 'Access is denied' not in stderr:
                return None
            # 在脚本头部添加重试 wrapper
            wrapper = '''
import time, sys
def _retry_on_permission(func, *args, max_retries=3, **kwargs):
    for attempt in range(max_retries):
        try:
            return func(*args, **kwargs)
        except PermissionError:
            if attempt == max_retries - 1:
                raise
            time.sleep(2 ** attempt)
'''
            return wrapper + '\n' + script

        def fix_name_error(stderr: str, script: str) -> Optional[str]:
            """NameError / UnboundLocalError → 尝试添加初始化"""
            m = re.search(r"name '(\w+)' is not defined", stderr)
            if not m:
                return None
            var_name = m.group(1)
            # 智能推断初始化类型：如果后续有算术运算则用 0，否则用 None
            # 检查变量附近是否有算术操作
            if re.search(rf'{re.escape(var_name)}\s*[+\-*/]', script):
                init_line = f"{var_name} = 0  # Auto-fix: initialized for arithmetic"
            elif re.search(rf'{re.escape(var_name)}\s*\[', script):
                init_line = f"{var_name} = []  # Auto-fix: initialized as list"
            elif re.search(rf'{re.escape(var_name)}\s*\.', script):
                init_line = f"{var_name} = type('obj', (), {{}})()  # Auto-fix: placeholder object"
            else:
                init_line = f"{var_name} = None  # Auto-fix: initialized to None"
            return init_line + '\n' + script

        def fix_timeout_error(stderr: str, script: str) -> Optional[str]:
            """TimeoutError / requests.Timeout → 添加重试"""
            if 'Timeout' not in stderr and 'timeout' not in stderr.lower():
                return None
            # 在脚本头部添加超时重试
            return (
                "import time\n"
                "def _with_retry(func, *args, max_retries=3, **kwargs):\n"
                "    for i in range(max_retries):\n"
                "        try:\n"
                "            return func(*args, **kwargs)\n"
                "        except Exception:\n"
                "            if i == max_retries - 1: raise\n"
                "            time.sleep(2 ** i)\n\n"
            ) + script

        # 注册（顺序决定优先级）
        cls.FIX_PATTERNS = [
            ("ModuleNotFoundError", "pip install 缺失模块", fix_import_error),
            ("SyntaxError / IndentationError", "修正缩进和中文标点", fix_syntax_error),
            ("PermissionError / Access denied", "添加延迟重试", fix_permission_error),
            ("NameError", "初始化未定义变量", fix_name_error),
            ("Timeout / timeout", "添加超时重试逻辑", fix_timeout_error),
        ]

    @classmethod
    def attempt_fix(cls, stderr: str, script: str) -> tuple[Optional[str], str]:
        """
        尝试自动修复。返回 (修复后脚本, 修复描述)。
        """
        if not cls.FIX_PATTERNS:
            cls.register_default_patterns()

        for pattern, description, fix_func in cls.FIX_PATTERNS:
            try:
                result = fix_func(stderr, script)
                if result is not None and result != script:
                    return result, description
            except Exception:
                continue

        return None, ""


# ---------------------------------------------------------------------------
# 验证器
# ---------------------------------------------------------------------------

class Validator:
    """判断任务执行是否成功"""

    @staticmethod
    def check(exit_code: int, stdout: str, stderr: str, success_markers: list[str] = None) -> tuple[bool, str]:
        """
        返回 (是否成功, 失败原因)。
        success_markers: 输出中必须包含的关键词列表。
        """
        if exit_code != 0:
            return False, f"exit_code={exit_code}"

        # 检查致命错误关键词
        fatal_keywords = ['FATAL', 'CRITICAL', 'Segmentation fault', 'access violation']
        for kw in fatal_keywords:
            if kw.lower() in stderr.lower():
                return False, f"fatal error: {kw}"

        # 检查成功标记
        if success_markers:
            combined = stdout + stderr
            missing = [m for m in success_markers if m.lower() not in combined.lower()]
            if missing:
                return False, f"missing markers: {missing}"

        return True, ""


# ---------------------------------------------------------------------------
# 任务循环引擎
# ---------------------------------------------------------------------------

class TaskLoop:
    """
    自主任务执行循环。

    用法:
        loop = TaskLoop(
            goal="处理 data/*.csv 生成汇总 Excel",
            work_dir="C:/Users/.../workspace",
            max_iterations=5,
            timeout=300
        )
        result = loop.run(initial_script="...python code...")
    """

    def __init__(
        self,
        goal: str,
        work_dir: str,
        max_iterations: int = 5,
        timeout: int = 300,
        success_markers: list[str] = None,
    ):
        self.goal = goal
        self.work_dir = Path(work_dir)
        self.temp_dir = self.work_dir / "temp"
        self.max_iterations = max_iterations
        self.timeout = timeout
        self.success_markers = success_markers or []
        self.logs: list[IterationLog] = []
        self.iteration = 0
        self.task_start_time = 0  # 由 run() 设置

        os.makedirs(self.temp_dir, exist_ok=True)

    def _write_script(self, code: str) -> str:
        """将代码写入临时脚本文件"""
        path = self.temp_dir / f"task_iter_{self.iteration:03d}.py"
        path.write_text(code, encoding='utf-8')
        return str(path)

    def _execute(self, script_path: str) -> tuple[int, str, str, float]:
        """执行脚本并捕获输出。Windows下用Popen+communicate避免reader线程异常。"""
        t0 = time.time()
        try:
            if os.name == 'nt':
                # Windows: 显式 Popen 避免 _readerthread 崩溃（已知 Windows CPython bug）
                p = subprocess.Popen(
                    [sys.executable, script_path],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    stdin=subprocess.DEVNULL,
                    cwd=str(self.work_dir),
                )
                try:
                    out, err = p.communicate(timeout=self.timeout)
                except subprocess.TimeoutExpired:
                    p.kill()
                    out, err = p.communicate()
                    duration = (time.time() - t0) * 1000
                    return -1, (out or b"").decode('utf-8', errors='replace'), \
                           f"TIMEOUT after {self.timeout}s\n{(err or b'').decode('utf-8', errors='replace')}", duration
                duration = (time.time() - t0) * 1000
                return p.returncode or 0, \
                       (out or b"").decode('utf-8', errors='replace'), \
                       (err or b"").decode('utf-8', errors='replace'), \
                       duration
            else:
                r = subprocess.run(
                    [sys.executable, script_path],
                    capture_output=True,
                    text=True,
                    timeout=self.timeout,
                    cwd=str(self.work_dir),
                )
                duration = (time.time() - t0) * 1000
                return r.returncode, r.stdout, r.stderr, duration
        except Exception as e:
            duration = (time.time() - t0) * 1000
            return -1, "", f"EXEC_ERROR: {e}", duration

    def _collect_artifacts(self) -> list[str]:
        """收集任务运行后新产生的文件（基于修改时间）"""
        new_files = []
        cutoff = self.task_start_time
        for root, _, files in os.walk(self.work_dir):
            if "temp" in root.split(os.sep):
                continue
            for f in files:
                fp = os.path.join(root, f)
                try:
                    if os.path.getmtime(fp) >= cutoff:
                        new_files.append(fp)
                except OSError:
                    continue
        return new_files

    def run(self, initial_script: str) -> TaskResult:
        """
        启动任务循环。

        initial_script: 第一次执行的 Python 脚本
        返回 TaskResult
        """
        self.iteration = 0
        self.task_start_time = time.time()
        current_script = initial_script

        while self.iteration < self.max_iterations:
            self.iteration += 1
            log = IterationLog(index=self.iteration, state=LoopState.EXECUTE, timestamp=time.time())

            # ── EXECUTE ──
            script_path = self._write_script(current_script)
            log.script_path = script_path
            exit_code, stdout, stderr, duration = self._execute(script_path)
            log.exit_code = exit_code
            log.stdout = stdout
            log.stderr = stderr
            log.duration_ms = duration

            # ── VALIDATE ──
            log.state = LoopState.VALIDATE
            success, reason = Validator.check(exit_code, stdout, stderr, self.success_markers)

            if success:
                log.state = LoopState.DONE
                self.logs.append(log)
                return TaskResult(
                    success=True,
                    goal=self.goal,
                    total_iterations=self.iteration,
                    final_state=LoopState.DONE,
                    output=stdout,
                    logs=self.logs,
                    artifacts=self._collect_artifacts(),
                )

            # ── FIX ──
            log.state = LoopState.FIX
            log.error_type = reason

            fixed_script, fix_desc = AutoFixer.attempt_fix(stderr, current_script)
            log.fix_applied = fix_desc

            if fixed_script is not None:
                current_script = fixed_script
                self.logs.append(log)
                print(f"[Iter {self.iteration}] {reason} → {fix_desc}", file=sys.stderr)
                continue
            else:
                # 无法自动修复
                log.state = LoopState.GIVE_UP
                log.fix_applied = "无法自动修复，需要 LLM 介入"
                self.logs.append(log)
                return TaskResult(
                    success=False,
                    goal=self.goal,
                    total_iterations=self.iteration,
                    final_state=LoopState.GIVE_UP,
                    output=stdout,
                    error=f"{reason}\n\nSTDERR:\n{stderr[:3000]}",
                    logs=self.logs,
                )

        # 达到最大迭代次数
        last_log = self.logs[-1] if self.logs else None
        return TaskResult(
            success=False,
            goal=self.goal,
            total_iterations=self.iteration,
            final_state=LoopState.GIVE_UP,
            output=last_log.stdout if last_log else "",
            error=f"达到最大迭代次数 {self.max_iterations}",
            logs=self.logs,
        )


# ---------------------------------------------------------------------------
# 入口：从命令行调用
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    """
    命令行用法:
        python engine.py "<goal_json>"
    
    goal_json:
    {
        "goal": "任务描述",
        "work_dir": "工作目录",
        "script": "Python脚本代码",
        "max_iterations": 5,
        "timeout": 300,
        "success_markers": ["SUCCESS"]
    }
    """
    import argparse

    parser = argparse.ArgumentParser(description="Task Loop Engine")
    parser.add_argument("config", help="JSON config string or path to config file")
    args = parser.parse_args()

    # 读取配置
    config_path = Path(args.config)
    if config_path.exists():
        config = json.loads(config_path.read_text(encoding='utf-8'))
    else:
        config = json.loads(args.config)

    loop = TaskLoop(
        goal=config["goal"],
        work_dir=config["work_dir"],
        max_iterations=config.get("max_iterations", 5),
        timeout=config.get("timeout", 300),
        success_markers=config.get("success_markers", []),
    )

    result = loop.run(config["script"])
    print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
