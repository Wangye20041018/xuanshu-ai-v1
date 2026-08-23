/**
 * Edge TTS 在线引擎（微软免费 TTS）
 * 使用 Microsoft Edge 的免费 TTS 服务，音质对标豆包
 * 无网络时自动降级到 Piper 离线引擎
 */

import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, readdirSync, statSync } from 'fs'
import { createHash, randomUUID, randomBytes } from 'crypto'
import { app } from 'electron'
import https from 'https'
import { getSystemProxy, createProxyAgent } from '../utils/proxy-resolver'
import { piperTTS, PiperOptions } from './piper'
import { logger } from '../../shared/logger'

/** Edge TTS 服务端当前要求的 Chromium/Edge 版本（用于 Sec-MS-GEC-Version 与 UA，需与服务端同步） */
const EDGE_VERSION_HEADER = '1-143.0.3650.75'

/** WebSocket 客户端帧编码（掩码位必须置 1，服务端要求客户端帧掩码） */
function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const finOpcode = 0x80 | opcode
  const mask = randomBytes(4)
  let header: Buffer
  const len = payload.length
  if (len < 126) {
    header = Buffer.alloc(2)
    header[0] = finOpcode
    header[1] = 0x80 | len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = finOpcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = finOpcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  const masked = Buffer.alloc(len)
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4]
  return Buffer.concat([header, mask, masked])
}

/* ============================================================
 * 类型定义
 * ============================================================ */
export interface EdgeVoice {
  id: string
  name: string
  gender: 'male' | 'female'
  locale: string
}

export interface EdgeOptions {
  pitch?: string        // 音调: 'default', 'x-low', 'low', 'medium', 'high', 'x-high', 或 '-10%' ~ '+10%'
  rate?: string         // 语速: 'default', 'x-slow', 'slow', 'medium', 'fast', 'x-fast', 或 '-50%' ~ '+100%'
  volume?: string       // 音量: 'default', 'silent', 'x-soft', 'soft', 'medium', 'loud', 'x-loud', 或 '0%' ~ '100%'
  timeout?: number      // 超时(ms): 默认 15000
}

export interface SynthesizeResult {
  success: boolean
  audioPath?: string
  error?: string
  engine: 'edge'
  voiceId: string
}

/* ============================================================
 * 支持的中文语音列表
 * ============================================================ */
export const EDGE_VOICES: EdgeVoice[] = [
  {
    id: 'zh-CN-XiaoxiaoNeural',
    name: '晓晓 (女声·温暖)',
    gender: 'female',
    locale: 'zh-CN'
  },
  {
    id: 'zh-CN-YunxiNeural',
    name: '云希 (男声·专业)',
    gender: 'male',
    locale: 'zh-CN'
  },
  {
    id: 'zh-CN-XiaoyiNeural',
    name: '晓伊 (女声·活泼)',
    gender: 'female',
    locale: 'zh-CN'
  },
  {
    id: 'zh-CN-YunjianNeural',
    name: '云健 (男声·活力)',
    gender: 'male',
    locale: 'zh-CN'
  },
  {
    id: 'zh-CN-XiaobeiNeural',
    name: '晓北 (女声·东北)',
    gender: 'female',
    locale: 'zh-CN'
  },
  {
    id: 'zh-CN-XiaoniNeural',
    name: '晓妮 (女声·亲切)',
    gender: 'female',
    locale: 'zh-CN'
  }
]

/* ============================================================
 * 语音包到 Edge 语音的映射
 * ============================================================ */
export const VOICE_TO_EDGE_MAP: Record<string, string> = {
  'xuanxu_warm_female': 'zh-CN-XiaoxiaoNeural',
  'xuanxu_calm_male': 'zh-CN-YunxiNeural',
  'xuanxu_bright_female': 'zh-CN-XiaoyiNeural',
  'xuanxu_deep_male': 'zh-CN-YunjianNeural',
  'xuanxu_gentle_female': 'zh-CN-XiaohanNeural',
  'xuanxu_professional_male': 'zh-CN-YunyangNeural',
  'xuanxu_cheerful_female': 'zh-CN-XiaoxiaoNeural',
  'xuanxu_elder_male': 'zh-CN-YunxiaNeural',
  'xuanxu_sweet_female': 'zh-CN-XiaochenNeural',
  'xuanxu_serious_male': 'zh-CN-YunjianNeural',
}

