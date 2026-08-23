"""
玄枢 — 微信测试号中转服务
=========================
Flask 服务，监听 localhost:8766
对接微信公众平台测试号，实现扫码绑定后微信聊天框直接对话玄枢。
配合 Cloudflare Tunnel 将本地服务暴露到公网。

启动方式:
    python server\wechat_relay.py
"""
import os
import sys
import json
import time
import hashlib
import threading
import logging
from datetime import datetime
from xml.etree import ElementTree

import requests
from flask import Flask, request, jsonify
from flask_cors import CORS

# 添加项目根目录到路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.wechat_bridge import WechatBridge

# ---------------------------------------------------------------------------
# 日志配置
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("wechat_relay")

# ---------------------------------------------------------------------------
# Flask 初始化
# ---------------------------------------------------------------------------
app = Flask(__name__)
CORS(app)

# ---------------------------------------------------------------------------
# 配置加载
# ---------------------------------------------------------------------------
CONFIG_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "engine", "config.json")


def load_config():
    """加载 config.json，返回 dict"""
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        logger.warning("config.json 未找到或格式错误，使用空配置")
        return {}


CONFIG = load_config()

WECHAT_APPID = CONFIG.get("wechat_appid", "")
WECHAT_APPSECRET = CONFIG.get("wechat_appsecret", "")
WECHAT_TOKEN = CONFIG.get("wechat_token", "")
API_SERVER_URL = "http://localhost:8765/chat"

# ---------------------------------------------------------------------------
# Access Token 缓存管理
# ---------------------------------------------------------------------------
_access_token_cache = {
    "token": "",
    "expires_at": 0,
}
_access_token_lock = threading.Lock()  # BUG-009 fix: 防止并发刷新竞态


def get_access_token():
    """获取微信 access_token，带缓存和自动刷新（BUG-009 修复：线程安全）"""
    global _access_token_cache
    now = time.time()

    # 若缓存有效（提前 300 秒刷新），直接返回（无锁快速路径）
    if _access_token_cache["token"] and now < _access_token_cache["expires_at"] - 300:
        return _access_token_cache["token"]

    with _access_token_lock:
        # 双重检查：拿锁后再次确认缓存是否已刷新
        if _access_token_cache["token"] and now < _access_token_cache["expires_at"] - 300:
            return _access_token_cache["token"]

        if not WECHAT_APPID or not WECHAT_APPSECRET:
            logger.error("微信 AppID 或 AppSecret 未配置，无法获取 access_token")
            return ""

        url = "https://api.weixin.qq.com/cgi-bin/token"
        params = {
            "grant_type": "client_credential",
            "appid": WECHAT_APPID,
            "secret": WECHAT_APPSECRET,
        }

        try:
            resp = requests.get(url, params=params, timeout=10)
            data = resp.json()
            if "access_token" in data:
                _access_token_cache["token"] = data["access_token"]
                _access_token_cache["expires_at"] = time.time() + data.get("expires_in", 7200)
                logger.info("access_token 获取成功，有效期 %ds", data.get("expires_in", 7200))
                return _access_token_cache["token"]
            else:
                logger.error("获取 access_token 失败: %s", data)
                return ""
        except Exception as e:
            logger.error("请求 access_token 异常: %s", e)
            return ""


# ---------------------------------------------------------------------------
# 微信消息验证与签名计算
# ---------------------------------------------------------------------------
def check_signature(signature, timestamp, nonce):
    """验证微信服务器签名"""
    if not WECHAT_TOKEN:
        logger.warning("微信 Token 未配置，跳过签名验证")
        return True
    tmp_list = sorted([WECHAT_TOKEN, timestamp, nonce])
    tmp_str = "".join(tmp_list)
    calc_sig = hashlib.sha1(tmp_str.encode("utf-8")).hexdigest()
    return calc_sig == signature


