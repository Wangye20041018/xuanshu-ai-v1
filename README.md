---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 3c24a5e3a352f921a82f7d3a39c85647_cd643d4d8aae11f1a00c525400826444
    ReservedCode1: C17vdHowlRaLHSQvn+96RUioL//5Yt0c9jK1qa4tLfaY3XiUc2lYoWSHGatvlNj42q/JfbSQw3kbzHqaL1YVKDcNuthmfKRZ6UyNnhL0NQK7sIslVNj9q5l8QelWLkUC/mkLMk6dCybZfBGhrjpAUoEjvqr/OVQv2il8hJV/0xaGShAegHTQZNwCqCo=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 3c24a5e3a352f921a82f7d3a39c85647_cd643d4d8aae11f1a00c525400826444
    ReservedCode2: C17vdHowlRaLHSQvn+96RUioL//5Yt0c9jK1qa4tLfaY3XiUc2lYoWSHGatvlNj42q/JfbSQw3kbzHqaL1YVKDcNuthmfKRZ6UyNnhL0NQK7sIslVNj9q5l8QelWLkUC/mkLMk6dCybZfBGhrjpAUoEjvqr/OVQv2il8hJV/0xaGShAegHTQZNwCqCo=
---

# 玄枢AI (XuanShu AI)

通用AI桌面助手 —— Electron + React + Python 双层架构，集成本地大模型推理、智能桌面自动化与多模态交互。

## 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 桌面框架 | Electron | 32 |
| 前端 | React + TypeScript | 18 / 5.7 |
| 构建 | Vite + electron-vite | 5.4 / 2.3 |
| 样式 | Tailwind CSS + Framer Motion | 4.3 / 11.18 |
| 状态管理 | Zustand | 5.0 |
| 3D 渲染 | Three.js | 0.185 |
| 后端引擎 | Python Flask | — |
| 推理引擎 | llama.cpp (llama-server) | — |
| 数据库 | better-sqlite3 | 12.11 |
| 包管理 | npm / pip | — |

## 快速开始

### 环境要求

- Node.js >= 18
- Python >= 3.10
- Windows 11（推荐）或 Windows 10

### 安装

```bash
# 安装 Node.js 依赖
npm install

# 安装 Python 引擎依赖
pip install -r engine/requirements.txt
```

### 开发

```bash
# 启动开发模式（Electron + Vite HMR）
npm run dev

# 或单独启动 Python 引擎
python engine/api_server.py
```

### 构建

```bash
# 构建生产版本
npm run build

# 打包为安装包
npm run pack
```

## 项目结构

```
E:\开发\
├── src/
│   ├── main/               # Electron 主进程（TypeScript）
│   │   ├── index.ts         #   应用入口、窗口管理
│   │   ├── model-manager/   #   模型下载、注册、生命周期
│   │   ├── runtime/         #   Python 运行时管理
│   │   ├── inference/       #   推理引擎调度
│   │   ├── voice-engine/    #   语音克隆与 TTS
│   │   ├── search/          #   搜索引擎集成
│   │   ├── ipc/             #   IPC 通信处理器
│   │   ├── permission/      #   系统权限检测与修复
│   │   ├── context-manager/ #   对话上下文管理
│   │   ├── automation/      #   桌面自动化（UIA）
│   │   ├── operation/       #   操作引擎
│   │   ├── external-ai/     #   外部 AI API 集成
│   │   ├── knowledge-graph/ #   知识图谱
│   │   ├── plugin-engine/   #   插件系统
│   │   ├── device/          #   硬件信息采集
│   │   ├── task-planner/    #   任务规划
│   │   └── utils/           #   工具函数
│   └── renderer/            # 渲染进程（React）
│       ├── components/      #   UI 组件
│       ├── pages/           #   页面
│       ├── store/           #   状态管理
│       └── styles/          #   样式
├── engine/                  # Python 推理引擎
│   ├── api_server.py        #   Flask API 服务（核心）
│   ├── model_manager.py     #   模型下载与校验
│   ├── voice_engine.py      #   语音合成引擎
│   ├── search_engine.py     #   搜索引擎（Playwright/Selenium）
│   ├── memory_guardian.py   #   内存监控与进程保护
│   ├── mode_router.py       #   local/cloud 模式路由
│   ├── brain_runtime.py     #   推理运行时
│   ├── vl_engine.py         #   视觉语言模型引擎
│   ├── SystemOperation.py   #   系统操作封装
│   ├── wechat_bridge.py     #   微信桥接
│   └── config.json          #   运行时配置
├── resources/               # 预置资源与模型
├── personas/                # AI 人格定义
├── plugins/                 # 功能插件
├── scripts/                 # 构建脚本
├── tests/                   # 测试
├── package.json
├── VERSION                  # 统一版本号
└── README.md
```

## 版本历史

| 版本 | 日期 | 主要变更 |
|------|------|----------|
| v11.2.0 | 2026-07 | 统一版本线，投机解码禁用，14B 验证模型退役，BUG-007 浏览器自动化实现，硬编码路径清理 |
| v10.x | — | 质量档模型支持，InternVL2.5-14B 注册，操作引擎重构 |

## 许可证

MIT License

Copyright (c) 2026 玄枢AI
*（内容由AI生成，仅供参考）*