/* ============================================================
 * Edge TTS 端点常量
 * ============================================================ */
const EDGE_TTS_URL = 'speech.platform.bing.com'
const EDGE_TTS_PATH = '/consumer/speech/synthesize/readaloud/edge/v1'
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'

/* ============================================================
 * EdgeTTS 类
 * ============================================================ */
export class EdgeTTS {
  private tempDir: string
  private cacheDir: string
  private abortController: AbortController | null = null
  private ws: { close: () => void } | null = null
  private initialized: boolean = false

  constructor() {
    this.tempDir = ''
    this.cacheDir = ''
  }

  /* ------ 初始化 ------ */
  initialize(): void {
    if (this.initialized) return
    try {
      this.tempDir = join(app.getPath('userData'), 'tts-temp')
      mkdirSync(this.tempDir, { recursive: true })

      // 缓存目录：Edge TTS 合成成功后缓存 MP3 到此目录
      // 使用 userData 下的 tts-cache（原 join(app.getAppPath(),'..','..','assets','voices','cache')
      // 会解析到项目外盘根目录 E:\assets，且打包后 app.asar 内只读无法写入）
      this.cacheDir = join(app.getPath('userData'), 'tts-cache')
      mkdirSync(this.cacheDir, { recursive: true })

      this.initialized = true
    } catch (e) {
      logger.error('[EdgeTTS] 初始化失败:', e)
      // 使用备用目录
      this.tempDir = join(process.env.TEMP || '/tmp', 'xuanshu-tts')
      mkdirSync(this.tempDir, { recursive: true })
      this.cacheDir = this.tempDir
      this.initialized = true
    }
  }

  /* ------ 语音合成（在线） ------ */
  async speak(
    text: string,
    voiceName: string,
    options: EdgeOptions = {}
  ): Promise<SynthesizeResult> {
    if (!this.initialized) this.initialize()

    if (!text || text.trim().length === 0) {
      return {
        success: false,
        error: '合成文本为空',
        engine: 'edge',
        voiceId: voiceName
      }
    }

    const {
      pitch = 'default',
      rate = 'default',
      volume = 'default',
      timeout = 15000
    } = options

    // 构建 SSML
    const ssml = this.buildSSML(text, voiceName, { pitch, rate, volume })

    // 生成临时文件路径
    const timestamp = Date.now()
    const outputFile = join(this.tempDir, `edge_output_${timestamp}.mp3`)

    try {
      logger.debug(`[EdgeTTS] 开始合成: voice=${voiceName}, textLen=${text.length}`)

      const audioData = await this.fetchTTS(ssml, timeout)

      if (!audioData || audioData.length === 0) {
        return {
          success: false,
          error: 'Edge TTS 返回空音频数据',
          engine: 'edge',
          voiceId: voiceName
        }
      }

      // 写入音频文件
      writeFileSync(outputFile, audioData)

      // 清理历史临时音频，防止磁盘无限增长（保留最近 30 个）
      this.cleanupTempAudio('edge_output_', 30)

      return {
        success: true,
        audioPath: outputFile,
        engine: 'edge',
        voiceId: voiceName
      }
    } catch (e) {
      const errorMsg = String(e)
      logger.error('[EdgeTTS] 合成失败:', errorMsg)

      // 清理可能的不完整文件
      try { unlinkSync(outputFile) } catch (e) { logger.error('[EdgeTTS] 清理临时文件失败:', e) }

      return {
        success: false,
        error: errorMsg,
        engine: 'edge',
        voiceId: voiceName
      }
    }
  }