# ---------------------------------------------------------------------------
# 微信接口路由
# ---------------------------------------------------------------------------
@app.route("/wechat", methods=["GET"])
def wechat_verify():
    """GET /wechat — 微信服务器配置验证（Token 验证）"""
    signature = request.args.get("signature", "")
    timestamp = request.args.get("timestamp", "")
    nonce = request.args.get("nonce", "")
    echostr = request.args.get("echostr", "")

    logger.info("收到微信验证请求: signature=%s, timestamp=%s, nonce=%s", signature, timestamp, nonce)

    if check_signature(signature, timestamp, nonce):
        logger.info("签名验证通过，返回 echostr")
        return echostr
    else:
        logger.warning("签名验证失败")
        return "signature verification failed", 403


@app.route("/wechat", methods=["POST"])
def wechat_message():
    """POST /wechat — 接收微信消息推送并回复"""
    xml_data = request.data
    logger.info("收到微信消息推送")

    # 解析消息
    bridge = WechatBridge()
    msg = bridge.receive_message(xml_data)
    if msg is None:
        logger.warning("消息解析失败或非文本消息")
        return ""

    from_user = msg["from_user"]
    to_user = msg["to_user"]
    content = msg["content"]

    logger.info("收到用户 %s 消息: %s", from_user, content)

    # 转发给 api_server 获取 AI 回复
    try:
        api_resp = requests.post(
            API_SERVER_URL,
            json={"message": content, "user_id": f"wechat_{from_user}"},
            timeout=60,
        )
        if api_resp.ok:
            ai_data = api_resp.json()
            reply_text = ai_data.get("reply", ai_data.get("response", "（玄枢正在思考...）"))
        else:
            reply_text = "玄枢 API 服务暂时不可用，请稍后重试。"
            logger.error("API 返回状态码: %d", api_resp.status_code)
    except requests.exceptions.ConnectionError:
        reply_text = "玄枢 API 服务未启动，请先运行 api_server。"
        logger.error("连接 API 失败: ConnectionError")
    except Exception as e:
        reply_text = "处理请求时发生错误。"
        logger.error("API 请求异常: %s", e)

    # 通过客服消息接口主动回复
    access_token = get_access_token()
    if access_token:
        bridge.send_customer_message(access_token, from_user, reply_text)
    else:
        logger.warning("无 access_token，无法发送客服消息")

    # 返回空字符串表示已处理（不触发微信默认回复）
    return ""


@app.route("/health", methods=["GET"])
def health_check():
    """健康检查"""
    return jsonify({
        "status": "ok",
        "service": "wechat_relay",
        "timestamp": datetime.now().isoformat(),
        "wechat_configured": bool(WECHAT_APPID and WECHAT_APPSECRET),
    })


# ---------------------------------------------------------------------------
# 启动入口
# ---------------------------------------------------------------------------
def main():
    host = "127.0.0.1"
    port = 8766

    print("=" * 56)
    print("  玄枢 — 微信测试号中转服务")
    print("  WeChat Relay Service v1.0")
    print("=" * 56)
    print(f"  监听地址: http://{host}:{port}")
    print(f"  回调 URL: http://<你的域名>/wechat")
    print()
    print("  配置状态:")
    print(f"    wechat_appid:     {'已配置' if WECHAT_APPID else '未配置（请在 config.json 中填写）'}")
    print(f"    wechat_appsecret: {'已配置' if WECHAT_APPSECRET else '未配置（请在 config.json 中填写）'}")
    print(f"    wechat_token:     {'已配置' if WECHAT_TOKEN else '未配置（请在 config.json 中填写）'}")
    print()
    print("  使用步骤:")
    print("    1. 前往 https://mp.weixin.qq.com/debug/cgi-bin/sandbox?t=sandbox/login")
    print("       注册微信公众平台测试号")
    print("    2. 获取测试号的 appID 和 appsecret，填入 engine/config.json")
    print("    3. 在测试号管理页「接口配置信息」中填入:")
    print(f"       URL:  http://<你的公网域名>/wechat")
    print(f"       Token: {WECHAT_TOKEN or '（你设定的 Token）'}")
    print("    4. 配合 Cloudflare Tunnel 将本地 8766 端口暴露到公网:")
    print("       cloudflared tunnel --url http://localhost:8766")
    print("    5. 扫码关注测试号，即可在微信聊天框与玄枢对话")
    print("=" * 56)

    app.run(host=host, port=port, debug=False)


if __name__ == "__main__":
    main()
