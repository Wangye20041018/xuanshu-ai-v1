#!/usr/bin/env python3
"""
玄枢AI - 任务分流路由器
基于任务描述关键词 + 长度 + 类型做快速分类，不需要LLM判断。
本地处理简单任务，云端处理复杂任务。本地失败自动 fallback 云端。

用法:
    # 作为模块导入
    from router.task_router import TaskRouter
    router = TaskRouter()
    result = router.route("写一个快速排序函数")

    # 作为独立 HTTP 服务运行 (供 Electron 主进程调用)
    python task_router.py --serve --port 8090
"""
import sys
import os
import json
import time
import re
import urllib.request
import urllib.error
from pathlib import Path
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

SRC_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SRC_DIR))

from config.local_llm_config import config


# ============================================================
# 类型定义
# ============================================================

class TaskTarget(Enum):
    """任务路由目标"""
    LOCAL = "local"    # 走本地 DeepSeek-7B
    CLOUD = "cloud"    # 走云端 API


class TaskCategory(Enum):
    """任务大类"""
    CODE_GENERATION = "code_generation"        # 代码生成/补全
    CODE_REVIEW = "code_review"                # 代码审查
    FILE_OPERATION = "file_operation"          # 文件读写
    TEXT_PROCESSING = "text_processing"        # 文本处理（格式化/正则）
    TRANSLATION = "translation"               # 翻译
    SUMMARIZATION = "summarization"           # 总结
    SHELL_COMMAND = "shell_command"           # Shell命令生成
    SINGLE_TOOL_CALL = "single_tool_call"     # 单步工具调用
    ARCHITECTURE = "architecture"             # 架构设计
    BUG_DEBUGGING = "bug_debugging"           # Bug排查
    REFACTORING = "refactoring"               # 重构
    SECURITY_AUDIT = "security_audit"         # 安全审查
    PERFORMANCE = "performance"               # 性能优化
    LONG_DOCUMENT = "long_document"           # 长文档分析
    COMPLEX_BUSINESS = "complex_business"     # 复杂业务逻辑
    GENERAL = "general"                       # 通用问答


@dataclass
class RouteResult:
    """路由决策结果"""
    target: TaskTarget
    category: TaskCategory
    confidence: float          # 0.0 ~ 1.0
    reason: str
    # 如果走本地，提供裁剪后的 prompt
    processed_prompt: str = ""


@dataclass
class RouterStats:
    """路由器统计信息"""
    local_calls: int = 0
    cloud_calls: int = 0
    local_failures: int = 0
    local_fallbacks: int = 0         # 本地失败后回退云端次数
    local_tokens_used: int = 0
    cloud_tokens_used: int = 0
    local_latency_ms: list = field(default_factory=list)
    cloud_latency_ms: list = field(default_factory=list)

    def record_local(self, tokens: int, latency_ms: int):
        self.local_calls += 1
        self.local_tokens_used += tokens
        self.local_latency_ms.append(latency_ms)
        if len(self.local_latency_ms) > 100:
            self.local_latency_ms.pop(0)

    def record_cloud(self, tokens: int, latency_ms: int):
        self.cloud_calls += 1
        self.cloud_tokens_used += tokens
        self.cloud_latency_ms.append(latency_ms)
        if len(self.cloud_latency_ms) > 100:
            self.cloud_latency_ms.pop(0)

    def record_local_failure(self):
        self.local_failures += 1

    def record_fallback(self):
        self.local_fallbacks += 1

    @property
    def local_avg_latency(self) -> float:
        if not self.local_latency_ms:
            return 0.0
        return sum(self.local_latency_ms) / len(self.local_latency_ms)

    @property
    def cloud_avg_latency(self) -> float:
        if not self.cloud_latency_ms:
            return 0.0
        return sum(self.cloud_latency_ms) / len(self.cloud_latency_ms)

    def summary(self) -> dict:
        return {
            "local_calls": self.local_calls,
            "cloud_calls": self.cloud_calls,
            "local_failures": self.local_failures,
            "local_fallbacks": self.local_fallbacks,
            "local_tokens_used": self.local_tokens_used,
            "cloud_tokens_used": self.cloud_tokens_used,
            "local_avg_latency_ms": round(self.local_avg_latency, 1),
            "cloud_avg_latency_ms": round(self.cloud_avg_latency, 1),
            "local_success_rate": (
                round(1 - self.local_failures / max(self.local_calls, 1), 3)
            ),
        }


