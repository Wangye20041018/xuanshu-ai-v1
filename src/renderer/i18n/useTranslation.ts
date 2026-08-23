/**
 * useTranslation — i18n React Hook
 *
 * 响应式翻译 Hook，监听 locale-changed 事件自动重渲染。
 *
 * @module useTranslation
 */

import { useCallback, useSyncExternalStore } from 'react'
import { t, getLocale, setLocale, type Locale } from './index'

/**
 * 订阅 locale 变化事件，供 useSyncExternalStore 使用
 */
function subscribeToLocale(callback: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {}
  }
  window.addEventListener('locale-changed', callback)
  return () => window.removeEventListener('locale-changed', callback)
}

function getLocaleSnapshot(): Locale {
  return getLocale()
}

/**
 * React Hook: 响应式国际化翻译
 *
 * @returns { t, locale, setLocale, getLocale }
 *
 * 使用示例:
 *   const { t } = useTranslation()
 *   <span>{t('common.loading')}</span>
 */
export function useTranslation() {
  const locale = useSyncExternalStore(subscribeToLocale, getLocaleSnapshot, getLocaleSnapshot)

  const translate = useCallback(
    (key: string, params?: Record<string, string | number>) => t(key, params),
    [locale],
  )

  return { t: translate, locale, setLocale, getLocale }
}

export default useTranslation
