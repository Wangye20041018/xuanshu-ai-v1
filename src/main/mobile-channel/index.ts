import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createServer, Server as HttpServer, IncomingMessage, ServerResponse } from 'http'
import { randomBytes, createHash } from 'crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { networkInterfaces } from 'os'

import { createLogger } from '../utils/logging'
const logger = createLogger('MobileChannel')

/* ==================== RTC 最小化类型声明（Node.js 环境） ==================== */

/** WebRTC DataChannel 最小化接口 */
interface RTCDataChannel {
  readyState: string
  onopen: ((ev: unknown) => void) | null
  onclose: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  send(data: string): void
  close(): void
}

/** WebRTC SessionDescription 初始参数 */
interface RTCSessionDescriptionInit {
  type: RTCSdpType
  sdp: string
}

type RTCSdpType = 'offer' | 'answer' | 'pranswer' | 'rollback'

/** WebRTC ICE Candidate 初始参数 */
interface RTCIceCandidateInit {
  candidate?: string
  sdpMid?: string | null
  sdpMLineIndex?: number | null
}

/* ==================== 类型定义 ==================== */

/** 连接状态枚举 */
type ConnectionState = 'disconnected' | 'pairing' | 'connecting' | 'connected' | 'reconnecting'

/** 已知设备记录 */
interface KnownDevice {
  deviceId: string
  deviceName: string
  deviceType: string
  lastConnectedAt: number
  trusted: boolean
}

/** 配置文件结构 */
interface MobileChannelConfig {
  port: number
  pairingCode: string
  lastKnownDevices: KnownDevice[]
  autoStart: boolean
  enabled: boolean
  name: string
  password: string
  useWebRTC: boolean
}

/** 默认配置 */
const DEFAULT_CONFIG: MobileChannelConfig = {
  port: 18765,
  pairingCode: '',
  lastKnownDevices: [],
  autoStart: false,
  enabled: false,
  name: '玄枢 AI',
  password: '',
  useWebRTC: true
}

/** 重试配置 */
const RETRY_CONFIG = {
  maxRetries: 3,
  retryDelayMs: 2000,
  connectionTimeout: 30000
}

/** Peer 连接对象 */
interface PeerConnection {
  id: string
  deviceName: string
  deviceType: string
  deviceId: string
  connectedAt: number
  iceConnectionState: string
  channel: WebSocket
  state: ConnectionState
  retryCount: number
  retryTimer: ReturnType<typeof setTimeout> | null
  webrtcDataChannel?: RTCDataChannel | null
  webrtcPending?: boolean
  dataChannelReady: boolean
}

/** 服务状态 */
interface ChannelStatus {
  running: boolean
  port: number
  connectedDevices: number
  connectionCode: string
  connectionState: ConnectionState
  serverName: string
  localIp: string
  useWebRTC: boolean
  autoStart: boolean
}

/** 信令消息 */
interface SignalingMessage {
  type: string
  from?: string
  to?: string
  data?: Record<string, unknown>
  sdp?: RTCSessionDescriptionInit
  ice?: RTCIceCandidateInit
  candidate?: RTCIceCandidateInit
  pairingCode?: string
  deviceName?: string
  deviceType?: string
  deviceId?: string
  payload?: Record<string, unknown>
  code?: string
  deviceInfo?: { deviceName?: string; deviceType?: string; deviceId?: string }
  success?: boolean
  message?: string
  timestamp?: number
}

/** IPC 返回格式 */
interface IpcResult<T = any> {
  success: boolean
  data?: T
  error?: string
}

/* ==================== CloudRelay 云端中继 ==================== */

/** 云端中继配置 */
interface CloudRelayConfig {
  /** 云端信令服务器地址（WebSocket），占位符，后续可配置 */
  relayUrl: string
  /** 是否启用云端中继降级 */
  enabled: boolean
  /** P2P 连接失败后，等待多久（ms）再触发中继降级 */
  fallbackTimeout: number
}

/** 中继连接状态 */
type RelayConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

/** 中继状态快照 */
interface RelayStatus {
  connected: boolean
  state: RelayConnectionState
  config: CloudRelayConfig
}

/** 默认中继配置 */
const DEFAULT_RELAY_CONFIG: CloudRelayConfig = {
  relayUrl: 'wss://relay.xuanshu.ai/signaling', // 占位符，后续可配置
  enabled: false,
  fallbackTimeout: 5000
}

/* ==================== 手机连接通道引擎 ==================== */

class MobileChannelEngine {
  // ========== 核心属性 ==========
  private config: MobileChannelConfig = { ...DEFAULT_CONFIG }
  private server: HttpServer | null = null
  private wss: WebSocketServer | null = null
  private peers: Map<string, PeerConnection> = new Map()
  private configPath: string | null = null
  private initialized: boolean = false
  private localIp: string = '127.0.0.1'

  /** 当前连接状态（全局级别，有任一设备连接即为 connected） */
  private _connectionState: ConnectionState = 'disconnected'

  // ========== 配对暴力破解防护 ==========

  /** 连续配对失败计数（窗口内超过阈值即锁定一段时间） */
  private pairFailCount = 0
  private pairFailWindowStart = 0
  private pairLockUntil = 0

  // ========== CloudRelay 属性 ==========

  private cloudRelayConfig: CloudRelayConfig = { ...DEFAULT_RELAY_CONFIG }
  private relayConnection: WebSocket | null = null
  private _relayConnectionState: RelayConnectionState = 'disconnected'
  private relayReconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** 记录 P2P 失败的 peer ID，用于 relay 降级后仍能对应 */
  private p2pFailedPeerIds: Set<string> = new Set()

  // ========== 构造函数 ==========

  constructor() {
    // 延迟初始化，由 app.whenReady 中调用 initialize()
  }

  // ========== 初始化 ==========

  initialize(): void {
    if (this.initialized) return
    try {
      this.configPath = join(app.getPath('userData'), 'mobile-channel-config.json')
      this.loadConfig()
      this.detectLocalIp()
      this.initialized = true

      // 若配置了 autoStart，则自动启动服务
      if (this.config.autoStart) {
        this.startServer().catch((err) => {
          logger.error(`[MobileChannel] autoStart failed: ${err}`)
        })
      }
    } catch (error) {
      logger.error(`[MobileChannel] initialize error: ${error}`)
    }
  }

  // ========== 配置管理 ==========

  private getConfigPath(): string {
    if (!this.configPath) {
      this.initialize()
    }
    return this.configPath!
  }

  private loadConfig(): void {
    try {
      const configPath = this.getConfigPath()
      if (existsSync(configPath)) {
        try {
          const raw = readFileSync(configPath, 'utf-8')
          const saved = JSON.parse(raw)
          // 合并配置，保留默认值兜底
          this.config = {
            ...DEFAULT_CONFIG,
            ...saved,
            lastKnownDevices: Array.isArray(saved.lastKnownDevices)
              ? saved.lastKnownDevices
              : [],
            pairingCode: saved.pairingCode || '',
            port: typeof saved.port === 'number' && saved.port > 0 ? saved.port : DEFAULT_CONFIG.port
          }
        } catch (parseErr) {
          logger.error(`[MobileChannel] loadConfig parse error: ${parseErr}`)
          this.config = { ...DEFAULT_CONFIG }
          this.saveConfig()
        }
      } else {
        // 确保目录存在
        const configDir = join(app.getPath('userData'), 'mobile-channel')
        mkdirSync(configDir, { recursive: true })
        this.config = { ...DEFAULT_CONFIG }
        this.saveConfig()
      }
    } catch (error) {
      logger.error(`[MobileChannel] loadConfig error: ${error}`)
      this.config = { ...DEFAULT_CONFIG }
    }
  }