# ============================================================
# 关键词分类器（规则引擎，不使用LLM）
# ============================================================

# ── 本地处理的关键词/模式 ──

LOCAL_KEYWORDS = {
    TaskCategory.CODE_GENERATION: [
        # 简单函数/类生成
        "写一个函数", "写个函数", "写函数", "生成函数",
        "写一个类", "写个类", "生成类",
        "代码补全", "补全代码", "自动补全",
        "实现一个", "帮我写", "写段代码", "写个方法",
        "正则表达式", "正则匹配", "写个正则",
        "format", "序列化", "反序列化",
        # 简单算法
        "冒泡排序", "快速排序", "二分查找", "斐波那契",
        "单例模式", "工厂模式",
    ],
    TaskCategory.FILE_OPERATION: [
        "读取文件", "写入文件", "保存文件", "打开文件",
        "创建文件", "删除文件", "复制文件", "移动文件",
        "遍历目录", "列出文件", "文件操作",
        "read file", "write file", "open file",
    ],
    TaskCategory.TEXT_PROCESSING: [
        "格式化", "提取", "替换",
        "去除空格", "去除换行", "去除注释",
        "转换编码", "JSON解析", "XML解析",
        "CSV处理", "文本处理",
    ],
    TaskCategory.TRANSLATION: [
        "翻译", "translate", "中译英", "英译中",
    ],
    TaskCategory.SUMMARIZATION: [
        "总结", "概括", "摘要", "归纳",
    ],
    TaskCategory.SHELL_COMMAND: [
        "运行命令", "执行命令", "shell命令",
        "cmd命令", "终端命令", "命令行",
        "pip install", "npm install", "git clone",
    ],
    TaskCategory.SINGLE_TOOL_CALL: [
        "搜索文件", "查找文件", "搜索图片",
        "打开应用", "启动程序",
    ],
}

# ── 云端处理的关键词/模式 ──

CLOUD_KEYWORDS = {
    TaskCategory.ARCHITECTURE: [
        "架构设计", "系统设计", "架构方案", "技术选型",
        "微服务", "分布式", "模块划分", "项目架构",
        "设计模式选型", "整体架构",
        "多模块", "跨模块", "模块间", "模块通信",
    ],
    TaskCategory.BUG_DEBUGGING: [
        "排查bug", "调试", "报错排查", "调用链追踪",
        "堆栈分析", "内存泄露", "死锁", "竞态条件",
        "深层bug", "底层错误", "crash分析",
        "coredump", "core dump", "段错误",
    ],
    TaskCategory.REFACTORING: [
        "重构", "大规模修改", "跨模块重构",
        "代码迁移", "升级依赖版本", "全面改造",
    ],
    TaskCategory.SECURITY_AUDIT: [
        "安全审查", "安全审计", "漏洞扫描", "注入检测",
        "权限检查", "越权", "XSS", "CSRF", "SQL注入",
        "安全漏洞", "渗透测试",
    ],
    TaskCategory.PERFORMANCE: [
        "性能优化", "性能分析", "瓶颈分析",
        "内存优化", "CPU优化", "IO优化",
        "并发优化", "缓存策略", "性能调优",
    ],
    TaskCategory.COMPLEX_BUSINESS: [
        "业务流程", "业务逻辑重构", "状态机设计",
        "工作流设计", "规则引擎", "策略模式",
        "订单系统", "支付系统", "审批流程",
    ],
}


# ── 额外判断规则 ──

