"""
玄枢 AI — Brain Runtime
========================
管理 11 个军团大脑的加载、卸载、切换、软件降级链、浏览器池、Skills 集成。

核心职责:
  1. 加载大脑 JSON 配置（workflow / checkpoints / quality_gates）
  2. 软件降级链（首选未安装 → 自动降级到下一个可用选项）
  3. 浏览器池管理（Edge / Chrome / Firefox / QQ 浏览器）
  4. Skills 注册与调用
  5. 运行时状态追踪（当前大脑、激活的工具集）

Author: 玄枢开发组
Version: 2.0.0 (9B native)
"""

import os
import sys
import json
import subprocess
from pathlib import Path
from typing import Optional, Dict, List, Any, Tuple
from dataclasses import dataclass, field
from datetime import datetime

try:
    from loguru import logger
except ImportError:
    import logging
    logger = logging.getLogger("brain-runtime")

# ============================================================================
# 路径配置
# ============================================================================

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PERSONAS_DIR = PROJECT_ROOT / "personas"
SCRIPTS_DIR = PROJECT_ROOT / "scripts"
TOOLS_DIR = PROJECT_ROOT / "tools"

# 11 个大脑 ID 列表
ALL_BRAIN_IDS = [
    "brain_software_dev",
    "brain_file_office",
    "brain_cybersecurity",
    "brain_multimedia",
    "brain_data_analysis",
    "brain_system_admin",
    "brain_content_creation",
    "brain_academic_research",
    "brain_legal_counsel",
    "brain_gaming",
    "brain_finance",
]

# ============================================================================
# 软件降级链（软件名 → 检测命令列表，找到第一个可用的）
# ============================================================================

SOFTWARE_DEGRADATION_CHAINS: Dict[str, List[str]] = {
    # 代码编辑器
    "code_editor": ["code", "cursor", "notepad++", "notepad"],
    # Office 套件
    "office_word": ["wps", "winword", "wordpad"],
    "office_excel": ["et", "excel"],
    "office_ppt": ["wpp", "powerpnt"],
    # 终端
    "terminal": ["wt", "powershell", "cmd"],
    # 浏览器
    "browser": ["msedge", "chrome", "firefox", "qqbrowser"],
    # 图片编辑
    "image_editor": ["photoshop", "gimp", "mspaint"],
    # 视频编辑
    "video_editor": ["剪映专业版", "davinci_resolve", "openshot"],
    # 数据库客户端
    "db_client": ["dbeaver", "heidisql", "pgadmin"],
    # Git
    "git": ["git"],
}

# 浏览器池配置
BROWSER_POOL: Dict[str, dict] = {
    "msedge": {
        "name": "Microsoft Edge",
        "process": "msedge.exe",
        "user_data_dir": str(Path.home() / "AppData/Local/Microsoft/Edge/User Data"),
        "debug_port": 9222,
        "priority": 1,
    },
    "chrome": {
        "name": "Google Chrome",
        "process": "chrome.exe",
        "user_data_dir": str(Path.home() / "AppData/Local/Google/Chrome/User Data"),
        "debug_port": 9223,
        "priority": 2,
    },
    "firefox": {
        "name": "Mozilla Firefox",
        "process": "firefox.exe",
        "user_data_dir": str(Path.home() / "AppData/Local/Mozilla/Firefox/Profiles"),
        "debug_port": 9224,
        "priority": 3,
    },
    "qqbrowser": {
        "name": "QQ 浏览器",
        "process": "QQBrowser.exe",
        "user_data_dir": str(Path.home() / "AppData/Local/Tencent/QQBrowser/User Data"),
        "debug_port": 9225,
        "priority": 4,
    },
}


# ============================================================================
# 数据结构
# ============================================================================