  private saveConfig(): void {
    try {
      const configPath = this.getConfigPath()
      const dir = join(app.getPath('userData'), 'mobile-channel')
      mkdirSync(dir, { recursive: true })
      // 仅持久化需要保存的字段
      const toSave: Record<string, unknown> = {
        port: this.config.port,
        pairingCode: this.config.pairingCode,
        lastKnownDevices: this.config.lastKnownDevices,
        autoStart: this.config.autoStart,
        enabled: this.config.enabled,
        name: this.config.name,
        password: this.config.password,
        useWebRTC: this.config.useWebRTC
      }
      writeFileSync(configPath, JSON.stringify(toSave, null, 2))
    } catch (error) {
      logger.error(`[MobileChannel] saveConfig error: ${error}`)
    }
  }

  // ========== 网络工具 ==========

  private detectLocalIp(): void {
    try {
      const interfaces = networkInterfaces()
      for (const name of Object.keys(interfaces)) {
        const netInfo = interfaces[name]
        if (!netInfo) continue
        for (const info of netInfo) {
          if (info.family === 'IPv4' && !info.internal) {
            this.localIp = info.address
            return
          }
        }
      }
    } catch (error) {
      logger.error(`[MobileChannel] detectLocalIp error: ${error}`)
    }
  }

  // ========== 配对码管理 ==========

  /**
   * 生成 6 位配对码（SHA256 哈希取前 6 位大写）
   */
  generatePairingCode(): string {
    try {
      const randomStr = randomBytes(32).toString('hex')
      const hash = createHash('sha256').update(randomStr).digest('hex')
      const code = hash.substring(0, 6).toUpperCase()
      this.config.pairingCode = code
      this.saveConfig()
      return code
    } catch (error) {
      logger.error(`[MobileChannel] generatePairingCode error: ${error}`)
      const fallback = Math.floor(100000 + Math.random() * 900000).toString()
      this.config.pairingCode = fallback
      this.saveConfig()
      return fallback
    }
  }

  /**
   * 获取当前配对码（同步，不依赖服务是否运行）
   */
  getPairingCode(): string {
    try {
      return this.config.pairingCode || ''
    } catch (error) {
      logger.error(`[MobileChannel] getPairingCode error: ${error}`)
      return ''
    }
  }

  /**
   * 设置自定义配对码
   */
  setPairingCode(code: string): boolean {
    try {
      if (!code || code.length < 4 || code.length > 12) return false
      const cleanCode = code.replace(/[^a-zA-Z0-9]/g, '')
      if (cleanCode.length < 4) return false
      this.config.pairingCode = cleanCode
      this.saveConfig()
      return true
    } catch (error) {
      logger.error(`[MobileChannel] setPairingCode error: ${error}`)
      return false
    }
  }

  /**
   * 验证配对码
   */
  private verifyPairingCode(code: string): boolean {
    try {
      // 暴力破解防护：锁定期间直接拒绝
      if (Date.now() < this.pairLockUntil) return false

      if (!code || !this.config.pairingCode) return false
      // 大小写不敏感比较
      const ok =
        code.toUpperCase() === this.config.pairingCode.toUpperCase() ||
        // 也支持密码验证（向后兼容）
        Boolean(this.config.password && code === this.config.password)

      if (!ok) this.recordPairFailure()
      else this.pairFailCount = 0

      return ok
    } catch (error) {
      logger.error(`[MobileChannel] verifyPairingCode error: ${error}`)
      return false
    }
  }

  /**
   * 记录配对失败并实施速率限制：
   * 60 秒窗口内失败 ≥ 8 次 → 锁定 60 秒，阻止暴力枚举 6 位配对码。
   */
  private recordPairFailure(): void {
    const now = Date.now()
    if (now - this.pairFailWindowStart > 60_000) {
      this.pairFailWindowStart = now
      this.pairFailCount = 0
    }
    this.pairFailCount += 1
    if (this.pairFailCount >= 8) {
      this.pairLockUntil = now + 60_000
      this.pairFailCount = 0
      this.pairFailWindowStart = now
      logger.warn('[MobileChannel] 配对失败次数过多，已临时锁定 60 秒')
    }
  }

  // ========== 连接状态管理 ==========

  get connectionState(): ConnectionState {
    return this._connectionState
  }

  private updateConnectionState(newState: ConnectionState): void {
    try {
      if (this._connectionState === newState) return
      const prevState = this._connectionState
      this._connectionState = newState
      logger.debug(`[MobileChannel] State: ${prevState} -> ${newState}`)

      // 通过 IPC 通知渲染进程状态变更
      this.notifyRenderer('mobile:connection-state-changed', {
        prevState,
        newState,
        timestamp: Date.now()
      })
    } catch (error) {
      logger.error(`[MobileChannel] updateConnectionState error: ${error}`)
    }
  }

  private computeGlobalState(): ConnectionState {
    try {
      if (!this.config.enabled || !this.server) return 'disconnected'

      const peers = Array.from(this.peers.values())

      if (peers.length === 0) {
        // 服务运行中但无连接 = 等待配对
        return 'pairing'
      }

      const hasConnected = peers.some(p => p.state === 'connected')
      const hasConnecting = peers.some(p => p.state === 'connecting')
      const hasReconnecting = peers.some(p => p.state === 'reconnecting')

      if (hasConnected) return 'connected'
      if (hasReconnecting) return 'reconnecting'
      if (hasConnecting) return 'connecting'
      return 'pairing'
    } catch (error) {
      logger.error(`[MobileChannel] computeGlobalState error: ${error}`)
      return 'disconnected'
    }
  }

  private refreshGlobalState(): void {
    try {
      const newState = this.computeGlobalState()
      this.updateConnectionState(newState)
    } catch (error) {
      logger.error(`[MobileChannel] refreshGlobalState error: ${error}`)
    }
  }

  // ========== 已知设备管理 ==========

  private recordKnownDevice(peer: PeerConnection): void {
    try {
      const existingIdx = this.config.lastKnownDevices.findIndex(
        (d) => d.deviceId === peer.deviceId
      )
      const device: KnownDevice = {
        deviceId: peer.deviceId,
        deviceName: peer.deviceName,
        deviceType: peer.deviceType,
        lastConnectedAt: Date.now(),
        trusted: true
      }

      if (existingIdx >= 0) {
        this.config.lastKnownDevices[existingIdx] = device
      } else {
        this.config.lastKnownDevices.push(device)
        // 最多保留 20 个已知设备
        if (this.config.lastKnownDevices.length > 20) {
          this.config.lastKnownDevices = this.config.lastKnownDevices.slice(-20)
        }
      }
      this.saveConfig()
    } catch (error) {
      logger.error(`[MobileChannel] recordKnownDevice error: ${error}`)
    }
  }

  // ========== 服务启动/停止 ==========

  /**
   * 启动 WebSocket 信令服务器
   */
  async startServer(): Promise<ChannelStatus> {
    try {
      if (this.server) {
        return this.getStatus()
      }

      return new Promise((resolve, reject) => {
        try {
          this.server = createServer((req, res) => {
            this.handleHttpRequest(req, res)
          })

          // 设置 WebSocket 服务器
          this.wss = new WebSocketServer({ server: this.server })

          this.wss.on('connection', (ws: WebSocket, req) => {
            try {
              this.handleWebSocketConnection(ws, req)
            } catch (error) {
              logger.error(`[MobileChannel] WebSocket connection error: ${error}`)
              try { ws.close() } catch (e) { logger.error(`[MobileChannel] 关闭WebSocket连接失败: ${e}`) }
            }
          })

          this.wss.on('error', (err: Error) => {
            logger.error(`[MobileChannel] WebSocketServer error: ${err}`)
          })

          // 监听指定端口
          const port = this.config.port || DEFAULT_CONFIG.port
          this.server.listen(port, () => {
            try {
              const address = this.server?.address()
              if (address && typeof address === 'object') {
                this.config.port = address.port
              }
              this.config.enabled = true

              // 生成配对码（如果还没有）
              if (!this.config.pairingCode) {
                this.generatePairingCode()
              }

              this.saveConfig()
              this.updateConnectionState('pairing')

              logger.debug(`[MobileChannel] Server started on port ${this.config.port}`)
              logger.debug(`[MobileChannel] Pairing code: ${this.config.pairingCode}`)
              logger.debug(`[MobileChannel] Local IP: ${this.localIp}`)

              resolve(this.getStatus())
            } catch (error) {
              reject(error)
            }
          })

          this.server.on('error', (err: Error) => {
            logger.error(`[MobileChannel] Server error: ${err}`)
            this.stopServer()
            reject(err)
          })
        } catch (error) {
          reject(error)
        }
      })
    } catch (error) {
      logger.error(`[MobileChannel] startServer error: ${error}`)
      return this.getStatus()
    }
  }

