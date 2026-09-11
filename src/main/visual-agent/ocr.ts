/**
 * 玄枢AI — 本地 OCR 层（大修第一批 · 屏幕理解三级回退第 2 级）
 *
 * 使用 Windows 内置 OCR 引擎（Windows.Media.Ocr，Windows 10+ 系统自带，
 * 通过 PowerShell WinRT 调用），纯本地、零显存、零依赖：
 *   - 不加载任何模型，不调用视觉模型
 *   - 支持中英文等用户语言包（TryCreateFromUserProfileLanguages）
 *   - 输出全文 + 每个词的行内坐标（供元素定位）
 *
 * 失败时返回空结果，由上层回退到第 3 级（2B 视觉模型兜底）。
 */

import { POWERSHELL_EXE } from '../utils/powershell'
import { logger } from '../../shared/logger'

export interface OcrWord {
  text: string
  x: number
  y: number
  w: number
  h: number
}

export interface OcrResult {
  ok: boolean
  text: string
  words: OcrWord[]
  error?: string
}

/**
 * PowerShell + Windows.Media.Ocr 脚本。
 * 输入：环境变量 XS_OCR_IMG（图片绝对路径）
 * 输出：JSON { text: string, words: [{text,x,y,w,h}] }
 *
 * 注意：PowerShell 转义反引号（`n、`1）在 JS 普通字符串中无需转义，
 * 因此本脚本使用数组 join 而非模板字符串，避免 TS 模板转义冲突。
 */
const OCR_PS_SCRIPT = [
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]',
  '$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]',
  '$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType=WindowsRuntime]',
  '$null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType=WindowsRuntime]',
  '$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq \'AsTask\' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq \'IAsyncOperation`1\' })[0]',
  'function Await($WinRtTask, $ResultType) {',
  '  try {',
  '    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)',
  '    $netTask = $asTask.Invoke($null, @($WinRtTask))',
  '    $netTask.Wait(-1) | Out-Null',
  '    return $netTask.Result',
  '  } catch { return $null }',
  '}',
  '$path = $env:XS_OCR_IMG',
  'if (-not $path) { Write-Output \'{}\'; exit }',
  '$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])',
  'if ($null -eq $file) { Write-Output \'{}\'; exit }',
  '$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
  'if ($null -eq $stream) { Write-Output \'{}\'; exit }',
  '$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
  'if ($null -eq $decoder) { Write-Output \'{}\'; exit }',
  '$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
  'if ($null -eq $bitmap) { Write-Output \'{}\'; exit }',
  '$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()',
  'if ($null -eq $engine) { Write-Output \'{}\'; exit }',
  '$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
  'if ($null -eq $result) { Write-Output \'{}\'; exit }',
  '$texts = @(); $words = @()',
  'foreach ($line in $result.Lines) {',
  '  $texts += $line.Text',
  '  foreach ($word in $line.Words) {',
  '    $r = $word.BoundingRect',
  '    $words += [ordered]@{ text=$word.Text; x=[int]$r.X; y=[int]$r.Y; w=[int]$r.Width; h=[int]$r.Height }',
  '  }',
  '}',
  '$out = [ordered]@{ text = ($texts -join "`n"); words = $words }',
  'Write-Output ($out | ConvertTo-Json -Compress -Depth 5)',
].join('\n')

/** 调用 PowerShell 执行 Windows OCR */
export function ocrImage(imagePath: string): Promise<OcrResult> {
  return new Promise((resolve) => {
    try {
      if (process.platform !== 'win32') {
        resolve({ ok: false, text: '', words: [], error: 'OCR 仅支持 Windows' })
        return
      }
      const { execFile } = require('child_process')
      execFile(
        POWERSHELL_EXE,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', OCR_PS_SCRIPT],
        {
          env: { ...process.env, XS_OCR_IMG: imagePath },
          maxBuffer: 4 * 1024 * 1024,
          timeout: 20000,
          windowsHide: true,
        },
        (err: Error | null, stdout: string) => {
          if (err) {
            resolve({ ok: false, text: '', words: [], error: String(err) })
            return
          }
          const line = (stdout || '').trim().split('\n').pop() || '{}'
          try {
            const parsed = JSON.parse(line)
            if (parsed && typeof parsed.text === 'string' && parsed.text.length > 0) {
              const words: OcrWord[] = Array.isArray(parsed.words)
                ? parsed.words.map((w: any) => ({
                    text: String(w.text || ''),
                    x: Math.round(w.x || 0),
                    y: Math.round(w.y || 0),
                    w: Math.round(w.w || 0),
                    h: Math.round(w.h || 0),
                  })).filter((w: OcrWord) => w.text.length > 0)
                : []
              resolve({ ok: true, text: parsed.text, words })
            } else {
              resolve({ ok: false, text: '', words: [], error: 'OCR 未识别到文字' })
            }
          } catch (e) {
            resolve({ ok: false, text: '', words: [], error: `OCR 输出解析失败: ${e}` })
          }
        },
      )
    } catch (e) {
      resolve({ ok: false, text: '', words: [], error: `OCR 调用失败: ${e}` })
    }
  })
}

/** 临时文件管理（OCR 需要文件路径） */
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

export function writeOcrTempImage(base64: string): string | null {
  try {
    const dir = join(tmpdir(), 'xuanshu-ocr')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = join(dir, `ocr_${Date.now()}_${Math.floor(Math.random() * 100000)}.png`)
    const data = base64.includes(',') ? base64.split(',')[1] : base64
    writeFileSync(path, Buffer.from(data, 'base64'))
    return path
  } catch (e) {
    logger.error('[OCR] 写入临时图片失败:', e)
    return null
  }
}

export const ocrEngine = {
  /** 对 base64 截图执行本地 OCR；返回识别结果（失败时 ok=false） */
  async recognize(base64: string): Promise<OcrResult> {
    const imgPath = writeOcrTempImage(base64)
    if (!imgPath) return { ok: false, text: '', words: [], error: '临时图片写入失败' }
    try {
      return await ocrImage(imgPath)
    } finally {
      try { require('fs').unlinkSync(imgPath) } catch { /* 清理失败忽略 */ }
    }
  },
}
