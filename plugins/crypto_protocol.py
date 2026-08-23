"""Plugin: Crypto & Protocol (crypto_protocol) — Level: Heavy"""
import hashlib, base64, os, secrets
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import hashes, padding as sym_padding
from cryptography.hazmat.primitives.asymmetric import rsa, padding as asym_padding
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat, NoEncryption

def run(action: str, data: str = "", key: str = "", algorithm: str = "sha256") -> dict:
    try:
        if action == "hash":
            h = hashlib.new(algorithm, data.encode())
            return {"success": True, "algorithm": algorithm, "hash": h.hexdigest()}

        elif action == "base64_encode":
            encoded = base64.b64encode(data.encode()).decode()
            return {"success": True, "encoded": encoded}

        elif action == "base64_decode":
            decoded = base64.b64decode(data).decode()
            return {"success": True, "decoded": decoded}

        elif action == "encrypt_aes":
            key_bytes = key.encode().ljust(32)[:32] if len(key) < 32 else key.encode()[:32]
            iv = os.urandom(16)
            padder = sym_padding.PKCS7(128).padder()
            padded = padder.update(data.encode()) + padder.finalize()
            cipher = Cipher(algorithms.AES(key_bytes), modes.CBC(iv))
            encryptor = cipher.encryptor()
            ct = encryptor.update(padded) + encryptor.finalize()
            result = base64.b64encode(iv + ct).decode()
            return {"success": True, "ciphertext": result, "mode": "AES-256-CBC"}

        elif action == "decrypt_aes":
            key_bytes = key.encode().ljust(32)[:32] if len(key) < 32 else key.encode()[:32]
            raw = base64.b64decode(data)
            iv, ct = raw[:16], raw[16:]
            cipher = Cipher(algorithms.AES(key_bytes), modes.CBC(iv))
            decryptor = cipher.decryptor()
            padded = decryptor.update(ct) + decryptor.finalize()
            unpadder = sym_padding.PKCS7(128).unpadder()
            plain = unpadder.update(padded) + unpadder.finalize()
            return {"success": True, "plaintext": plain.decode()}

        elif action == "generate_key":
            if algorithm == "rsa":
                priv = rsa.generate_private_key(65537, 2048)
                pub = priv.public_key()
                return {"success": True, "type": "RSA-2048",
                        "public_key": pub.public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo).decode()}
            else:
                return {"success": True, "key": secrets.token_hex(32), "type": "AES-256"}

        elif action == "rsa_sign":
            return {"success": False, "error": "RSA sign requires private key PEM — provide key parameter with PEM content"}

        elif action == "rsa_verify":
            return {"success": False, "error": "RSA verify requires public key PEM — provide key parameter with PEM content"}

        return {"success": False, "error": f"Unknown action: {action}"}
    except Exception as e:
        return {"success": False, "error": str(e)}
