"""
玄枢 AI Engine v3.1 — 多浏览器搜索引擎
=========================================
主引擎: Edge WebView2 (Win11 内置，零部署)
副引擎: Chrome DevTools Protocol / Firefox Marionette
搜索引擎后端: Bing / Google CSE / Baidu / DuckDuckGo (多路并发)

调度策略:
  - 中文问题 → Bing + Baidu 并发
  - 技术问题 → Google + Bing 并发
  - 隐私问题 → DuckDuckGo only
  - 综合调研 → 三引擎并发 + 交叉验证

每个搜索结果包含: title, url, snippet, source_engine, relevance_score
"""

import os
import sys
import re
import json
import time
import random
import hashlib
import threading
import concurrent.futures
from typing import Optional, List, Dict, Callable
from dataclasses import dataclass, field
from urllib.parse import quote_plus, urlparse

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# --- 日志 ---
import logging
logger = logging.getLogger("xuanshu-search")

# ============================================================================
# 数据结构
# ============================================================================
@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str
    source_engine: str           # "bing" | "google" | "baidu" | "duckduckgo"
    relevance_score: float = 0.0  # 0.0 ~ 1.0


# ============================================================================
# 反爬策略
# ============================================================================
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
]

def _random_ua() -> str:
    return random.choice(USER_AGENTS)

def _create_session() -> requests.Session:
    """创建带重试和随机 UA 的 session"""
    session = requests.Session()
    retry = Retry(total=3, backoff_factor=0.5, status_forcelist=[429, 500, 502, 503, 504])
    adapter = HTTPAdapter(max_retries=retry, pool_connections=5, pool_maxsize=10)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update({
        "User-Agent": _random_ua(),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate",
    })
    return session


# ============================================================================
# 各搜索引擎后端
# ============================================================================
class BingBackend:
    """Bing 搜索（免费网页抓取，无需 API Key）"""
    NAME = "bing"

    def search(self, query: str, max_results: int = 10) -> List[SearchResult]:
        results = []
        try:
            session = _create_session()
            url = f"https://www.bing.com/search?q={quote_plus(query)}&count={max_results}"
            resp = session.get(url, timeout=15)
            resp.raise_for_status()

            # 简单正则提取（Bing 搜索结果在 <li class="b_algo"> 中）
            html = resp.text
            # 匹配标题链接
            link_pattern = re.compile(
                r'<h2[^>]*>.*?<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
                re.DOTALL | re.IGNORECASE
            )
            snippet_pattern = re.compile(
                r'<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>(.*?)</p>',
                re.DOTALL
            )

            links = link_pattern.findall(html)
            snippets = snippet_pattern.findall(html)

            for i, (href, title) in enumerate(links[:max_results]):
                clean_title = re.sub(r'<.*?>', '', title).strip()
                if not clean_title or not href.startswith("http"):
                    continue
                snippet = ""
                if i < len(snippets):
                    snippet = re.sub(r'<.*?>', '', snippets[i]).strip()

                results.append(SearchResult(
                    title=clean_title,
                    url=href,
                    snippet=snippet[:500],
                    source_engine=self.NAME,
                    relevance_score=1.0 - i * 0.1,
                ))

            time.sleep(random.uniform(0.5, 1.5))  # 请求间隔
        except Exception as e:
            logger.warning(f"Bing 搜索异常: {e}")
        return results


class DuckDuckGoBackend:
    """DuckDuckGo 搜索（HTML 版，免费无限）"""
    NAME = "duckduckgo"

    def search(self, query: str, max_results: int = 10) -> List[SearchResult]:
        results = []
        try:
            session = _create_session()
            url = "https://html.duckduckgo.com/html/"
            data = {"q": query, "kl": "cn-zh"}
            resp = session.post(url, data=data, timeout=15)
            resp.raise_for_status()

            html = resp.text
            # DuckDuckGo HTML 结果在 class="result"
            result_pattern = re.compile(
                r'<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
                re.DOTALL
            )
            snippet_pattern = re.compile(
                r'<a[^>]*class="result__snippet"[^>]*>(.*?)</a>',
                re.DOTALL
            )

            links = result_pattern.findall(html)
            snippets = snippet_pattern.findall(html)

            for i, (href, title) in enumerate(links[:max_results]):
                clean_title = re.sub(r'<.*?>', '', title).strip()
                if not clean_title:
                    continue
                snippet = ""
                if i < len(snippets):
                    snippet = re.sub(r'<.*?>', '', snippets[i]).strip()

                results.append(SearchResult(
                    title=clean_title,
                    url=href,
                    snippet=snippet[:500],
                    source_engine=self.NAME,
                    relevance_score=1.0 - i * 0.1,
                ))

            time.sleep(random.uniform(0.3, 1.0))
        except Exception as e:
            logger.warning(f"DuckDuckGo 搜索异常: {e}")
        return results


