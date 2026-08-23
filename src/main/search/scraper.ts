import { ScrapedPage } from './types'
import { createProxyAgent } from '../utils/proxy-resolver'

/** 创建带超时的 fetch（10秒），注入系统代理 */
function fetchWithTimeout(url: string, timeoutMs: number = 10000): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const agent = createProxyAgent()
  const fetchOptions: RequestInit & { dispatcher?: any } = { signal: controller.signal }
  if (agent) fetchOptions.dispatcher = agent
  return fetch(url, fetchOptions as RequestInit).finally(() => clearTimeout(timeout))
}

/** 清理 HTML 实体 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCharCode(Number(dec)))
}

/** 清理文本：去除多余空白 */
function cleanText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim()
}

/** 提取网页标题 */
function extractTitle(html: string): string {
  const patterns = [
    /<title[^>]*>([\s\S]*?)<\/title>/i,
    /<meta[^>]*property="og:title"[^>]*content="([^"]*)"/i,
    /<meta[^>]*name="twitter:title"[^>]*content="([^"]*)"/i,
    /<h1[^>]*>([\s\S]*?)<\/h1>/i
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(html)
    if (match && match[1]) {
      return decodeHtmlEntities(cleanText(match[1].replace(/<[^>]+>/g, '')))
    }
  }

  return ''
}

/** 提取网页正文 */
function extractMainText(html: string): string {
  // 移除 script、style、nav、header、footer 等非正文标签
  let cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<form[^>]*>[\s\S]*?<\/form>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  // 尝试提取常见正文容器
  const contentPatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/gi,
    /<main[^>]*>([\s\S]*?)<\/main>/gi,
    /<div[^>]*class="[^"]*(?:content|article|post|entry|body|main|text)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    /<div[^>]*id="[^"]*(?:content|article|post|entry|body|main|text)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi
  ]

  let extractedText = ''

  for (const pattern of contentPatterns) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(cleaned)) !== null) {
      extractedText += match[1] + '\n'
    }
    if (extractedText.length > 100) break
  }

  // 如果没找到正文容器，提取 body 中的文本
  if (extractedText.length < 100) {
    const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(cleaned)
    if (bodyMatch) {
      extractedText = bodyMatch[1]
    }
  }

  // 移除所有 HTML 标签
  let text = extractedText.replace(/<[^>]+>/g, ' ')
  // 解码 HTML 实体
  text = decodeHtmlEntities(text)
  // 清理多余空白
  text = cleanText(text)

  // 限制最大长度（避免过大的文本）
  if (text.length > 10000) {
    text = text.substring(0, 10000) + '...'
  }

  return text
}

/** 提取网页中的链接 */
function extractLinks(html: string): string[] {
  const links: string[] = []
  const linkRegex = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>/gi
  let match

  while ((match = linkRegex.exec(html)) !== null) {
    const url = match[1]
    if (url && !links.includes(url) && !url.includes('javascript:') && !url.includes('mailto:')) {
      links.push(url)
      if (links.length >= 50) break
    }
  }

  return links
}

/** 提取 favicon */
function extractFavicon(html: string, baseUrl: string): string | undefined {
  const patterns = [
    /<link[^>]*rel="[^"]*(?:icon|shortcut icon)[^"]*"[^>]*href="([^"]+)"/i,
    /<link[^>]*href="([^"]+)"[^>]*rel="[^"]*(?:icon|shortcut icon)[^"]*"/i
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(html)
    if (match && match[1]) {
      const favicon = match[1]
      if (favicon.startsWith('http')) {
        return favicon
      }
      // 相对路径，拼接 base URL
      try {
        return new URL(favicon, baseUrl).href
      } catch {
        return undefined
      }
    }
  }

  // 默认 favicon 路径
  try {
    return new URL('/favicon.ico', baseUrl).href
  } catch {
    return undefined
  }
}

/**
 * 抓取网页内容
 * @param url 目标 URL
 * @returns 抓取到的网页内容
 */
export async function scrapeUrl(url: string): Promise<ScrapedPage> {
  const emptyResult: ScrapedPage = {
    title: '',
    url,
    text: '',
    links: []
  }

  try {
    const response = await fetchWithTimeout(url)

    if (!response.ok) {
      return emptyResult
    }

    const contentType = response.headers.get('content-type') || ''

    // 只处理 HTML 页面
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return emptyResult
    }

    const html = await response.text()

    if (!html || html.length < 100) {
      return emptyResult
    }

    const title = extractTitle(html)
    const text = extractMainText(html)
    const links = extractLinks(html)
    const favicon = extractFavicon(html, url)

    return {
      title,
      url,
      text,
      links,
      favicon
    }
  } catch {
    return emptyResult
  }
}

/**
 * 批量抓取网页
 * @param urls URL 列表
 * @returns 抓取结果列表
 */
export async function scrapeUrls(urls: string[]): Promise<ScrapedPage[]> {
  const results = await Promise.allSettled(
    urls.map(url => scrapeUrl(url))
  )

  return results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value
    }
    return {
      title: '',
      url: urls[index],
      text: '',
      links: []
    }
  })
}