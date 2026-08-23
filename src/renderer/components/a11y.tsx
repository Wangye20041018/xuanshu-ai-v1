/**
 * Accessibility Utilities — 无障碍辅助组件
 *
 * 提供跳转链接、焦点陷阱、屏幕阅读器专用文本等 WCAG 2.1 AA 合规组件。
 *
 * @module a11y
 */

import React, { useEffect, useRef } from 'react'

/* ==================== SkipLink ==================== */

/**
 * 键盘用户跳转到主内容的链接（WCAG 2.4.1 Bypass Blocks）
 */
export const SkipLink: React.FC<{ targetId?: string; label?: string }> = ({
  targetId = 'main-content',
  label = '跳转到主内容',
}) => (
  <a
    href={`#${targetId}`}
    className="skip-link"
    style={{
      position: 'absolute',
      top: '-100px',
      left: '8px',
      padding: '8px 16px',
      backgroundColor: 'var(--accent)',
      color: 'var(--bg-base)',
      borderRadius: '0 0 8px 8px',
      zIndex: 100000,
      fontSize: 'var(--text-lg)',
      fontWeight: 500,
      textDecoration: 'none',
      transition: 'top 0.2s',
    }}
    onFocus={(e) => {
      e.currentTarget.style.top = '8px'
    }}
    onBlur={(e) => {
      e.currentTarget.style.top = '-100px'
    }}
  >
    {label}
  </a>
)

/* ==================== ScreenReaderOnly ==================== */

/**
 * 仅屏幕阅读器可见的文本
 */
export const ScreenReaderOnly: React.FC<{ children: React.ReactNode; as?: keyof JSX.IntrinsicElements }> = ({
  children,
  as: Tag = 'span',
}) => (
  <Tag
    style={{
      position: 'absolute',
      width: '1px',
      height: '1px',
      padding: 0,
      margin: '-1px',
      overflow: 'hidden',
      clip: 'rect(0, 0, 0, 0)',
      whiteSpace: 'nowrap',
      border: 0,
    }}
  >
    {children}
  </Tag>
)

/* ==================== FocusTrap ==================== */

/**
 * 焦点陷阱 — 将键盘焦点限制在模态框/对话框内
 */
export const FocusTrap: React.FC<{
  active: boolean
  children: React.ReactNode
  className?: string
}> = ({ active, children, className }) => {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!active || !containerRef.current) {
      return
    }

    const container = containerRef.current
    const focusableSelector =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') {
        return
      }

      const focusable = container.querySelectorAll<HTMLElement>(focusableSelector)
      if (focusable.length === 0) {
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last?.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first?.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [active])

  return (
    <div ref={containerRef} className={className}>
      {children}
    </div>
  )
}

/* ==================== LiveRegion ==================== */

/**
 * ARIA Live Region — 动态内容更新通知
 */
export const LiveRegion: React.FC<{
  politeness?: 'polite' | 'assertive'
  message: string
}> = ({ politeness = 'polite', message }) => (
  <div
    aria-live={politeness}
    aria-atomic="true"
    style={{
      position: 'absolute',
      width: '1px',
      height: '1px',
      padding: 0,
      margin: '-1px',
      overflow: 'hidden',
      clip: 'rect(0, 0, 0, 0)',
      whiteSpace: 'nowrap',
      border: 0,
    }}
  >
    {message}
  </div>
)

/* ==================== VisuallyHiddenInteractive ==================== */

/**
 * 视觉隐藏但键盘可聚焦的元素
 */
export const VisuallyHiddenInteractive: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement>
> = (props) => (
  <button
    {...props}
    style={{
      position: 'absolute',
      width: '1px',
      height: '1px',
      padding: 0,
      margin: '-1px',
      overflow: 'hidden',
      clip: 'rect(0, 0, 0, 0)',
      whiteSpace: 'nowrap',
      border: 0,
      ...(props.style ?? {}),
    }}
  />
)

export default SkipLink
