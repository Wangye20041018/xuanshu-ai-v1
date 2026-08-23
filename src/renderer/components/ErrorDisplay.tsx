/**
 * ErrorDisplay — 错误展示组件
 *
 * 统一的错误状态展示，覆盖网络错误、权限错误、未知错误等场景。
 * 支持重试、报告错误、返回首页等操作。
 *
 * WCAG: role="alert" + aria-live 确保屏幕阅读器实时播报错误
 *
 * @module ErrorDisplay
 */

import React from 'react'
import { useTranslation } from '../i18n'

export type ErrorType = 'network' | 'permission' | 'not-found' | 'crash' | 'timeout' | 'unknown'

export interface ErrorDisplayProps {
  type?: ErrorType
  title?: string
  message?: string
  detail?: string
  onRetry?: () => void
  onGoHome?: () => void
  onReport?: () => void
  className?: string
}

const ERROR_ICONS: Record<ErrorType, string> = {
  network: '⚠',
  permission: '🔒',
  'not-found': '🔍',
  crash: '💥',
  timeout: '⏱',
  unknown: '❗',
}

export const ErrorDisplay: React.FC<ErrorDisplayProps> = ({
  type = 'unknown',
  title,
  message,
  detail,
  onRetry,
  onGoHome,
  onReport,
  className = '',
}) => {
  const { t } = useTranslation()

  return (
    <div
      className={`error-display ${className}`}
      role="alert"
      aria-live="assertive"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '48px 24px',
        textAlign: 'center',
        gap: '12px',
        minHeight: '200px',
      }}
    >
      <div
        className="error-display-icon"
        aria-hidden="true"
        style={{ fontSize: '48px', marginBottom: '8px' }}
      >
        {ERROR_ICONS[type]}
      </div>
      <h3
        className="error-display-title"
        style={{
          fontSize: 'var(--text-2xl)',
          fontWeight: 600,
          color: 'var(--danger-alt)',
          margin: 0,
        }}
      >
        {title ?? t(`errorDisplay.${type}`)}
      </h3>
      {message && (
        <p
          className="error-display-message"
          style={{
            fontSize: 'var(--text-lg)',
            color: 'var(--text-primary)',
            maxWidth: '400px',
            margin: 0,
            lineHeight: 1.5,
          }}
        >
          {message}
        </p>
      )}
      {detail && (
        <details
          className="error-display-detail"
          style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
            maxWidth: '500px',
            textAlign: 'left',
            backgroundColor: 'var(--bg-surface)',
            borderRadius: '8px',
            padding: '12px',
            width: '100%',
          }}
        >
          <summary style={{ cursor: 'pointer', marginBottom: '8px' }}>
            {t('errorDisplay.detail')}
          </summary>
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
            }}
          >
            {detail}
          </pre>
        </details>
      )}
      <div
        className="error-display-actions"
        style={{
          display: 'flex',
          gap: '8px',
          marginTop: '12px',
          flexWrap: 'wrap',
          justifyContent: 'center',
        }}
      >
        {onRetry && (
          <button
            className="error-display-action-retry"
            onClick={onRetry}
            type="button"
            style={{
              padding: '8px 24px',
              borderRadius: '8px',
              border: 'none',
              backgroundColor: '#3b82f6',
              color: '#fff',
              fontSize: 'var(--text-lg)',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {t('errorDisplay.retry')}
          </button>
        )}
        {onReport && (
          <button
            className="error-display-action-report"
            onClick={onReport}
            type="button"
            style={{
              padding: '8px 20px',
              borderRadius: '8px',
              border: '1px solid var(--border-default)',
              backgroundColor: 'transparent',
              color: 'var(--danger-alt)',
              fontSize: 'var(--text-lg)',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {t('errorDisplay.report')}
          </button>
        )}
        {onGoHome && (
          <button
            className="error-display-action-home"
            onClick={onGoHome}
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
            {t('errorDisplay.goHome')}
          </button>
        )}
      </div>
    </div>
  )
}

export default ErrorDisplay
