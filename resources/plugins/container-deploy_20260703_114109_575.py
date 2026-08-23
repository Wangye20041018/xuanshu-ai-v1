#!/usr/bin/env python3
"""容器化部署外挂 — Docker Compose/Dockerfile/K8s配置生成"""

import subprocess
import json
import os
from typing import Dict, Any


def execute(user_msg: str, **kwargs) -> Dict[str, Any]:
    action = kwargs.get("action", "docker_ps")
    stack_name = kwargs.get("stack_name", "myapp")
    services = kwargs.get("services", "")
    app_type = kwargs.get("app_type", "python")

    try:
        if action == "docker_ps":
            return _docker_ps()
        elif action == "docker_images":
            return _docker_images()
        elif action == "docker_stats":
            return _docker_stats()
        elif action == "generate_compose":
            return _generate_compose(stack_name, services)
        elif action == "generate_dockerfile":
            return _generate_dockerfile(app_type)
        else:
            return {"success": False, "error": f"未知操作: {action}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _run_docker(args: list) -> Dict:
    try:
        result = subprocess.run(
            ["docker"] + args,
            capture_output=True, text=True, timeout=30
        )
        return {
            "success": result.returncode == 0,
            "stdout": result.stdout[:3000],
            "stderr": result.stderr[:500],
            "returncode": result.returncode
        }
    except FileNotFoundError:
        return {"success": False, "error": "Docker 未安装或不在 PATH 中"}
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Docker 命令超时"}


def _docker_ps() -> Dict:
    return _run_docker(["ps", "--format", "table {{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"])


def _docker_images() -> Dict:
    return _run_docker(["images", "--format", "table {{.Repository}}\t{{.Tag}}\t{{.Size}}"])


def _docker_stats() -> Dict:
    return _run_docker(["stats", "--no-stream", "--format", "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"])


def _generate_compose(stack_name: str, services: str) -> Dict:
    """生成 docker-compose.yml"""
    try:
        if services:
            services_dict = json.loads(services)
        else:
            # 默认模板
            services_dict = {
                "web": {
                    "build": ".",
                    "ports": ["8080:8080"],
                    "volumes": ["./data:/app/data"],
                    "environment": ["DEBUG=false"]
                },
                "db": {
                    "image": "postgres:15",
                    "environment": ["POSTGRES_PASSWORD=secret"],
                    "volumes": ["pgvar/lib/postgresql/data"]
                }
            }
    except json.JSONDecodeError:
        services_dict = {"web": {"image": "nginx:latest", "ports": ["80:80"]}}

    compose = {
        "version": "3.8",
        "services": services_dict
    }

    # 添加 volumes
    if "db" in services_dict:
        compose["volumes"] = {"pgdata": None}

    output_path = f"{stack_name}_docker-compose.yml"
    try:
        import yaml
        with open(output_path, "w", encoding="utf-8") as f:
            yaml.dump(compose, f, allow_unicode=True, default_flow_style=False)
    except ImportError:
        # 没有 yaml 模块，手动写
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(f"version: '3.8'\n\nservices:\n")
            for name, svc in services_dict.items():
                f.write(f"  {name}:\n")
                for k, v in svc.items():
                    f.write(f"    {k}: {v}\n")

    return {"success": True, "output": output_path, "stack_name": stack_name}


def _generate_dockerfile(app_type: str) -> Dict:
    """生成 Dockerfile"""
    templates = {
        "python": """FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8080
CMD ["python", "main.py"]
""",
        "node": """FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
""",
        "static": """FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
"""
    }

    content = templates.get(app_type, templates["python"])
    output_path = "Dockerfile"
    try:
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(content)
        return {"success": True, "output": output_path, "type": app_type}
    except Exception as e:
        return {"success": False, "error": str(e)}
