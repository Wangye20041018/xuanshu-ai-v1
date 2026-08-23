/**
 * camera-tracker.ts — 摄像头追踪 Node.js 桥接 v1.0
 *
 * 职责：
 * - 启动/停止 Python MediaPipe 追踪进程
 * - 解析 stdout JSON 帧数据
 * - 手势变化检测与去抖
 * - 将手势数据输入到角色行为推理引擎
 * - 通过 IPC 广播追踪状态到渲染进程
 */

import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import { createInterface } from 'readline'
import { BrowserWindow } from 'electron'
import { createLogger } from '../../shared/logger'
import { sensoryBus } from '../context/sensory-bus'

const logger = createLogger('CameraTracker')

/* ============================================================
 * 类型定义
 * ============================================================ */

export interface PoseFrame {
  ts: number
  landmarks: PoseLandmark[]
  /** v2.0 Holistic: 面部 468 关键点 */
  faceLandmarks?: FaceLandmark[]
  /** v2.0 Holistic: 左手 21 关键点 */
  leftHandLandmarks?: HandLandmark[]
  /** v2.0 Holistic: 右手 21 关键点 */
  rightHandLandmarks?: HandLandmark[]
  gesture: string
  confidence: number
}

export interface PoseLandmark {
  x: number
  y: number
  z: number
  visibility: number
}

export interface FaceLandmark {
  x: number
  y: number
  z: number
}

export interface HandLandmark {
  x: number
  y: number
  z: number
}

export type CameraTrackerStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'error'

export interface CameraTrackerState {
  status: CameraTrackerStatus
  currentGesture: string
  gestureConfidence: number
  fps: number
  error?: string
}


/* ============================================================
 * CameraTrackerBridge
 * ============================================================ */

export class CameraTrackerBridge {
  private process: ChildProcess | null = null
  private state: CameraTrackerState = {
    status: 'idle',
    currentGesture: 'idle',
    gestureConfidence: 0,
    fps: 0,
  }

  private pythonScriptPath: string
  private previousGesture: string = 'idle'
  private gestureStableCount: number = 0
  private readonly GESTURE_STABLE_THRESHOLD = 3 // 手势稳定帧数阈值
  private readonly GESTURE_COOLDOWN_MS = 2000 // 手势冷却时间
  private lastGestureTriggeredAt: number = 0
  private lastGestureTriggered: string = ''

  private frameCount: number = 0
  private fpsTimer: ReturnType<typeof setInterval> | null = null

  /** M5 指哪问哪：最近一帧完整关键点缓存（供 PointAtEngine 计算指向向量与视线） */
  private lastFrameData: {
    ts: number
    pose: Array<PoseLandmark>
    face: Array<FaceLandmark>
    leftHand: Array<HandLandmark>
    rightHand: Array<HandLandmark>
    gesture: string
  } | null = null

  /** M5 指哪问哪：取最近一帧关键点（供 PointAtEngine 同步消费） */
  getLastFrame(): typeof this.lastFrameData {
    return this.lastFrameData
  }

  constructor() {
    // 脚本路径：项目根目录下的 scripts/camera_tracker.py
    this.pythonScriptPath = join(__dirname, '../../../scripts/camera_tracker.py')
  }

  /* ==========================================================
   * 生命周期
   * ========================================================== */