# 代码生成中指示"复杂度高"的模式（走云端）
COMPLEX_CODE_PATTERNS = [
    r"(完整|整个)(.{0,4})(项目|系统|平台|框架|应用)",
    r"(设计|实现)(一个|整个)(系统|平台|框架|引擎)",
    r"从零(搭建|构建|开发)",
    r"前后端(分离|联调|对接)",
    r"数据库(设计|迁移|优化|分库分表)",
    r"(高并发|高可用|分布式|集群)",
    r"(订单|支付|库存|物流|权限|认证)(系统|模块|管理)",
    r"(电商|商城|ERP|CRM|OA|CMS)(系统|平台)",
]

# 代码审查 → 云端
CODE_REVIEW_PATTERNS = [
    r"(审查|review|检查)(.{0,6})(代码|项目|程序)",
    r"代码(.{0,2})(检查|审查|review)",
    r"code review",
    r"(帮我|给我|帮我看看).{0,4}review",
    r"(帮我|给我).{0,4}(审查|检查).{0,4}(代码|项目)",
    r"代码.{0,4}(有问题|问题|bug|错误|报错|漏洞)",
    r"(看看|看下|看一下).{0,4}(代码|项目).{0,4}(有没有|有没|有无)",
]


class TaskClassifier:
    """
    基于规则的任务分类器。
    使用关键词匹配 + 文本长度 + 模式正则做快速判断，
    不额外调用 LLM，零 token 消耗。
    """

    def classify(self, task_description: str, context_length: int = 0) -> RouteResult:
        """
        对任务描述进行分类并给出路由目标。

        Args:
            task_description: 用户任务描述文本
            context_length: 关联上下文/文档的总字符数（用于长文档判断）

        Returns:
            RouteResult 包含目标、类别、置信度、原因
        """
        desc_lower = task_description.lower()
        desc_len = len(task_description)

        # ── 第一步：检查强制走云端的条件 ──

        # 1a. 长文档判断（上下文长度超过阈值）
        if context_length > config.long_doc_threshold:
            return RouteResult(
                target=TaskTarget.CLOUD,
                category=TaskCategory.LONG_DOCUMENT,
                confidence=0.95,
                reason=f"上下文长度 {context_length} 字符 > 长文档阈值 {config.long_doc_threshold}",
            )

        # 1b. 复杂代码模式
        for pattern in COMPLEX_CODE_PATTERNS:
            if re.search(pattern, desc_lower):
                return RouteResult(
                    target=TaskTarget.CLOUD,
                    category=TaskCategory.ARCHITECTURE,
                    confidence=0.85,
                    reason=f"匹配复杂代码模式: {pattern}",
                )

        # 1c. 代码审查
        for pattern in CODE_REVIEW_PATTERNS:
            if re.search(pattern, desc_lower):
                return RouteResult(
                    target=TaskTarget.CLOUD,
                    category=TaskCategory.CODE_REVIEW,
                    confidence=0.90,
                    reason="代码审查任务需深度分析",
                )

        # ── 第二步：检查云端关键词 ──
        for category, keywords in CLOUD_KEYWORDS.items():
            for kw in keywords:
                if kw.lower() in desc_lower:
                    return RouteResult(
                        target=TaskTarget.CLOUD,
                        category=category,
                        confidence=0.80,
                        reason=f"匹配云端关键词: '{kw}'",
                    )

        # ── 第三步：检查本地关键词 ──
        for category, keywords in LOCAL_KEYWORDS.items():
            for kw in keywords:
                if kw.lower() in desc_lower:
                    # 如果是翻译/总结，需要检查长度
                    if category in (TaskCategory.TRANSLATION, TaskCategory.SUMMARIZATION):
                        if desc_len > config.max_local_text_length:
                            return RouteResult(
                                target=TaskTarget.CLOUD,
                                category=TaskCategory.LONG_DOCUMENT,
                                confidence=0.75,
                                reason=f"任务描述 {desc_len} 字符 > 本地阈值 {config.max_local_text_length}",
                            )
                    return RouteResult(
                        target=TaskTarget.LOCAL,
                        category=category,
                        confidence=0.75,
                        reason=f"匹配本地关键词: '{kw}'",
                    )

        # ── 第四步：基于文本长度的启发式判断 ──

        # 短描述 → 偏向本地（可能是简单问答/补全）
        if desc_len < 300:
            # 纯代码片段（含较多特殊符号） → 代码补全
            code_chars = sum(1 for c in task_description if c in "{}[]()<>;=+-*/&|!%")
            if code_chars > len(task_description) * 0.05:
                return RouteResult(
                    target=TaskTarget.LOCAL,
                    category=TaskCategory.CODE_GENERATION,
                    confidence=0.65,
                    reason="短文本包含代码特征 → 本地代码补全",
                )
            return RouteResult(
                target=TaskTarget.LOCAL,
                category=TaskCategory.GENERAL,
                confidence=0.60,
                reason=f"短文本 ({desc_len}字符) → 默认本地处理",
            )

        # 中等长度 → 偏向本地
        if desc_len < 1000:
            return RouteResult(
                target=TaskTarget.LOCAL,
                category=TaskCategory.GENERAL,
                confidence=0.55,
                reason=f"中等长度 ({desc_len}字符) → 本地处理",
            )

        # 长描述 → 云端
        if desc_len > config.max_local_text_length:
            return RouteResult(
                target=TaskTarget.CLOUD,
                category=TaskCategory.GENERAL,
                confidence=0.60,
                reason=f"长文本 ({desc_len}字符 > {config.max_local_text_length}) → 云端处理",
            )

        # ── 第五步：兜底 → 本地 ──
        return RouteResult(
            target=TaskTarget.LOCAL,
            category=TaskCategory.GENERAL,
            confidence=0.50,
            reason="无明确特征 → 默认本地处理",
        )