  /* ------ 带降级的语音合成（Edge 失败时自动切换到 Piper） ------ */
  async speakWithFallback(
    text: string,
    voiceName: string,
    piperModelId: string,
    edgeOptions: EdgeOptions = {},
    piperOptions: PiperOptions = {}
  ): Promise<SynthesizeResult> {
    if (!this.initialized) this.initialize()

    // 1. 检查缓存：同一文本+同一语音的合成结果可复用
    const cachePath = this.getCachePath(text, voiceName)
    if (existsSync(cachePath)) {
      logger.debug(`[EdgeTTS] 命中缓存: ${cachePath}`)
      return {
        success: true,
        audioPath: cachePath,
        engine: 'edge',
        voiceId: voiceName
      }
    }

    // 2. 快速网络连通性预检（2秒超时，走系统代理）
    let isOnline = true
    try {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 2000)
      const proxyAgent = createProxyAgent()
      const headOptions: any = { method: 'HEAD', signal: controller.signal }
      if (proxyAgent) headOptions.dispatcher = proxyAgent
      await fetch('https://speech.platform.bing.com', headOptions)
    } catch {
      isOnline = false
      logger.debug('[EdgeTTS] 网络预检失败，直接使用 Piper 离线引擎')
    }

    if (!isOnline) {
      const piperResult = await piperTTS.speak(text, piperModelId, piperOptions)
      if (piperResult.success) {
        return {
          ...piperResult,
          engine: 'piper' as any,
          voiceId: ''
        }
      }
    }

    // 3. 先尝试 Edge TTS（在线）；偶发连接重置（ECONNRESET）时短延迟重试一次
    let edgeResult = await this.speak(text, voiceName, edgeOptions)
    if (!edgeResult.success && /ECONNRESET|socket hang up|ETIMEDOUT|ECONNREFUSED|ENETDOWN|network|timeout|abort/i.test(edgeResult.error || '')) {
      logger.debug('[EdgeTTS] Edge 连接偶发失败，短延迟重试一次:', edgeResult.error)
      await new Promise((r) => setTimeout(r, 600))
      edgeResult = await this.speak(text, voiceName, edgeOptions)
    }

    if (edgeResult.success && edgeResult.audioPath) {
      // Edge TTS 成功 → 缓存结果
      try {
        const audioData = readFileSync(edgeResult.audioPath)
        writeFileSync(cachePath, audioData)
        logger.debug(`[EdgeTTS] 缓存已写入: ${cachePath}`)
      } catch (e) {
        logger.error('[EdgeTTS] 缓存写入失败:', e)
      }
      // 返回缓存路径（下次直接命中），同时保留临时文件供本次使用
      return {
        success: true,
        audioPath: edgeResult.audioPath,
        engine: 'edge',
        voiceId: voiceName
      }
    }

    // 4. 检查错误类型，判断是否需要降级
    const errorMsg = edgeResult.error || ''
    const isNetworkError =
      errorMsg.includes('ENOTFOUND') ||
      errorMsg.includes('ECONNREFUSED') ||
      errorMsg.includes('ETIMEDOUT') ||
      errorMsg.includes('fetch failed') ||
      errorMsg.includes('network') ||
      errorMsg.includes('timeout') ||
      errorMsg.includes('abort')

    if (isNetworkError) {
      logger.debug('[EdgeTTS] 网络不可用，降级到 Piper 离线引擎')
      const piperResult = await piperTTS.speak(text, piperModelId, piperOptions)
      if (piperResult.success) {
        return {
          ...piperResult,
          engine: 'piper' as any,
          voiceId: ''
        }
      }
      return {
        success: false,
        error: `Edge TTS 网络不可用，Piper 降级也失败: ${piperResult.error}`,
        engine: 'edge',
        voiceId: voiceName
      }
    }

    // 5. 非网络错误，尝试降级
    logger.debug('[EdgeTTS] Edge TTS 失败，尝试降级到 Piper:', errorMsg)
    const piperResult = await piperTTS.speak(text, piperModelId, piperOptions)
    if (piperResult.success) {
      return {
        ...piperResult,
        engine: 'piper' as any,
        voiceId: ''
      }
    }

