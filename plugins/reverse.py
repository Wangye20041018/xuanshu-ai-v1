"""Plugin: Reverse Analysis (reverse) — Level: Heavy"""
import os, re, struct

def run(action: str, file_path: str = "", min_length: int = 4) -> dict:
    if not file_path or not os.path.exists(file_path):
        return {"success": False, "error": "File not found"}
    try:
        with open(file_path, "rb") as f:
            data = f.read()
        size = len(data)

        if action == "strings":
            pattern = re.compile(rb'[\x20-\x7e]{%d,}' % min_length)
            matches = pattern.findall(data)
            strings = [m.decode('ascii', errors='ignore') for m in matches]
            return {"success": True, "count": len(strings), "strings": strings[:200]}

        elif action == "hex_dump":
            lines = []
            for i in range(0, min(size, 1024), 16):
                chunk = data[i:i+16]
                hex_str = ' '.join(f'{b:02x}' for b in chunk)
                ascii_str = ''.join(chr(b) if 32 <= b < 127 else '.' for b in chunk)
                lines.append(f"{i:08x}  {hex_str:<48} |{ascii_str}|")
            return {"success": True, "hex_dump": '\n'.join(lines), "total_size": size}

        elif action == "pe_info":
            if data[:2] != b'MZ': return {"success": False, "error": "Not a valid PE file (missing MZ header)"}
            pe_offset = struct.unpack('<I', data[0x3C:0x40])[0]
            if data[pe_offset:pe_offset+4] != b'PE\x00\x00': return {"success": False, "error": "Invalid PE signature"}
            machine = struct.unpack('<H', data[pe_offset+4:pe_offset+6])[0]
            num_sections = struct.unpack('<H', data[pe_offset+6:pe_offset+8])[0]
            timestamp = struct.unpack('<I', data[pe_offset+8:pe_offset+12])[0]
            characteristics = struct.unpack('<H', data[pe_offset+22:pe_offset+24])[0]
            from datetime import datetime
            machines = {0x14c: "i386", 0x8664: "AMD64", 0xaa64: "ARM64"}
            return {"success": True, "machine": machines.get(machine, f"0x{machine:04x}"), "sections": num_sections,
                    "timestamp": datetime.fromtimestamp(timestamp).isoformat(), "is_dll": bool(characteristics & 0x2000),
                    "is_exe": bool(characteristics & 0x0002)}

        elif action == "elf_info":
            if data[:4] != b'\x7fELF': return {"success": False, "error": "Not a valid ELF file"}
            bitness = "64-bit" if data[4] == 2 else "32-bit"
            endian = "little-endian" if data[5] == 1 else "big-endian"
            e_type_map = {1: "REL (relocatable)", 2: "EXEC (executable)", 3: "DYN (shared object)", 4: "CORE"}
            e_machine_map = {3: "i386", 0x3e: "AMD64", 0x28: "ARM", 0xb7: "AArch64"}
            e_type = e_type_map.get(struct.unpack('<H', data[16:18])[0], "unknown")
            e_machine = e_machine_map.get(struct.unpack('<H', data[18:20])[0], "unknown")
            return {"success": True, "bitness": bitness, "endian": endian, "type": e_type, "machine": e_machine}

        elif action == "magic_bytes":
            magic = data[:16]
            magic_hex = ' '.join(f'{b:02x}' for b in magic)
            known = {b'\x89PNG': "PNG Image", b'\xff\xd8\xff': "JPEG Image", b'PK\x03\x04': "ZIP Archive",
                     b'GIF8': "GIF Image", b'%PDF': "PDF Document", b'MZ': "PE Executable",
                     b'\x7fELF': "ELF Binary", b'\x1f\x8b': "GZip Archive", b'RIFF': "RIFF (WAV/AVI)"}
            detected = "Unknown"
            for sig, name in known.items():
                if data.startswith(sig): detected = name; break
            return {"success": True, "magic": magic_hex, "detected": detected}
        return {"success": False, "error": f"Unknown action: {action}"}
    except Exception as e:
        return {"success": False, "error": str(e)}