# ============================================================
# 本地 API 调用客户端
# ============================================================

class LocalLLMClient:
    """OpenAI 兼容格式的本地 LLM API 客户端"""

    def __init__(self, base_url: str = None):
        self.base_url = base_url or config.api_base

    def health_check(self, timeout: int = 5) -> bool:
        """检查本地服务是否可用"""
        try:
            req = urllib.request.Request(
                f"{self.base_url.replace('/v1', '')}/health",
                method="GET",
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status == 200
        except Exception:
            return False

    def chat(
        self,
        messages: list[dict],
        max_tokens: int = None,
        temperature: float = None,
        stream: bool = False,
        timeout: int = 120,
    ) -> dict:
        """
        调用本地 API 进行对话。

        Returns:
            {"success": bool, "content": str, "tokens_used": int, "error": str}
        """
        payload = {
            "model": "local-model",
            "messages": messages,
            "max_tokens": max_tokens or config.max_tokens,
            "temperature": temperature or config.temperature,
            "stream": stream,
        }

        try:
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                config.chat_endpoint,
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
                tokens = result.get("usage", {}).get("total_tokens", 0)
                return {
                    "success": True,
                    "content": content,
                    "tokens_used": tokens,
                    "error": None,
                }

        except urllib.error.URLError as e:
            return {
                "success": False,
                "content": "",
                "tokens_used": 0,
                "error": f"本地 API 不可达: {e.reason}",
            }
        except Exception as e:
            return {
                "success": False,
                "content": "",
                "tokens_used": 0,
                "error": str(e),
            }


# ============================================================
# 云端 API 调用客户端
# ============================================================

class CloudLLMClient:
    """云端 OpenAI 兼容 API 客户端"""

    def __init__(self):
        self.api_base = config.cloud_api_base
        self.api_key = config.cloud_api_key
        self.model = config.cloud_model

    def chat(
        self,
        messages: list[dict],
        max_tokens: int = 4096,
        temperature: float = 0.7,
        timeout: int = 60,
    ) -> dict:
        """调用云端 API"""
        payload = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": False,
        }

        try:
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                f"{self.api_base}/chat/completions",
                data=data,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.api_key}",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
                tokens = result.get("usage", {}).get("total_tokens", 0)
                return {
                    "success": True,
                    "content": content,
                    "tokens_used": tokens,
                    "error": None,
                }

        except Exception as e:
            return {
                "success": False,
                "content": "",
                "tokens_used": 0,
                "error": str(e),
            }


