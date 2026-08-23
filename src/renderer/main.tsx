import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import './styles/globals.css'
import { logger } from '../shared/logger'

// 全局错误捕获
window.onerror = function(msg, _url, _line, _col, err) {
  logger.error('GLOBAL ERROR:', msg, err)
  const el = document.getElementById('root')
  if (el && !el.querySelector('.error-overlay')) {
    const overlay = document.createElement('div')
    overlay.className = 'error-overlay'
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:var(--bg-base);color:var(--danger-alt);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:99999;padding:40px;font-family:system-ui,sans-serif'

    const title = document.createElement('h2')
    title.style.cssText = 'color:var(--danger-alt);margin-bottom:16px'
    // C-16 修复：textContent 渲染错误信息，杜绝 XSS
    title.textContent = '应用遇到错误'

    const detail = document.createElement('p')
    detail.style.cssText = 'color:rgba(255,255,255,0.6);margin-bottom:24px;max-width:500px;text-align:center;word-break:break-all'
    detail.textContent = String(msg)

    const reloadBtn = document.createElement('button')
    reloadBtn.textContent = '重新加载'
    reloadBtn.style.cssText = 'padding:10px 24px;background:var(--accent);color:var(--bg-base);border:none;border-radius:12px;font-size:14px;cursor:pointer;font-weight:600'
    reloadBtn.addEventListener('click', () => location.reload())

    overlay.appendChild(title)
    overlay.appendChild(detail)
    overlay.appendChild(reloadBtn)
    el.appendChild(overlay)
  }
  return true
}

// 全局未处理 Promise rejection 捕获
window.addEventListener('unhandledrejection', (event) => {
  logger.error('UNHANDLED PROMISE REJECTION:', event.reason)
  event.preventDefault()
})

// 移除 HTML 内联骨架屏，React 接管后由 App 组件管理加载过渡
const skeleton = document.getElementById('app-skeleton')
if (skeleton) skeleton.style.display = 'none'

// 挂载 React
try {
  const rootEl = document.getElementById('root')
  if (!rootEl) throw new Error('Fatal: #root element not found in HTML')
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <ErrorBoundary>
        <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <App />
        </HashRouter>
      </ErrorBoundary>
    </React.StrictMode>
  )
} catch (err) {
  logger.error('FATAL: React mount failed:', err)
  // C-16 修复：textContent 渲染错误信息，杜绝 XSS
  const body = document.body
  const wrap = document.createElement('div')
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:var(--bg-base);color:var(--text-primary);padding:40px'
  const title = document.createElement('h2')
  title.style.color = 'var(--danger-alt)'
  title.textContent = '启动失败'
  const detail = document.createElement('p')
  detail.style.cssText = 'color:rgba(255,255,255,0.5);margin-top:16px;word-break:break-all'
  detail.textContent = String(err)
  wrap.appendChild(title)
  wrap.appendChild(detail)
  body.innerHTML = ''
  body.appendChild(wrap)
}
