/**
 * 安全凭证存储 — S1 修复
 * ===================================
 * 使用 Electron safeStorage API 对敏感凭证（API Key、Token 等）
 * 进行系统级加密存储，防止明文泄露。
 *
 * - Windows: DPAPI (Data Protection API)
 * - macOS: Keychain
 * - Linux: libsecret 或 kwallet
 *
 * 加密后存储格式：base64 编码的 ciphertext，前缀 `$ENC$`
 * 用于区分明文（历史数据）和密文（新数据）。
 */

import { safeStorage } from 'electron'
import { logger } from '../../shared/logger'

/** 加密标记前缀，用于区分加密字段与明文历史数据 */
const ENC_PREFIX = '$ENC$'

/**
 * 检查 safeStorage 是否可用。
 * 大部分桌面系统都可用，仅少数无桌面的 Linux 环境不可用。
 */
export function isAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/**
 * 加密明文凭证。
 * @param plaintext 明文 API Key 或其他敏感值
 * @returns base64 编码的密文（带 $ENC$ 前缀），或 null（加密失败）
 */
export function encrypt(plaintext: string | undefined | null): string | null {
  if (plaintext == null || plaintext === '') {
    return plaintext ?? ''
  }
  if (!isAvailable()) {
    logger.error('[SecureStore] safeStorage 不可用，无法加密')
    return null
  }
  try {
    const buf = safeStorage.encryptString(plaintext)
    return ENC_PREFIX + buf.toString('base64')
  } catch (e) {
    logger.error('[SecureStore] 加密失败:', e)
    return null
  }
}

/**
 * 解密密文凭证。
 * 如果值不是以 $ENC$ 开头，视为明文历史数据，直接返回。
 * @param ciphertext 带 $ENC$ 前缀的密文，或普通明文
 * @returns 解密后的明文凭证
 */
export function decrypt(ciphertext: string | undefined | null): string {
  if (ciphertext == null || ciphertext === '') {
    return ciphertext ?? ''
  }
  // 非加密值（历史明文数据），直接返回
  if (!ciphertext.startsWith(ENC_PREFIX)) {
    return ciphertext
  }
  if (!isAvailable()) {
    logger.error('[SecureStore] safeStorage 不可用，无法解密')
    return ''
  }
  try {
    const base64 = ciphertext.slice(ENC_PREFIX.length)
    const buf = Buffer.from(base64, 'base64')
    return safeStorage.decryptString(buf)
  } catch (e) {
    logger.error('[SecureStore] 解密失败:', e)
    return ''
  }
}

/**
 * 创建掩码（显示前4位 + ****），用于展示给渲染进程。
 */
export function mask(value: string | undefined | null): string {
  if (value == null || value === '') return ''
  if (value.length <= 4) return '****'
  return value.substring(0, 4) + '****'
}