  /**
   * 停止服务器
   */
  stopServer(): void {
    try {
      // 清除所有 peer 的重试定时器
      this.peers.forEach((peer) => {
        try {
          if (peer.retryTimer) {
            clearTimeout(peer.retryTimer)
            peer.retryTimer = null
          }
        } catch (e) { logger.error(`[MobileChannel] 清除重试定时器失败: ${e}`) }
      })

      // 断开所有 peer
      this.peers.forEach((peer) => {
        try {
          // 发送断开通知
          if (peer.channel.readyState === WebSocket.OPEN) {
            peer.channel.send(JSON.stringify({
              type: 'server-shutdown',
              data: { message: '服务器已关闭' }
            }))
          }
          peer.channel.close()
        } catch (e) { logger.error(`[MobileChannel] 关闭Peer通道失败: ${e}`) }
      })
      this.peers.clear()

      // 关闭 WebSocket 服务器
      if (this.wss) {
        try {
          // 强制断开所有客户端
          this.wss.clients.forEach((client) => {
            try { client.close() } catch (e) { logger.error(`[MobileChannel] 关闭WebSocket客户端失败: ${e}`) }
          })
          this.wss.close()
        } catch (e) { logger.error(`[MobileChannel] 关闭WebSocket服务器失败: ${e}`) }
        this.wss = null
      }

      // 关闭 HTTP 服务器
      if (this.server) {
        try {
          this.server.close()
        } catch (e) { logger.error(`[MobileChannel] 关闭HTTP服务器失败: ${e}`) }
        this.server = null
      }

      this.config.enabled = false
      this.saveConfig()
      this.updateConnectionState('disconnected')

      this.notifyRenderer('mobile:server-stopped', {
        timestamp: Date.now()
      })

      logger.debug('[MobileChannel] Server stopped')
    } catch (error) {
      logger.error(`[MobileChannel] stopServer error: ${error}`)
    }
  }

  // ========== HTTP 请求处理 ==========

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    try {
      const corsHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }

