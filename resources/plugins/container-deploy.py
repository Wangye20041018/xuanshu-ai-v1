{
  "id": "pentest",
  "name": "渗透测试",
  "description": "端口扫描/目录爆破/漏洞检测",
  "level": "heavy",
  "triggers": ["渗透", "扫描端口", "漏洞", "nmap", "目录爆破", "子域名", "安全测试"],
  "function_schema": {
    "name": "pentest",
    "description": "渗透测试工具集",
    "parameters": {
      "type": "object",
      "properties": {
        "action": {"type": "string", "enum": ["port_scan", "dir_brute", "subdomain", "vuln_check"]},
        "target": {"type": "string"},
        "ports": {"type": "string"},
        "wordlist": {"type": "string"}
      },
      "required": ["action", "target"]
    }
  }
}
