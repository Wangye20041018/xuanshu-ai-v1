"""
基础 API 单元测试 — 对 api_server.py 的四个核心端点进行冒烟测试。

运行: pytest tests/test_api.py -v
"""

import json


class TestHealthEndpoint:
    """GET /health"""

    def test_returns_200(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200

    def test_returns_ok_status(self, client):
        resp = client.get("/health")
        data = resp.get_json()
        assert data["status"] == "ok"

    def test_contains_model_field(self, client):
        resp = client.get("/health")
        data = resp.get_json()
        assert "model" in data


class TestVersionEndpoint:
    """GET /version"""

    def test_returns_200(self, client):
        resp = client.get("/version")
        assert resp.status_code == 200

    def test_has_version_field(self, client):
        resp = client.get("/version")
        data = resp.get_json()
        assert "version" in data

    def test_has_engine_field(self, client):
        resp = client.get("/version")
        data = resp.get_json()
        assert data["engine"] == "xuanshu-ai"

    def test_version_not_empty(self, client):
        resp = client.get("/version")
        data = resp.get_json()
        assert len(data["version"]) > 0


class TestStatusEndpoint:
    """GET /status"""

    def test_returns_200(self, client):
        resp = client.get("/status")
        assert resp.status_code == 200

    def test_contains_core_fields(self, client):
        resp = client.get("/status")
        data = resp.get_json()
        required = ["status", "uptime", "current_mode", "total_requests",
                    "streaming_enabled", "gpu", "memory", "cpu"]
        for field in required:
            assert field in data, f"Missing field: {field}"

    def test_status_is_running(self, client):
        resp = client.get("/status")
        data = resp.get_json()
        assert data["status"] == "running"

    def test_models_section_exists(self, client):
        resp = client.get("/status")
        data = resp.get_json()
        assert "models" in data
        assert "draft_9b" in data["models"]


class TestConfigEndpoint:
    """GET /config"""

    def test_returns_200_or_404(self, client):
        resp = client.get("/config")
        assert resp.status_code in (200, 404)

    def test_returns_json(self, client):
        resp = client.get("/config")
        data = resp.get_json()
        assert isinstance(data, dict)

    def test_response_is_parseable(self, client):
        resp = client.get("/config")
        assert resp.content_type == "application/json"


class TestChatEndpoint:
    """POST /chat — 基本结构测试"""

    def test_empty_body_rejected(self, client):
        resp = client.post("/chat", data="")
        assert resp.status_code == 400

    def test_invalid_json_rejected(self, client):
        resp = client.post("/chat",
                           data="not json",
                           content_type="application/json")
        assert resp.status_code == 400

    def test_no_messages_returns_error(self, client):
        resp = client.post("/chat",
                           json={},
                           content_type="application/json")
        assert resp.status_code == 400
