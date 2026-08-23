import { useEffect, useMemo, useRef, useState } from 'react'

interface ControlStatePayload {
  active: boolean
  detail?: string
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
 * ControlOverlay — 「控制电脑」全屏特效（产品级）
 *
 * 当主进程广播 control:state（玄枢正在移动鼠标/键盘输入/注册表写入/
 * 服务启停/进程结束等）时，在应用窗口上叠加一层可视化的"控制中"特效，
 * 让用户始终清楚 AI 此刻正在操作自己的电脑。
 *
 * 特性：
 * - 危险分级配色（高风险=红 / 输入模拟=琥珀 / 普通=品牌蓝紫）
 * - 顶部 HUD 状态条 + 操作计数与耗时
 * - 底部滚动操作历史 ticker
 * - 鼠标"注视"光晕（随指针移动，示意 AI 关注点）
 * - 指针穿透（pointer-events:none），不阻断用户操作
 */
export default function ControlOverlay() {
  const [active, setActive] = useState(false)
  const [detail, setDetail] = useState('')
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [startTs, setStartTs] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  // 超过 12 秒未收到 finish 时兜底隐藏 overlay
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const glowRef = useRef<HTMLDivElement | null>(null)

  const severity = useMemo(() => classifySeverity(detail), [detail])
  const accent = SEVERITY_COLOR[severity]

  useEffect(() => {
    const api = (window as any).api
    if (!api?.on) {
      // 无 preload 环境（如纯浏览器调试），忽略
      return
    }

    const unsubscribe = api.on('control:state', (_event: unknown, payload: ControlStatePayload) => {
      if (payload?.active) {
        const d = payload.detail || '正在控制电脑'
        setActive(true)
        setDetail(d)
        setStartTs(payload.ts || Date.now())
        setElapsed(0)
        setHistory((prev) => {
          const next = [{ detail: d, ts: payload.ts || Date.now(), severity: classifySeverity(d) }, ...prev]
          return next.slice(0, 6)
        })
        if (hideTimer.current) clearTimeout(hideTimer.current)
        // 兜底：若异常导致 finish 未送达，12 秒后强制隐藏 overlay
        hideTimer.current = setTimeout(() => setActive(false), 12_000)
      } else {
        if (hideTimer.current) clearTimeout(hideTimer.current)
        setActive(false)
        setElapsed(0)
      }
    })

    return () => {
      if (unsubscribe) unsubscribe()
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [])

  // 操作耗时计时器
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startTs) / 1000)), 250)
    return () => clearInterval(timer)
  }, [active, startTs])

  // 鼠标"注视"光晕：监听窗口级 mousemove，直接改写 DOM style（不触发 React 重渲染）
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

  if (!active) return null

  const danger = severity === 'danger'
  const warning = severity === 'warning'

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
        @keyframes xsc-borderflow {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        @keyframes xsc-ticker-in {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .xsc-overlay {
          --xc-accent: ${accent};
          position: fixed;
          inset: 0;
          z-index: 99990;
          pointer-events: none;
          overflow: hidden;
          background:
            radial-gradient(ellipse at center, transparent 45%, ${danger ? 'rgba(40, 6, 10, 0.5)' : warning ? 'rgba(30, 20, 4, 0.44)' : 'rgba(6, 10, 24, 0.42)'} 100%);
        }
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

        /* 顶部 HUD 状态条 */
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

        /* 中央状态 */
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

        /* 雷达 */
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

        /* 鼠标注视光晕 */
        .xsc-glow-cursor {
          position: absolute; top: 0; left: 0; width: 280px; height: 280px;
          border-radius: 50%; opacity: 0;
          background: radial-gradient(circle, var(--xc-accent)22, transparent 70%);
          transition: opacity 0.4s ease;
          will-change: transform;
        }

        /* 底部操作历史 ticker */
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
        <div className="xsc-grid" />
        <div className="xsc-scanline" />
        <div className="xsc-glow-cursor" ref={glowRef} />
        <div className="xsc-corner tl" />
        <div className="xsc-corner tr" />
        <div className="xsc-corner bl" />
        <div className="xsc-corner br" />
        <div className="xsc-radar" />

        {/* 顶部 HUD */}
        <div className="xsc-hud">
          <span className="dot" />
          <span>SYSTEM CONTROL</span>
          <span className="sep">|</span>
          <span>STATUS</span>
          <span className="metric">{severity.toUpperCase()}</span>
          <span className="sep">|</span>
          <span>T+{elapsed}s</span>
          <span className="sep">|</span>
          <span>OPS {history.length}</span>
        </div>

        {/* 中央状态 */}
        <div className="xsc-status">
          <span className="xsc-dot" />
          <span className="xsc-title">玄枢正在控制电脑</span>
          <span className="xsc-detail">{detail}</span>
          <span className={`xsc-badge ${severity}`}>
            <span className="xsc-dot" style={{ width: 6, height: 6 }} />
            {SEVERITY_LABEL[severity]}
          </span>
        </div>

        {/* 底部操作历史 */}
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
