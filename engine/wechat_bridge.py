"""
玄枢 — 微信消息处理模块
=======================
负责微信消息 XML 格式的解析和封装，支持文本消息的接收与客服消息回复。
消息长度超过 2048 字符时自动分段发送。
"""
import logging
from xml.etree import ElementTree

import requests

logger = logging.getLogger("wechat_bridge")

# 微信客服消息接口单条消息最大字符数
MAX_CONTENT_LENGTH = 2048


def escape_cdata(text: str) -> str:
    """M-15 修复：转义 CDATA 中的 ']]>' 序列，防止 XML CDATA 段被提前关闭"""
    return str(text).replace(']]>', ']]]]><![CDATA[>')


class WechatBridge:
    """微信消息处理桥接类"""

    # ------------------------------------------------------------------
    # 消息接收与解析
    # ------------------------------------------------------------------
    def receive_message(self, xml_data):
        """
        解析微信 XML 消息，返回 dict 或 None。

        参数:
            xml_data: 微信服务器 POST 的原始 XML 字节串

        返回:
            {
                "from_user": str,   # 发送方 OpenID
                "to_user": str,     # 接收方（公众号）OpenID
                "content": str,     # 消息文本内容
                "msg_type": str,    # 消息类型，如 "text"
                "create_time": int, # 消息创建时间戳
            }
            若非文本消息或解析失败则返回 None
        """
        try:
            root = ElementTree.fromstring(xml_data)
        except ElementTree.ParseError as e:
            logger.error("XML 解析失败: %s", e)
            return None

        msg_type = self._get_text(root, "MsgType")
        if msg_type != "text":
            logger.info("非文本消息类型: %s，已忽略", msg_type)
            return None

        from_user = self._get_text(root, "FromUserName")
        to_user = self._get_text(root, "ToUserName")
        content = self._get_text(root, "Content")
        create_time = self._get_text(root, "CreateTime")

        if not from_user or not content:
            logger.warning("消息缺少必要字段: from_user=%s, content=%s", from_user, content)
            return None

        return {
            "from_user": from_user,
            "to_user": to_user,
            "content": content,
            "msg_type": msg_type,
            "create_time": int(create_time) if create_time else 0,
        }

    # ------------------------------------------------------------------
    # 被动回复（XML 格式）
    # ------------------------------------------------------------------
    def build_reply(self, to_user, from_user, content):
        """
        构建微信 XML 格式的被动回复消息。

        参数:
            to_user:   接收方 OpenID（用户）
            from_user: 发送方 OpenID（公众号）
            content:   回复文本内容

        返回:
            XML 字符串
        """
        import time as _time
        reply_xml = (
            "<xml>"
            f"<ToUserName><![CDATA[{to_user}]]></ToUserName>"
            f"<FromUserName><![CDATA[{from_user}]]></FromUserName>"
            f"<CreateTime>{int(_time.time())}</CreateTime>"
            "<MsgType><![CDATA[text]]></MsgType>"
            f"<Content><![CDATA[{escape_cdata(content)}]]></Content>"
            "</xml>"
        )
        return reply_xml

    # ------------------------------------------------------------------
    # 客服消息主动回复
    # ------------------------------------------------------------------
    def send_customer_message(self, access_token, to_user, content):
        """
        通过微信客服消息 API 主动向用户发送文本回复。
        内容超过 2048 字符时自动分段发送。

        参数:
            access_token: 微信 access_token
            to_user:      接收方 OpenID
            content:      回复文本内容

        返回:
            bool: 全部发送成功返回 True，否则返回 False
        """
        if not access_token or not to_user or not content:
            logger.warning("send_customer_message 缺少必要参数")
            return False

        url = f"https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token={access_token}"

        # 按 MAX_CONTENT_LENGTH 分段
        segments = self._split_content(content, MAX_CONTENT_LENGTH)
        logger.info("客服消息共 %d 段，发送给 %s", len(segments), to_user)

        all_ok = True
        for i, seg in enumerate(segments):
            payload = {
                "touser": to_user,
                "msgtype": "text",
                "text": {"content": seg},
            }
            try:
                resp = requests.post(url, json=payload, timeout=10)
                result = resp.json()
                if result.get("errcode") != 0:
                    logger.error(
                        "客服消息第 %d/%d 段发送失败: errcode=%s, errmsg=%s",
                        i + 1,
                        len(segments),
                        result.get("errcode"),
                        result.get("errmsg"),
                    )
                    all_ok = False
                else:
                    logger.info("客服消息第 %d/%d 段发送成功", i + 1, len(segments))
            except Exception as e:
                logger.error("客服消息第 %d/%d 段请求异常: %s", i + 1, len(segments), e)
                all_ok = False

        return all_ok

    # ------------------------------------------------------------------
    # 内部工具方法
    # ------------------------------------------------------------------
    @staticmethod
    def _get_text(element, tag):
        """从 XML 元素中安全提取文本内容"""
        child = element.find(tag)
        return child.text.strip() if child is not None and child.text else ""

    @staticmethod
    def _split_content(text, max_len):
        """
        将长文本按 max_len 分段，尽量在换行符处断开。

        参数:
            text:    原始文本
            max_len: 每段最大字符数

        返回:
            list[str]: 分段后的文本列表
        """
        if len(text) <= max_len:
            return [text]

        segments = []
        while len(text) > max_len:
            # 在 max_len 范围内找最后一个换行符
            split_at = text.rfind("\n", 0, max_len)
            if split_at == -1 or split_at < max_len // 2:
                # 没有合适的换行点，直接按长度切分
                split_at = max_len
            segments.append(text[:split_at])
            text = text[split_at:].lstrip("\n")
        if text:
            segments.append(text)
        return segments