  async start(): Promise<boolean> {
    if (this.state.status === 'running') {
      logger.warn('[CameraTracker] 已在运行中')
      return true
    }

    this.state.status = 'starting'
    this.broadcastState()

    try {
      logger.info(`[CameraTracker] 启动 Python 追踪服务: ${this.pythonScriptPath}`)

      this.process = spawn('python', [this.pythonScriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      })

      // 监听 stderr
      if (this.process.stderr) {
        const stderrLines = createInterface({ input: this.process.stderr })
        stderrLines.on('line', (line: string) => {
          logger.debug(`[CameraTracker:py] ${line}`)
        })
      }

      // 监听 stdout（JSON 帧数据）
      if (this.process.stdout) {
        const stdoutLines = createInterface({ input: this.process.stdout })
        stdoutLines.on('line', (line: string) => {
          try {
            const data = JSON.parse(line.trim())
            this.handleFrame(data)
          } catch {
            // 非 JSON 行，忽略
          }
        })
      }

      // 监听进程退出
      this.process.on('exit', (code) => {
        logger.info(`[CameraTracker] Python 进程退出: code=${code}`)
        this.process = null
        if (this.state.status === 'running') {
          this.state.status = 'error'
          this.state.error = `Python 进程意外退出 (code=${code})`
          this.broadcastState()
        }
      })

      this.process.on('error', (err) => {
        logger.error(`[CameraTracker] 进程错误: ${err.message}`)
        this.state.status = 'error'
        this.state.error = err.message
        this.broadcastState()
      })

      // 发送 start 命令
      this.sendCommand({ cmd: 'start' })

      // 启动 FPS 计数器
      this.startFpsCounter()

      // 等待一小段时间确认启动
      await new Promise(resolve => setTimeout(resolve, 500))

      if ((this.state as CameraTrackerState).status !== 'error') {
        this.state.status = 'running'
        // M2 视觉情境：摄像头启动后打开视觉通道（隐私模式下 sensoryBus 会自动拦截）
        sensoryBus.setChannel('vision', { enabled: true, sampling: 'high' })
        this.broadcastState()
        logger.info('[CameraTracker] 追踪服务已启动')
        return true
      }

      return false
    } catch (e: any) {
      logger.error(`[CameraTracker] 启动失败: ${e.message}`)
      this.state.status = 'error'
      this.state.error = e.message
      this.broadcastState()
      return false
    }
  }

  async stop(): Promise<void> {
    if (this.state.status !== 'running') return

    this.state.status = 'stopping'
    this.broadcastState()

    this.stopFpsCounter()

    if (this.process) {
      this.sendCommand({ cmd: 'stop' })
      // 给 Python 进程一点时间优雅退出
      await new Promise(resolve => setTimeout(resolve, 500))
      if (this.process && !this.process.killed) {
        this.sendCommand({ cmd: 'exit' })
        this.process.kill()
      }
      this.process = null
    }

    this.state.status = 'idle'
    this.state.currentGesture = 'idle'
    this.state.gestureConfidence = 0
    // M2 视觉情境：摄像头停止后关闭视觉通道
    sensoryBus.setChannel('vision', { enabled: false, sampling: 'off' })
    this.broadcastState()
    logger.info('[CameraTracker] 追踪服务已停止')
  }

  getState(): CameraTrackerState {
    return { ...this.state }
  }

  /* ==========================================================
   * 帧数据处理
   * ========================================================== */

  private handleFrame(data: any): void {
    // 处理状态消息
    if (data.status) {
      logger.info(`[CameraTracker] 状态: ${data.status}`)
      if (data.status === 'started') {
        this.state.status = 'running'
      } else if (data.status === 'stopped') {
        this.state.status = 'idle'
      }
      this.broadcastState()
      return
    }

    // 处理错误消息
    if (data.error) {
      logger.error(`[CameraTracker] 错误: ${data.error}`)
      this.state.status = 'error'
      this.state.error = data.error
      this.broadcastState()
      return
    }

    // 处理帧数据 (v2.0 Holistic: pose_landmarks / face_landmarks / left_hand_landmarks / right_hand_landmarks)
    // 兼容 v1.0 格式: landmarks
    const hasPoseData = data.pose_landmarks !== undefined || data.landmarks !== undefined
    if (hasPoseData) {
      this.frameCount++
      const gesture = data.gesture || 'idle'
      const confidence = data.confidence || 0

      this.state.currentGesture = gesture
      this.state.gestureConfidence = confidence

      // 广播帧数据到渲染进程（Holistic 格式）
      const poseLms = data.pose_landmarks || data.landmarks || []
      const faceLms = data.face_landmarks || []
      // M5 指哪问哪：缓存最近一帧完整关键点
      this.lastFrameData = {
        ts: Date.now(),
        pose: poseLms as Array<PoseLandmark>,
        face: faceLms as Array<FaceLandmark>,
        leftHand: (data.left_hand_landmarks || []) as Array<HandLandmark>,
        rightHand: (data.right_hand_landmarks || []) as Array<HandLandmark>,
        gesture,
      }
      this.broadcastFrame(
        poseLms as PoseLandmark[],
        gesture,
        confidence,
        faceLms,
        data.left_hand_landmarks || [],
        data.right_hand_landmarks || []
      )

      // M2 视觉情境：在场检测（人脸存在即在场，消失即离开）
      this.detectPresence(faceLms.length > 0)

      // 手势变化检测
      this.detectGestureChange(gesture, confidence, data.landmarks)
    }
  }

