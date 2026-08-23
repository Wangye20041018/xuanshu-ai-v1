/**
 * EmptyState — 空状态组件
 *
 * 统一的无数据展示组件，覆盖空文件、空搜索结果、空列表等场景。
 * 支持自定义图标、标题、描述和操作按钮。
 *
 * WCAG: 符合 WCAG 2.1 AA 标准
 *
 * @module EmptyState
 */

import React from 'react'

export interface EmptyStateProps {
  /** 标题 */
  title: string
  /** 描述文本 */
  description?: string
  /** 图标（可选，默认显示通用空状态图标） */
  icon?: React.ReactNode
  /** 主操作按钮 */
  action?: {
    label: string
    onClick: () => void
  }
  /** 次要操作按钮 */
  secondaryAction?: {
    label: string
    onClick: () => void
  }
  /** 自定义 className */
  className?: string
}

const DefaultIcon: React.FC = () => (
  <svg
    width="64"
    height="64"
    viewBox="0 0 64 64"
    fill="none"
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="8" y="12" width="48" height="40" rx="4" stroke="var(--text-tertiary)" strokeWidth="2" />
    <path d="M24 32h16M24 40h12" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" />
  </svg>
)

export const EmptyState: React.FC<EmptyStateProps> = ({
  title,
  description,
  icon,
  action,
  secondaryAction,
  className = '',
}) => {
  return (
    <div
      className={`empty-state ${className}`}
      role="status"
      aria-label={title}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '48px 24px',
        textAlign: 'center',
        gap: '12px',
      }}
    >
      <div className="empty-state-icon" aria-hidden="true">
        {icon ?? <DefaultIcon />}
      </div>
      <h3
        className="empty-state-title"
        style={{
          fontSize: 'var(--text-xl)',
          fontWeight: 600,
          color: 'var(--text-primary)',
          margin: 0,
        }}
      >
        {title}
      </h3>
      {description && (
        <p
          className="empty-state-description"
          style={{
            fontSize: 'var(--text-lg)',
            color: 'var(--text-secondary)',
            maxWidth: '320px',
            margin: 0,
            lineHeight: 1.5,
          }}
        >
          {description}
        </p>
      )}
      <div
        className="empty-state-actions"
        style={{
          display: 'flex',
          gap: '8px',
          marginTop: '8px',
        }}
      >
        {action && (
          <button
            className="empty-state-action-primary"
            onClick={action.onClick}
            type="button"
            style={{
              padding: '8px 20px',
              borderRadius: '8px',
              border: 'none',
              backgroundColor: 'var(--accent)',
              color: '#1a1a1c',
              fontSize: 'var(--text-lg)',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {action.label}
          </button>
        )}
        {secondaryAction && (
          <button
            className="empty-state-action-secondary"
            onClick={secondaryAction.onClick}
            type="button"
            style={{
              padding: '8px 20px',
              borderRadius: '8px',
              border: '1px solid var(--border-default)',
              backgroundColor: 'transparent',
              color: 'var(--text-primary)',
              fontSize: 'var(--text-lg)',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {secondaryAction.label}
          </button>
        )}
      </div>
    </div>
  )
}

export default EmptyState