class GoogleBackend:
    """Google CSE (Custom Search Engine) — 需 API Key（可选）"""
    NAME = "google"

    def __init__(self, api_key: str = "", cse_id: str = ""):
        self.api_key = api_key
        self.cse_id = cse_id

    def search(self, query: str, max_results: int = 10) -> List[SearchResult]:
        results = []
        if not self.api_key or not self.cse_id:
            logger.debug("Google CSE 未配置 API Key，跳过")
            return results

        try:
            url = "https://www.googleapis.com/customsearch/v1"
            params = {
                "key": self.api_key,
                "cx": self.cse_id,
                "q": query,
                "num": min(max_results, 10),
                "hl": "zh-CN",
            }
            resp = requests.get(url, params=params, timeout=15)
            resp.raise_for_status()
            data = resp.json()

            for i, item in enumerate(data.get("items", [])):
                results.append(SearchResult(
                    title=item.get("title", ""),
                    url=item.get("link", ""),
                    snippet=item.get("snippet", "")[:500],
                    source_engine=self.NAME,
                    relevance_score=1.0 - i * 0.08,
                ))
        except Exception as e:
            logger.warning(f"Google CSE 搜索异常: {e}")
        return results


class BaiduBackend:
    """百度搜索（网页抓取）"""
    NAME = "baidu"

    def search(self, query: str, max_results: int = 10) -> List[SearchResult]:
        results = []
        try:
            session = _create_session()
            url = f"https://www.baidu.com/s?wd={quote_plus(query)}&rn={max_results}"
            resp = session.get(url, timeout=15)
            resp.raise_for_status()
            resp.encoding = "utf-8"

            html = resp.text
            # 百度搜索结果
            result_pattern = re.compile(
                r'<h3[^>]*class="[^"]*t[^"]*"[^>]*>.*?<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
                re.DOTALL
            )
            snippet_pattern = re.compile(
                r'<span[^>]*class="[^"]*content-right_[^"]*"[^>]*>(.*?)</span>',
                re.DOTALL
            )

            links = result_pattern.findall(html)
            snippets = snippet_pattern.findall(html)

            for i, (href, title) in enumerate(links[:max_results]):
                clean_title = re.sub(r'<.*?>', '', title).strip()
                if not clean_title:
                    continue
                snippet = ""
                if i < len(snippets):
                    snippet = re.sub(r'<.*?>', '', snippets[i]).strip()

                results.append(SearchResult(
                    title=clean_title,
                    url=href,
                    snippet=snippet[:500],
                    source_engine=self.NAME,
                    relevance_score=1.0 - i * 0.1,
                ))

            time.sleep(random.uniform(0.8, 2.0))
        except Exception as e:
            logger.warning(f"百度搜索异常: {e}")
        return results


# ============================================================================
# WebView2 浏览器操控（预留接口）
# ============================================================================
class EdgeWebView2Controller:
    """通过 COM 接口操控 Edge WebView2（Win11 内置）"""

    def __init__(self):
        self._available = False
        self._controller = None
        self._detect()

    def _detect(self):
        """检测 WebView2 是否可用"""
        try:
            # 检查 Edge 是否安装
            edge_paths = [
                r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            ]
            for p in edge_paths:
                if os.path.exists(p):
                    self._available = True
                    logger.info(f"检测到 Edge: {p}")
                    break
            if not self._available:
                logger.debug("Edge 未安装，WebView2 不可用")
        except Exception as e:
            logger.debug(f"WebView2 检测失败: {e}")

    def is_available(self) -> bool:
        return self._available

    def open_url(self, url: str) -> None:
        """BUG-007: 浏览器自动化尚未实现"""
        raise NotImplementedError(
            "EdgeWebView2Controller.open_url: 浏览器自动化尚未实现（BUG-007）。需对接 Playwright/Selenium/Windows UI Automation。"
        )

    def fill_form(self, selector: str, value: str) -> None:
        """BUG-007: 浏览器自动化尚未实现"""
        raise NotImplementedError(
            "EdgeWebView2Controller.fill_form: 浏览器自动化尚未实现（BUG-007）。需对接 Playwright/Selenium。"
        )

    def fetch_page(self, url: str) -> Optional[str]:
        """通过 Edge WebView2 抓取页面（需 pywebview 或直接 http）"""
        try:
            session = _create_session()
            resp = session.get(url, timeout=20)
            resp.raise_for_status()
            return resp.text
        except Exception as e:
            logger.warning(f"抓取页面失败 {url}: {e}")
            return None