@dataclass
class BrainConfig:
    """加载后的大脑配置"""
    id: str
    name: str
    icon: str
    description: str
    color: str
    temperature: float
    system_prompt: str
    primary_tools: List[str]
    software_stack: Dict[str, str]
    workflow: Dict[str, str]
    checkpoints: List[str]
    quality_gates: Dict[str, str]
    domain_rules: List[str]
    forbidden_actions: List[str]
    created_at: str
    tags: List[str]

    def to_prompt(self) -> str:
        """生成注入到模型的运行时 prompt"""
        parts = [
            self.system_prompt,
            "",
            "---",
            "",
            "## 可用工具",
            ", ".join(self.primary_tools),
            "",
            "## 软件栈",
        ]
        for k, v in self.software_stack.items():
            parts.append(f"- {k}: {v}")
        parts.extend([
            "",
            "## 工作流",
        ])
        for k, v in self.workflow.items():
            parts.append(f"- **{k}**: {v}")
        parts.extend([
            "",
            "## 质量门",
        ])
        for k, v in self.quality_gates.items():
            parts.append(f"- {k}: {v}")
        parts.extend([
            "",
            "## 检查点",
        ])
        for cp in self.checkpoints:
            parts.append(f"- [ ] {cp}")
        parts.extend([
            "",
            "## 领域规则",
        ])
        for rule in self.domain_rules:
            parts.append(f"- {rule}")
        parts.extend([
            "",
            "## 禁止行为",
        ])
        for fb in self.forbidden_actions:
            parts.append(f"- {fb}")
        return "\n".join(parts)


@dataclass
class BrainRuntimeState:
    """运行时状态追踪"""
    current_brain: Optional[str] = None
    current_brain_config: Optional[BrainConfig] = None
    brain_loaded_at: Optional[datetime] = None
    loaded_brains: Dict[str, BrainConfig] = field(default_factory=dict)
    active_tools: List[str] = field(default_factory=list)
    browser_instances: Dict[str, Any] = field(default_factory=dict)
    session_history: List[Dict] = field(default_factory=list)


# ============================================================================
# Brain Loader
# ============================================================================

class BrainLoader:
    """大脑配置加载器"""

    def __init__(self, personas_dir: Path = PERSONAS_DIR):
        self.personas_dir = Path(personas_dir)
        self._cache: Dict[str, BrainConfig] = {}

    def load(self, brain_id: str) -> BrainConfig:
        """加载单个大脑配置"""
        if brain_id in self._cache:
            return self._cache[brain_id]

        brain_file = self.personas_dir / f"{brain_id}.json"
        if not brain_file.exists():
            raise FileNotFoundError(f"大脑配置不存在: {brain_file}")

        with open(brain_file, "r", encoding="utf-8") as f:
            data = json.load(f)

        config = BrainConfig(
            id=data["id"],
            name=data["name"],
            icon=data.get("icon", "brain"),
            description=data.get("description", ""),
            color=data.get("color", "#3498DB"),
            temperature=data.get("temperature", 0.3),
            system_prompt=data.get("system_prompt", ""),
            primary_tools=data.get("primary_tools", []),
            software_stack=data.get("software_stack", {}),
            workflow=data.get("workflow", {}),
            checkpoints=data.get("checkpoints", []),
            quality_gates=data.get("quality_gates", {}),
            domain_rules=data.get("domain_rules", []),
            forbidden_actions=data.get("forbidden_actions", []),
            created_at=data.get("created_at", ""),
            tags=data.get("tags", []),
        )
        self._cache[brain_id] = config
        logger.info(f"大脑已加载: {config.name} ({brain_id})")
        return config

    def load_all(self) -> Dict[str, BrainConfig]:
        """批量加载所有大脑"""
        results = {}
        for brain_id in ALL_BRAIN_IDS:
            try:
                results[brain_id] = self.load(brain_id)
            except FileNotFoundError as e:
                logger.warning(f"跳过 {brain_id}: {e}")
        return results

    def list_brain_ids(self) -> List[str]:
        """列出所有可用大脑 ID"""
        available = []
        for brain_id in ALL_BRAIN_IDS:
            if (self.personas_dir / f"{brain_id}.json").exists():
                available.append(brain_id)
        return available

    def get_brain_summary(self, brain_id: str) -> Optional[dict]:
        """获取大脑摘要（不含完整 system_prompt）"""
        try:
            config = self.load(brain_id)
            return {
                "id": config.id,
                "name": config.name,
                "icon": config.icon,
                "description": config.description,
                "color": config.color,
                "tags": config.tags,
                "tools_count": len(config.primary_tools),
            }
        except FileNotFoundError:
            return None


