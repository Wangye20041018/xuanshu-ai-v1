import { logger } from '../../shared/logger'
import { nomicEmbedder } from '../context-manager/embedder'
const EMBEDDING_MODEL = 'sentence-transformers/all-MiniLM-L6-v2'
const EMBEDDING_URL = 'http://localhost:11434/api/embeddings'
/** 向量库统一使用 384 维（兼容既有索引），nomic-embed 768 维截取前 384 维 */
const EMBEDDING_DIMENSIONS = 384
const OLLAMA_TIMEOUT_MS = 3000

export interface EmbeddingResult {
  embedding: number[]
  dimensions: number
}

/** 首选：本地 nomic-embed.gguf（llama-cpp-python），失败返回 null 走降级 */
async function tryNomicEmbedding(text: string): Promise<EmbeddingResult | null> {
  try {
    const vector = await nomicEmbedder.embed(text)
    if (!vector || vector.length === 0) return null
    const embedding = vector.slice(0, EMBEDDING_DIMENSIONS)
    return { embedding, dimensions: EMBEDDING_DIMENSIONS }
  } catch (e) {
    logger.warn(`[RAG] NomicEmbedder 不可用，降级 Ollama: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

export async function getEmbedding(text: string): Promise<EmbeddingResult> {
  const nomic = await tryNomicEmbedding(text)
  if (nomic) return nomic

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS)
    const response = await fetch(EMBEDDING_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        prompt: text
      }),
      signal: controller.signal
    })
    clearTimeout(timer)

    if (response.ok) {
      const data = await response.json()
      return {
        embedding: data.embedding,
        dimensions: data.embedding.length
      }
    }

    const reason = `HTTP ${response.status}`
    logger.error(`Failed to get embedding from Ollama: ${reason}`)
    return {
      embedding: generateFallbackEmbedding(text, reason),
      dimensions: EMBEDDING_DIMENSIONS
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logger.error('Failed to get embedding from Ollama:', error)
    return {
      embedding: generateFallbackEmbedding(text, reason),
      dimensions: EMBEDDING_DIMENSIONS
    }
  }
}

export async function getEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
  const results: EmbeddingResult[] = []

  for (const text of texts) {
    const result = await getEmbedding(text)
    results.push(result)
  }

  return results
}

function generateFallbackEmbedding(text: string, reason: string = 'unknown'): number[] {
  logger.warn(`Using fallback embedding for "${text.substring(0, 50)}..." — reason: ${reason}`)
  const dimensions = 384
  const embedding = new Array(dimensions).fill(0)

  const words = text.toLowerCase().split(/\s+/)
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    for (let j = 0; j < word.length; j++) {
      const charIndex = (i + j) % dimensions
      embedding[charIndex] += word.charCodeAt(j) / 255
    }
  }

  let magnitude = 0
  for (let i = 0; i < dimensions; i++) {
    magnitude += embedding[i] * embedding[i]
  }
  magnitude = Math.sqrt(magnitude)

  if (magnitude > 0) {
    for (let i = 0; i < dimensions; i++) {
      embedding[i] /= magnitude
    }
  }

  return embedding
}

export function splitText(text: string, chunkSize: number = 500, overlap: number = 50): string[] {
  const chunks: string[] = []
  const sentences = text.split(/[。！？；\n]+/)

  let currentChunk = ''

  for (const sentence of sentences) {
    const trimmed = sentence.trim()
    if (!trimmed) continue

    if (currentChunk.length + trimmed.length + 1 <= chunkSize) {
      currentChunk += (currentChunk ? '。' : '') + trimmed
    } else {
      if (currentChunk) {
        chunks.push(currentChunk)
      }

      if (trimmed.length <= chunkSize) {
        currentChunk = trimmed
      } else {
        const words = trimmed.split(/\s+/)
        currentChunk = ''

        for (const word of words) {
          if (currentChunk.length + word.length + 1 <= chunkSize) {
            currentChunk += (currentChunk ? ' ' : '') + word
          } else {
            if (currentChunk) {
              chunks.push(currentChunk)
            }
            currentChunk = word.slice(0, chunkSize)
          }
        }
      }
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk)
  }

  // Apply overlap between consecutive chunks
  if (overlap > 0 && chunks.length > 1) {
    for (let i = 1; i < chunks.length; i++) {
      const prevEnd = chunks[i - 1].slice(-overlap)
      chunks[i] = prevEnd + chunks[i]
    }
  }

  return chunks
}
