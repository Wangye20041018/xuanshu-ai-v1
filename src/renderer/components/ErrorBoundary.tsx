import React, { Component, ReactNode } from 'react'
import { logger } from '../../shared/logger'
import { t } from '../i18n/index'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error?: Error
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.error('Renderer ErrorBoundary caught an error:', error, errorInfo)
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: undefined })
  }

  handleGoHome = () => {
    this.setState({ hasError: false, error: undefined })
    const targetHash = '#/'
    if (window.location.hash !== targetHash) {
      window.location.hash = targetHash
    } else {
      window.location.reload()
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return <>{this.props.fallback}</>
      }
      const errorType = this.state.error?.name || t('error.unknown')
      return (
        <div
          style={{
            margin: 16,
            padding: 24,
            borderRadius: 16,
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.08)',
            color: '#e4e4e7',
            fontFamily: 'inherit',
          }}
        >
          <div style={{ marginBottom: 16 }}>
            <h2 style={{
              fontSize: 18,
              fontWeight: 700,
              color: '#e4e4e7',
              margin: '0 0 4px 0',
            }}>
              {t('errorBoundary.renderError')}
            </h2>
            <span style={{
              fontSize: 13,
              color: '#ef4444',
              fontWeight: 500,
            }}>
              {errorType}
            </span>
          </div>

          {this.state.error?.message && (
            <details style={{ marginBottom: 20 }}>
              <summary style={{
                cursor: 'pointer',
                fontSize: 13,
                color: 'rgba(255,255,255,0.55)',
                marginBottom: 8,
              }}>
                {t('errorBoundary.viewDetail')}
              </summary>
              <pre style={{
                margin: 0,
                padding: '12px 16px',
                borderRadius: 10,
                background: 'rgba(0,0,0,0.35)',
                border: '1px solid rgba(255,255,255,0.06)',
                fontSize: 12,
                color: 'rgba(255,255,255,0.55)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                lineHeight: 1.6,
              }}>
                {this.state.error.message}
              </pre>
            </details>
          )}

          <div style={{ display: 'flex', gap: 12 }}>
            <button
              onClick={this.handleRetry}
              style={{
                padding: '10px 22px',
                borderRadius: 12,
                border: 'none',
                background: '#b0b0ba',
                color: '#1a1a1c',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'background 0.2s ease',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#8a8a96' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#b0b0ba' }}
            >
              {t('errorBoundary.reload')}
            </button>
            <button
              onClick={this.handleGoHome}
              style={{
                padding: '10px 22px',
                borderRadius: 12,
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'transparent',
                color: 'rgba(255,255,255,0.55)',
                fontSize: 14,
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'border-color 0.2s ease, color 0.2s ease',
              }}
              onMouseEnter={(e) => {
                const el = e.currentTarget as HTMLButtonElement
                el.style.borderColor = 'rgba(255,255,255,0.3)'
                el.style.color = 'rgba(255,255,255,0.8)'
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget as HTMLButtonElement
                el.style.borderColor = 'rgba(255,255,255,0.15)'
                el.style.color = 'rgba(255,255,255,0.55)'
              }}
            >
              {t('errorBoundary.goHome')}
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
