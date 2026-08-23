/**
 * LoadingSkeleton — 加载骨架屏组件
 *
 * 统一的内容加载占位组件，用于数据加载过程中的视觉反馈。
 * 支持多种形状：文本行、矩形卡片、圆形头像等。
 *
 * WCAG: aria-busy="true" + aria-label 告知屏幕阅读器内容正在加载
 *
 * @module LoadingSkeleton
 */

import React from 'react'

interface SkeletonLineProps {
  width?: string
  height?: string
}

const SkeletonLine: React.FC<SkeletonLineProps> = ({
  width = '100%',
  height = '16px',
}) => (
  <div
    style={{
      width,
      height,
      backgroundColor: 'var(--bg-elevated)',
      borderRadius: '4px',
      animation: 'skeleton-pulse 1.5s ease-in-out infinite',
    }}
  />
)

export interface LoadingSkeletonProps {
  /** 骨架屏类型 */
  variant?: 'text' | 'card' | 'list' | 'avatar' | 'page'
  /** 行数（text / list 类型） */
  lines?: number
  /** 自定义 className */
  className?: string
  /** 加载描述（用于屏幕阅读器） */
  loadingText?: string
}

const pulseKeyframes = `
@keyframes skeleton-pulse {
  0% { opacity: 0.3; }
  50% { opacity: 0.6; }
  100% { opacity: 0.3; }
}
`

export const LoadingSkeleton: React.FC<LoadingSkeletonProps> = ({
  variant = 'text',
  lines = 3,
  className = '',
  loadingText = '内容加载中',
}) => {
  const renderSkeleton = (): React.ReactNode => {
    switch (variant) {
      case 'text':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '24px' }}>
            {Array.from({ length: lines }).map((_, i) => (
              <SkeletonLine
                key={i}
                width={i === lines - 1 ? '60%' : '100%'}
                height="16px"
              />
            ))}
          </div>
        )

      case 'card':
        return (
          <div style={{ padding: '24px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '16px' }}>
            {Array.from({ length: lines }).map((_, i) => (
              <div
                key={i}
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  borderRadius: '12px',
                  padding: '16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <SkeletonLine height="140px" />
                <SkeletonLine width="70%" height="18px" />
                <SkeletonLine width="40%" height="14px" />
              </div>
            ))}
          </div>
        )

      case 'list':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '16px' }}>
            {Array.from({ length: lines }).map((_, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '12px',
                  backgroundColor: 'var(--bg-surface)',
                  borderRadius: '8px',
                }}
              >
                <SkeletonLine width="40px" height="40px" />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <SkeletonLine width="60%" height="16px" />
                  <SkeletonLine width="40%" height="12px" />
                </div>
              </div>
            ))}
          </div>
        )

      case 'avatar':
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '16px' }}>
            <div
              style={{
                width: '48px',
                height: '48px',
                backgroundColor: 'var(--bg-elevated)',
                borderRadius: '50%',
                animation: 'skeleton-pulse 1.5s ease-in-out infinite',
              }}
            />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <SkeletonLine width="40%" height="16px" />
              <SkeletonLine width="25%" height="12px" />
            </div>
          </div>
        )

      case 'page':
        return (
          <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <SkeletonLine width="30%" height="28px" />
            {Array.from({ length: lines }).map((_, i) => (
              <SkeletonLine key={i} height="18px" width={i === lines - 1 ? '50%' : '100%'} />
            ))}
            <div style={{ marginTop: '16px' }}>
              <SkeletonLine height="200px" />
            </div>
          </div>
        )
    }
  }

  return (
    <>
      <style>{pulseKeyframes}</style>
      <div
        className={`loading-skeleton loading-skeleton-${variant} ${className}`}
        role="status"
        aria-busy="true"
        aria-label={loadingText}
      >
        <span className="sr-only" style={{ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap' }}>
          {loadingText}
        </span>
        {renderSkeleton()}
      </div>
    </>
  )
}

export default LoadingSkeleton
