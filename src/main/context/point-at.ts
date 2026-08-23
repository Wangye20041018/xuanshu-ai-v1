/**
 * point-at.ts — 指哪问哪引擎 v1.0（M5 屏幕语义锚定层）
 *
 * 核心思路：单摄无深度，纯几何法无法像素级定位，改为四层融合做区域级锚定：
 *   1. 指向向量层：point 手势时，用手部关键点（食指指尖-指根 3D 指向线）→ 粗略方向（九宫格区域）
 *   2. 视线交叉层：FaceMesh iris gaze 估计 → 与指向同区则置信度拉高，异区则降级
 *   3. 屏幕语义锚定层：UIA 扫描当前活动窗口 UI 树 → 按区域过滤候选元素（核心精度来源）
 *   4. 对话确认闭环：置信度不足时，广播候选并 TTS 主动确认
 *
 * 不依赖鼠标、不依赖深度摄像头，单摄 + 语义层 + 确认闭环完成"指哪问哪"。
 */

import { BrowserWindow } from 'electron'
import { execFileSync } from 'child_process'
import { createLogger } from '../../shared/logger'
import { sensoryBus, type SensoryEvent } from './sensory-bus'
import { cameraTracker } from '../vision/camera-tracker'

const logger = createLogger('PointAt')

/* ============================================================
 * 类型定义
 * ============================================================ */

/** 屏幕九宫格区域 */
export type ScreenRegion =
  | 'left-top' | 'center-top' | 'right-top'
  | 'left-middle' | 'center-middle' | 'right-middle'
  | 'left-bottom' | 'center-bottom' | 'right-bottom'

/** 语义锚定候选元素 */
export interface PointAtCandidate {
  name: string
  controlType: string
  automationId: string
  className: string
  rect: { x: number; y: number; w: number; h: number }
  /** 与指向区域的匹配度 0-1 */
  score: number
}

/** 指哪问哪结果 */
export interface PointAtResult {
  ts: number
  gesture: string
  /** 指向向量（图像归一化坐标系的 dx/dy，0-1） */
  direction: { dx: number; dy: number }
  /** 指向落点（图像归一化坐标，0-1） */
  target: { x: number; y: number }
  region: ScreenRegion
  /** 视线与指向是否同区 */
  gazeMatched: boolean
  /** 综合置信度 0-1 */
  confidence: number
  /** 是否需对话确认闭环 */
  needsConfirm: boolean
  candidates: Array<PointAtCandidate>
  windowTitle: string
}

/* ============================================================
 * 几何工具：手部 21 点（MediaPipe）与面部 478 点（Holistic refine）
 * ============================================================ */

const INDEX_TIP = 8
const INDEX_PIP = 6
const WRIST = 0

/** 左眼 iris 关键点（Holistic refine_face_landmarks=True 时 478 点，468-472） */
const LEFT_IRIS = [468, 469, 470, 471, 472]
/** 右眼 iris 关键点（473-477） */
const RIGHT_IRIS = [473, 474, 475, 476, 477]
/** 眼角参考：左眼外/内眼角 33/133，右眼内/外眼角 362/263 */
const LEFT_EYE_CORNERS = [33, 133]
const RIGHT_EYE_CORNERS = [362, 263]

interface Pt { x: number; y: number; z: number }

function sub(a: Pt, b: Pt): Pt {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

function len(v: Pt): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
}

function norm(v: Pt): Pt {
  const l = len(v)
  if (l < 1e-6) {return { x: 0, y: 0, z: 0 }}
  return { x: v.x / l, y: v.y / l, z: v.z / l }
}

function avg(points: Array<Pt>): Pt | null {
  if (points.length === 0) {return null}
  return points.reduce(
    (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y, z: acc.z + p.z }),
    { x: 0, y: 0, z: 0 }
  )
}

/**
 * 由手部关键点计算指向向量与落点。
 * point_right：用右手（右手指向屏幕右侧）；point_left：用左手（镜像后指向左侧）。
 * 落点 = 手腕沿指向方向外推（粗略区域级），方向 = 食指指尖-指根归一化向量。
 */