    return {
      success: false,
      error: `Edge TTS 失败: ${errorMsg}，Piper 降级也失败: ${piperResult.error}`,
      engine: 'edge',
      voiceId: voiceName
    }
  }

  /* ------ 清理历史临时音频（保留最近 N 个，防止 tts-temp 无限增长） ------ */
  private cleanupTempAudio(prefix: string, keep: number): void {
    try {
      const files = readdirSync(this.tempDir)
        .filter((f) => f.startsWith(prefix) && (f.endsWith('.mp3') || f.endsWith('.wav')))
        .map((f) => {
          const p = join(this.tempDir, f)
          try { return { p, m: statSync(p).mtimeMs } } catch { return null }
        })
        .filter((x): x is { p: string; m: number } => x !== null)
        .sort((a, b) => b.m - a.m)
      for (const f of files.slice(keep)) {
        try { unlinkSync(f.p) } catch { /* 忽略并发占用 */ }
      }
      if (files.length > keep) logger.debug(`[EdgeTTS] 清理旧音频: 删除 ${files.length - keep} 个`)
    } catch (e) {
      logger.error('[EdgeTTS] 清理临时音频失败:', e)
    }
  }

  /* ------ 停止合成 ------ */
  stop(): void {
    if (this.ws) {
      try {
        this.ws.close()
      } catch (e) { logger.error('[EdgeTTS] 关闭 WebSocket 失败:', e) }
      this.ws = null
    }
    if (this.abortController) {
      try {
        this.abortController.abort()
      } catch (e) { logger.error('[EdgeTTS] 中止合成请求失败:', e) }
      this.abortController = null
    }
  }

  /* ------ 获取可用语音列表 ------ */
  getVoices(): EdgeVoice[] {
    return EDGE_VOICES
  }

  /* ------ 获取语音包到 Edge 语音的映射 ------ */
  getEdgeVoiceForPack(voicePackId: string): string | undefined {
    return VOICE_TO_EDGE_MAP[voicePackId]
  }

  /* ------ 快速网络检测 ------ */
  async checkNetwork(): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 3000)

      const response = await fetch(`https://${EDGE_TTS_URL}${EDGE_TTS_PATH}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`, {
        method: 'HEAD',
        signal: controller.signal
      })
      clearTimeout(timeoutId)
      return response.ok || response.status === 405 // 405 表示端点存在但方法不允许
    } catch {
      return false
    }
  }

  /* ============================================================
   * 私有方法
   * ============================================================ */

  /* ------ 缓存路径生成：text + voiceName → SHA256 哈希 ------ */
  private getCachePath(text: string, voiceName: string): string {
    const hash = createHash('sha256')
      .update(`${voiceName}:${text}`)
      .digest('hex')
      .substring(0, 16)
    return join(this.cacheDir, `${hash}.mp3`)
  }

  /* ------ 构建 SSML ------ */
  private buildSSML(
    text: string,
    voiceName: string,
    options: { pitch: string; rate: string; volume: string }
  ): string {
    // 转义 HTML 特殊字符
    const escapedText = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')

    const prosodyAttrs: string[] = []
    // default 统一映射为 +0Hz / +0% / +0%，确保 prosody 始终带完整属性（服务端对空 prosody 响应不稳定）
    prosodyAttrs.push(`pitch="${options.pitch !== 'default' ? options.pitch : '+0Hz'}"`)
    prosodyAttrs.push(`rate="${options.rate !== 'default' ? options.rate : '+0%'}"`)
    prosodyAttrs.push(`volume="${options.volume !== 'default' ? options.volume : '+0%'}"`)

    const prosodyStr = ` ${prosodyAttrs.join(' ')}`

    return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="zh-CN">
  <voice name="${voiceName}">
    <prosody${prosodyStr}>
      ${escapedText}
    </prosody>
  </voice>
</speak>`
  }

  /* ------ 通过 WebSocket 调用 Edge TTS 服务 ------ */
  /**
   * Edge TTS 实际使用 WSS 协议（HTTP POST 不携带 Sec-MS-GEC 鉴权必然失败）。
   * 参照 edge-tts 开源协议实现：Sec-MS-GEC 鉴权 + speech.config + ssml 双消息，
   * 二进制消息即 MP3 音频分片，收到 Path:turn.end 表示合成结束。
   * 使用 Node 原生 https upgrade（ws 库与服务端握手存在兼容性问题：连接建立后服务端不返回任何数据）。
   */
  private async fetchTTS(ssml: string, timeout: number): Promise<Buffer> {
    this.abortController = new AbortController()
    const abortSignal = this.abortController.signal

    const requestId = randomUUID().replace(/-/g, '')
    const connectionId = randomUUID().replace(/-/g, '')
    const secMsGec = this.generateSecMsGec()
    const muid = randomUUID().replace(/-/g, '')

    // 参数顺序对齐官方 edge-tts（TrustedClientToken -> ConnectionId -> Sec-MS-GEC -> Version）
    const url =
      `wss://${EDGE_TTS_URL}${EDGE_TTS_PATH}` +
      `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&ConnectionId=${connectionId}` +
      `&Sec-MS-GEC=${secMsGec}` +
      `&Sec-MS-GEC-Version=${EDGE_VERSION_HEADER}`

    const wsHeaders: Record<string, string> = {
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      'Pragma': 'no-cache',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
      'Cookie': `muid=${muid};`,
      'Sec-WebSocket-Version': '13',
      'Upgrade': 'websocket',
      'Connection': 'Upgrade',
    }

    const controller = new AbortController()
    // 超时与手动取消合并：任一方触发即销毁连接
    const timeoutId = setTimeout(() => controller.abort(), timeout)
    abortSignal.addEventListener('abort', () => controller.abort(), { once: true })

    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      let settled = false
      let audioStarted = false
      let socket: any = null
      let req: any = null

      const finish = (err?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        try { socket?.destroy() } catch { /* 忽略 */ }
        this.ws = null
        if (err) {
          reject(err)
        } else {
          const audioData = Buffer.concat(chunks)
          if (audioData.length === 0) {
            reject(new Error('Edge TTS 返回空音频数据'))
          } else {
            resolve(audioData)
          }
        }
      }

      // 解析 WebSocket 帧：返回是否有剩余数据（true=已消费/需要更多，false=帧不完整）
      let wsBuf = Buffer.alloc(0)
      const handleData = (d: Buffer) => {
        wsBuf = Buffer.concat([wsBuf, d])
        while (wsBuf.length >= 2) {
          const b0 = wsBuf[0]
          const opcode = b0 & 0x0f
          const b1 = wsBuf[1]
          const masked = (b1 & 0x80) !== 0
          let len = b1 & 0x7f
          let offset = 2
          if (len === 126) {
            if (wsBuf.length < 4) return
            len = wsBuf.readUInt16BE(2)
            offset = 4
          } else if (len === 127) {
            if (wsBuf.length < 10) return
            len = Number(wsBuf.readBigUInt64BE(2))
            offset = 10
          }
          let maskKey: Buffer | null = null
          if (masked) {
            if (wsBuf.length < offset + 4) return
            maskKey = wsBuf.subarray(offset, offset + 4)
            offset += 4
          }
          if (wsBuf.length < offset + len) return
          let payload = wsBuf.subarray(offset, offset + len)
          if (maskKey) {
            const m = Buffer.from(payload)
            for (let i = 0; i < m.length; i++) m[i] ^= maskKey[i % 4]
            payload = m
          }
          wsBuf = wsBuf.subarray(offset + len)

          if (settled) return
          if (opcode === 0x2) {
            // 二进制消息：前 2 字节为 header 长度（大端），其后为 header，再后为音频数据
            if (payload.length >= 2) {
              const headerLength = payload.readUInt16BE(0)
              if (payload.length > headerLength + 2) {
                audioStarted = true
                chunks.push(payload.subarray(headerLength + 2))
              }
            }
          } else if (opcode === 0x1) {
            const text = payload.toString()
            const pathMatch = text.match(/Path:(\S+)/)
            if (pathMatch && pathMatch[1] === 'turn.end') {
              finish()
            }
          } else if (opcode === 0x8) {
            // 服务端主动关闭
            if (!audioStarted) {
              finish(new Error(`Edge TTS 连接提前关闭 (code=${payload.length >= 2 ? payload.readUInt16BE(0) : 0})`))
            } else {
              finish(new Error('Edge TTS 音频流中断'))
            }
          }
        }
      }

      const reqUrl = new URL(url)
      const reqOptions: any = {
        hostname: reqUrl.hostname,
        port: 443,
        path: reqUrl.pathname + reqUrl.search,
        method: 'GET',
        headers: {
          ...wsHeaders,
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        },
      }
      // 系统代理（仅 http/https 代理可用 HttpsProxyAgent；socks 代理无法透传，直连）
      const proxyUrl = getSystemProxy()
      if (proxyUrl && !proxyUrl.startsWith('socks')) {
        try {
          const { HttpsProxyAgent } = require('https-proxy-agent') as any
          reqOptions.agent = new HttpsProxyAgent(proxyUrl)
        } catch (e) {
          logger.warn('[EdgeTTS] 创建代理 Agent 失败，直连:', e)
        }
      }

      req = https.request(reqOptions)
      this.ws = { close: () => { try { socket?.destroy() } catch { /* 忽略 */ } } }

      req.on('upgrade', (_res: any, sock: any) => {
        socket = sock
        // 1. speech.config 初始化
        const configMsg = '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}'
        socket.write(
          encodeWsFrame(0x1, Buffer.from(`X-RequestId:${requestId}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${configMsg}`))
        )
        // 2. SSML 合成请求（X-Timestamp 需带 Z 后缀，微软服务端要求，缺失会导致不响应）
        const d = new Date()
        const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
        const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
        const pad = (n: number) => String(n).padStart(2, '0')
        const timestamp =
          `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${d.getUTCFullYear()} ` +
          `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
        socket.write(
          encodeWsFrame(0x1, Buffer.from(`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp}Z\r\nPath:ssml\r\n\r\n${ssml}`))
        )
        socket.on('data', handleData)
        socket.on('close', () => {
          if (settled) return
          if (!audioStarted) {
            finish(new Error('Edge TTS 连接提前关闭'))
          } else {
            finish(new Error('Edge TTS 音频流中断'))
          }
        })
        socket.on('error', (err: Error) => {
          const msg = String(err?.message || err)
          logger.error('[EdgeTTS] WebSocket 错误:', msg)
          const isNet = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|socket hang up|network|timeout|abort/i.test(msg)
          finish(new Error(isNet ? `Edge TTS 网络错误: ${msg}` : `Edge TTS 连接失败: ${msg}`))
        })
      })

      req.on('response', () => {
        if (!settled) {
          finish(new Error('Edge TTS 握手失败：服务端未升级为 WebSocket'))
        }
      })

      req.on('error', (err: Error) => {
        const msg = String(err?.message || err)
        logger.error('[EdgeTTS] 请求错误:', msg)
        const isNet = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|socket hang up|network|timeout|abort/i.test(msg)
        finish(new Error(isNet ? `Edge TTS 网络错误: ${msg}` : `Edge TTS 连接失败: ${msg}`))
      })

      // 监听手动取消：abort → 销毁连接
      controller.signal.addEventListener('abort', () => {
        try { socket?.destroy() } catch { /* 忽略 */ }
      }, { once: true })
      req.end()
    })
  }

  /* ------ 生成 Edge TTS Sec-MS-GEC 鉴权参数 ------ */
  /**
   * 与 edge-tts v7.2.8 DRM 实现保持一致：
   * ticks = (unix秒 + WIN_EPOCH) 向下取整到 5 分钟，再转 100ns 间隔；
   * hash(`${ticks}${TRUSTED_CLIENT_TOKEN}`)。旧算法（毫秒*10000 无 epoch、拼接 expiration）已被服务端拒绝(403)。
   */
  private generateSecMsGec(): string {
    const WIN_EPOCH = 11644473600
    const ticksSec = Math.floor(Date.now() / 1000) + WIN_EPOCH
    const roundedTicks = ticksSec - (ticksSec % 300)
    const ticks = Math.floor(roundedTicks * 1e7)
    return createHash('sha256')
      .update(`${ticks}${TRUSTED_CLIENT_TOKEN}`)
      .digest('hex')
      .toUpperCase()
  }
}

/* ============================================================
 * 单例导出
 * ============================================================ */
export const edgeTTS = new EdgeTTS()