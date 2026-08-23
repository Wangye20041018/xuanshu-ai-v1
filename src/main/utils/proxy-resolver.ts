/* ============================================================
 * 系统代理自动检测 & 代理 Agent 工厂
 *
 * 检测顺序: 环境变量 → Windows 系统代理 → 配置文件
 * 使用 undici ProxyAgent 为 Node.js fetch 提供代理支持
 * v10.1.1: execSync→execAsync, socks5 支持, clearProxyCache 公开
 * ============================================================ */

import { exec } from 'child_process'
import { promisify } from 'util'
import { ProxyAgent } from 'undici'

import { POWERSHELL_EXE } from './powershell'
import { logger } from '../../shared/logger'

const execAsync = promisify(exec)

let cachedProxyUrl: string | null = null
let cacheChecked = false

/**
 * 获取系统代理 URL
 * 检测顺序: 环境变量 HTTP_PROXY/HTTPS_PROXY → Windows 系统代理 → 已保存配置
 */
export function getSystemProxy(): string | null {
  if (cacheChecked) return cachedProxyUrl
  cacheChecked = true

  // 1️⃣ 环境变量（最高优先级）
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  if (envProxy) {
    cachedProxyUrl = normalizeProxyUrl(envProxy)
    logger.debug('[Proxy] 从环境变量检测到代理:', cachedProxyUrl)
    return cachedProxyUrl
  }

  return null
}

/**
 * 异步获取系统代理 URL（不阻塞主进程）
 * execSync → execAsync
 */
export async function getSystemProxyAsync(): Promise<string | null> {
  if (cacheChecked) return cachedProxyUrl
  cacheChecked = true

  // 1️⃣ 环境变量
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  if (envProxy) {
    cachedProxyUrl = normalizeProxyUrl(envProxy)
    logger.debug('[Proxy] 从环境变量检测到代理:', cachedProxyUrl)
    return cachedProxyUrl
  }

  // 2️⃣ Windows 系统代理（异步）
  try {
    const { stdout: proxyServer } = await execAsync(
      `"${POWERSHELL_EXE}" -Command "(Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings').ProxyServer"`,
      { timeout: 3000 }
    )
    const server = proxyServer.trim()

    const { stdout: proxyEnable } = await execAsync(
      `"${POWERSHELL_EXE}" -Command "(Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings').ProxyEnable"`,
      { timeout: 3000 }
    )

    if (proxyEnable.trim() === '1' && server) {
      let proxyUrl = server
      if (server.includes('=')) {
        const parts = server.split(';')
        const httpsPart = parts.find(p => p.trim().toLowerCase().startsWith('https='))
        const httpPart = parts.find(p => p.trim().toLowerCase().startsWith('http='))
        proxyUrl = httpsPart ? httpsPart.split('=')[1] : httpPart ? httpPart.split('=')[1] : parts[0].split('=')[1]
      }
      cachedProxyUrl = normalizeProxyUrl(proxyUrl)
      logger.debug('[Proxy] 从 Windows 系统设置检测到代理:', cachedProxyUrl)
      return cachedProxyUrl
    }
  } catch (e) {
    logger.error('[ProxyResolver] 读取Windows注册表代理失败:', e)
    // 非 Windows 或注册表读取失败
  }

  // 3️⃣ WinHTTP 代理（异步）
  try {
    const { stdout: winhttpResult } = await execAsync(
      'netsh winhttp show proxy 2>&1',
      { timeout: 3000 }
    )
    const match = winhttpResult.match(/代理服务器\s*:\s*(\S+)/)
    if (match && match[1] && match[1] !== '直接访问') {
      cachedProxyUrl = normalizeProxyUrl(match[1])
      logger.debug('[Proxy] 从 WinHTTP 检测到代理:', cachedProxyUrl)
      return cachedProxyUrl
    }
  } catch (e) { logger.error('[ProxyResolver] WinHTTP代理检测失败:', e) }

  return null
}

/**
 * 规范化代理 URL — 检测 socks5:///socks5h://
 */
function normalizeProxyUrl(raw: string): string {
  let url = raw.trim()
  // 检测 socks5:// 或 socks5h:// 前缀，不做任何修改
  if (url.startsWith('socks5://') || url.startsWith('socks5h://')) {
    return url
  }
  // 已有 http/https 前缀
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url
  }
  // 默认补 http://
  url = 'http://' + url
  // 去掉末尾斜杠
  if (url.endsWith('/')) {
    url = url.slice(0, -1)
  }
  return url
}

/**
 * 创建 undici ProxyAgent（用于 Node.js fetch 的 dispatcher 参数）
 */
export function createProxyAgent(): ProxyAgent | null {
  const proxyUrl = getSystemProxy()
  if (!proxyUrl) return null

  try {
    return new ProxyAgent({
      uri: proxyUrl,
      keepAliveTimeout: 10_000,
      keepAliveMaxTimeout: 30_000,
    })
  } catch (e) {
    logger.warn('[Proxy] 创建 ProxyAgent 失败:', e)
    return null
  }
}

/**
 * 异步创建 undici ProxyAgent — 会触发 Windows 系统代理（注册表/WinHTTP）检测。
 * 适用于启动预热与需要完整系统代理检测的关键外网链路。
 */
export async function createProxyAgentAsync(): Promise<ProxyAgent | null> {
  const proxyUrl = await getSystemProxyAsync()
  if (!proxyUrl) return null

  try {
    return new ProxyAgent({
      uri: proxyUrl,
      keepAliveTimeout: 10_000,
      keepAliveMaxTimeout: 30_000,
    })
  } catch (e) {
    logger.warn('[Proxy] 创建 ProxyAgent(异步) 失败:', e)
    return null
  }
}

/**
 * 清除代理缓存（用户修改代理设置后重新检测）
 * clearProxyCache 公开导出
 */
export function clearProxyCache(): void {
  cachedProxyUrl = null
  cacheChecked = false
  logger.debug('[Proxy] 代理缓存已清除')
}

/**
 * 检测代理是否可用
 */
export async function testProxy(): Promise<{ available: boolean; proxyUrl: string | null; latency: number }> {
  const proxyUrl = getSystemProxy()
  if (!proxyUrl) {
    return { available: false, proxyUrl: null, latency: 0 }
  }

  try {
    const agent = new ProxyAgent({ uri: proxyUrl })
    const start = Date.now()
    const response = await fetch('https://www.baidu.com', {
      method: 'HEAD',
      // @ts-ignore TS2353 — dispatcher not in fetch options type
      dispatcher: agent,
      signal: AbortSignal.timeout(5000),
    })
    const latency = Date.now() - start
    return { available: response.ok, proxyUrl, latency }
  } catch (e) {
    logger.error('[ProxyResolver] 测试代理连接失败:', e)
    return { available: false, proxyUrl, latency: 0 }
  }
}
