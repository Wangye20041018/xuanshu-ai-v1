import { useEffect, useRef, useState, lazy, Suspense } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import Sidebar from './components/layout/Sidebar'
import TitleBar from './components/layout/TitleBar'
import StatusBar from './components/layout/StatusBar'
import ErrorBoundary from './components/ErrorBoundary'
import { ToastContainer } from './components/Toast'
import { LoadingSkeleton } from './components/LoadingSkeleton'
import Onboarding from './components/Onboarding'
import { SkipLink } from './components/a11y'
import ControlOverlay from './components/ControlOverlay'
import { useTranslation } from './i18n'
import { logger } from '../shared/logger'
import { applyThemeOnBoot } from './theme'

// 首屏立即加载（Home），其余路由组件按需懒加载
import Home from './pages/Home'

const Voice = lazy(() => import('./pages/Voice'))
const Model = lazy(() => import('./pages/Model'))
const Memory = lazy(() => import('./pages/Memory'))
const Knowledge = lazy(() => import('./pages/Knowledge'))
const Plugins = lazy(() => import('./pages/Plugins'))
const Settings = lazy(() => import('./pages/Settings'))
const Automation = lazy(() => import('./pages/Automation'))
const SelfModify = lazy(() => import('./pages/SelfModify'))

/** 模块状态快照 */
interface ModuleStatus {
  [name: string]: 'idle' | 'ready' | 'failed'
}

/** 诊断信息 */
interface DiagnosticInfo {
  ready: boolean
  timeout: boolean
  modules: ModuleStatus
  initTimeMs: number | null
  /** Smart App Control 状态（来自主进程注册表检测） */
  sacStatus?: { enabled: boolean; mode: 'on' | 'evaluation' | 'off' | 'unknown' }
}

/** 路由懒加载骨架屏 */
function RouteFallback() {
  return <LoadingSkeleton variant="page" lines={4} />
}