# ============================================================
# 任务路由器
# ============================================================

class TaskRouter:
    """任务分流路由器：分类 → 路由 → 调用 → fallback"""

    def __init__(self):
        self.classifier = TaskClassifier()
        self.local_client = LocalLLMClient()
        self.cloud_client = CloudLLMClient()
        self.stats = RouterStats()
        self._load_stats()

    # ── 持久化统计 ──

    def _stats_path(self) -> Path:
        return Path(r"D:\开发2\logs\router_stats.json")

    def _load_stats(self):
        try:
            p = self._stats_path()
            if p.is_file():
                data = json.loads(p.read_text("utf-8"))
                self.stats.local_calls = data.get("local_calls", 0)
                self.stats.cloud_calls = data.get("cloud_calls", 0)
                self.stats.local_failures = data.get("local_failures", 0)
                self.stats.local_fallbacks = data.get("local_fallbacks", 0)
                self.stats.local_tokens_used = data.get("local_tokens_used", 0)
                self.stats.cloud_tokens_used = data.get("cloud_tokens_used", 0)
        except Exception:
            pass

    def _save_stats(self):
        try:
            p = self._stats_path()
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps(self.stats.summary(), ensure_ascii=False, indent=2), "utf-8")
        except Exception:
            pass

    # ── 核心路由方法 ──

    def route(
        self,
        task_description: str,
        messages: list[dict] = None,
        context_length: int = 0,
    ) -> dict:
        """
        对任务进行分流处理。

        Args:
            task_description: 任务描述
            messages: 已构建的 messages 列表（可选，不传则用 task_description 构建）
            context_length: 关联文档的总字符数

        Returns:
            {
                "success": bool,
                "content": str,
                "target": "local" | "cloud",
                "category": str,
                "tokens_used": int,
                "latency_ms": int,
                "fallback": bool,         # 是否触发了 fallback
                "error": str | None,
            }
        """
        # 1. 分类
        route_result = self.classifier.classify(task_description, context_length)

        # 2. 构建 messages
        if messages is None:
            messages = [{"role": "user", "content": task_description}]

        # 3. 根据路由目标调用
        if route_result.target == TaskTarget.LOCAL:
            return self._call_local(messages, route_result)
        else:
            return self._call_cloud(messages, route_result)

    def _call_local(self, messages: list[dict], route_result: RouteResult) -> dict:
        """调用本地 API，失败时 fallback 云端"""
        t0 = time.time()

        result = self.local_client.chat(messages)
        latency = int((time.time() - t0) * 1000)

        if result["success"]:
            self.stats.record_local(result["tokens_used"], latency)
            self._save_stats()
            return {
                "success": True,
                "content": result["content"],
                "target": "local",
                "category": route_result.category.value,
                "tokens_used": result["tokens_used"],
                "latency_ms": latency,
                "fallback": False,
                "error": None,
            }

        # 本地失败 → fallback 云端
        self.stats.record_local_failure()
        log = lambda m: print(f"[Router] {m}", flush=True)
        log(f"本地调用失败: {result['error']}，回退云端...")

        t1 = time.time()
        cloud_result = self.cloud_client.chat(messages)
        cloud_latency = int((time.time() - t1) * 1000)

        if cloud_result["success"]:
            self.stats.record_fallback()
            self.stats.record_cloud(cloud_result["tokens_used"], cloud_latency)
            self._save_stats()
            return {
                "success": True,
                "content": cloud_result["content"],
                "target": "cloud",
                "category": route_result.category.value,
                "tokens_used": cloud_result["tokens_used"],
                "latency_ms": cloud_latency + latency,
                "fallback": True,
                "error": None,
            }

        # 云端也失败
        self._save_stats()
        return {
            "success": False,
            "content": "",
            "target": "cloud",
            "category": route_result.category.value,
            "tokens_used": 0,
            "latency_ms": cloud_latency + latency,
            "fallback": True,
            "error": f"本地: {result['error']}; 云端: {cloud_result['error']}",
        }

    def _call_cloud(self, messages: list[dict], route_result: RouteResult) -> dict:
        """直接调用云端 API"""
        t0 = time.time()
        result = self.cloud_client.chat(messages)
        latency = int((time.time() - t0) * 1000)

        if result["success"]:
            self.stats.record_cloud(result["tokens_used"], latency)
        self._save_stats()

        return {
            "success": result["success"],
            "content": result["content"],
            "target": "cloud",
            "category": route_result.category.value,
            "tokens_used": result["tokens_used"],
            "latency_ms": latency,
            "fallback": False,
            "error": result["error"],
        }

    # ── 工具方法 ──

    def get_stats(self) -> dict:
        return self.stats.summary()

    def is_local_available(self) -> bool:
        return self.local_client.health_check()