      // 预检请求
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders)
        res.end()
        return
      }

      if (req.url === '/status' || req.url === '/api/status') {
        // SECURITY: 不再返回 pairingCode。配对码属于敏感凭据，只能通过受信任的
        // IPC 通道（mobile:get-pairing-code）在电脑本地展示，禁止经无认证的
        // 局域网 HTTP 明文暴露（可被任意网页经 DNS rebinding/localhost 窃取）。
        res.writeHead(200, corsHeaders)
        res.end(JSON.stringify({
          name: this.config.name,
          connectedDevices: this.peers.size,
          localIp: this.localIp,
          port: this.config.port,
          connectionState: this._connectionState,
          useWebRTC: this.config.useWebRTC
        }))
      } else if (req.url === '/pairing-code' || req.url === '/api/pairing-code') {
        // SECURITY: 该端点原先明文返回配对码，属高危泄露。改为仅返回元信息，
        // 不再泄露凭据。配对码请在应用内「移动连接」面板查看。
        res.writeHead(200, corsHeaders)
        res.end(JSON.stringify({
          serverName: this.config.name,
          localIp: this.localIp,
          port: this.config.port,
          pairingRequired: true
        }))
      } else if (req.url === '/api/peers') {
        const peers = Array.from(this.peers.entries()).map(([id, peer]) => ({
          id,
          deviceName: peer.deviceName,
          deviceType: peer.deviceType,
          state: peer.state,
          connectedAt: peer.connectedAt,
          dataChannelReady: peer.dataChannelReady
        }))
        res.writeHead(200, corsHeaders)
        res.end(JSON.stringify({ peers, count: peers.length }))
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('玄枢 Mobile Channel - WebSocket Signaling Server')
      }
    } catch (error) {
      logger.error(`[MobileChannel] HTTP request error: ${error}`)
      try {
        res.writeHead(500)
        res.end('Internal Server Error')
      } catch (e) { logger.error(`[MobileChannel] 发送HTTP错误响应失败: ${e}`) }
    }
  }

  // ========== WebSocket 连接处理 ==========

  // @ts-expect-error TS6133 - req reserved for future use
  private handleWebSocketConnection(ws: WebSocket, req: IncomingMessage): void {
    let peerId: string | null = null
    let connectionTimeout: NodeJS.Timeout | null = null

    try {
      // 连接超时：未在指定时间内完成配对的连接自动断开
      connectionTimeout = setTimeout(() => {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'error',
              data: { message: '连接超时，请通过配对码验证' }
            }))
            setTimeout(() => {
              try { ws.close(4001, '配对超时') } catch (e) { logger.error(`[MobileChannel] 关闭超时WebSocket连接失败: ${e}`) }
            }, 500)
          }
        } catch (e) { logger.error(`[MobileChannel] 发送超时错误消息失败: ${e}`) }
      }, RETRY_CONFIG.connectionTimeout)

      ws.on('message', (raw: Buffer | string) => {
        try {
          const message: SignalingMessage = typeof raw === 'string'
            ? JSON.parse(raw)
            : JSON.parse(raw.toString())

          this.handleMessage(ws, message, connectionTimeout, peerId,
            (newPeerId) => { peerId = newPeerId })
        } catch (error) {
          logger.error(`[MobileChannel] Message handling error: ${error}`)
          try {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'error',
                data: { message: '消息格式错误' }
              }))
            }
          } catch (e) { logger.error(`[MobileChannel] 发送错误消息失败: ${e}`) }
        }
      })

      ws.on('close', (code: number, reason: Buffer) => {
        try {
          if (connectionTimeout) {
            clearTimeout(connectionTimeout)
            connectionTimeout = null
          }
          if (peerId) {
            this.handlePeerDisconnect(peerId, code, reason)
          }
        } catch (error) {
          logger.error(`[MobileChannel] WebSocket close error: ${error}`)
        }
      })

      ws.on('error', (err: Error) => {
        try {
          logger.error(`[MobileChannel] WebSocket error: ${err}`)
          if (connectionTimeout) {
            clearTimeout(connectionTimeout)
            connectionTimeout = null
          }
          if (peerId) {
            this.handlePeerDisconnect(peerId, 1006, Buffer.from(err.message))
          }
        } catch (e) { logger.error(`[MobileChannel] 处理WebSocket错误事件失败: ${e}`) }
      })

      // 连接建立时发送欢迎消息
      try {
        ws.send(JSON.stringify({
          type: 'welcome',
          data: {
            serverName: this.config.name,
            version: '10.0.0',
            useWebRTC: this.config.useWebRTC,
            message: '请发送配对码进行连接'
          }
        }))
      } catch (e) { logger.error(`[MobileChannel] 发送欢迎消息失败: ${e}`) }
    } catch (error) {
      logger.error(`[MobileChannel] handleWebSocketConnection error: ${error}`)
      try { ws.close() } catch (e) { logger.error(`[MobileChannel] 关闭WebSocket连接失败: ${e}`) }
    }
  }

  // ========== 消息处理 ==========

  private handleMessage(
    ws: WebSocket,
    message: SignalingMessage,
    timeout: NodeJS.Timeout | null,
    // @ts-expect-error TS6133 - currentPeerId reserved for future use
    currentPeerId: string | null,
    setPeerId: (id: string) => void
  ): void {
    try {
      switch (message.type) {
        case 'pair':
          this.handlePairMessage(ws, message, timeout, setPeerId)
          break

        case 'offer':
        case 'answer':
          this.handleSignalingMessage(ws, message)
          break

        case 'ice-candidate':
          this.handleIceCandidateMessage(ws, message)
          break

        case 'data':
          this.handleDataMessage(ws, message)
          break

        case 'data-channel-ready':
          this.handleDataChannelReady(ws, message)
          break

        case 'ping':
          try {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }))
            }
          } catch (e) { logger.error(`[MobileChannel] 发送Pong响应失败: ${e}`) }
          break

        case 'device-info':
          this.handleDeviceInfo(ws, message)
          break

        default:
          logger.debug(`[MobileChannel] Unknown message type: ${message.type}`)
      }
    } catch (error) {
      logger.error(`[MobileChannel] handleMessage error: ${error}`)
    }
  }

  // ========== 配对消息处理 ==========

  private handlePairMessage(
    ws: WebSocket,
    message: SignalingMessage,
    timeout: NodeJS.Timeout | null,
    setPeerId: (id: string) => void
  ): void {
    try {
      const code = message.code || message.pairingCode || ''
      const deviceName = message.deviceName || message.deviceInfo?.deviceName || '未知设备'
      const deviceType = message.deviceType || message.deviceInfo?.deviceType || 'mobile'
      const deviceId = message.deviceId || message.deviceInfo?.deviceId || `device-${randomBytes(8).toString('hex')}`

      // 验证配对码
      if (!this.verifyPairingCode(code)) {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'paired',
              success: false,
              message: '配对码错误，请重试'
            }))
          }
        } catch (e) { logger.error(`[MobileChannel] 发送配对拒绝消息失败: ${e}`) }
        logger.debug(`[MobileChannel] Pairing rejected: invalid code "${code}"`)
        return
      }

      // 配对成功，清除超时
      if (timeout) {
        clearTimeout(timeout)
      }

      // 生成 peer ID
      const peerId = `peer-${Date.now()}-${randomBytes(4).toString('hex')}`

      // 创建 peer 连接对象
      const peer: PeerConnection = {
        id: peerId,
        deviceName,
        deviceType,
        deviceId,
        connectedAt: Date.now(),
        iceConnectionState: 'new',
        channel: ws,
        state: 'connecting',
        retryCount: 0,
        retryTimer: null,
        webrtcPending: this.config.useWebRTC,
        dataChannelReady: false
      }

      this.peers.set(peerId, peer)
      setPeerId(peerId)

      // 记录已知设备
      this.recordKnownDevice(peer)

      // 发送配对成功消息
      try {
        ws.send(JSON.stringify({
          type: 'paired',
          success: true,
          peerId,
          serverName: this.config.name,
          message: '配对成功',
          data: {
            peerId,
            serverName: this.config.name,
            useWebRTC: this.config.useWebRTC
          }
        }))
      } catch (e) { logger.error(`[MobileChannel] 发送配对成功消息失败: ${e}`) }

      // 更新状态
      peer.state = 'connected'
      this.refreshGlobalState()

      // 通知渲染进程
      this.notifyRenderer('peer:connected', {
        peerId,
        deviceName: peer.deviceName,
        deviceType: peer.deviceType,
        deviceId: peer.deviceId,
        connectedAt: peer.connectedAt,
        state: peer.state
      })

      logger.debug(`[MobileChannel] Peer paired: ${deviceName} (${peerId})`)
    } catch (error) {
      logger.error(`[MobileChannel] handlePairMessage error: ${error}`)
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'paired',
            success: false,
            message: '内部错误，请重试'
          }))
        }
      } catch (e) { logger.error(`[MobileChannel] 发送配对错误消息失败: ${e}`) }
    }
  }

  // ========== WebRTC 信令处理 ==========

  private handleSignalingMessage(ws: WebSocket, message: SignalingMessage): void {
    try {
      const senderPeer = this.findPeerByWs(ws)
      if (!senderPeer) {
        logger.debug('[MobileChannel] No peer found for signaling message')
        return
      }

      // 点对点转发
      if (message.to) {
        const destPeer = this.peers.get(message.to)
        if (destPeer && destPeer.channel.readyState === WebSocket.OPEN) {
          try {
            destPeer.channel.send(JSON.stringify({
              type: message.type,
              from: senderPeer.id,
              sdp: message.sdp,
              data: message.data
            }))
          } catch (e) { logger.error(`[MobileChannel] 转发信令消息失败: ${e}`) }
        }
        return
      }

      // 广播给所有其他 peer（包括渲染进程建立的 WebRTC 连接）
      this.peers.forEach((peer) => {
        if (peer.id !== senderPeer.id && peer.channel.readyState === WebSocket.OPEN) {
          try {
            peer.channel.send(JSON.stringify({
              type: message.type,
              from: senderPeer.id,
              sdp: message.sdp,
              data: message.data
            }))
          } catch (e) { logger.error(`[MobileChannel] 广播信令消息失败: ${e}`) }
        }
      })

      // 通知渲染进程（以便渲染进程可以创建 RTCPeerConnection）
      this.notifyRenderer('webrtc:signaling', {
        type: message.type,
        from: senderPeer.id,
        fromDevice: senderPeer.deviceName,
        sdp: message.sdp,
        data: message.data
      })
    } catch (error) {
      logger.error(`[MobileChannel] handleSignalingMessage error: ${error}`)
    }
  }

  private handleIceCandidateMessage(ws: WebSocket, message: SignalingMessage): void {
    try {
      const senderPeer = this.findPeerByWs(ws)
      if (!senderPeer) return

      // 更新 ICE 连接状态
      senderPeer.iceConnectionState = 'checking'

      // 点对点转发 ICE candidate
      if (message.to) {
        const destPeer = this.peers.get(message.to)
        if (destPeer && destPeer.channel.readyState === WebSocket.OPEN) {
          try {
            destPeer.channel.send(JSON.stringify({
              type: 'ice-candidate',
              from: senderPeer.id,
              candidate: message.candidate,
              ice: message.ice
            }))
          } catch (e) { logger.error(`[MobileChannel] 转发ICE候选消息失败: ${e}`) }
        }
        return
      }

      // 广播 ICE candidate
      this.peers.forEach((peer) => {
        if (peer.id !== senderPeer.id && peer.channel.readyState === WebSocket.OPEN) {
          try {
            peer.channel.send(JSON.stringify({
              type: 'ice-candidate',
              from: senderPeer.id,
              candidate: message.candidate,
              ice: message.ice
            }))
          } catch (e) { logger.error(`[MobileChannel] 广播ICE候选消息失败: ${e}`) }
        }
      })

      // 通知渲染进程
      this.notifyRenderer('webrtc:ice-candidate', {
        from: senderPeer.id,
        fromDevice: senderPeer.deviceName,
        candidate: message.candidate,
        ice: message.ice
      })
    } catch (error) {
      logger.error(`[MobileChannel] handleIceCandidateMessage error: ${error}`)
    }
  }

  // ========== DataChannel 处理 ==========

  // @ts-expect-error TS6133 - message reserved for future use
  private handleDataChannelReady(ws: WebSocket, message: SignalingMessage): void {
    try {
      const senderPeer = this.findPeerByWs(ws)
      if (!senderPeer) return

      senderPeer.dataChannelReady = true
      senderPeer.webrtcPending = false
      senderPeer.iceConnectionState = 'connected'

      logger.debug(`[MobileChannel] DataChannel ready for peer: ${senderPeer.deviceName}`)

      this.notifyRenderer('peer:data-channel-ready', {
        peerId: senderPeer.id,
        deviceName: senderPeer.deviceName,
        deviceType: senderPeer.deviceType
      })
    } catch (error) {
      logger.error(`[MobileChannel] handleDataChannelReady error: ${error}`)
    }
  }

  // ========== 数据消息处理 ==========

  private handleDataMessage(ws: WebSocket, message: SignalingMessage): void {
    try {
      const fromPeer = this.findPeerByWs(ws)
      if (!fromPeer) return

      if (message.to) {
        // 转发给指定 peer
        const destPeer = this.peers.get(message.to)
        if (destPeer && destPeer.channel.readyState === WebSocket.OPEN) {
          try {
            destPeer.channel.send(JSON.stringify({
              type: 'data',
              from: fromPeer.id,
              payload: message.payload
            }))
          } catch (e) { logger.error(`[MobileChannel] 转发数据消息失败: ${e}`) }
        }
      } else {
        // 广播给所有其他 peer
        this.peers.forEach((peer) => {
          if (peer.id !== fromPeer.id && peer.channel.readyState === WebSocket.OPEN) {
            try {
              peer.channel.send(JSON.stringify({
                type: 'data',
                from: fromPeer.id,
                payload: message.payload
              }))
            } catch (e) { logger.error(`[MobileChannel] 广播数据消息失败: ${e}`) }
          }
        })
      }

      // 通知渲染进程
      this.notifyRenderer('peer:data', {
        from: fromPeer.id,
        fromDevice: fromPeer.deviceName,
        payload: message.payload
      })
    } catch (error) {
      logger.error(`[MobileChannel] handleDataMessage error: ${error}`)
    }
  }

  // ========== 设备信息处理 ==========

  private handleDeviceInfo(ws: WebSocket, message: SignalingMessage): void {
    try {
      const peer = this.findPeerByWs(ws)
      if (!peer) return
      // 更新设备信息
      if (message.deviceName) peer.deviceName = message.deviceName
      if (message.deviceType) peer.deviceType = message.deviceType
      if (message.deviceId) peer.deviceId = message.deviceId
    } catch (error) {
      logger.error(`[MobileChannel] handleDeviceInfo error: ${error}`)
    }
  }

  // ========== Peer 断开与重连 ==========

  private handlePeerDisconnect(peerId: string, code: number, reason: Buffer): void {
    try {
      const peer = this.peers.get(peerId)
      if (!peer) return

      // 清除重试定时器
      if (peer.retryTimer) {
        clearTimeout(peer.retryTimer)
        peer.retryTimer = null
      }

      const reasonStr = reason?.toString() || '未知原因'

      logger.debug(`[MobileChannel] Peer disconnected: ${peer.deviceName} (${peerId}), code=${code}, reason=${reasonStr}`)

      // 检查是否需要自动重试
      if (this.shouldRetryConnection(peer)) {
        this.scheduleRetry(peer)
      } else {
        // 彻底断开
        this.finalizePeerDisconnect(peerId)
      }
    } catch (error) {
      logger.error(`[MobileChannel] handlePeerDisconnect error: ${error}`)
      // 确保清理
      try {
        this.finalizePeerDisconnect(peerId)
      } catch (e) { logger.error(`[MobileChannel] 清理Peer断开连接失败: ${e}`) }
    }
  }

  private shouldRetryConnection(peer: PeerConnection): boolean {
    try {
      // 仅在服务器运行且重试次数未超限时重试
      if (!this.config.enabled || !this.server) return false
      if (peer.retryCount >= RETRY_CONFIG.maxRetries) return false
      // 仅对已连接过的设备重试
      if (peer.state !== 'connected' && peer.state !== 'connecting') return false
      return true
    } catch {
      return false
    }
  }

  private scheduleRetry(peer: PeerConnection): void {
    try {
      peer.retryCount++
      peer.state = 'reconnecting'

      logger.debug(`[MobileChannel] Scheduling retry ${peer.retryCount}/${RETRY_CONFIG.maxRetries} for ${peer.deviceName}`)

      peer.retryTimer = setTimeout(() => {
        try {
          // 重试：将 peer 状态重置为等待重连
          peer.retryTimer = null
          peer.state = 'connecting'
          peer.iceConnectionState = 'new'

          this.refreshGlobalState()

          this.notifyRenderer('peer:reconnecting', {
            peerId: peer.id,
            deviceName: peer.deviceName,
            deviceType: peer.deviceType,
            retryCount: peer.retryCount,
            maxRetries: RETRY_CONFIG.maxRetries
          })

          logger.debug(`[MobileChannel] Retry attempt ${peer.retryCount} for ${peer.deviceName}`)
        } catch (error) {
          logger.error(`[MobileChannel] scheduleRetry callback error: ${error}`)
        }
      }, RETRY_CONFIG.retryDelayMs)
    } catch (error) {
      logger.error(`[MobileChannel] scheduleRetry error: ${error}`)
    }
  }

  private finalizePeerDisconnect(peerId: string): void {
    try {
      const peer = this.peers.get(peerId)
      if (!peer) return

      const deviceName = peer.deviceName
      const wasConnected = peer.state === 'connected'

      // 清除重试定时器
      if (peer.retryTimer) {
        clearTimeout(peer.retryTimer)
        peer.retryTimer = null
      }

      // 关闭 WebSocket
      try {
        if (peer.channel.readyState === WebSocket.OPEN || peer.channel.readyState === WebSocket.CONNECTING) {
          peer.channel.close()
        }
      } catch (e) { logger.error(`[MobileChannel] 关闭Peer通道失败: ${e}`) }

      this.peers.delete(peerId)

      // 更新全局状态
      this.refreshGlobalState()

      // 通知渲染进程
      this.notifyRenderer('peer:disconnected', {
        peerId,
        deviceName: peer.deviceName,
        deviceType: peer.deviceType,
        deviceId: peer.deviceId,
        timestamp: Date.now()
      })

      logger.debug(`[MobileChannel] Peer finalized: ${peer.deviceName} (${peerId})`)

      // P2P 失败时触发云端中继降级（仅对已连接过的设备）
      if (wasConnected && peer.retryCount >= RETRY_CONFIG.maxRetries) {
        this.onP2PFallback(peerId, deviceName)
      }
    } catch (error) {
      logger.error(`[MobileChannel] finalizePeerDisconnect error: ${error}`)
    }
  }

  // ========== 工具方法 ==========

  private findPeerByWs(ws: WebSocket): PeerConnection | null {
    try {
      for (const [, peer] of this.peers) {
        if (peer.channel === ws) {
          return peer
        }
      }
      return null
    } catch (error) {
      logger.error(`[MobileChannel] findPeerByWs error: ${error}`)
      return null
    }
  }

  private notifyRenderer(event: string, data: unknown): void {
    try {
      const windows = BrowserWindow.getAllWindows()
      const mainWin = windows[0]
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send(event, data)
      }
    } catch (error) {
      logger.error(`[MobileChannel] notifyRenderer error: ${error}`)
    }
  }

  // ========== 公共 API ==========

  /**
   * 获取服务状态
   */
  getStatus(): ChannelStatus {
    try {
      return {
        running: this.config.enabled && this.server !== null,
        port: this.config.port,
        connectedDevices: this.peers.size,
        connectionCode: this.config.pairingCode,
        connectionState: this._connectionState,
        serverName: this.config.name,
        localIp: this.localIp,
        useWebRTC: this.config.useWebRTC,
        autoStart: this.config.autoStart
      }
    } catch (error) {
      logger.error(`[MobileChannel] getStatus error: ${error}`)
      return {
        running: false,
        port: 0,
        connectedDevices: 0,
        connectionCode: '',
        connectionState: 'disconnected',
        serverName: this.config.name,
        localIp: '127.0.0.1',
        useWebRTC: true,
        autoStart: false
      }
    }
  }

  /**
   * 获取连接状态
   */
  getConnectionStatus(): { state: ConnectionState; peers: number; details: Array<{
    id: string
    deviceName: string
    deviceType: string
    deviceId: string
    state: ConnectionState
    iceConnectionState: string
    dataChannelReady: boolean
    connectedAt: number
    retryCount: number
  }> } {
    try {
      const peers = Array.from(this.peers.entries()).map(([id, peer]) => ({
        id,
        deviceName: peer.deviceName,
        deviceType: peer.deviceType,
        deviceId: peer.deviceId,
        state: peer.state,
        iceConnectionState: peer.iceConnectionState,
        dataChannelReady: peer.dataChannelReady,
        connectedAt: peer.connectedAt,
        retryCount: peer.retryCount
      }))

      return {
        state: this._connectionState,
        peers: peers.length,
        details: peers
      }
    } catch (error) {
      logger.error(`[MobileChannel] getConnectionStatus error: ${error}`)
      return { state: 'disconnected', peers: 0, details: [] }
    }
  }

  /**
   * 向指定 peer 发送数据
   */
  sendData(peerId: string, data: Record<string, unknown>): boolean {
    try {
      const peer = this.peers.get(peerId)
      if (!peer || peer.channel.readyState !== WebSocket.OPEN) {
        return false
      }

      peer.channel.send(JSON.stringify({
        type: 'data',
        from: 'server',
        payload: data
      }))

      return true
    } catch (error) {
      logger.error(`[MobileChannel] sendData error: ${error}`)
      return false
    }
  }

  /**
   * 向所有已连接 peer 广播数据
   */
  broadcastData(data: Record<string, unknown>): number {
    try {
      let sent = 0
      this.peers.forEach((peer) => {
        if (peer.channel.readyState === WebSocket.OPEN) {
          try {
            peer.channel.send(JSON.stringify({
              type: 'data',
              from: 'server',
              payload: data
            }))
            sent++
          } catch (e) { logger.error(`[MobileChannel] 广播数据到Peer失败: ${e}`) }
        }
      })
      return sent
    } catch (error) {
      logger.error(`[MobileChannel] broadcastData error: ${error}`)
      return 0
    }
  }

  /**
   * 断开指定 peer
   */
  disconnectPeer(peerId: string): boolean {
    try {
      const peer = this.peers.get(peerId)
      if (!peer) return false

      // 清除重试定时器
      if (peer.retryTimer) {
        clearTimeout(peer.retryTimer)
        peer.retryTimer = null
      }

      // 发送断开通知
      try {
        if (peer.channel.readyState === WebSocket.OPEN) {
          peer.channel.send(JSON.stringify({
            type: 'disconnect',
            data: { message: '服务端主动断开连接' }
          }))
        }
      } catch (e) { logger.error(`[MobileChannel] 发送断开通知失败: ${e}`) }

      try {
        peer.channel.close()
      } catch (e) { logger.error(`[MobileChannel] 关闭Peer通道失败: ${e}`) }

      this.peers.delete(peerId)
      this.refreshGlobalState()

      this.notifyRenderer('peer:disconnected', {
        peerId,
        deviceName: peer.deviceName,
        deviceType: peer.deviceType,
        timestamp: Date.now()
      })

      return true
    } catch (error) {
      logger.error(`[MobileChannel] disconnectPeer error: ${error}`)
      return false
    }
  }

  /**
   * 切换通道开关
   */
  async toggleChannel(): Promise<ChannelStatus> {
    try {
      if (this.config.enabled) {
        this.stopServer()
      } else {
        await this.startServer()
      }
      return this.getStatus()
    } catch (error) {
      logger.error(`[MobileChannel] toggleChannel error: ${error}`)
      return this.getStatus()
    }
  }

  /**
   * 设置配置
   */
  setConfig(partial: Partial<MobileChannelConfig>): void {
    try {
      this.config = { ...this.config, ...partial }
      this.saveConfig()
    } catch (error) {
      logger.error(`[MobileChannel] setConfig error: ${error}`)
    }
  }

  /**
   * 获取已知设备列表
   */
  getKnownDevices(): KnownDevice[] {
    try {
      return [...this.config.lastKnownDevices]
    } catch (error) {
      logger.error(`[MobileChannel] getKnownDevices error: ${error}`)
      return []
    }
  }

  /**
   * 获取所有已连接 peer
   */
  getPeers(): Array<{
    id: string
    deviceName: string
    deviceType: string
    deviceId: string
    state: ConnectionState
    connectedAt: number
    iceConnectionState: string
    dataChannelReady: boolean
  }> {
    try {
      return Array.from(this.peers.entries()).map(([id, peer]) => ({
        id,
        deviceName: peer.deviceName,
        deviceType: peer.deviceType,
        deviceId: peer.deviceId,
        state: peer.state,
        connectedAt: peer.connectedAt,
        iceConnectionState: peer.iceConnectionState,
        dataChannelReady: peer.dataChannelReady
      }))
    } catch (error) {
      logger.error(`[MobileChannel] getPeers error: ${error}`)
      return []
    }
  }

  // ========== CloudRelay 云端中继 ==========

  /**
   * 建立云端中继连接
   * 当 WebRTC P2P 直连失败（NAT 穿透失败）时，通过 WebSocket 连接到云端信令服务器进行数据中转
   */
  async connectRelay(): Promise<boolean> {
    try {
      if (!this.cloudRelayConfig.enabled) {
        logger.debug('[CloudRelay] Relay is disabled, skipping')
        return false
      }

      if (this.relayConnection && this.relayConnection.readyState === WebSocket.OPEN) {
        logger.debug('[CloudRelay] Already connected')
        return true
      }

      this._relayConnectionState = 'connecting'
      this.notifyRenderer('mobile:relay-state-changed', {
        state: 'connecting',
        timestamp: Date.now()
      })

      logger.debug(`[CloudRelay] Connecting to ${this.cloudRelayConfig.relayUrl}...`)

      return new Promise((resolve) => {
        try {
          const ws = new WebSocket(this.cloudRelayConfig.relayUrl)

          const connectionTimeout = setTimeout(() => {
            try {
              logger.error('[CloudRelay] Connection timeout')
              this._relayConnectionState = 'error'
              ws.close()
              resolve(false)
            } catch (e) {
              resolve(false)
            }
          }, this.cloudRelayConfig.fallbackTimeout)

          ws.on('open', () => {
            try {
              clearTimeout(connectionTimeout)
              this.relayConnection = ws
              this._relayConnectionState = 'connected'
              logger.debug('[CloudRelay] Connected successfully')

              // 发送身份信息
              ws.send(JSON.stringify({
                type: 'relay-register',
                data: {
                  serverName: this.config.name,
                  pairingCode: this.config.pairingCode,
                  deviceId: `desktop-${this.localIp.replace(/\./g, '-')}`,
                  deviceType: 'desktop',
                  timestamp: Date.now()
                }
              }))

              this.notifyRenderer('mobile:relay-state-changed', {
                state: 'connected',
                timestamp: Date.now()
              })

              resolve(true)
            } catch (e) {
              resolve(false)
            }
          })

          ws.on('message', (raw: Buffer | string) => {
            try {
              const message: SignalingMessage = typeof raw === 'string'
                ? JSON.parse(raw)
                : JSON.parse(raw.toString())
              this.handleRelayMessage(message)
            } catch (error) {
              logger.error(`[CloudRelay] Message parsing error: ${error}`)
            }
          })

          ws.on('close', (code: number, reason: Buffer) => {
            try {
              logger.debug(`[CloudRelay] Disconnected: code=${code}, reason=${reason?.toString() || 'unknown'}`)
              this._relayConnectionState = 'disconnected'
              this.relayConnection = null

              this.notifyRenderer('mobile:relay-state-changed', {
                state: 'disconnected',
                code,
                timestamp: Date.now()
              })

              // 自动重连
              if (this.cloudRelayConfig.enabled && this.config.enabled) {
                this.scheduleRelayReconnect()
              }
            } catch (e) {
              logger.error(`[CloudRelay] close handler error: ${e}`)
            }
          })

          ws.on('error', (err: Error) => {
            try {
              clearTimeout(connectionTimeout)
              logger.error(`[CloudRelay] WebSocket error: ${err.message}`)
              this._relayConnectionState = 'error'
              this.relayConnection = null

              this.notifyRenderer('mobile:relay-state-changed', {
                state: 'error',
                error: err.message,
                timestamp: Date.now()
              })

              resolve(false)
            } catch (e) {
              resolve(false)
            }
          })
        } catch (error) {
          logger.error(`[CloudRelay] connectRelay error: ${error}`)
          resolve(false)
        }
      })
    } catch (error) {
      logger.error(`[CloudRelay] connectRelay error: ${error}`)
      this._relayConnectionState = 'error'
      return false
    }
  }

  /**
   * 断开云端中继连接
   */
  disconnectRelay(): void {
    try {
      // 清除重连定时器
      if (this.relayReconnectTimer) {
        clearTimeout(this.relayReconnectTimer)
        this.relayReconnectTimer = null
      }

      if (this.relayConnection) {
        try {
          if (this.relayConnection.readyState === WebSocket.OPEN) {
            this.relayConnection.send(JSON.stringify({
              type: 'relay-disconnect',
              data: { message: '客户端主动断开' }
            }))
          }
          this.relayConnection.close()
        } catch (e) {
          logger.error(`[CloudRelay] Error closing relay connection: ${e}`)
        }
        this.relayConnection = null
      }

      this._relayConnectionState = 'disconnected'
      this.p2pFailedPeerIds.clear()

      this.notifyRenderer('mobile:relay-state-changed', {
        state: 'disconnected',
        timestamp: Date.now()
      })

      logger.debug('[CloudRelay] Disconnected')
    } catch (error) {
      logger.error(`[CloudRelay] disconnectRelay error: ${error}`)
    }
  }

  /**
   * 通过中继发送数据
   */
  sendRelayData(targetPeerId: string | null, data: Record<string, unknown>): boolean {
    try {
      if (!this.relayConnection || this.relayConnection.readyState !== WebSocket.OPEN) {
        logger.warn('[CloudRelay] Relay not connected, cannot send data')
        return false
      }

      this.relayConnection.send(JSON.stringify({
        type: 'relay-data',
        to: targetPeerId,
        payload: data,
        timestamp: Date.now()
      }))

      return true
    } catch (error) {
      logger.error(`[CloudRelay] sendRelayData error: ${error}`)
      return false
    }
  }

  /**
   * 通过中继广播数据到所有中继节点
   */
  broadcastRelayData(data: Record<string, unknown>): boolean {
    try {
      return this.sendRelayData(null, data)
    } catch (error) {
      logger.error(`[CloudRelay] broadcastRelayData error: ${error}`)
      return false
    }
  }

  /**
   * 处理来自中继的消息
   */
  private handleRelayMessage(message: SignalingMessage): void {
    try {
      switch (message.type) {
        case 'relay-data':
          // 来自中继的数据转发
          this.notifyRenderer('mobile:relay-data', {
            from: message.from,
            payload: message.payload,
            timestamp: message.data?.timestamp || Date.now()
          })
          break

        case 'relay-device-joined':
          logger.debug(`[CloudRelay] Device joined via relay: ${message.deviceName}`)
          this.notifyRenderer('mobile:relay-device-joined', {
            deviceName: message.deviceName,
            deviceType: message.deviceType,
            deviceId: message.deviceId
          })
          break

        case 'relay-device-left':
          logger.debug(`[CloudRelay] Device left via relay: ${message.deviceName}`)
          this.notifyRenderer('mobile:relay-device-left', {
            deviceName: message.deviceName,
            deviceId: message.deviceId
          })
          break

        case 'relay-error':
          logger.error(`[CloudRelay] Server error: ${message.message}`)
          this.notifyRenderer('mobile:relay-error', {
            message: message.message
          })
          break

        case 'pong':
          // 心跳响应，忽略
          break

        default:
          logger.debug(`[CloudRelay] Unknown relay message type: ${message.type}`)
      }
    } catch (error) {
      logger.error(`[CloudRelay] handleRelayMessage error: ${error}`)
    }
  }

  /**
   * 定时重连中继
   */
  private scheduleRelayReconnect(): void {
    try {
      if (this.relayReconnectTimer) return // 已有重连任务

      logger.debug('[CloudRelay] Scheduling reconnect in 10s...')
      this.relayReconnectTimer = setTimeout(async () => {
        try {
          this.relayReconnectTimer = null
          if (this.cloudRelayConfig.enabled && this.config.enabled) {
            await this.connectRelay()
          }
        } catch (error) {
          logger.error(`[CloudRelay] Reconnect failed: ${error}`)
        }
      }, 10000)
    } catch (error) {
      logger.error(`[CloudRelay] scheduleRelayReconnect error: ${error}`)
    }
  }

  /**
   * P2P 失败时触发中继降级
   * 在 peer 断开且重试耗尽后调用
   */
  private async onP2PFallback(peerId: string, deviceName: string): Promise<void> {
    try {
      if (!this.cloudRelayConfig.enabled) {
        logger.debug(`[CloudRelay] Fallback disabled, P2P peer lost: ${deviceName}`)
        return
      }

      this.p2pFailedPeerIds.add(peerId)
      logger.debug(`[CloudRelay] P2P failed for ${deviceName} (${peerId}), attempting relay fallback...`)

      const connected = await this.connectRelay()
      if (connected) {
        logger.debug(`[CloudRelay] Relay fallback active for ${deviceName}`)
        this.notifyRenderer('mobile:relay-fallback-triggered', {
          peerId,
          deviceName,
          timestamp: Date.now()
        })
      } else {
        logger.error(`[CloudRelay] Relay fallback failed for ${deviceName}`)
      }
    } catch (error) {
      logger.error(`[CloudRelay] onP2PFallback error: ${error}`)
    }
  }

  /**
   * 获取中继连接状态
   */
  getRelayStatus(): RelayStatus {
    try {
      return {
        connected: this.relayConnection !== null && this.relayConnection.readyState === WebSocket.OPEN,
        state: this._relayConnectionState,
        config: { ...this.cloudRelayConfig }
      }
    } catch (error) {
      logger.error(`[CloudRelay] getRelayStatus error: ${error}`)
      return {
        connected: false,
        state: 'disconnected',
        config: { ...DEFAULT_RELAY_CONFIG }
      }
    }
  }

  /**
   * 切换中继功能开关
   */
  async toggleRelay(): Promise<RelayStatus> {
    try {
      this.cloudRelayConfig.enabled = !this.cloudRelayConfig.enabled

      if (this.cloudRelayConfig.enabled) {
        logger.debug('[CloudRelay] Enabled, connecting...')
        await this.connectRelay()
      } else {
        logger.debug('[CloudRelay] Disabled, disconnecting...')
        this.disconnectRelay()
      }

      return this.getRelayStatus()
    } catch (error) {
      logger.error(`[CloudRelay] toggleRelay error: ${error}`)
      return this.getRelayStatus()
    }
  }

  /**
   * 设置中继配置
   */
  setRelayConfig(partial: Partial<CloudRelayConfig>): void {
    try {
      this.cloudRelayConfig = { ...this.cloudRelayConfig, ...partial }
      logger.debug(`[CloudRelay] Config updated: ${this.cloudRelayConfig}`)
    } catch (error) {
      logger.error(`[CloudRelay] setRelayConfig error: ${error}`)
    }
  }
}