function computePointing(
  hand: Array<Pt>,
  mirrored: boolean
): { direction: { dx: number; dy: number }; target: { x: number; y: number }; valid: boolean } {
  if (!hand || hand.length < 21) {return { direction: { dx: 0, dy: 0 }, target: { x: 0.5, y: 0.5 }, valid: false }}

  const tip = hand[INDEX_TIP]
  const pip = hand[INDEX_PIP]
  const wrist = hand[WRIST]

  // 指向向量：指尖 - 指根（x 向右、y 向下、z 深度）
  let v = sub(tip, pip)
  if (len(v) < 1e-4) {
    v = sub(tip, wrist)
  }
  const vn = norm(v)

  // 摄像头画面通常左右镜像（用户看到自己）；指向屏幕时需把图像 x 翻转：
  // 画面中手在右侧（图像 x 大）→ 用户指向的是自己左侧。此处做镜像修正。
  let dx = vn.x
  if (mirrored) {dx = -dx}

  // 落点：沿指向方向从手腕外推 0.35（区域级，不求精确）
  let tx = wrist.x + dx * 0.35
  let ty = wrist.y + vn.y * 0.35
  tx = Math.min(1, Math.max(0, tx))
  ty = Math.min(1, Math.max(0, ty))

  return { direction: { dx, dy: vn.y }, target: { x: tx, y: ty }, valid: true }
}

/** 由 (x, y) 归一化坐标（图像坐标系，y 向下）映射到九宫格区域 */
function regionOf(x: number, y: number): ScreenRegion {
  const col = x < 0.33 ? 'left' : x < 0.66 ? 'center' : 'right'
  const row = y < 0.33 ? 'top' : y < 0.66 ? 'middle' : 'bottom'
  return `${col}-${row}` as ScreenRegion
}

/**
 * 视线估计：用左右眼 iris 相对眼角中心的水平偏移判断视线方向（左/中/右）。
 * 返回 -1(左) ~ 1(右)。
 */
function estimateGazeX(face: Array<Pt>): number | null {
  if (!face || face.length < 478) {return null}
  const lIris = avg(LEFT_IRIS.map(i => face[i]))
  const rIris = avg(RIGHT_IRIS.map(i => face[i]))
  const lCorner = avg(LEFT_EYE_CORNERS.map(i => face[i]))
  const rCorner = avg(RIGHT_EYE_CORNERS.map(i => face[i]))
  if (!lIris || !rIris || !lCorner || !rCorner) {return null}

  // 左眼：iris 相对眼角的偏移（正=向右看）；右眼同理，取均值
  const lOff = (lIris.x - lCorner.x) * 2.2
  const rOff = (rIris.x - rCorner.x) * 2.2
  const gaze = (lOff + rOff) / 2
  return Math.min(1, Math.max(-1, gaze))
}

/** 视线水平方向映射为列区域 */
function gazeCol(gazeX: number | null): 'left' | 'center' | 'right' | null {
  if (gazeX === null) {return null}
  if (gazeX < -0.18) {return 'left'}
  if (gazeX > 0.18) {return 'right'}
  return 'center'
}

/** 区域列名 */
function colOf(region: ScreenRegion): 'left' | 'center' | 'right' {
  if (region.startsWith('left')) {return 'left'}
  if (region.startsWith('right')) {return 'right'}
  return 'center'
}

/* ============================================================
 * UIA 语义锚定
 * ============================================================ */

import { UIAScanner, type UIAElement } from '../ui-automation/uia-scanner'

/** 可交互控件类型白名单 */
const INTERACTIVE_TYPES = new Set([
  'Button', 'Edit', 'CheckBox', 'RadioButton', 'Hyperlink', 'ListItem',
  'MenuItem', 'TabItem', 'TreeItem', 'ComboBox', 'Custom', 'Text', 'Image',
])