class ChromeDevToolsController:
    """Chrome DevTools Protocol 操控"""

    def __init__(self):
        self._available = False
        self._detect()

    def _detect(self):
        chrome_paths = [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        ]
        for p in chrome_paths:
            if os.path.exists(p):
                self._available = True
                break

    def is_available(self) -> bool:
        return self._available

    def open_url(self, url: str) -> None:
        """BUG-007: 浏览器自动化尚未实现"""
        raise NotImplementedError(
            "ChromeDevToolsController.open_url: 浏览器自动化尚未实现（BUG-007）。需对接 Playwright/Selenium。"
        )

    def fill_form(self, selector: str, value: str) -> None:
        """BUG-007: 浏览器自动化尚未实现"""
        raise NotImplementedError(
            "ChromeDevToolsController.fill_form: 浏览器自动化尚未实现（BUG-007）。需对接 Playwright/Selenium。"
        )


class FirefoxMarionetteController:
    """Firefox Marionette 操控"""

    def __init__(self):
        self._available = False
        self._detect()

    def _detect(self):
        firefox_paths = [
            r"C:\Program Files\Mozilla Firefox\firefox.exe",
            r"C:\Program Files (x86)\Mozilla Firefox\firefox.exe",
        ]
        for p in firefox_paths:
            if os.path.exists(p):
                self._available = True
                break

    def is_available(self) -> bool:
        return self._available

    def open_url(self, url: str) -> None:
        """BUG-007: 浏览器自动化尚未实现"""
        raise NotImplementedError(
            "FirefoxMarionetteController.open_url: 浏览器自动化尚未实现（BUG-007）。需对接 Playwright/Selenium。"
        )

    def fill_form(self, selector: str, value: str) -> None:
        """BUG-007: 浏览器自动化尚未实现"""
        raise NotImplementedError(
            "FirefoxMarionetteController.fill_form: 浏览器自动化尚未实现（BUG-007）。需对接 Playwright/Selenium。"
        )


