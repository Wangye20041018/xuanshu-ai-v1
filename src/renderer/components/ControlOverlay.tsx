import { useEffect, useMemo, useRef, useState } from 'react'

interface ControlStatePayload {
  active: boolean
  detail?: string
  phase?: 'thinking' | 'acting' | 'done'
  ts?: number
}

/** 危险分级：决定特效配色与警示文案 */
type Severity = 'danger' | 'warning' | 'normal'

interface HistoryItem {
  detail: string
  ts: number
  severity: Severity
}

const SEVERITY_COLOR: Record<Severity, string> = {
  danger: '#ff5f6d',
  warning: '#f5a623',
  normal: '#6c8cff',
}

const SEVERITY_LABEL: Record<Severity, string> = {
  danger: '高风险操作',
  warning: '输入模拟',
  normal: '正在控制',
}

/** 发光特效预设色（对应 config controlGlowColor） */
const GLOW_PRESETS: Record<string, string> = {
  blueviolet: '#6d5bff',
  cyan: '#22d3ee',
  amber: '#f59e0b',
  red: '#ef4444',
}

/** 三态文案 */
const PHASE_LABEL: Record<string, string> = {
  thinking: '思考中',
  acting: '操作中',
  done: '已完成',
}

/** 依据操作文案判定风险等级（主进程 detail 由受控标签拼接，无用户/LLM 自由文本） */
function classifySeverity(detail: string): Severity {
  const d = detail || ''
  if (/注册表|服务|进程|提权|管理员|锁屏|计划任务|环境变量|删除|结束|停止|elevate|registry|service|process|kill|lock/i.test(d)) {
    return 'danger'
  }
  if (/键盘|输入|按键|类型|发送|type|key|input|send-keys/i.test(d)) {
    return 'warning'
  }
  return 'normal'
}

/**
 * ControlOverlay — 「控制电脑」全屏发光特效（智能体操作系统版）
 *
 * 在 control:state 广播时叠加全屏特效：
 *  - 屏幕四周发光（8~12px 蓝紫渐变边框）+ 三态动效（thinking/acting/done）
 *  - 危险分级配色 + 顶部 HUD + 操作历史 ticker
 *  - 可配置：开关 / 亮度 / 颜色 / 动效强度（electron-store 4 个 config key）
 *  - 紧急暂停：监听 control:panic 进入「已暂停」态
 *  - 指针穿透（pointer-events:none），不阻断用户操作
 */