/**
 * 扫描当前活动窗口 UI 树，提取可交互元素，按指向区域排序。
 * 核心精度来源：UIA 给出元素精确 boundingRect，与指向区域做匹配打分。
 */
export function anchorToScreenElements(
  windowTitle: string,
  region: ScreenRegion,
  target: { x: number; y: number }
): { candidates: Array<PointAtCandidate>; windowTitle: string } {
  try {
    const tree = UIAScanner.scanWindow(windowTitle)
    if (!tree) {return { candidates: [], windowTitle: windowTitle || '(前台窗口)' }}

    const col = colOf(region)
    const row = region.includes('top') ? 'top' : region.includes('bottom') ? 'bottom' : 'middle'

    // 以窗口（根节点）实际尺寸作为区域坐标参考
    const winW = tree.boundingRect?.w || 1920
    const winH = tree.boundingRect?.h || 1080
    const wx = tree.boundingRect?.x || 0
    const wy = tree.boundingRect?.y || 0

    const elements: Array<UIAElement> = []
    const walk = (node: UIAElement): void => {
      elements.push(node)
      for (const child of node.children || []) {walk(child)}
    }
    walk(tree)

    const candidates: Array<PointAtCandidate> = elements
      .filter(el => {
        if (!el.name?.trim()) {return false}
        if (!el.boundingRect || el.boundingRect.w < 8 || el.boundingRect.h < 8) {return false}
        // 只要交互控件或高信息量文本（按钮/输入/链接/列表项等）
        const type = el.controlType || ''
        if (!INTERACTIVE_TYPES.has(type)) {return false}
        return true
      })
      .map(el => {
        const rect = el.boundingRect
        const cx = rect.x + rect.w / 2
        const cy = rect.y + rect.h / 2
        // 区域匹配打分：列 + 行（相对窗口坐标系）
        let score = 0
        if (col === 'left' && cx < wx + winW * 0.33) {score += 0.4}
        else if (col === 'center' && cx >= wx + winW * 0.33 && cx <= wx + winW * 0.66) {score += 0.4}
        else if (col === 'right' && cx > wx + winW * 0.66) {score += 0.4}
        else {score += 0.15}
        if (row === 'top' && cy < wy + winH * 0.33) {score += 0.3}
        else if (row === 'middle' && cy >= wy + winH * 0.33 && cy <= wy + winH * 0.66) {score += 0.3}
        else if (row === 'bottom' && cy > wy + winH * 0.66) {score += 0.3}
        else {score += 0.1}
        // 与指向落点距离惩罚（将图像归一化落点映射到窗口像素）
        const tx = wx + target.x * winW
        const ty = wy + target.y * winH
        const dist = Math.hypot(cx - tx, cy - ty) / Math.max(winW, winH)
        score += Math.max(0, 0.3 - dist * 0.3)
        return { name: el.name, controlType: el.controlType, automationId: el.automationId, className: el.className, rect, score }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)

    return { candidates, windowTitle: tree.name || windowTitle || '(前台窗口)' }
  } catch (e: unknown) {
    logger.warn(`[PointAt] UIA 锚定失败: ${e instanceof Error ? e.message : String(e)}`)
    return { candidates: [], windowTitle: windowTitle || '(前台窗口)' }
  }
}

/* ============================================================
 * PointAtEngine
 * ============================================================ */

class PointAtEngine {
  private enabled = false
  private unsub: (() => void) | null = null
  private lastResult: PointAtResult | null = null

  start(): void {
    if (this.enabled) {return}
    this.enabled = true
    this.unsub = sensoryBus.subscribe(e => {
      if (e.channel !== 'vision' || e.type !== 'gesture') {return}
      const gesture = String(e.payload?.gesture ?? '')
      if (gesture === 'point_left' || gesture === 'point_right') {
        void this.handlePoint(gesture, e)
      }
    })
    logger.info('[PointAt] 指哪问哪引擎已启动')
  }

  stop(): void {
    this.enabled = false
    this.unsub?.()
    this.unsub = null
    logger.info('[PointAt] 指哪问哪引擎已停止')
  }

  isRunning(): boolean {
    return this.enabled
  }

  getLastResult(): PointAtResult | null {
    return this.lastResult
  }

  /** 手动触发一次（调试/测试用） */
  trigger(): PointAtResult | null {
    return this.handlePoint('point_right', {
      channel: 'vision',
      type: 'gesture',
      ts: Date.now(),
      confidence: 1,
      payload: { gesture: 'point_right' },
    } as SensoryEvent)
  }

  private handlePoint(gesture: string, e: SensoryEvent): PointAtResult | null {
    try {
      const frame = cameraTracker.getLastFrame()
      if (!frame) {
        logger.warn('[PointAt] 无最近帧数据，无法计算指向')
        return null
      }

      // 1. 指向向量层：选择手（point_right 用右手；point_left 用左手，画面镜像修正）
      const mirrored = true // 摄像头画面默认镜像（用户视角）
      const hand = gesture === 'point_left' ? frame.leftHand : frame.rightHand
      const pointing = computePointing(hand, mirrored)
      if (!pointing.valid) {
        logger.warn('[PointAt] 手部关键点不足，无法计算指向')
        return null
      }

      const region = regionOf(pointing.target.x, pointing.target.y)

      // 2. 视线交叉层：iris gaze 与指向列对比
      const gazeX = estimateGazeX(frame.face)
      const gazeMatched = gazeX !== null && gazeCol(gazeX) === colOf(region)
      let confidence = e.confidence * 0.6 + 0.3
      if (gazeMatched) {confidence += 0.2}
      else if (gazeX !== null) {confidence -= 0.1}
      confidence = Math.min(1, Math.max(0.05, confidence))

      // 3. 屏幕语义锚定层
      const activeTitle = getActiveWindowTitle()
      const { candidates, windowTitle } = anchorToScreenElements(activeTitle, region, pointing.target)

      // 4. 确认闭环判定：置信度不足或候选不唯一 → 需确认
      const best = candidates[0]
      const needsConfirm = confidence < 0.55 || !best || best.score < 0.5 || candidates.length > 1

      const result: PointAtResult = {
        ts: Date.now(),
        gesture,
        direction: pointing.direction,
        target: pointing.target,
        region,
        gazeMatched,
        confidence,
        needsConfirm,
        candidates,
        windowTitle,
      }
      this.lastResult = result
      this.broadcast(result)
      return result
    } catch (err: unknown) {
      logger.error(`[PointAt] 处理指向失败: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  private broadcast(result: PointAtResult): void {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        try { win.webContents.send('context:point-at', result) } catch { /* pipe broken */ }
      }
    })
    if (result.needsConfirm) {
      logger.info(`[PointAt] 指向区域 ${result.region} 置信 ${result.confidence.toFixed(2)}，候选 ${result.candidates.length} 个，进入确认闭环`)
    } else {
      logger.info(`[PointAt] 命中候选: ${result.candidates[0]?.name} @ ${result.region}`)
    }
  }
}

/** 取前台窗口标题（跨平台兜底：优先用 system-signals 缓存，取不到则留空让 UIA 扫前台） */
function getActiveWindowTitle(): string {
  try {
    // system-signals 通过 user32 GetForegroundWindow 轮询，这里用轻量 PowerShell 同步取一次
    const POWERSHELL_EXE = `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    const out = execFileSync(
      POWERSHELL_EXE,
      ['-NoProfile', '-Command',
        'Add-Type @"\nusing System;\nusing System.Runtime.InteropServices;\npublic class W { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n); }\n$h=[W]::GetForegroundWindow(); $s=New-Object System.Text.StringBuilder 512; [W]::GetWindowText($h,$s,512)|Out-Null; $s.ToString()'],
      { timeout: 2000, encoding: 'utf-8', windowsHide: true }
    )
    return String(out).trim()
  } catch {
    return ''
  }
}

export const pointAtEngine = new PointAtEngine()