/* ==================== 单例导出 ==================== */

export const mobileChannelEngine = new MobileChannelEngine()

/* ==================== IPC Handlers ==================== */

export function setupMobileChannelHandlers(): void {
  // ========== 服务器控制 ==========

  /** 启动 WebSocket 信令服务器 */
  ipcMain.handle('mobile:start-server', async (): Promise<IpcResult<ChannelStatus>> => {
    try {
      const status = await mobileChannelEngine.startServer()
      return { success: true, data: status }
    } catch (error) {
      logger.error(`[MobileChannel IPC] start-server error: ${error}`)
      return { success: false, error: '手机通道遇到内部错误' }
    }
  })

  /** 停止服务器 */
  ipcMain.handle('mobile:stop-server', (): IpcResult => {
    try {
      mobileChannelEngine.stopServer()
      return { success: true }
    } catch (error) {
      logger.error(`[MobileChannel IPC] stop-server error: ${error}`)
      return { success: false, error: '手机通道遇到内部错误' }
    }
  })

  // ========== 状态查询 ==========

  /** 获取服务器状态：运行中/已停止，端口号，配对码，当前连接数 */
  ipcMain.handle('mobile:server-status', (): ChannelStatus => {
    try {
      return mobileChannelEngine.getStatus()
    } catch (error) {
      logger.error(`[MobileChannel IPC] server-status error: ${error}`)
      return {
        running: false,
        port: 0,
        connectedDevices: 0,
        connectionCode: '',
        connectionState: 'disconnected',
        serverName: '玄枢 AI',
        localIp: '127.0.0.1',
        useWebRTC: true,
        autoStart: false
      }
    }
  })

  /** 同步获取当前配对码，不依赖服务是否运行 */
  ipcMain.handle('mobile:pairing-code', (): { code: string } => {
    try {
      const code = mobileChannelEngine.getPairingCode()
      return { code }
    } catch (error) {
      logger.error(`[MobileChannel IPC] pairing-code error: ${error}`)
      return { code: '' }
    }
  })

  /** 获取当前连接状态 */
  ipcMain.handle('mobile:connection-status', (): ReturnType<MobileChannelEngine['getConnectionStatus']> => {
    try {
      return mobileChannelEngine.getConnectionStatus()
    } catch (error) {
      logger.error(`[MobileChannel IPC] connection-status error: ${error}`)
      return { state: 'disconnected', peers: 0, details: [] }
    }
  })

  // ========== 配对码管理（兼容旧接口） ==========

  /** 获取配对码（旧接口，保持兼容） */
  ipcMain.handle('mobile:get-pairing-code', (): { code: string; error?: string } => {
    try {
      const code = mobileChannelEngine.getPairingCode()
      return { code }
    } catch (error) {
      logger.error(`[MobileChannel IPC] get-pairing-code error: ${error}`)
      return { code: '', error: '手机通道遇到内部错误' }
    }
  })

  /** 设置自定义配对码 */
  ipcMain.handle('mobile:set-pairing-code', (_event, code: string): { success: boolean; code: string; error?: string } => {
    try {
      const result = mobileChannelEngine.setPairingCode(code)
      return { success: result, code: mobileChannelEngine.getPairingCode() }
    } catch (error) {
      logger.error(`[MobileChannel IPC] set-pairing-code error: ${error}`)
      return { success: false, code: '', error: '手机通道遇到内部错误' }
    }
  })

  // ========== Peer 连接管理 ==========

  /** 发起连接（WebRTC 信令） */
  ipcMain.handle('mobile:connect-peer', async (_event, peerId: string): Promise<IpcResult> => {
    try {
      return { success: true, data: { peerId } }
    } catch (error) {
      logger.error(`[MobileChannel IPC] connect-peer error: ${error}`)
      return { success: false, error: '手机通道遇到内部错误' }
    }
  })

  /** 断开指定 peer */
  ipcMain.handle('mobile:disconnect-peer', (_event, peerId: string): IpcResult => {
    try {
      const result = mobileChannelEngine.disconnectPeer(peerId)
      return { success: result }
    } catch (error) {
      logger.error(`[MobileChannel IPC] disconnect-peer error: ${error}`)
      return { success: false, error: '手机通道遇到内部错误' }
    }
  })

  /** 获取所有已连接 peer */
  ipcMain.handle('mobile:list-peers', (): ReturnType<MobileChannelEngine['getPeers']> => {
    try {
      return mobileChannelEngine.getPeers()
    } catch (error) {
      logger.error(`[MobileChannel IPC] list-peers error: ${error}`)
      return []
    }
  })

  // ========== 数据通信 ==========

  /** 向指定 peer 发送数据 */
  ipcMain.handle('mobile:send-peer-data', (_event, peerId: string, data: Record<string, unknown>): IpcResult => {
    try {
      const result = mobileChannelEngine.sendData(peerId, data)
      return { success: result }
    } catch (error) {
      logger.error(`[MobileChannel IPC] send-peer-data error: ${error}`)
      return { success: false, error: '手机通道遇到内部错误' }
    }
  })

  /** 向所有 peer 广播数据 */
  ipcMain.handle('mobile:broadcast-data', (_event, data: Record<string, unknown>): IpcResult<number> => {
    try {
      const sent = mobileChannelEngine.broadcastData(data)
      return { success: true, data: sent }
    } catch (error) {
      logger.error(`[MobileChannel IPC] broadcast-data error: ${error}`)
      return { success: false, error: '手机通道遇到内部错误' }
    }
  })

  // ========== 通道控制 ==========

  /** 切换通道开关 */
  ipcMain.handle('mobile:toggle-channel', async (): Promise<ChannelStatus> => {
    try {
      const status = await mobileChannelEngine.toggleChannel()
      return status
    } catch (error) {
      logger.error(`[MobileChannel IPC] toggle-channel error: ${error}`)
      return {
        running: false,
        port: 0,
        connectedDevices: 0,
        connectionCode: '',
        connectionState: 'disconnected',
        serverName: '玄枢 AI',
        localIp: '127.0.0.1',
        useWebRTC: true,
        autoStart: false
      }
    }
  })

  // ========== 配置管理 ==========

  /** 设置配置 */
  ipcMain.handle('mobile:set-config', (_event, partial: Partial<MobileChannelConfig>): IpcResult => {
    try {
      mobileChannelEngine.setConfig(partial)
      return { success: true }
    } catch (error) {
      logger.error(`[MobileChannel IPC] set-config error: ${error}`)
      return { success: false, error: '手机通道遇到内部错误' }
    }
  })

  /** 获取已知设备列表 */
  ipcMain.handle('mobile:known-devices', (): KnownDevice[] => {
    try {
      return mobileChannelEngine.getKnownDevices()
    } catch (error) {
      logger.error(`[MobileChannel IPC] known-devices error: ${error}`)
      return []
    }
  })

  // ========== 信令消息转发（渲染进程 -> 手机端） ==========

  /** 从渲染进程发送 WebRTC 信令到手机端 */
  ipcMain.handle('mobile:send-signaling', (_event, peerId: string, signalingData: {
    type: string
    sdp?: RTCSessionDescriptionInit
    candidate?: RTCIceCandidateInit
  }): IpcResult => {
    try {
      const peer = mobileChannelEngine['peers'].get(peerId) as PeerConnection | undefined
      if (!peer) {
        return { success: false, error: 'Peer not found' }
      }
      if (peer.channel.readyState !== WebSocket.OPEN) {
        return { success: false, error: 'Peer not connected' }
      }

      peer.channel.send(JSON.stringify(signalingData))
      return { success: true }
    } catch (error) {
      logger.error(`[MobileChannel IPC] send-signaling error: ${error}`)
      return { success: false, error: '手机通道遇到内部错误' }
    }
  })

  // ========== CloudRelay 云端中继 ==========

  /** 查询中继连接状态 */
  ipcMain.handle('mobile:relay-status', (): RelayStatus => {
    try {
      return mobileChannelEngine.getRelayStatus()
    } catch (error) {
      logger.error(`[CloudRelay IPC] relay-status error: ${error}`)
      return {
        connected: false,
        state: 'disconnected',
        config: { ...DEFAULT_RELAY_CONFIG }
      }
    }
  })

  /** 开关中继功能 */
  ipcMain.handle('mobile:toggle-relay', async (): Promise<RelayStatus> => {
    try {
      const status = await mobileChannelEngine.toggleRelay()
      return status
    } catch (error) {
      logger.error(`[CloudRelay IPC] toggle-relay error: ${error}`)
      return {
        connected: false,
        state: 'disconnected',
        config: { ...DEFAULT_RELAY_CONFIG }
      }
    }
  })
}