# ============================================================
# 全局单例
# ============================================================

router = TaskRouter()


# ============================================================
# HTTP 服务模式（供 Electron 主进程通过 HTTP 调用）
# ============================================================

def run_http_server(port: int = 8090):
    """启动 HTTP 服务，接收 JSON POST 请求"""
    from http.server import HTTPServer, BaseHTTPRequestHandler

    class RouterHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            if self.path == "/route":
                try:
                    content_length = int(self.headers.get("Content-Length", 0))
                    body = json.loads(self.rfile.read(content_length).decode("utf-8"))

                    task_desc = body.get("task", "")
                    messages = body.get("messages")
                    context_length = body.get("context_length", 0)

                    result = router.route(task_desc, messages, context_length)

                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))
                except Exception as e:
                    self.send_response(500)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))

            elif self.path == "/stats":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(router.get_stats(), ensure_ascii=False).encode("utf-8"))

            elif self.path == "/health":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": "ok",
                    "local_available": router.is_local_available(),
                }).encode("utf-8"))

            else:
                self.send_response(404)
                self.end_headers()

        def log_message(self, format, *args):
            pass  # 静默日志

    server = HTTPServer(("127.0.0.1", port), RouterHandler)
    print(f"[Router] HTTP 服务启动: http://127.0.0.1:{port}")
    print(f"[Router] 端点: POST /route, GET /stats, GET /health")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[Router] 服务已停止")


# ============================================================
# CLI 入口
# ============================================================

def main():
    import argparse

    parser = argparse.ArgumentParser(description="玄枢AI - 任务分流路由器")
    parser.add_argument("--serve", action="store_true", help="以 HTTP 服务模式运行")
    parser.add_argument("--port", type=int, default=8090, help="HTTP 服务端口 (默认: 8090)")
    parser.add_argument("--test", type=str, default=None, help="测试路由：输入任务描述，输出路由结果")
    parser.add_argument("--stats", action="store_true", help="显示统计信息")
    args = parser.parse_args()

    if args.serve:
        run_http_server(args.port)
    elif args.test:
        result = router.classifier.classify(args.test)
        print(f"\n任务描述: {args.test}")
        print(f"路由目标: {result.target.value}")
        print(f"任务类别: {result.category.value}")
        print(f"置信度:   {result.confidence}")
        print(f"原因:     {result.reason}")
    elif args.stats:
        print(json.dumps(router.get_stats(), ensure_ascii=False, indent=2))
    else:
        # 交互模式
        print("玄枢AI - 任务分流路由器")
        print("输入任务描述，查看路由结果。输入 'stats' 查看统计，'quit' 退出。\n")
        while True:
            try:
                user_input = input("> ").strip()
                if not user_input:
                    continue
                if user_input.lower() in ("quit", "exit", "q"):
                    break
                if user_input.lower() == "stats":
                    print(json.dumps(router.get_stats(), ensure_ascii=False, indent=2))
                    continue

                result = router.classifier.classify(user_input)
                print(f"  -> {result.target.value} | {result.category.value} "
                      f"(置信度: {result.confidence:.0%}) | {result.reason}")
            except (KeyboardInterrupt, EOFError):
                break


if __name__ == "__main__":
    main()