# ============================================================================
# 搜索引擎调度
# ============================================================================
class SearchEngine:
    """
    多浏览器搜索引擎。

    用法:
        engine = SearchEngine()
        results = engine.search("Python 异步编程")
        page_text = engine.fetch_page("https://example.com")
    """

    # 语言检测关键词
    _CN_KEYWORDS = set("的一是不了在有人我他这为之来以个们到说和地也得自时与中你他会国学子成去过家能对现要多从下还天年进位都作经把" +
                       "中国北京上海广州深圳杭州成都南京武汉西安重庆苏州天津长沙青岛郑州大连福州合肥济南沈阳昆明南昌南宁长春" +
                       "中文汉语普通话简体字怎么什么为什么哪里哪个如何")

    def __init__(self):
        self._backends = {
            "bing": BingBackend(),
            "duckduckgo": DuckDuckGoBackend(),
            "google": GoogleBackend(),   # 需要 API key
            "baidu": BaiduBackend(),
        }
        self._webview2 = EdgeWebView2Controller()
        self._chrome = ChromeDevToolsController()
        self._firefox = FirefoxMarionetteController()
        self._session = _create_session()

    def search(self, query: str, engine_strategy: str = "auto",
               max_results: int = 15) -> List[SearchResult]:
        """
        执行多引擎搜索。

        engine_strategy:
          - "auto": 根据问题语言/类型自动选择引擎
          - "bing": 仅 Bing
          - "baidu": 仅百度
          - "duckduckgo": 仅 DuckDuckGo
          - "google": 仅 Google
          - "all": 全部并发
          - "zh": Bing + Baidu
          - "tech": Google + Bing
          - "privacy": DuckDuckGo only
        """
        engines_to_use = self._resolve_strategy(query, engine_strategy)
        logger.info(f"搜索策略: {engine_strategy} → 引擎: {engines_to_use}")

        all_results = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            futures = {}
            for eng_name in engines_to_use:
                backend = self._backends.get(eng_name)
                if backend is None:
                    continue
                futures[executor.submit(backend.search, query, max_results)] = eng_name

            for future in concurrent.futures.as_completed(futures):
                eng_name = futures[future]
                try:
                    results = future.result(timeout=20)
                    all_results.extend(results)
                    logger.debug(f"{eng_name}: {len(results)} 条结果")
                except Exception as e:
                    logger.warning(f"{eng_name} 搜索超时或失败: {e}")

        # 去重 + 排序
        merged = self._deduplicate_and_rank(all_results)
        return merged[:max_results]

    def fetch_page(self, url: str) -> Optional[str]:
        """抓取单个页面正文"""
        try:
            resp = self._session.get(url, timeout=20)
            resp.raise_for_status()
            html = resp.text
            # 简单提取正文（去掉 script/style 标签）
            cleaned = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
            cleaned = re.sub(r'<style[^>]*>.*?</style>', '', cleaned, flags=re.DOTALL | re.IGNORECASE)
            cleaned = re.sub(r'<[^>]+>', ' ', cleaned)
            cleaned = re.sub(r'\s+', ' ', cleaned).strip()
            return cleaned[:10000]
        except Exception as e:
            logger.warning(f"抓取失败: {e}")
            return None

    def _resolve_strategy(self, query: str, strategy: str) -> List[str]:
        """根据策略决定使用哪些搜索引擎"""
        if strategy == "all":
            return ["bing", "baidu", "google", "duckduckgo"]
        if strategy == "zh":
            return ["bing", "baidu"]
        if strategy == "tech":
            return ["google", "bing"]
        if strategy == "privacy":
            return ["duckduckgo"]
        if strategy in self._backends:
            return [strategy]

        # auto: 智能判断
        return self._auto_select(query)

    def _auto_select(self, query: str) -> List[str]:
        """自动选择搜索引擎"""
        # 检测是否中文
        cn_count = sum(1 for ch in query if ch in self._CN_KEYWORDS)
        is_cn = cn_count > len(query) * 0.15

        # 检测技术关键词
        tech_keywords = [
            "python", "java", "javascript", "react", "vue", "docker", "kubernetes",
            "api", "sdk", "sdk", "http", "git", "linux", "sql", "mongodb",
            "编程", "代码", "框架", "部署", "配置", "bug", "error", "npm", "pip",
            "algorithm", "算法", "ai", "ml", "深度学习", "神经网络",
        ]
        is_tech = any(kw.lower() in query.lower() for kw in tech_keywords)

        # 隐私相关
        privacy_keywords = ["隐私", "匿名", "无痕", "加密", "tor", "vpn"]
        is_privacy = any(kw.lower() in query.lower() for kw in privacy_keywords)

        if is_privacy:
            return ["duckduckgo"]
        if is_cn:
            return ["bing", "baidu"]
        if is_tech:
            return ["google", "bing"]
        # 综合调研
        return ["bing", "baidu", "duckduckgo"]

    def _deduplicate_and_rank(self, results: List[SearchResult]) -> List[SearchResult]:
        """去重 + 相关性排序"""
        seen_urls = set()
        unique = []

        # 按相关性降序
        sorted_results = sorted(results, key=lambda r: r.relevance_score, reverse=True)

        for r in sorted_results:
            # 标准化 URL 用于去重
            norm_url = self._normalize_url(r.url)
            url_hash = hashlib.md5(norm_url.encode()).hexdigest()
            if url_hash not in seen_urls:
                seen_urls.add(url_hash)
                unique.append(r)

        return unique

    @staticmethod
    def _normalize_url(url: str) -> str:
        """标准化 URL 用于去重"""
        try:
            parsed = urlparse(url)
            return f"{parsed.scheme}://{parsed.netloc}{parsed.path}".rstrip("/").lower()
        except Exception:
            return url.lower()


# ============================================================================
# 测试入口
# ============================================================================
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")

    engine = SearchEngine()
    query = "Python asyncio 最佳实践"
    print(f"\n搜索: {query}\n")

    results = engine.search(query, engine_strategy="auto", max_results=10)
    for i, r in enumerate(results):
        print(f"{i+1}. [{r.source_engine}] {r.title}")
        print(f"   {r.url}")
        print(f"   {r.snippet[:120]}")
        print()
