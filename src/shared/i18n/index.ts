import { useState, useCallback, useEffect } from 'react'
import zhCN from './zh-CN'
import enUS from './en-US'

/** 支持的语言 */
export type SupportedLanguage = 'zh-CN' | 'en-US'

/** 翻译键类型 */
export type TranslationKey = string

/** 翻译映射表类型 */
export type TranslationMap = Record<string, string>

/** 语言包注册表 */
const LOCALE_MAP: Record<SupportedLanguage, TranslationMap> = {
  'zh-CN': zhCN,
  'en-US': enUS,
}

/** localStorage 键名 */
const STORAGE_KEY = 'xuanshu-language'

/** 从 localStorage 读取保存的语言偏好 */
function getStoredLanguage(): SupportedLanguage {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'zh-CN' || stored === 'en-US') {
      return stored
    }
  } catch {
    // localStorage 不可用时静默回退
  }
  return 'zh-CN'
}

/** 持久化语言偏好 */
function storeLanguage(lang: SupportedLanguage): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    // localStorage 不可用时静默回退
  }
}

/** 判断是否为支持的语言 */
function isSupportedLanguage(lang: string): lang is SupportedLanguage {
  return lang === 'zh-CN' || lang === 'en-US'
}

/** 全局当前语言（模块级变量，非 React 环境也可访问） */
let currentLanguage: SupportedLanguage = getStoredLanguage()

/** 获取当前语言 */
export function getCurrentLanguage(): SupportedLanguage {
  return currentLanguage
}

/** 切换语言（非 React 环境） */
export function setLanguage(lang: SupportedLanguage): void {
  currentLanguage = lang
  storeLanguage(lang)
}

/**
 * 翻译函数（非 React 环境也可使用）
 * 使用示例: t('settings.title') => '设置'
 * 支持回退到 key 本身
 */
export function t(key: string): string {
  const map = LOCALE_MAP[currentLanguage]
  return map[key] ?? key
}

/**
 * React Hook: 国际化
 * 返回 { t, language, setLanguage }
 */
export function useI18n() {
  const [lang, setLang] = useState<SupportedLanguage>(currentLanguage)

  useEffect(() => {
    const stored = getStoredLanguage()
    if (stored !== currentLanguage) {
      currentLanguage = stored
      setLang(stored)
    }
    // 监听 storage 事件（跨标签页同步）
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && isSupportedLanguage(e.newValue ?? '')) {
        currentLanguage = e.newValue as SupportedLanguage
        setLang(currentLanguage)
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  const changeLanguage = useCallback((newLang: SupportedLanguage) => {
    currentLanguage = newLang
    storeLanguage(newLang)
    setLang(newLang)
  }, [])

  const translate = useCallback(
    (key: string): string => {
      return LOCALE_MAP[lang][key] ?? key
    },
    [lang],
  )

  return {
    t: translate,
    language: lang,
    setLanguage: changeLanguage,
  } as const
}

export { zhCN, enUS }
export default { useI18n, t, getCurrentLanguage, setLanguage }