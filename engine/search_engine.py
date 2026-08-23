"""
玄枢 AI Engine v11.2.0 — 多浏览器搜索引擎
==========================================
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
# 浏览器自动化基类（Playwright 优先，Selenium 降级）
# ============================================================================
class _BrowserAutomationBase:
    """浏览器自动化共享实现：Playwright → Selenium 降级链"""

    _playwright_available = None  # 类级别缓存
    _selenium_available = None

    def __init__(self, browser_type: str, browser_path: str):
        """
        browser_type: "chromium" | "firefox"
        browser_path: 可执行文件路径
        """
        self._browser_type = browser_type
        self._browser_path = browser_path
        self._driver = None      # Playwright Browser / Selenium WebDriver
        self._page = None        # Playwright Page / Selenium 等价
        self._using_selenium = False

    @classmethod
    def _check_playwright(cls) -> bool:
        if cls._playwright_available is None:
            try:
                from playwright.sync_api import sync_playwright
                cls._playwright_available = True
            except ImportError:
                cls._playwright_available = False
                logger.debug("Playwright 未安装")
        return cls._playwright_available

    @classmethod
    def _check_selenium(cls) -> bool:
        if cls._selenium_available is None:
            try:
                from selenium import webdriver
                cls._selenium_available = True
            except ImportError:
                cls._selenium_available = False
                logger.debug("Selenium 未安装")
        return cls._selenium_available

    # ── 公开接口 ──

    def open_url(self, url: str, headless: bool = False) -> None:
        """打开浏览器并导航到指定 URL"""
        self.close()  # 确保干净状态

        if self._check_playwright():
            self._open_playwright(url, headless)
        elif self._check_selenium():
            self._open_selenium(url, headless)
        else:
            raise RuntimeError(
                "浏览器自动化不可用：请安装 playwright（pip install playwright && playwright install）"
                " 或 selenium（pip install selenium）"
            )

    def fill_form(self, selector: str, text: str) -> None:
        """定位表单元素并填入文本"""
        if self._page is None:
            raise RuntimeError("fill_form: 请先调用 open_url 打开页面")
        if self._using_selenium:
            elem = self._page.find_element("css selector", selector)
            elem.clear()
            elem.send_keys(text)
        else:
            self._page.fill(selector, text)

    def click(self, selector: str) -> None:
        """点击指定元素"""
        if self._page is None:
            raise RuntimeError("click: 请先调用 open_url 打开页面")
        if self._using_selenium:
            self._page.find_element("css selector", selector).click()
        else:
            self._page.click(selector)

    def get_page_text(self) -> str:
        """获取页面纯文本内容"""
        if self._page is None:
            raise RuntimeError("get_page_text: 请先调用 open_url 打开页面")
        if self._using_selenium:
            return self._page.find_element("tag name", "body").text
        else:
            return self._page.inner_text("body")

    def screenshot(self) -> str:
        """截图并返回 base64 编码字符串"""
        if self._page is None:
            raise RuntimeError("screenshot: 请先调用 open_url 打开页面")
        import base64
        if self._using_selenium:
            png_bytes = self._page.get_screenshot_as_png()
        else:
            png_bytes = self._page.screenshot(type="png")
        return base64.b64encode(png_bytes).decode("ascii")

    def close(self) -> None:
        """关闭浏览器实例"""
        if self._driver is not None:
            try:
                self._driver.close()
            except Exception:
                pass
            self._driver = None
            self._page = None
            self._using_selenium = False

    # ── 内部实现 ──

    def _open_playwright(self, url: str, headless: bool) -> None:
        from playwright.sync_api import sync_playwright
        self._pw = sync_playwright().start()
        browser_launcher = getattr(self._pw, self._browser_type)
        self._driver = browser_launcher.launch(
            headless=headless,
            executable_path=self._browser_path or None,
        )
        self._page = self._driver.new_page()
        self._page.goto(url)
        self._using_selenium = False
        logger.info(f"Playwright {self._browser_type}: 已打开 {url}")

    def _open_selenium(self, url: str, headless: bool) -> None:
        from selenium import webdriver
        from selenium.webdriver.chrome.service import Service as ChromeService
        from selenium.webdriver.firefox.service import Service as FirefoxService
        from selenium.webdriver.chrome.options import Options as ChromeOptions
        from selenium.webdriver.firefox.options import Options as FirefoxOptions

        if self._browser_type == "firefox":
            options = FirefoxOptions()
            if headless:
                options.add_argument("--headless")
            service = FirefoxService(executable_path=self._browser_path) if self._browser_path else None
            self._driver = webdriver.Firefox(service=service, options=options)
        else:
            options = ChromeOptions()
            if headless:
                options.add_argument("--headless=new")
            if self._browser_path:
                options.binary_location = self._browser_path
            self._driver = webdriver.Chrome(options=options)

        self._page = self._driver
        self._page.get(url)
        self._using_selenium = True
        logger.info(f"Selenium {self._browser_type}: 已打开 {url}")


# ============================================================================
# 浏览器控制器（复用 _BrowserAutomationBase）
# ============================================================================
class EdgeWebView2Controller:
    """通过 Playwright/Selenium 操控 Edge（Win11 内置）"""

    def __init__(self):
        self._available = False
        self._edge_path = ""
        self._auto = None
        self._detect()

    def _detect(self):
        """检测 Edge 路径（注册表优先，环境变量兜底）"""
        # 1) 从注册表读取
        try:
            import winreg
            for root, key, name in [
                (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe", ""),
                (winreg.HKEY_CURRENT_USER,  r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe", ""),
                (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe", ""),
            ]:
                try:
                    hkey = winreg.OpenKey(root, key)
                    self._edge_path, _ = winreg.QueryValueEx(hkey, "")
                    winreg.CloseKey(hkey)
                    if self._edge_path and os.path.exists(self._edge_path):
                        self._available = True
                        logger.info(f"Edge（注册表）: {self._edge_path}")
                        return
                except OSError:
                    continue
        except Exception:
            pass

        # 2) 从环境变量 PATH 搜索
        for p in os.environ.get("PATH", "").split(os.pathsep):
            candidate = os.path.join(p, "msedge.exe")
            if os.path.exists(candidate):
                self._edge_path = candidate
                self._available = True
                logger.info(f"Edge（PATH）: {self._edge_path}")
                return

        # 3) 常见安装路径兜底
        common_paths = [
            os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
            os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
            os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"),
        ]
        for p in common_paths:
            if os.path.exists(p):
                self._edge_path = p
                self._available = True
                logger.info(f"Edge（常见路径）: {self._edge_path}")
                return

        logger.debug("Edge 未检测到")

    def is_available(self) -> bool:
        return self._available

    def open_url(self, url: str, headless: bool = False) -> None:
        self._auto = _BrowserAutomationBase("chromium", self._edge_path)
        self._auto.open_url(url, headless)

    def fill_form(self, selector: str, value: str) -> None:
        self._auto.fill_form(selector, value)

    def click(self, selector: str) -> None:
        self._auto.click(selector)

    def get_page_text(self) -> str:
        return self._auto.get_page_text()

    def screenshot(self) -> str:
        return self._auto.screenshot()

    def close(self) -> None:
        if self._auto is not None:
            self._auto.close()
            self._auto = None

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
    """通过 Playwright/Selenium 操控 Chrome"""

    def __init__(self):
        self._available = False
        self._chrome_path = ""
        self._auto = None
        self._detect()

    def _detect(self):
        """检测 Chrome 路径（注册表优先，环境变量兜底）"""
        try:
            import winreg
            for root, key in [
                (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"),
                (winreg.HKEY_CURRENT_USER,  r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"),
                (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"),
            ]:
                try:
                    hkey = winreg.OpenKey(root, key)
                    self._chrome_path, _ = winreg.QueryValueEx(hkey, "")
                    winreg.CloseKey(hkey)
                    if self._chrome_path and os.path.exists(self._chrome_path):
                        self._available = True
                        logger.info(f"Chrome（注册表）: {self._chrome_path}")
                        return
                except OSError:
                    continue
        except Exception:
            pass

        for p in os.environ.get("PATH", "").split(os.pathsep):
            candidate = os.path.join(p, "chrome.exe")
            if os.path.exists(candidate):
                self._chrome_path = candidate
                self._available = True
                logger.info(f"Chrome（PATH）: {self._chrome_path}")
                return

        common_paths = [
            os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        ]
        for p in common_paths:
            if os.path.exists(p):
                self._chrome_path = p
                self._available = True
                logger.info(f"Chrome（常见路径）: {self._chrome_path}")
                return

        logger.debug("Chrome 未检测到")

    def is_available(self) -> bool:
        return self._available

    def open_url(self, url: str, headless: bool = False) -> None:
        self._auto = _BrowserAutomationBase("chromium", self._chrome_path)
        self._auto.open_url(url, headless)

    def fill_form(self, selector: str, value: str) -> None:
        self._auto.fill_form(selector, value)

    def click(self, selector: str) -> None:
        self._auto.click(selector)

    def get_page_text(self) -> str:
        return self._auto.get_page_text()

    def screenshot(self) -> str:
        return self._auto.screenshot()

    def close(self) -> None:
        if self._auto is not None:
            self._auto.close()
            self._auto = None


class FirefoxMarionetteController:
    """通过 Playwright/Selenium 操控 Firefox"""

    def __init__(self):
        self._available = False
        self._firefox_path = ""
        self._auto = None
        self._detect()

    def _detect(self):
        """检测 Firefox 路径（注册表优先，环境变量兜底）"""
        try:
            import winreg
            for root, key in [
                (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Mozilla\Mozilla Firefox"),
                (winreg.HKEY_CURRENT_USER,  r"SOFTWARE\Mozilla\Mozilla Firefox"),
                (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Mozilla\Mozilla Firefox"),
            ]:
                try:
                    hkey = winreg.OpenKey(root, key)
                    path_key = hkey
                    try:
                        subkey = winreg.OpenKey(path_key, r"bin")
                        self._firefox_path, _ = winreg.QueryValueEx(subkey, "PathToExe")
                        winreg.CloseKey(subkey)
                    except OSError:
                        self._firefox_path, _ = winreg.QueryValueEx(path_key, "")
                    winreg.CloseKey(hkey)
                    ff = self._firefox_path
                    if ff and not ff.endswith("firefox.exe"):
                        ff = os.path.join(ff, "firefox.exe")
                    if ff and os.path.exists(ff):
                        self._firefox_path = ff
                        self._available = True
                        logger.info(f"Firefox（注册表）: {self._firefox_path}")
                        return
                except OSError:
                    continue
        except Exception:
            pass

        for p in os.environ.get("PATH", "").split(os.pathsep):
            candidate = os.path.join(p, "firefox.exe")
            if os.path.exists(candidate):
                self._firefox_path = candidate
                self._available = True
                logger.info(f"Firefox（PATH）: {self._firefox_path}")
                return

        common_paths = [
            os.path.expandvars(r"%ProgramFiles%\Mozilla Firefox\firefox.exe"),
            os.path.expandvars(r"%ProgramFiles(x86)%\Mozilla Firefox\firefox.exe"),
        ]
        for p in common_paths:
            if os.path.exists(p):
                self._firefox_path = p
                self._available = True
                logger.info(f"Firefox（常见路径）: {self._firefox_path}")
                return

        logger.debug("Firefox 未检测到")

    def is_available(self) -> bool:
        return self._available

    def open_url(self, url: str, headless: bool = False) -> None:
        self._auto = _BrowserAutomationBase("firefox", self._firefox_path)
        self._auto.open_url(url, headless)

    def fill_form(self, selector: str, value: str) -> None:
        self._auto.fill_form(selector, value)

    def click(self, selector: str) -> None:
        self._auto.click(selector)

    def get_page_text(self) -> str:
        return self._auto.get_page_text()

    def screenshot(self) -> str:
        return self._auto.screenshot()

    def close(self) -> None:
        if self._auto is not None:
            self._auto.close()
            self._auto = None


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
            # 标准化 URL 用于去重（L-06 修复：改用 SHA256）
            norm_url = self._normalize_url(r.url)
            url_hash = hashlib.sha256(norm_url.encode()).hexdigest()
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
