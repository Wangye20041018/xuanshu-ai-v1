"""
pytest 配置与 fixture — Flask 测试客户端
"""

import sys
import json
from pathlib import Path

import pytest

# 确保 engine 目录在 sys.path 中
ENGINE_DIR = Path(__file__).resolve().parent.parent / "engine"
sys.path.insert(0, str(ENGINE_DIR))


@pytest.fixture(scope="session")
def engine_dir():
    """engine 目录路径"""
    return ENGINE_DIR


@pytest.fixture(scope="session")
def config_json(engine_dir):
    """加载 config.json"""
    config_path = engine_dir / "config.json"
    if config_path.exists():
        with open(config_path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


@pytest.fixture(scope="module")
def app():
    """创建 Flask 测试应用（不启动真实服务器）"""
    from api_server import app as flask_app
    flask_app.config["TESTING"] = True
    return flask_app


@pytest.fixture(scope="module")
def client(app):
    """Flask 测试客户端"""
    return app.test_client()
