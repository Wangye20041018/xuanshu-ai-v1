# 玄枢AI Engine API 文档

> **⚠️ 已废弃** — 本文档面向旧版 Python Flask 引擎（v11.2.0），该引擎在 v10+ 版本中已被 TypeScript Electron 主进程架构替代。`engine/` 目录仅保留微信中转等辅助服务。
> 当前 API 通过 Electron IPC 通道提供，详见 `src/main/ipc/` 和 `src/preload/index.ts`。

> API 版本: 1.0 | 引擎版本: v11.2.0（已废弃） | 默认端口: 8765

---

## 目录

- [系统端点](#系统端点)
- [对话与推理](#对话与推理)
- [模式与配置](#模式与配置)
- [语音 (TTS)](#语音-tts)
- [搜索](#搜索)
- [视觉语言模型 (VL)](#视觉语言模型-vl)
- [微信](#微信)
- [错误码](#错误码)

---

## 系统端点

### `GET /health`

健康检查。

**响应** `200 OK`

```json
{
  "status": "ok",
  "model": "Qwen3.5-9B (单模型模式)"
}
```

---

### `GET /version`

引擎版本信息。

**响应** `200 OK`

```json
{
  "version": "11.2.0",
  "engine": "xuanshu-ai",
  "api_version": "1.0"
}
```

---

### `GET /status`

系统运行状态，包含 GPU、内存、CPU、模型加载情况。

**响应** `200 OK`

```json
{
  "status": "running",
  "uptime": "01:23:45",
  "current_mode": "local",
  "active_persona": "default",
  "active_plugins": [],
  "total_requests": 42,
  "streaming_enabled": true,
  "throughput": 12.5,
  "throughput_tokens_per_sec": 12.5,
  "draft_loaded": true,
  "verify_loaded": false,
  "gpu": { "name": "NVIDIA RTX 4060", "vram_used_gb": 4.2, "vram_total_gb": 8.0 },
  "memory": { "used_gb": 6.1, "total_gb": 16.0, "percent": 38.1 },
  "cpu": { "percent": 15.2, "cores": 16 },
  "models": {
    "draft_9b": {
      "name": "Qwen3.5-9B",
      "quantization": "Q4_K_M",
      "loaded": true,
      "device": "GPU",
      "backend": "llama-server-cuda",
      "vram_est_gb": 5.5
    },
    "verify_14b": {
      "name": "Qwen2.5-14B-Instruct (已移除)",
      "loaded": false,
      "note": "14B 验证模型已从 config.json 移除，投机解码已禁用"
    }
  },
  "hardware": { "gpu": {}, "cpu": {}, "memory": {} },
  "personas_loaded": 3,
  "plugins_loaded": 5
}
```

---

### `GET /config`

返回当前 `config.json` 全部内容。

**响应** `200 OK` — 完整配置 JSON。`404` — config.json 不存在。

---

### `POST /config/inference`

更新推理运行时参数（temperature、max_tokens 等）。

**请求**

```json
{
  "temperature": 0.8,
  "max_tokens": 4096,
  "stream": true
}
```

**响应** `200 OK`

```json
{ "success": true }
```

---

## 对话与推理

### `POST /chat`

核心对话接口。

**请求**

```json
{
  "messages": [
    { "role": "user", "content": "你好" }
  ],
  "mode": "local",
  "personality": "default",
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 2048,
  "top_p": 0.9,
  "top_k": 40
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| messages | array | 是 | 对话消息列表，每项含 `role` 和 `content` |
| mode | string | 否 | `local` 或 `cloud`，默认 `local` |
| personality | string | 否 | 人格 ID，默认当前活跃人格 |
| stream | bool | 否 | 是否流式输出，默认 `false` |
| temperature | float | 否 | 采样温度，默认 0.7 |
| max_tokens | int | 否 | 最大生成 token 数，默认 2048 |
| top_p | float | 否 | nucleus sampling，默认 0.9 |

**响应** `200 OK`（非流式）

```json
{
  "role": "assistant",
  "content": "你好！有什么可以帮助你的？",
  "reply": "你好！有什么可以帮助你的？",
  "text": "你好！有什么可以帮助你的？",
  "mode": "local"
}
```

**错误**

| 状态码 | error | 说明 |
|--------|-------|------|
| 400 | `invalid_json` | JSON 解析失败 |
| 400 | `empty_body` | 空请求体 |
| 400 | `no_messages` | 未提供 messages 字段 |
| 500 | `inference_failed` | 推理失败 |

---

### `POST /embeddings`

文本向量化接口。

**请求**

```json
{
  "input": "这是一段需要向量化的文本"
}
```

**响应** `200 OK`

```json
{
  "embedding": [0.0123, -0.0456, ...],
  "dim": 768
}
```

---

## 模式与配置

### `POST /mode/switch`

切换 local / cloud 推理模式。

**请求**

```json
{ "mode": "cloud" }
```

**响应** `200 OK`

```json
{
  "previous": "local",
  "current": "cloud",
  "message": "已切换到 cloud 模式",
  "success": true
}
```

**错误** `400` — mode 不是 `local` 或 `cloud`。

---

### `POST /persona`

设置当前 AI 人格。

**请求**

```json
{ "persona_id": "professor" }
```

**响应** `200 OK` — 设置后的状态。

---

### `GET /personas`

获取所有可用人格列表。

**响应** `200 OK` — 人格数组。

---

### `GET /plugins`

获取所有可用插件列表。

**响应** `200 OK` — 插件数组。

---

### `POST /plugin/toggle`

启用/禁用插件。

**请求**

```json
{ "plugin_id": "code-interpreter", "enabled": true }
```

**响应** `200 OK`

---

### `POST /settings`

更新并持久化设置到 config.json（兼容旧接口）。

**请求**

```json
{ "voice_name": "xiaoxiao" }
```

**响应** `200 OK`

```json
{ "success": true }
```

---

## 语音 (TTS)

### `GET /voice/status`

语音引擎状态。

**响应** `200 OK`

---

### `POST /voice/set`

切换 TTS 音色。

**请求**

```json
{ "voice": "xiaoxiao" }
```

---

### `POST /voice/speak`

即时播放文本语音。

**请求**

```json
{ "text": "你好世界" }
```

---

### `POST /tts`

文本转语音，返回音频流。

**请求**

```json
{ "text": "你好世界", "voice": "xiaoxiao" }
```

**响应** `200 OK` — `audio/wav` 二进制流。

---

## 搜索

### `POST /search`

联网搜索引擎端点。

**请求**

```json
{
  "query": "最新AI新闻",
  "engines": ["bing"],
  "max_results": 5
}
```

---

## 视觉语言模型 (VL)

### `GET /vl/status`

视觉语言模型状态。

**响应** `200 OK`

```json
{ "available": true }
```

---

## 微信

### `GET /wechat` | `POST /wechat`

微信消息收发桥接。具体格式由 `wechat_bridge.py` 定义。

---

## 错误码

| 状态码 | error | 说明 |
|--------|-------|------|
| 400 | `invalid_json` | 请求体 JSON 格式无效 |
| 400 | `empty_body` | 请求体为空 |
| 400 | `no_messages` | /chat 未提供 messages |
| 400 | `参数错误` | 参数值不合法 |
| 404 | — | 资源不存在（如 config.json 缺失） |
| 500 | `inference_failed` | 模型推理异常 |
| 500 | `switch_failed` | 模式切换异常 |
*（内容由AI生成，仅供参考）*