# ============================================================================
# Software Detector
# ============================================================================

class SoftwareDetector:
    """检测已安装软件并执行降级链"""

    @staticmethod
    def is_installed(software_name: str) -> bool:
        """检测单个软件是否已安装（在 PATH 中）"""
        try:
            result = subprocess.run(
                ["where", software_name],
                capture_output=True, text=True, timeout=5,
                shell=True,
            )
            return result.returncode == 0 and len(result.stdout.strip()) > 0
        except Exception:
            return False

    @staticmethod
    def find_in_degradation_chain(chain_name: str) -> Optional[str]:
        """从降级链中找到第一个可用的软件"""
        chain = SOFTWARE_DEGRADATION_CHAINS.get(chain_name, [])
        for software in chain:
            if SoftwareDetector.is_installed(software):
                return software
        return None

    @staticmethod
    def get_available_browsers() -> List[str]:
        """获取可用的浏览器列表（按优先级排序）"""
        available = []
        for browser_id, config in sorted(
            BROWSER_POOL.items(),
            key=lambda x: x[1]["priority"]
        ):
            if SoftwareDetector.is_installed(browser_id):
                available.append(browser_id)
        return available

    @staticmethod
    def scan_environment() -> Dict[str, Any]:
        """扫描完整软件环境"""
        result = {
            "os": "Windows",
            "code_editor": SoftwareDetector.find_in_degradation_chain("code_editor"),
            "office_word": SoftwareDetector.find_in_degradation_chain("office_word"),
            "office_excel": SoftwareDetector.find_in_degradation_chain("office_excel"),
            "office_ppt": SoftwareDetector.find_in_degradation_chain("office_ppt"),
            "terminal": SoftwareDetector.find_in_degradation_chain("terminal"),
            "browsers": SoftwareDetector.get_available_browsers(),
            "image_editor": SoftwareDetector.find_in_degradation_chain("image_editor"),
            "video_editor": SoftwareDetector.find_in_degradation_chain("video_editor"),
            "db_client": SoftwareDetector.find_in_degradation_chain("db_client"),
            "git": SoftwareDetector.find_in_degradation_chain("git"),
        }
        return result


# ============================================================================
# Brain Runtime Engine
# ============================================================================

