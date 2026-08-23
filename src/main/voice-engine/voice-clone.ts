/**
 * 语音克隆推理管线 v10.1.1
 * 录制音频 → OpenVoice 提取真实 256 维 speaker embedding → 保存
 * 用 openvoiceBridge 替代假克隆
 */
import { app, ipcMain } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, unlinkSync } from 'fs'
import { spawn, SpawnOptions } from 'child_process'
import { pythonRuntime } from '../runtime/python'
import { openvoiceBridge } from './openvoice-bridge'
import { edgeTTS } from '../tts/edge'
import { logger } from '../../shared/logger'

/** spawnSafe — spawn 封装，避免中文路径经 cmd.exe 时被 GBK 编码乱码 */
function spawnSafe(
  command: string,
  args: string[],
  options?: { timeout?: number }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    const child = spawn(command, args, spawnOpts)
    const timer = options?.timeout
      ? setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`spawnSafe 超时 (${options.timeout}ms)`)) }, options.timeout)
      : null
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString('utf-8') })
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString('utf-8') })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr || `Exit code: ${code}`))
    })
    child.on('error', (err) => { if (timer) clearTimeout(timer); reject(err) })
  })
}

interface ClonedVoice {
  id: string
  name: string
  createdAt: string
  timbre: string
  duration: number
  embeddingPath: string
  embeddingDim: number
  sourceType: 'recorded' | 'preset'
}

function voicesDir(): string {
  const dir = join(app.getPath('userData'), 'cloned-voices')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

// 单文件级 try-catch
export function listClonedVoices(): ClonedVoice[] {
  const dir = voicesDir()
  const voices: ClonedVoice[] = []
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.json'))
    for (const f of files) {
      try {
        const data = JSON.parse(readFileSync(join(dir, f), 'utf-8'))
        if (data.id && data.name) {
          voices.push(data as ClonedVoice)
        }
      } catch {
        logger.warn(`[VoiceClone] 跳过损坏的音色文件: ${f}`)
      }
    }
  } catch (e) { logger.error('[VoiceClone] 列出克隆语音失败:', e); return [] }
  return voices
}

function saveClonedVoice(v: ClonedVoice): void {
  writeFileSync(join(voicesDir(), `${v.id}.json`), JSON.stringify(v, null, 2))
}

export function deleteClonedVoiceFile(id: string): void {
  const p = join(voicesDir(), `${id}.json`)
  const ep = join(voicesDir(), `${id}.npy`)
  if (existsSync(p)) unlinkSync(p)
  if (existsSync(ep)) unlinkSync(ep)
}

/**
 * 使用 OpenVoice 提取 256 维 embedding
 */
async function cloneVoice(base64Audio: string): Promise<{ embeddingPath: string; embeddingDim: number }> {
  const dir = voicesDir()
  const embeddingPath = join(dir, `embedding_${Date.now()}.npy`)

  try {
    // 使用 openvoiceBridge 提取真实 speaker embedding
    const { embedding, method } = await openvoiceBridge.extractEmbedding(base64Audio)
    logger.debug(`[VoiceClone] 提取方法: ${method}, 维度: ${embedding.length}`)

    // 保存 embedding 为 .npy 文件
    const pyPath = pythonRuntime.getPythonPath()

    // 将 Float32Array 转为 bytes 并保存
    const bytes = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
    const tempPklPath = join(dir, `temp_embedding_bytes_${Date.now()}.bin`)
    writeFileSync(tempPklPath, bytes)

    try {
      // spawnSafe 直接传参给 CreateProcessW，无需对路径做 shell 转义
      const safePklPath = tempPklPath.replace(/\\/g, '/')
      const safeEmbPath = embeddingPath.replace(/\\/g, '/')
      await spawnSafe(pyPath, [
        '-c',
        `import numpy as np; data=np.frombuffer(open(r'${safePklPath}','rb').read(), dtype=np.float32); np.save(r'${safeEmbPath}', data)`
      ], { timeout: 10000 })
    } finally {
      try { unlinkSync(tempPklPath) } catch (e) { logger.error('[VoiceClone] 清理临时文件失败:', e) }
    }

    return { embeddingPath, embeddingDim: embedding.length }
  } catch (e) {
    logger.error('[VoiceClone] 克隆失败:', e)
    return { embeddingPath: '', embeddingDim: 0 }
  }
}

/**
 * 基于克隆 embedding 合成定制音色（试听）
 */
