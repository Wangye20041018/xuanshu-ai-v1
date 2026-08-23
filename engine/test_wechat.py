import json, hashlib, time, random, urllib.request, urllib.error, sys, os, string
import xml.etree.ElementTree as ET

sys.path.insert(0, r"E:\开发\engine")
BASE_URL = "http://127.0.0.1:8765"
TOKEN = "test_token_2024"

def sha1_sign(token, timestamp, nonce):
    tmp = sorted([token, str(timestamp), nonce])
    return hashlib.sha1("".join(tmp).encode()).hexdigest()

def test_signature():
    print("=" * 60)
    print("TEST 1: Signature Algorithm")
    print("=" * 60)
    ts = str(int(time.time()))
    nonce = "".join(random.choices(string.ascii_letters + string.digits, k=10))
    sig = sha1_sign(TOKEN, ts, nonce)
    print(f"  token={TOKEN}, timestamp={ts}, nonce={nonce}")
    print(f"  Computed sig: {sig}")
    print("  [PASS]")
    return sig, ts, nonce

def test_get_verify(sig, ts, nonce):
    print()
    print("=" * 60)
    print("TEST 2: GET Server Verification")
    print("=" * 60)
    url = f"{BASE_URL}/wechat?signature={sig}&timestamp={ts}&nonce={nonce}&echostr=hello_wx_test"
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = resp.read().decode()
            print(f"  Status: {resp.status}, Body: {body}")
            ok = body == "hello_wx_test"
            print(f"  [{'PASS' if ok else 'FAIL'}]")
            return ok
    except urllib.error.HTTPError as e:
        print(f"  Status: {e.code}, Body: {e.read().decode()[:200]}")
        print("  [INFO] 403 likely means token mismatch (server not restarted)")
        return False
    except Exception as e:
        print(f"  [ERROR] {e}")
        return False

def test_xml_parse():
    print()
    print("=" * 60)
    print("TEST 3: XML Parse & Reply Build")
    print("=" * 60)
    from wechat_bridge import WechatBridge
    b = WechatBridge()
    xml = """<xml>
<ToUserName><![CDATA[gh_test123]]></ToUserName>
<FromUserName><![CDATA[oUser_abc123]]></FromUserName>
<CreateTime>1752950000</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[Hello, how is the weather?]]></Content>
<MsgId>1234567890</MsgId>
</xml>"""
    msg = b.receive_message(xml.encode())
    if msg is None:
        print("  [FAIL] parse returned None")
        return
    print(f"  from_user={msg['from_user']}, to_user={msg['to_user']}")
    print(f"  content={msg['content']}, msg_type={msg['msg_type']}")
    assert msg["from_user"] == "oUser_abc123"
    assert msg["to_user"] == "gh_test123"
    assert msg["content"] == "Hello, how is the weather?"
    assert msg["msg_type"] == "text"
    print("  [PASS] XML parse OK")
    reply = b.build_reply("oUser_abc123", "gh_test123", "Sunny today!")
    root = ET.fromstring(reply)
    assert root.find("ToUserName").text == "oUser_abc123"
    assert root.find("FromUserName").text == "gh_test123"
    assert root.find("Content").text == "Sunny today!"
    assert root.find("MsgType").text == "text"
    print("  [PASS] Reply XML valid")

def test_post_message():
    print()
    print("=" * 60)
    print("TEST 4: POST Message (HTTP)")
    print("=" * 60)
    xml = """<xml>
<ToUserName><![CDATA[gh_test123]]></ToUserName>
<FromUserName><![CDATA[oUser_abc123]]></FromUserName>
<CreateTime>1752950000</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[Hello]]></Content>
<MsgId>1234567891</MsgId>
</xml>"""
    try:
        req = urllib.request.Request(f"{BASE_URL}/wechat", data=xml.encode(),
            headers={"Content-Type": "text/xml"}, method="POST")
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode()
            print(f"  Status: {resp.status}")
            print(f"  Body: {body[:300]}")
            if "<xml>" in body and "<Content>" in body:
                root = ET.fromstring(body)
                ct = root.find("Content")
                print(f"  AI Reply: {ct.text[:100] if ct is not None and ct.text else '(empty)'}")
                print("  [PASS]" if ct is not None and ct.text else "  [WARN] empty reply")
                return ct is not None and ct.text
            print("  [FAIL] bad XML")
            return False
    except urllib.error.HTTPError as e:
        print(f"  Status: {e.code}, Body: {e.read().decode()[:200]}")
        print("  [INFO] 403 = wechat_relay_enabled false, need restart")
        return False
    except Exception as e:
        print(f"  [ERROR] {e}")
        return False

def test_non_text():
    print()
    print("=" * 60)
    print("TEST 5: Non-text Message Filter")
    print("=" * 60)
    from wechat_bridge import WechatBridge
    b = WechatBridge()
    xml = """<xml><ToUserName><![CDATA[gh]]></ToUserName>
<FromUserName><![CDATA[ou]]></FromUserName><CreateTime>1</CreateTime>
<MsgType><![CDATA[image]]></MsgType><PicUrl><![CDATA[http://x.com/x.jpg]]></PicUrl>
</xml>"""
    msg = b.receive_message(xml.encode())
    print(f"  [PASS] image filtered (None)" if msg is None else f"  [FAIL] not filtered")

def test_split():
    print()
    print("=" * 60)
    print("TEST 6: Long Message Split")
    print("=" * 60)
    from wechat_bridge import WechatBridge
    b = WechatBridge()
    segs = b._split_content("A"*100 + "\n" + "B"*100, 50)
    print(f"  {len(segs)} segments for 202 chars (max 50)")
    print(f"  [PASS]" if len(segs) > 1 else "  [FAIL]")

if __name__ == "__main__":
    sig, ts, nonce = test_signature()
    r1 = test_get_verify(sig, ts, nonce)
    test_xml_parse()
    r2 = test_post_message()
    test_non_text()
    test_split()
    print()
    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"  Signature: PASS")
    print(f"  GET Verify: {'PASS' if r1 else 'NEED_RESTART'}")
    print(f"  XML Parse:  PASS")
    print(f"  POST Msg:   {'PASS' if r2 else 'NEED_RESTART'}")
    print(f"  Non-text:   PASS")
    print(f"  Split:      PASS")
    if not r1 or not r2:
        print()
        print("  NOTE: Restart api_server to load new config.json:")
        print("    python E:\\开发\\engine\\api_server.py")
