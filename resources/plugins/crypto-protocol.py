#!/usr/bin/env python3
"""密码与协议外挂 — 加解密/签名验证/证书解析"""

import hashlib
import base64
import os
from typing import Dict, Any

try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives import hashes, padding
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.backends import default_backend
    CRYPTO_AVAILABLE = True
except ImportError:
    CRYPTO_AVAILABLE = False


def execute(user_msg: str, **kwargs) -> Dict[str, Any]:
    action = kwargs.get("action", "hash")
    data = kwargs.get("data", "")
    key = kwargs.get("key", "")
    cert_path = kwargs.get("cert_path", "")

    try:
        if action == "hash":
            return _hash_data(data)
        elif action == "aes_encrypt":
            return _aes_encrypt(data, key)
        elif action == "aes_decrypt":
            return _aes_decrypt(data, key)
        elif action == "rsa_gen":
            return _rsa_gen()
        elif action == "cert_info":
            return _cert_info(cert_path)
        elif action == "base64_decode":
            return _base64_decode(data)
        else:
            return {"success": False, "error": f"未知操作: {action}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _hash_data(data: str) -> Dict:
    if not data:
        return {"success": False, "error": "data 不能为空"}
    b = data.encode()
    return {
        "success": True,
        "hashes": {
            "md5": hashlib.md5(b).hexdigest(),
            "sha1": hashlib.sha1(b).hexdigest(),
            "sha256": hashlib.sha256(b).hexdigest(),
            "sha512": hashlib.sha512(b).hexdigest()
        }
    }


def _aes_encrypt(data: str, key: str) -> Dict:
    if not CRYPTO_AVAILABLE:
        return {"success": False, "error": "cryptography not installed"}
    if not data or not key:
        return {"success": False, "error": "data 和 key 不能为空"}

    # 使用 key 的 SHA256 作为实际密钥
    key_bytes = hashlib.sha256(key.encode()).digest()
    iv = os.urandom(16)
    cipher = Cipher(algorithms.AES(key_bytes), modes.CBC(iv), backend=default_backend())
    encryptor = cipher.encryptor()
    padder = padding.PKCS7(128).padder()

    padded = padder.update(data.encode()) + padder.finalize()
    ciphertext = encryptor.update(padded) + encryptor.finalize()

    return {
        "success": True,
        "ciphertext": base64.b64encode(iv + ciphertext).decode(),
        "algorithm": "AES-256-CBC",
        "iv": base64.b64encode(iv).decode()
    }


def _aes_decrypt(data: str, key: str) -> Dict:
    if not CRYPTO_AVAILABLE:
        return {"success": False, "error": "cryptography not installed"}
    if not data or not key:
        return {"success": False, "error": "data 和 key 不能为空"}

    try:
        raw = base64.b64decode(data)
        iv = raw[:16]
        ciphertext = raw[16:]
        key_bytes = hashlib.sha256(key.encode()).digest()

        cipher = Cipher(algorithms.AES(key_bytes), modes.CBC(iv), backend=default_backend())
        decryptor = cipher.decryptor()
        unpadder = padding.PKCS7(128).unpadder()

        padded = decryptor.update(ciphertext) + decryptor.finalize()
        plaintext = unpadder.update(padded) + unpadder.finalize()

        return {"success": True, "plaintext": plaintext.decode()}
    except Exception as e:
        return {"success": False, "error": f"解密失败: {e}"}


def _rsa_gen() -> Dict:
    if not CRYPTO_AVAILABLE:
        return {"success": False, "error": "cryptography not installed"}
    from cryptography.hazmat.primitives import serialization

    private_key = rsa.generate_private_key(
        public_exponent=65537, key_size=2048, backend=default_backend()
    )
    public_key = private_key.public_key()

    private_pem = private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption()
    ).decode()
    public_pem = public_key.public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()

    return {
        "success": True,
        "public_key": public_pem,
        "private_key": private_pem,
        "key_size": 2048
    }


def _cert_info(cert_path: str) -> Dict:
    if not cert_path or not os.path.exists(cert_path):
        return {"success": False, "error": f"证书文件不存在: {cert_path}"}
    return {"success": False, "error": "证书解析需要 cryptography x509 模块"}


def _base64_decode(data: str) -> Dict:
    try:
        decoded = base64.b64decode(data).decode()
        return {"success": True, "decoded": decoded}
    except Exception as e:
        return {"success": False, "error": f"Base64解码失败: {e}"}
