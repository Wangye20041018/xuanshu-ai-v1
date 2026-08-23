#!/usr/bin/env python3
"""逆向分析外挂 — PE/ELF解析/字符串提取/十六进制转储"""

import os
import re
from typing import Dict, Any


def execute(user_msg: str, **kwargs) -> Dict[str, Any]:
    action = kwargs.get("action", "pe_info")
    file_path = kwargs.get("file_path", "")
    min_length = kwargs.get("min_length", 4)

    if not file_path or not os.path.exists(file_path):
        return {"success": False, "error": f"文件不存在: {file_path}"}

    try:
        if action == "pe_info":
            return _pe_info(file_path)
        elif action == "elf_info":
            return _elf_info(file_path)
        elif action == "strings":
            return _extract_strings(file_path, min_length)
        elif action == "hex_dump":
            return _hex_dump(file_path)
        else:
            return {"success": False, "error": f"未知操作: {action}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _pe_info(path: str) -> Dict:
    """PE文件基本信息"""
    try:
        with open(path, "rb") as f:
            header = f.read(2)
            if header != b"MZ":
                return {"success": False, "error": "不是有效的PE文件 (MZ头缺失)"}

            f.seek(0x3C)
            pe_offset_bytes = f.read(4)
            if len(pe_offset_bytes) < 4:
                return {"success": False, "error": "无法读取PE偏移"}

            pe_offset = int.from_bytes(pe_offset_bytes, "little")
            f.seek(pe_offset)
            pe_sig = f.read(4)
            if pe_sig != b"PE\0\0":
                return {"success": False, "error": "PE签名无效"}

            # COFF Header
            coff = f.read(20)
            machine = int.from_bytes(coff[0:2], "little")
            num_sections = int.from_bytes(coff[2:4], "little")
            time_stamp = int.from_bytes(coff[4:8], "little")
            size_of_opt_header = int.from_bytes(coff[16:18], "little")
            characteristics = int.from_bytes(coff[18:20], "little")

            # Optional Header (部分字段)
            opt_header = f.read(size_of_opt_header)
            magic = int.from_bytes(opt_header[0:2], "little")

            machine_types = {0x14C: "i386", 0x8664: "AMD64", 0xAA64: "ARM64"}
            exe_types = {0x10B: "PE32", 0x20B: "PE32+"}

            return {
                "success": True,
                "info": {
                    "type": "PE",
                    "machine": machine_types.get(machine, f"0x{machine:X}"),
                    "format": exe_types.get(magic, f"0x{magic:X}"),
                    "sections": num_sections,
                    "timestamp": time_stamp,
                    "characteristics": f"0x{characteristics:04X}",
                    "size_mb": round(os.path.getsize(path) / (1024**2), 2)
                }
            }
    except Exception as e:
        return {"success": False, "error": str(e)}


def _elf_info(path: str) -> Dict:
    """ELF文件基本信息"""
    try:
        with open(path, "rb") as f:
            magic = f.read(4)
            if magic != b"\x7fELF":
                return {"success": False, "error": "不是有效的ELF文件"}

            elf_class = f.read(1)[0]  # 32/64位
            elf_endian = f.read(1)[0]
            elf_version = f.read(1)[0]

            class_map = {1: "32-bit", 2: "64-bit"}
            endian_map = {1: "Little Endian", 2: "Big Endian"}

            return {
                "success": True,
                "info": {
                    "type": "ELF",
                    "class": class_map.get(elf_class, f"unknown({elf_class})"),
                    "endian": endian_map.get(elf_endian, f"unknown({elf_endian})"),
                    "version": elf_version,
                    "size_mb": round(os.path.getsize(path) / (1024**2), 2)
                }
            }
    except Exception as e:
        return {"success": False, "error": str(e)}


def _extract_strings(path: str, min_len: int = 4) -> Dict:
    """提取可打印字符串"""
    pattern = re.compile(rb"[\x20-\x7E]{%d,}" % min_len)
    strings = []
    try:
        with open(path, "rb") as f:
            data = f.read()
        for match in pattern.finditer(data):
            s = match.group().decode("ascii", errors="ignore")
            strings.append(s)
    except Exception as e:
        return {"success": False, "error": str(e)}

    return {
        "success": True,
        "strings": strings[:200],
        "count": len(strings)
    }


def _hex_dump(path: str) -> Dict:
    """十六进制转储（前1024字节）"""
    try:
        with open(path, "rb") as f:
            data = f.read(1024)
        hex_lines = []
        for i in range(0, len(data), 16):
            chunk = data[i:i+16]
            hex_part = " ".join(f"{b:02X}" for b in chunk)
            ascii_part = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
            hex_lines.append(f"{i:08X}  {hex_part:<48s}  {ascii_part}")
        return {"success": True, "hex_dump": "\n".join(hex_lines)}
    except Exception as e:
        return {"success": False, "error": str(e)}