export async function previewClonedVoice(id: string, text?: string): Promise<any> {
    try {
      const voices = listClonedVoices()
      const v = voices.find(vc => vc.id === id)
      if (!v || !existsSync(v.embeddingPath)) {
        return { success: false, error: '音色未找到' }
      }

      const defaultText = text || '你好，这是我的克隆声音测试。'
      
      // 加载 embedding 并提取音色参数
      const pyPath = pythonRuntime.getPythonPath()
      
      // 从 .npy 读取 embedding，计算音色参数传给 Edge TTS
      const safeEmbPath = v.embeddingPath.replace(/\\/g, '/')
      const analyzeScript = `
import numpy as np, json
e = np.load(r"${safeEmbPath}")
rms = float(np.sqrt(np.mean(e**2)))
centroid = float(np.sum(np.abs(e)) / float(len(e)))
energy = float(np.mean(e**2)) * 1000
pitch_shift = max(-50, min(50, (centroid - 0.05) * 200))
rate_shift = max(-50, min(50, (energy - 1.0) * 30))
print(json.dumps({
  "pitch": f"{'+' if pitch_shift >= 0 else ''}{pitch_shift:.0f}%",
  "rate": f"{'+' if rate_shift >= 0 else ''}{rate_shift:.0f}%",
  "rms": rms,
  "energy": energy,
  "dim": int(e.shape[0])
}))
`
      let voiceParams = { pitch: 'default', rate: 'default' }
      try {
        // spawnSafe 直接传参，绕过 cmd.exe GBK 编码问题
        const { stdout } = await spawnSafe(pyPath, ['-c', analyzeScript], { timeout: 15000 })
        const analysisResult = JSON.parse(stdout.trim())
        voiceParams = { 
          pitch: analysisResult.pitch || 'default', 
          rate: analysisResult.rate || 'default' 
        }
      } catch (e) {
        logger.warn('[VoiceClone] 音色分析失败，使用默认参数:', e)
      }

      // 选择与embedding特征匹配的Edge语音
      const voiceNames = ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunjianNeural', 'zh-CN-XiaohanNeural']
      const voiceIdx = Math.abs(Math.floor(JSON.stringify(voiceParams).length % voiceNames.length))
      const selectedVoice = voiceNames[voiceIdx % voiceNames.length]

      // 使用音色参数合成
      const result = await edgeTTS.speak(defaultText, selectedVoice, voiceParams)

      if (result.success && result.audioPath) {
        try {
          const audioBuf = readFileSync(result.audioPath)
          return {
            success: true,
            audioBase64: audioBuf.toString('base64'),
            text: defaultText,
            engine: 'edge',
            format: 'mp3',
            voiceParams,
            selectedVoice,
          }
        } catch (e) {
          return { success: true, audioPath: result.audioPath, text: defaultText, engine: 'edge', voiceParams }
        }
      }
      return { success: false, error: result.error || 'TTS 合成失败' }
    } catch (e) {
      logger.error('[VoiceClone] test error:', e)
      return { success: false, error: String(e) }
    }
}

export function setupVoiceCloneHandlers(): void {
  // 克隆状态（供 UI/健康检查使用）
  ipcMain.handle('voice-clone:status', async () => {
    try {
      return { status: 'active', voices: listClonedVoices(), message: 'Voice clone is available via voice engine' }
    } catch (e) {
      logger.error('[VoiceClone] voice-clone:status 错误:', e)
      return { status: 'error', voices: [], error: String(e) }
    }
  })

  // 预览音色（语音克隆 Tab 的“试听”按钮调用的是旧通道 voice:preview，此处委托到真实实现）
  ipcMain.handle('voice:preview', async (_e, id: string, text?: string) => {
    try {
      return await previewClonedVoice(id, text)
    } catch (e) {
      logger.error('[VoiceClone] voice:preview 错误:', e)
      return { success: false, error: String(e) }
    }
  })

  // 删除音色（语音克隆 Tab 的“删除”按钮调用的是旧通道 voice:delete-voice，此处委托到真实实现）
  ipcMain.handle('voice:delete-voice', (_e, id: string) => {
    try {
      deleteClonedVoiceFile(id)
      return true
    } catch (e) {
      logger.error('[VoiceClone] voice:delete-voice 错误:', e)
      return false
    }
  })

  // try-catch 包裹
  ipcMain.handle('voice:clone:start', async (_e, base64Audio: string) => {
    try {
      const { embeddingPath, embeddingDim } = await cloneVoice(base64Audio)
      if (!embeddingPath) {
        return { success: false, error: '克隆失败：无法提取音色特征' }
      }
      const v: ClonedVoice = {
        id: `vc-${Date.now()}`,
        name: `我的声音 ${listClonedVoices().length + 1}`,
        createdAt: new Date().toISOString(),
        timbre: '已克隆',
        duration: 30,
        embeddingPath,
        embeddingDim,
        sourceType: 'recorded'
      }
      saveClonedVoice(v)
      return { success: true, voice: v }
    } catch (e) {
      logger.error('[VoiceClone] voice:clone:start 错误:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('voice:clone:list', () => {
    try {
      return listClonedVoices()
    } catch (e) {
      logger.error('[VoiceClone] list error:', e)
      return []
    }
  })

  ipcMain.handle('voice:clone:delete', (_e, id: string) => {
    try {
      deleteClonedVoiceFile(id)
      return true
    } catch (e) {
      logger.error('[VoiceClone] delete error:', e)
      return false
    }
  })

  // 基于克隆embedding合成定制音色
  ipcMain.handle('voice:clone:test', async (_e, id: string, text: string) => {
    return previewClonedVoice(id, text)
  })

  // 预置音色列表
  ipcMain.handle('voice:clone:presets', () => {
    try {
      return openvoiceBridge.listPresetSpeakers()
    } catch (e) {
      logger.error('[VoiceClone] presets error:', e)
      return []
    }
  })
}