  /* ==========================================================
   * 手势变化检测与去抖
   * ========================================================== */

  private lastPresentState: boolean | null = null

  /** M2 视觉情境：在场/离开事件（去抖：状态变化才上报） */
  private detectPresence(present: boolean): void {
    if (present === this.lastPresentState) return
    this.lastPresentState = present
    sensoryBus.emit({
      channel: 'vision',
      type: 'presence',
      ts: Date.now(),
      confidence: present ? 0.9 : 0.85,
      payload: { present },
    })
    logger.info(`[CameraTracker] 在场状态变化: ${present ? '在场' : '离开'}`)
  }

  private detectGestureChange(gesture: string, confidence: number, _landmarks: PoseLandmark[]): void {
    if (gesture === 'idle' || gesture === 'not_found') {
      this.gestureStableCount = 0
      this.previousGesture = gesture
      return
    }

    // 手势稳定检测
    if (gesture === this.previousGesture) {
      this.gestureStableCount++
    } else {
      this.gestureStableCount = 1
      this.previousGesture = gesture
    }

    // 冷却时间检查
    const now = Date.now()
    if (gesture === this.lastGestureTriggered &&
        now - this.lastGestureTriggeredAt < this.GESTURE_COOLDOWN_MS) {
      return
    }

    // 手势稳定 + 置信度足够 → 触发角色行为
    if (this.gestureStableCount >= this.GESTURE_STABLE_THRESHOLD && confidence >= 0.6) {
      this.lastGestureTriggered = gesture
      this.lastGestureTriggeredAt = now
      this.gestureStableCount = 0

      logger.info(`[CameraTracker] 检测到手势: ${gesture} (置信度: ${confidence.toFixed(2)})`)

      // 广播手势到渲染进程
      this.broadcastGesture(gesture, confidence)

    }
  }


  /* ==========================================================
   * 通信
   * ========================================================== */

  private sendCommand(cmd: Record<string, unknown>): void {
    if (this.process && this.process.stdin && !this.process.stdin.destroyed) {
      try {
        this.process.stdin.write(JSON.stringify(cmd) + '\n')
      } catch (e: any) {
        logger.error(`[CameraTracker] 发送命令失败: ${e.message}`)
      }
    }
  }

  /* ==========================================================
   * 广播
   * ========================================================== */

  private broadcastState(): void {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send('camera:state', this.state)
        } catch { /* pipe broken */ }
      }
    })
  }

  private broadcastGesture(gesture: string, confidence: number): void {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send('camera:gesture', { gesture, confidence })
        } catch { /* pipe broken */ }
      }
    })

    // M2 视觉情境：手势事件注入感官总线（供状态推理/情境引擎消费）
    sensoryBus.emit({
      channel: 'vision',
      type: 'gesture',
      ts: Date.now(),
      confidence,
      payload: { gesture },
    })
  }

  private broadcastFrame(
    landmarks: PoseLandmark[],
    gesture: string,
    confidence: number,
    faceLandmarks: FaceLandmark[] = [],
    leftHandLandmarks: HandLandmark[] = [],
    rightHandLandmarks: HandLandmark[] = []
  ): void {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send('camera:frame', {
            ts: Date.now(),
            landmarks,
            gesture,
            confidence,
            faceLandmarks,
            leftHandLandmarks,
            rightHandLandmarks,
          })
        } catch { /* pipe broken */ }
      }
    })
  }

  /* ==========================================================
   * FPS 计数器
   * ========================================================== */

  private startFpsCounter(): void {
    this.frameCount = 0
    this.fpsTimer = setInterval(() => {
      this.state.fps = this.frameCount
      this.frameCount = 0
    }, 1000)
  }

  private stopFpsCounter(): void {
    if (this.fpsTimer) {
      clearInterval(this.fpsTimer)
      this.fpsTimer = null
    }
    this.frameCount = 0
    this.state.fps = 0
  }
}

/* ============================================================
 * 单例导出
 * ============================================================ */

export const cameraTracker = new CameraTrackerBridge()