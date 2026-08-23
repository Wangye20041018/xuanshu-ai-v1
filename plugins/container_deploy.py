"""Plugin: Container Deploy (container_deploy) — Level: Heavy"""
import subprocess, json, os

DOCKERFILE_TEMPLATES = {
    "python": 'FROM python:3.11-slim\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY . .\nEXPOSE {port}\nCMD ["python", "{entrypoint}"]',
    "node": 'FROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --only=production\nCOPY . .\nEXPOSE {port}\nCMD ["node", "{entrypoint}"]',
    "go": 'FROM golang:1.22-alpine AS builder\nWORKDIR /app\nCOPY . .\nRUN go build -o app .\n\nFROM alpine:latest\nWORKDIR /app\nCOPY --from=builder /app/app .\nEXPOSE {port}\nCMD ["./app"]',
    "java": 'FROM openjdk:17-slim\nWORKDIR /app\nCOPY target/*.jar app.jar\nEXPOSE {port}\nCMD ["java", "-jar", "app.jar"]',
    "static": 'FROM nginx:alpine\nCOPY . /usr/share/nginx/html\nEXPOSE {port}\n',
}

def run(action: str, app_name: str = "myapp", app_type: str = "python", port: int = 80) -> dict:
    try:
        if action == "generate_dockerfile":
            df = DOCKERFILE_TEMPLATES.get(app_type, DOCKERFILE_TEMPLATES["python"])
            entrypoint = "app.py" if app_type == "python" else ("index.js" if app_type == "node" else "main")
            content = df.format(port=port, entrypoint=entrypoint)
            return {"success": True, "dockerfile": content}

        elif action == "generate_compose":
            compose = {
                "version": "3.8",
                "services": {
                    app_name: {
                        "build": ".",
                        "ports": [f"{port}:{port}"],
                        "restart": "unless-stopped",
                        "environment": {"NODE_ENV": "production" if app_type != "python" else ""}
                    }
                }
            }
            yaml_lines = []
            def to_yaml(d, indent=0):
                for k, v in d.items():
                    if isinstance(v, dict):
                        yaml_lines.append(" " * indent + f"{k}:")
                        to_yaml(v, indent + 2)
                    elif isinstance(v, list):
                        yaml_lines.append(" " * indent + f"{k}:")
                        for item in v:
                            yaml_lines.append(" " * (indent + 2) + f"- {item}")
                    else:
                        yaml_lines.append(" " * indent + f"{k}: {v}")
            to_yaml(compose)
            return {"success": True, "docker_compose": "\n".join(yaml_lines)}

        elif action == "generate_k8s":
            k8s = f"""apiVersion: apps/v1
kind: Deployment
metadata:
  name: {app_name}
  labels:
    app: {app_name}
spec:
  replicas: 2
  selector:
    matchLabels:
      app: {app_name}
  template:
    metadata:
      labels:
        app: {app_name}
    spec:
      containers:
      - name: {app_name}
        image: {app_name}:latest
        ports:
        - containerPort: {port}
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
---
apiVersion: v1
kind: Service
metadata:
  name: {app_name}-svc
spec:
  selector:
    app: {app_name}
  ports:
  - port: {port}
    targetPort: {port}
  type: ClusterIP"""
            return {"success": True, "k8s_manifest": k8s}

        elif action in ("list_containers", "list_images"):
            try:
                if action == "list_containers":
                    r = subprocess.run(["docker", "ps", "--format", "{{json .}}"], capture_output=True, text=True)
                else:
                    r = subprocess.run(["docker", "images", "--format", "{{json .}}"], capture_output=True, text=True)
                if r.returncode != 0:
                    return {"success": False, "error": "Docker not running or not installed"}
                entries = [json.loads(l) for l in r.stdout.strip().split("\n") if l.strip()]
                return {"success": True, "items": entries, "count": len(entries)}
            except FileNotFoundError:
                return {"success": False, "error": "Docker not installed"}

        return {"success": False, "error": f"Unknown action: {action}"}
    except Exception as e:
        return {"success": False, "error": str(e)}