function App() {
  const { t } = useTranslation()
  const location = useLocation()
  const [appReady, setAppReady] = useState(false)
  const [diagnostics, setDiagnostics] = useState<DiagnosticInfo | null>(null)
  const [initStartTime] = useState<number>(Date.now())
  const fpsRafRef = useRef<number>(0)
  const frameTimestamps = useRef<number[]>([])
  const lastReportTs = useRef<number>(0)

  // 启动即恢复已保存的主题色，避免重启后 --brand 系列 CSS 变量回退默认
  useEffect(() => {
    applyThemeOnBoot()
  }, [])

  // 监听 app:ready IPC 事件，控制骨架屏切换
  useEffect(() => {
    // 前端兜底超时：15 秒后若仍未收到 app:ready，查询诊断信息
    const frontendTimeout = setTimeout(async () => {
      if (!appReady) {
        logger.warn('[App] app:ready 超时未到达，正在获取诊断信息...')
        try {
          const win = window as any
          // 尝试查询后端状态
          const res = await win.api?.invoke?.('app:ready')
          if (res) {
            setDiagnostics({
              ready: !!res.ready,
              timeout: true,
              modules: res.modules || {},
              initTimeMs: Date.now() - initStartTime,
              sacStatus: res.sacStatus
            })
          } else {
            // 后端无响应，preload 可能也未就绪
            setDiagnostics({
              ready: false,
              timeout: true,
              modules: {},
              initTimeMs: Date.now() - initStartTime
            })
          }
        } catch {
          // IPC 调用失败，后端不可达
          setDiagnostics({
            ready: false,
            timeout: true,
            modules: {},
            initTimeMs: Date.now() - initStartTime
          })
        }
        // 无论如何都显示 UI（含诊断面板）
        setAppReady(true)
      }
    }, 15000)

    try {
      const win = window as any
      if (win.api?.on) {
        const unsubscribe = win.api.on('app:ready', (data: any) => {
          clearTimeout(frontendTimeout)
          if (data?.ready) {
            setDiagnostics(null) // 正常启动，清除诊断
            setAppReady(true)
          }
        })
        // 同时主动查询一次（可能已经 ready）
        win.api.invoke?.('app:ready').then((res: any) => {
          clearTimeout(frontendTimeout)
          if (res?.ready) {
            setDiagnostics(null)
            setAppReady(true)
          }
        }).catch(() => { /* browser dev mode, IPC unavailable */ })
        return () => {
          clearTimeout(frontendTimeout)
          unsubscribe()
        }
      } else {
        // 浏览器 dev server 环境，无 Electron preload，直接进入应用
        clearTimeout(frontendTimeout)
        setAppReady(true)
      }
    } catch {
      // preload 未就绪，降级：直接显示 UI
      clearTimeout(frontendTimeout)
      setDiagnostics({
        ready: false,
        timeout: false,
        modules: {},
        initTimeMs: Date.now() - initStartTime
      })
      setAppReady(true)
    }
  }, [])

  // FPS 数据采集与上报（每 2 秒一次）
  useEffect(() => {
    const win = window as any
    if (!win.api?.send) return

    const tick = () => {
      const now = performance.now()
      frameTimestamps.current.push(now)

      // 只保留最近 2 秒的时间戳
      const cutoff = now - 2000
      while (frameTimestamps.current.length > 0 && frameTimestamps.current[0] < cutoff) {
        frameTimestamps.current.shift()
      }

      // 每 2 秒计算并上报一次（RAF 每帧都会进入 tick，必须节流，否则 IPC 洪泛）
      if (frameTimestamps.current.length > 1 && now - lastReportTs.current >= 2000) {
        const elapsed = (frameTimestamps.current[frameTimestamps.current.length - 1] - frameTimestamps.current[0]) / 1000
        const fps = elapsed > 0 ? Math.round(frameTimestamps.current.length / elapsed) : 0
        try {
          win.api.send('perf:fps-report', fps)
        } catch { /* ignore */ }
        lastReportTs.current = now
      }

      fpsRafRef.current = requestAnimationFrame(tick)
    }

    fpsRafRef.current = requestAnimationFrame(tick)

    return () => {
      if (fpsRafRef.current) {
        cancelAnimationFrame(fpsRafRef.current)
      }
    }
  }, [appReady])

  // 骨架屏：等待 app:ready 前显示 loading，超时时显示诊断信息
  if (!appReady) {
    return (
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'var(--bg-base)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        zIndex: 99999,
        fontFamily: "'Work Sans', 'Noto Sans SC', system-ui, sans-serif",
        userSelect: 'none'
      }}>
        <LoadingSkeleton variant="page" lines={4} loadingText={t('chat.modelLoading')} />
      </div>
    )
  }

  // 超时诊断面板：app:ready 超时后覆盖在主 UI 上方
  if (diagnostics) {
    const moduleEntries = diagnostics.modules ? Object.entries(diagnostics.modules) : []
    const failedModules = moduleEntries.filter(([, status]) => status === 'failed')
    const idleModules = moduleEntries.filter(([, status]) => status === 'idle')
    // 判断是否是 Smart App Control 拦截特征：主进程已检测到 SAC 启用，或后端未就绪且多模块异常
    const sacEnabled = diagnostics.sacStatus?.enabled ?? false
    const isSacSuspected = sacEnabled || (!diagnostics.ready && (failedModules.length > 1 || idleModules.length > 2))

    return (
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        zIndex: 100000,
        fontFamily: "'Work Sans', 'Noto Sans SC', system-ui, sans-serif",
        userSelect: 'none'
      }}>
        <div style={{
          maxWidth: 520, width: '90%',
          background: 'rgba(30,30,36,0.95)',
          borderRadius: 12,
          padding: '32px 36px',
          border: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '0 8px 40px rgba(0,0,0,0.5)'
        }}>
          {/* 标题 */}
          <div style={{
            fontFamily: "'Playfair Display', 'Noto Serif SC', serif",
            fontSize: 24, fontWeight: 700,
            color: '#e0e0e8', letterSpacing: 2,
            marginBottom: 4
          }}>{t('common.appName')}</div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', marginBottom: 20 }}>
            启动诊断报告 &middot; 已等待 {diagnostics.initTimeMs ? Math.round(diagnostics.initTimeMs / 1000) : '?'} 秒
          </div>

          {/* 总览 */}
          <div style={{
            padding: '12px 16px',
            background: 'rgba(255,255,255,0.04)',
            borderRadius: 8,
            marginBottom: 16,
            fontSize: 13, color: 'rgba(255,255,255,0.6)',
            lineHeight: 1.6
          }}>
            <div><span style={{color: '#909098'}}>后端就绪：</span>
              <span style={{color: diagnostics.ready ? '#4ade80' : '#f87171', fontWeight: 600}}>
                {diagnostics.ready ? t('common.ok') : t('common.cancel')}
              </span>
            </div>
            <div><span style={{color: '#909098'}}>超时触发：</span>
              <span style={{color: diagnostics.timeout ? '#fbbf24' : '#4ade80'}}>
                {diagnostics.timeout ? '是' : '否'}
              </span>
            </div>
            <div><span style={{color: '#909098'}}>模块总数：</span>{moduleEntries.length}
              &nbsp;&nbsp;就绪 {moduleEntries.filter(([, s]) => s === 'ready').length}
              &nbsp;&nbsp;失败 {failedModules.length}
              &nbsp;&nbsp;待初始化 {idleModules.length}
            </div>
          </div>

          {/* Smart App Control 警告 */}
          {isSacSuspected && (
            <div style={{
              padding: '14px 16px',
              background: 'rgba(251,191,36,0.08)',
              border: '1px solid rgba(251,191,36,0.25)',
              borderRadius: 8,
              marginBottom: 16
            }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#fbbf24', marginBottom: 6 }}>
                {sacEnabled
                  ? `部分服务被 Smart App Control 拦截 (SAC 状态: ${diagnostics.sacStatus?.mode === 'on' ? '已开启' : diagnostics.sacStatus?.mode === 'evaluation' ? '评估模式' : '未知'})`
                  : '部分服务被系统安全策略拦截'}
              </div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', lineHeight: 1.6 }}>
                多个核心模块未能初始化，可能原因：<br/>
                1. <b>Windows 智能应用控制 (Smart App Control)</b> 已拦截部分可执行文件<br/>
                2. 杀毒软件或防火墙阻止了后台服务启动<br/>
                <br/>
                建议操作：<br/>
                &bull; 打开「Windows 安全中心」→「应用和浏览器控制」→「智能应用控制」，选择「关闭」<br/>
                &bull; 或将玄枢AI安装目录添加到杀毒软件白名单<br/>
                &bull; 关闭后重新安装应用
              </div>
            </div>
          )}

          {/* 失败模块列表 */}
          {failedModules.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#f87171', marginBottom: 6 }}>
                启动失败 ({failedModules.length})
              </div>
              {failedModules.map(([name]) => (
                <div key={name} style={{
                  fontSize: 11, color: 'rgba(255,255,255,0.4)',
                  padding: '3px 0', fontFamily: 'var(--font-mono)'
                }}>
                  {name}
                </div>
              ))}
            </div>
          )}

          {/* 就绪模块 */}
          {moduleEntries.filter(([, s]) => s === 'ready').length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#4ade80', marginBottom: 6 }}>
                已就绪 ({moduleEntries.filter(([, s]) => s === 'ready').length})
              </div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', fontFamily: 'var(--font-mono)', lineHeight: 1.5 }}>
                {moduleEntries.filter(([, s]) => s === 'ready').map(([name]) => name).join(', ')}
              </div>
            </div>
          )}

          {/* 操作按钮 */}
          <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
            <button onClick={() => setDiagnostics(null)}
              style={{
                flex: 1, padding: '10px 0',
                background: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 6, cursor: 'pointer',
                color: '#d0d0d8', fontSize: 13,
                fontFamily: 'inherit'
              }}>
              继续进入应用
            </button>
            <button onClick={() => {
              const win = window as any
              win.api?.send?.('app:relaunch')
            }}
              style={{
                flex: 1, padding: '10px 0',
                background: 'rgba(59,130,246,0.15)',
                border: '1px solid rgba(59,130,246,0.3)',
                borderRadius: 6, cursor: 'pointer',
                color: '#60a5fa', fontSize: 13,
                fontWeight: 600, fontFamily: 'inherit'
              }}>
              重启应用
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <ErrorBoundary>
      {/* WCAG SkipLink: keyboard navigation bypass (L-15: 统一使用 a11y.tsx 组件) */}
      <SkipLink label={t('accessibility.skipToContent')} />
      {/* WCAG LiveRegion: dynamic content announcements */}
      <div
        role="status"
        aria-live="polite"
        className="sr-only"
        style={{
          position: 'absolute', width: '1px', height: '1px', overflow: 'hidden',
          clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0,
        }}
      />
      <div className="app-layout" style={{ background: 'var(--bg-base)' }}>
        <Sidebar />
        <div className="app-main" id="main-content">
          <TitleBar />
          <div className="app-content">
            <AnimatePresence mode="wait">
                <motion.div
                  key={location.pathname}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                  style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}
                >
                  <Suspense fallback={<RouteFallback />}>
                    <Routes location={location}>
                      <Route path="/" element={<Home />} />
                      <Route path="/voice" element={<Voice />} />
                      <Route path="/model" element={<Model />} />
                      <Route path="/memory" element={<Memory />} />
                      <Route path="/knowledge" element={<Knowledge />} />
                      <Route path="/plugins" element={<Plugins />} />
                      <Route path="/settings" element={<Settings />} />
                      <Route path="/automation" element={<Automation />} />
                      <Route path="/self-modify" element={<SelfModify />} />
                    </Routes>
                  </Suspense>
                </motion.div>
            </AnimatePresence>
          </div>
          <StatusBar />
        </div>
      </div>
      <ControlOverlay />
      <ToastContainer />
      <Onboarding />
    </ErrorBoundary>
  )
}

export default App