class BrainRuntime:
    """
    大脑运行时引擎

    用法:
        runtime = BrainRuntime()
        runtime.activate("brain_software_dev")  # 激活软件开发大脑
        runtime.activate("brain_file_office")    # 切换到文件办公大脑
        runtime.deactivate()                     # 关闭大脑，回到默认
    """

    def __init__(self):
        self.loader = BrainLoader()
        self.detector = SoftwareDetector()
        self.state = BrainRuntimeState()

        # 预加载所有大脑摘要
        self._all_summaries: Dict[str, dict] = {}
        self._init_summaries()

    def _init_summaries(self):
        """预加载所有大脑摘要"""
        for brain_id in ALL_BRAIN_IDS:
            summary = self.loader.get_brain_summary(brain_id)
            if summary:
                self._all_summaries[brain_id] = summary

    def activate(self, brain_id: str) -> BrainConfig:
        """
        激活指定大脑
        - 加载完整配置
        - 注入系统 prompt
        - 激活相关工具集
        """
        if brain_id not in ALL_BRAIN_IDS:
            raise ValueError(f"未知大脑 ID: {brain_id}。可用: {ALL_BRAIN_IDS}")

        # 卸载当前大脑
        if self.state.current_brain is not None:
            self.deactivate()

        # 加载新大脑
        config = self.loader.load(brain_id)
        self.state.current_brain = brain_id
        self.state.current_brain_config = config
        self.state.brain_loaded_at = datetime.now()
        self.state.active_tools = config.primary_tools.copy()

        logger.info(f"大脑已激活: {config.name} (温度={config.temperature})")
        return config

    def deactivate(self):
        """卸载当前大脑，回到默认模式"""
        if self.state.current_brain:
            logger.info(f"大脑已卸载: {self.state.current_brain_config.name}")
        self.state.current_brain = None
        self.state.current_brain_config = None
        self.state.brain_loaded_at = None
        self.state.active_tools = []

    def get_current_config(self) -> Optional[BrainConfig]:
        """获取当前激活的大脑配置"""
        return self.state.current_brain_config

    def get_current_prompt(self) -> Optional[str]:
        """获取当前大脑的完整运行时 prompt"""
        config = self.state.current_brain_config
        if config is None:
            return None
        return config.to_prompt()

    def get_all_summaries(self) -> Dict[str, dict]:
        """获取所有大脑的摘要列表（用于 UI 展示）"""
        return self._all_summaries.copy()

    def get_software_for_brain(self, brain_id: str) -> Dict[str, str]:
        """获取某个大脑所需的软件及当前可用状态"""
        try:
            config = self.loader.load(brain_id)
        except FileNotFoundError:
            return {}

        result = {}
        for key, expected in config.software_stack.items():
            # 从降级链找对应的检测方式
            chain_name = {
                "editor": "code_editor",
                "office_suite": "office_word",
                "office_suite_word": "office_word",
                "office_suite_excel": "office_excel",
                "office_suite_ppt": "office_ppt",
            }.get(key)
            if chain_name:
                available = self.detector.find_in_degradation_chain(chain_name)
                result[key] = {
                    "expected": expected,
                    "available": available,
                    "status": "ok" if available else "missing"
                }
            else:
                result[key] = {"expected": expected, "available": "unknown", "status": "unknown"}
        return result

    def get_session_context(self) -> dict:
        """获取当前会话上下文（注入给 9B 模型）"""
        return {
            "active_brain": self.state.current_brain,
            "brain_name": self.state.current_brain_config.name if self.state.current_brain_config else None,
            "brain_temperature": self.state.current_brain_config.temperature if self.state.current_brain_config else 0.3,
            "active_tools": self.state.active_tools,
            "brain_loaded_at": self.state.brain_loaded_at.isoformat() if self.state.brain_loaded_at else None,
            "system_prompt": self.get_current_prompt(),
        }


# ============================================================================
# CLI / 测试入口
# ============================================================================

def main():
    """命令行测试入口"""
    import argparse

    parser = argparse.ArgumentParser(description="玄枢 Brain Runtime CLI")
    parser.add_argument("action", choices=["list", "activate", "scan", "info"])
    parser.add_argument("brain_id", nargs="?", help="大脑 ID")
    args = parser.parse_args()

    runtime = BrainRuntime()

    if args.action == "list":
        print("\n=== 可用大脑 ===")
        for brain_id, summary in runtime.get_all_summaries().items():
            active = " *" if brain_id == runtime.state.current_brain else ""
            print(f"  [{brain_id}]{active}")
            print(f"    {summary['name']} — {summary['description']}")
            print(f"    工具: {summary['tools_count']}个 | 标签: {', '.join(summary['tags'])}")
            print()

    elif args.action == "activate":
        if not args.brain_id:
            print("请指定 brain_id")
            return
        config = runtime.activate(args.brain_id)
        print(f"\n已激活: {config.name}")
        print(f"温度: {config.temperature}")
        print(f"工具: {', '.join(config.primary_tools[:5])}...")
        print(f"\n检查点:")
        for cp in config.checkpoints:
            print(f"  - {cp}")

    elif args.action == "scan":
        detector = SoftwareDetector()
        env = detector.scan_environment()
        print("\n=== 软件环境扫描 ===")
        for key, value in env.items():
            print(f"  {key}: {value}")

    elif args.action == "info":
        if not args.brain_id:
            print("请指定 brain_id")
            return
        sw = runtime.get_software_for_brain(args.brain_id)
        print(f"\n=== {args.brain_id} 软件需求 ===")
        for key, info in sw.items():
            status_icon = "✅" if info["status"] == "ok" else "❌"
            print(f"  {status_icon} {key}: 需要={info['expected']}, 可用={info['available']}")


if __name__ == "__main__":
    main()