export default function ControlOverlay() {
  const [active, setActive] = useState(false)
  const [detail, setDetail] = useState('')
  const [phase, setPhase] = useState<'thinking' | 'acting' | 'done'>('acting')
  const [paused, setPaused] = useState(false)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [startTs, setStartTs] = useState(0)
  const [elapsed, setElapsed] = useState(0)

  // 发光特效配置（默认开启）
  const [glowConfig, setGlowConfig] = useState({
    enabled: true,
    brightness: 0.8,
    color: 'blueviolet',
    intensity: 0.7,
  })

  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const glowRef = useRef<HTMLDivElement | null>(null)

  const severity = useMemo(() => classifySeverity(detail), [detail])
  const accent = SEVERITY_COLOR[severity]
  const glowColor = GLOW_PRESETS[glowConfig.color] || GLOW_PRESETS.blueviolet

  // 读取发光配置
  useEffect(() => {
    const api = (window as any).api
    if (!api?.invoke) return
    const load = async () => {
      try {
        const cfg = await api.invoke('config:get')
        if (cfg) {
          setGlowConfig({
            enabled: cfg.controlGlowEnabled !== false,
            brightness: clampNum(cfg.controlGlowBrightness, 0.8),
            color: cfg.controlGlowColor || 'blueviolet',
            intensity: clampNum(cfg.controlGlowIntensity, 0.7),
          })
        }
      } catch {
        /* 浏览器调试环境，忽略 */
      }
    }
    void load()
  }, [])

  useEffect(() => {
    const api = (window as any).api
    if (!api?.on) return

    const unsubscribe = api.on('control:state', (_event: unknown, payload: ControlStatePayload) => {
      if (payload?.active) {
        const d = payload.detail || '正在控制电脑'
        setActive(true)
        setPaused(false)
        setDetail(d)
        setPhase(payload.phase || 'acting')
        setStartTs(payload.ts || Date.now())
        setElapsed(0)
        setHistory((prev) => {
          const next = [{ detail: d, ts: payload.ts || Date.now(), severity: classifySeverity(d) }, ...prev]
          return next.slice(0, 6)
        })
        if (hideTimer.current) clearTimeout(hideTimer.current)
        hideTimer.current = setTimeout(() => setActive(false), 12_000)
      } else {
        if (hideTimer.current) clearTimeout(hideTimer.current)
        setPhase('done')
        // done 态短暂停留后隐藏
        setTimeout(() => setActive(false), 700)
        setElapsed(0)
      }
    })

    const unsubPanic = api.on('control:panic', () => {
      setPaused(true)
      setActive(true)
      setPhase('done')
      if (hideTimer.current) clearTimeout(hideTimer.current)
    })

    return () => {
      if (unsubscribe) unsubscribe()
      if (unsubPanic) unsubPanic()
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [])

  // 操作耗时计时器
  useEffect(() => {
    if (!active || paused) return
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startTs) / 1000)), 250)
    return () => clearInterval(timer)
  }, [active, paused, startTs])

  // 鼠标「注视」光晕
  useEffect(() => {
    if (!active) return
    const onMove = (e: MouseEvent) => {
      const el = glowRef.current
      if (!el) return
      el.style.opacity = '1'
      el.style.transform = `translate(${e.clientX - 140}px, ${e.clientY - 140}px)`
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [active])

  if (!active || !glowConfig.enabled) return null

  const danger = severity === 'danger'
  const warning = severity === 'warning'
  const intensity = glowConfig.intensity
  const brightness = glowConfig.brightness

  return (
    <>
      <style>{`
        @keyframes xsc-scan { 0% { transform: translateY(-100%); } 100% { transform: translateY(100vh); } }
        @keyframes xsc-sweep { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes xsc-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
        @keyframes xsc-glow {
          0%, 100% { box-shadow: 0 0 12px var(--xc-accent), 0 0 40px var(--xc-accent)66; }
          50% { box-shadow: 0 0 24px var(--xc-accent), 0 0 60px var(--xc-accent)aa; }
        }
        @keyframes xsc-ticker-in {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        /* 三态边框动效：thinking 呼吸蓝 / acting 高频流动紫 / done 渐隐收束 */
        @keyframes xsc-border-breathe {
          0%, 100% { opacity: ${0.4 * intensity}; filter: blur(0px); }
          50% { opacity: ${0.9 * intensity}; filter: blur(2px); }
        }
        @keyframes xsc-border-flow {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        @keyframes xsc-border-fade {
          0% { opacity: ${0.9 * intensity}; }
          100% { opacity: 0; }
        }
        .xsc-overlay {
          --xc-accent: ${accent};
          --xc-glow: ${glowColor};
          position: fixed;
          inset: 0;
          z-index: 99990;
          pointer-events: none;
          overflow: hidden;
          background:
            radial-gradient(ellipse at center, transparent 45%, ${danger ? 'rgba(40, 6, 10, 0.5)' : warning ? 'rgba(30, 20, 4, 0.44)' : 'rgba(6, 10, 24, 0.42)'} 100%);
        }
        /* 屏幕四周发光边框 */
        .xsc-border {
          position: absolute;
          inset: 0;
          z-index: 1;
          pointer-events: none;
        }
        .xsc-border::before {
          content: '';
          position: absolute;
          inset: 0;
          border-radius: 0;
          padding: ${8 + Math.round(intensity * 4)}px;
          background: linear-gradient(120deg, ${glowColor}, ${accent}, ${glowColor});
          background-size: 300% 300%;
          -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
          -webkit-mask-composite: xor;
          mask-composite: exclude;
          opacity: ${brightness};
          animation: xsc-border-flow 3s ease infinite, xsc-border-breathe 1.6s ease-in-out infinite;
        }
        .xsc-border.thinking::before { animation: xsc-border-breathe 2.4s ease-in-out infinite; }
        .xsc-border.acting::before { animation: xsc-border-flow 1.6s linear infinite, xsc-border-breathe 0.8s ease-in-out infinite; }
        .xsc-border.done::before { animation: xsc-border-fade 0.7s ease forwards; }
        .xsc-grid {
          position: absolute; inset: 0;
          background-image:
            linear-gradient(var(--xc-accent)12 1px, transparent 1px),
            linear-gradient(90deg, var(--xc-accent)12 1px, transparent 1px);
          background-size: 48px 48px;
          mask-image: radial-gradient(ellipse at center, black 40%, transparent 90%);
        }
        .xsc-scanline {
          position: absolute; left: 0; right: 0; height: 120px;
          background: linear-gradient(180deg, transparent, var(--xc-accent)33, transparent);
          animation: xsc-scan 2.6s linear infinite;
        }
        .xsc-corner {
          position: absolute; width: 46px; height: 46px;
          border: 2px solid var(--xc-accent);
          filter: drop-shadow(0 0 8px var(--xc-accent));
        }
        .xsc-corner.tl { top: 22px; left: 22px; border-right: none; border-bottom: none; border-top-left-radius: 10px; }
        .xsc-corner.tr { top: 22px; right: 22px; border-left: none; border-bottom: none; border-top-right-radius: 10px; }
        .xsc-corner.bl { bottom: 22px; left: 22px; border-right: none; border-top: none; border-bottom-left-radius: 10px; }
        .xsc-corner.br { bottom: 22px; right: 22px; border-left: none; border-top: none; border-bottom-right-radius: 10px; }

        .xsc-hud {
          position: absolute; top: 22px; left: 50%; transform: translateX(-50%);
          display: flex; align-items: center; gap: 16px;
          padding: 10px 20px; border-radius: 12px;
          background: linear-gradient(90deg, var(--xc-accent)0d, rgba(8,12,28,0.72), var(--xc-accent)0d);
          border: 1px solid var(--xc-accent)44;
          font-family: 'SF Mono', 'Consolas', 'JetBrains Mono', monospace;
          font-size: 12px; letter-spacing: 0.12em; color: #eaf0ff;
        }
        .xsc-hud .dot {
          width: 8px; height: 8px; border-radius: 50%; background: var(--xc-accent);
          animation: xsc-glow 1.6s ease-in-out infinite;
        }
        .xsc-hud .sep { opacity: 0.35; }
        .xsc-hud .metric { color: var(--xc-accent); font-weight: 700; }

        .xsc-status {
          position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
          display: flex; flex-direction: column; align-items: center; gap: 14px;
          color: #eaf0ff;
        }
        .xsc-dot { width: 12px; height: 12px; border-radius: 50%; background: var(--xc-accent); animation: xsc-glow 1.6s ease-in-out infinite; }
        .xsc-title {
          font-size: 20px; font-weight: 700; letter-spacing: 0.16em; color: #eaf0ff;
        }
        .xsc-detail {
          font-size: 13px; color: rgba(234, 240, 255, 0.78);
          max-width: 460px; text-align: center; letter-spacing: 0.04em;
          overflow: hidden; text-overflow: ellipsis; display: -webkit-box;
          -webkit-line-clamp: 2; -webkit-box-orient: vertical;
        }
        .xsc-badge {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 7px 16px; border-radius: 999px; font-size: 12px; letter-spacing: 0.1em;
          color: var(--xc-accent); border: 1px solid var(--xc-accent)55;
          background: rgba(8, 12, 28, 0.6);
          animation: xsc-pulse 2s ease-in-out infinite;
        }
        .xsc-badge.danger { background: rgba(40, 6, 10, 0.6); font-weight: 700; }
        .xsc-badge.warning { background: rgba(30, 20, 4, 0.6); }
        .xsc-badge.paused { color: #fbbf24; border-color: #fbbf2455; animation: none; }

        .xsc-radar {
          position: absolute; top: 50%; left: 50%; width: 340px; height: 340px;
          margin: -170px 0 0 -170px; border-radius: 50%;
          border: 1px solid var(--xc-accent)44;
          background:
            radial-gradient(circle, transparent 58%, var(--xc-accent)0d 59%, transparent 60%),
            radial-gradient(circle, transparent 79%, var(--xc-accent)0d 80%, transparent 81%);
        }
        .xsc-radar::after {
          content: ''; position: absolute; inset: 6px; border-radius: 50%;
          background: conic-gradient(from 0deg, var(--xc-accent)55, transparent 120deg);
          mask-image: radial-gradient(circle, transparent 55%, black 56%);
          animation: xsc-sweep 3.2s linear infinite;
        }

        .xsc-glow-cursor {
          position: absolute; top: 0; left: 0; width: 280px; height: 280px;
          border-radius: 50%; opacity: 0;
          background: radial-gradient(circle, var(--xc-accent)22, transparent 70%);
          transition: opacity 0.4s ease;
          will-change: transform;
        }

        .xsc-ticker {
          position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%);
          display: flex; flex-direction: column; gap: 4px; align-items: center;
          max-width: 560px; width: max-content;
        }
        .xsc-ticker-label {
          font-size: 10px; letter-spacing: 0.2em; color: rgba(234,240,255,0.45);
          font-family: 'SF Mono', 'Consolas', monospace; margin-bottom: 2px;
        }
        .xsc-ticker-item {
          display: flex; align-items: center; gap: 8px;
          font-size: 11px; color: rgba(234,240,255,0.66);
          animation: xsc-ticker-in 0.3s ease;
          letter-spacing: 0.02em;
        }
        .xsc-ticker-item .tdot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
        .xsc-ticker-item .ttime { color: rgba(234,240,255,0.35); font-family: 'SF Mono', monospace; font-size: 10px; }
      `}</style>

      <div className="xsc-overlay" role="status" aria-live="assertive" aria-label="AI 正在控制电脑">
        <div className={`xsc-border ${phase}`} />
        <div className="xsc-grid" />
        <div className="xsc-scanline" />
        <div className="xsc-glow-cursor" ref={glowRef} />
        <div className="xsc-corner tl" />
        <div className="xsc-corner tr" />
        <div className="xsc-corner bl" />
        <div className="xsc-corner br" />
        <div className="xsc-radar" />

        <div className="xsc-hud">
          <span className="dot" />
          <span>SYSTEM CONTROL</span>
          <span className="sep">|</span>
          <span>PHASE</span>
          <span className="metric">{PHASE_LABEL[phase]?.toUpperCase() || phase.toUpperCase()}</span>
          <span className="sep">|</span>
          <span>STATUS</span>
          <span className="metric">{paused ? 'PAUSED' : severity.toUpperCase()}</span>
          <span className="sep">|</span>
          <span>T+{elapsed}s</span>
          <span className="sep">|</span>
          <span>OPS {history.length}</span>
        </div>

        <div className="xsc-status">
          <span className="xsc-dot" />
          <span className="xsc-title">{paused ? '已紧急暂停' : '玄枢正在控制电脑'}</span>
          <span className="xsc-detail">{paused ? '所有控制操作已中断' : detail}</span>
          <span className={`xsc-badge ${paused ? 'paused' : severity}`}>
            <span className="xsc-dot" style={{ width: 6, height: 6 }} />
            {paused ? '已暂停' : SEVERITY_LABEL[severity]}
          </span>
        </div>

        <div className="xsc-ticker">
          <span className="xsc-ticker-label">RECENT ACTIONS</span>
          {history.slice(0, 3).map((h, i) => (
            <div className="xsc-ticker-item" key={`${h.ts}-${i}`}>
              <span className="tdot" style={{ background: SEVERITY_COLOR[h.severity] }} />
              <span>{h.detail}</span>
              <span className="ttime">
                {new Date(h.ts).toLocaleTimeString('zh-CN', { hour12: false })}
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

/** 数值夹取到 0.2~1.0（发光亮度/强度合法区间） */
function clampNum(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0.2, n))
}
