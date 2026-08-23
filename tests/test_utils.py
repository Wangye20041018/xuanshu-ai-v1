"""
DI Container 单元测试
"""
import pytest
from unittest.mock import Mock


# Simple DI implementation for Python side
class DIContainer:
    """Minimal DI container for Python services."""

    def __init__(self):
        self._registry = {}
        self._instances = {}

    def register(self, token: str, factory, singleton: bool = True):
        self._registry[token] = (factory, singleton)

    def register_instance(self, token: str, instance):
        self._instances[token] = instance

    def resolve(self, token: str):
        if token in self._instances:
            return self._instances[token]
        factory, singleton = self._registry[token]
        instance = factory(self)
        if singleton:
            self._instances[token] = instance
        return instance

    def has(self, token: str) -> bool:
        return token in self._registry or token in self._instances


class TestDIContainer:
    def test_register_and_resolve_singleton(self):
        container = DIContainer()
        container.register("test", lambda c: {"value": 42})

        a = container.resolve("test")
        b = container.resolve("test")

        assert a["value"] == 42
        assert a is b  # 单例

    def test_register_transient(self):
        container = DIContainer()
        container.register("test", lambda c: {"value": 42}, singleton=False)

        a = container.resolve("test")
        b = container.resolve("test")

        assert a is not b  # 瞬态

    def test_register_instance(self):
        container = DIContainer()
        instance = {"value": 100}
        container.register_instance("test", instance)

        assert container.resolve("test") is instance

    def test_has_token(self):
        container = DIContainer()
        assert not container.has("test")
        container.register("test", lambda c: None)
        assert container.has("test")

    def test_unregistered_token_raises(self):
        container = DIContainer()
        with pytest.raises(KeyError):
            container.resolve("nonexistent")


class TestResilience:
    """Resilience patterns unit tests."""

    def test_retry_success_first_attempt(self, event_loop):
        call_count = 0

        async def success_fn():
            nonlocal call_count
            call_count += 1
            return "ok"

        async def with_retry(fn, max_retries=3, backoff=10):
            for attempt in range(max_retries + 1):
                try:
                    return await fn()
                except Exception:
                    if attempt == max_retries:
                        raise
            return None

        result = event_loop.run_until_complete(with_retry(success_fn))
        assert result == "ok"
        assert call_count == 1

    def test_retry_with_failures(self, event_loop):
        call_count = 0

        async def failing_fn():
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise ValueError("transient error")
            return "recovered"

        async def with_retry(fn, max_retries=5, backoff=10):
            last_error = None
            for attempt in range(max_retries + 1):
                try:
                    return await fn()
                except Exception as e:
                    last_error = e
            raise last_error

        result = event_loop.run_until_complete(with_retry(failing_fn))
        assert result == "recovered"
        assert call_count == 3

    def test_retry_exhausted(self, event_loop):
        async def always_fail():
            raise ValueError("permanent error")

        async def with_retry(fn, max_retries=2, backoff=10):
            for _ in range(max_retries + 1):
                try:
                    return await fn()
                except Exception:
                    pass
            raise RuntimeError("All retries exhausted")

        with pytest.raises(RuntimeError, match="All retries exhausted"):
            event_loop.run_until_complete(with_retry(always_fail))

    def test_circuit_breaker_trips(self, event_loop):
        failures = 0

        async def fail_then_succeed():
            nonlocal failures
            failures += 1
            if failures <= 3:
                raise ConnectionError("unavailable")
            return "ok"

        state = "CLOSED"
        fail_count = 0
        threshold = 3

        async def execute_with_cb(fn):
            nonlocal state, fail_count
            if state == "OPEN":
                raise RuntimeError("Circuit OPEN")
            try:
                result = await fn()
                state = "CLOSED"
                fail_count = 0
                return result
            except Exception as e:
                fail_count += 1
                if fail_count >= threshold:
                    state = "OPEN"
                raise e

        # 前 3 次失败，第 3 次触发熔断
        for _ in range(3):
            with pytest.raises((ConnectionError, RuntimeError)):
                event_loop.run_until_complete(execute_with_cb(fail_then_succeed))

        assert state == "OPEN"

    def test_circuit_breaker_rejects_when_open(self, event_loop):
        state = "OPEN"

        async def healthy_fn():
            return "ok"

        async def execute_with_cb(fn):
            if state == "OPEN":
                raise RuntimeError("Circuit OPEN")
            return await fn()

        with pytest.raises(RuntimeError, match="Circuit OPEN"):
            event_loop.run_until_complete(execute_with_cb(healthy_fn))


class TestInputSanitizer:
    """Input sanitization unit tests."""

    def test_escape_html(self):
        from html import escape
        assert escape("<script>alert(1)</script>") == "&lt;script&gt;alert(1)&lt;/script&gt;"
        assert escape('"quoted"') == "&quot;quoted&quot;"
        assert escape("safe text") == "safe text"

    def test_sanitize_user_text(self):
        import re
        def sanitize(text):
            text = re.sub(r'<script\b[^<]*(?:(?!</script>)<[^<]*)*</script>', '', text, flags=re.IGNORECASE)
            text = re.sub(r'on\w+\s*=\s*"[^"]*"', '', text, flags=re.IGNORECASE)
            text = re.sub(r'javascript\s*:', '', text, flags=re.IGNORECASE)
            return text.strip()

        assert sanitize('<script>alert(1)</script>hello') == 'hello'
        assert sanitize('<div onclick="alert(1)">click</div>') == '<div >click</div>'
        assert sanitize('javascript:void(0)') == 'void(0)'

    def test_path_sanitization(self):
        def sanitize_path(p):
            return p.replace('..', '').replace('<', '_').replace('>', '_')

        assert sanitize_path('../../../etc/passwd') == '///etc/passwd'
        assert sanitize_path('safe/path/file.txt') == 'safe/path/file.txt'
