import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function createPNG(width, height, drawPixel) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  
  function crc32(data) {
    let crc = 0xFFFFFFFF
    const table = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
      }
      table[n] = c
    }
    for (let i = 0; i < data.length; i++) {
      crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8)
    }
    return (crc ^ 0xFFFFFFFF) >>> 0
  }
  
  function createChunk(type, data) {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const typeBuffer = Buffer.from(type)
    const crcData = Buffer.concat([typeBuffer, data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(crcData), 0)
    return Buffer.concat([length, typeBuffer, data, crc])
  }
  
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  
  const rawData = []
  for (let y = 0; y < height; y++) {
    rawData.push(0)
    for (let x = 0; x < width; x++) {
      const pixel = drawPixel(x, y, width, height)
      rawData.push(pixel.r, pixel.g, pixel.b, pixel.a)
    }
  }
  
  const rawBuffer = Buffer.from(rawData)
  
  return new Promise((resolve, reject) => {
    zlib.deflate(rawBuffer, (err, compressed) => {
      if (err) return reject(err)
      const ihdrChunk = createChunk('IHDR', ihdr)
      const idatChunk = createChunk('IDAT', compressed)
      const iendChunk = createChunk('IEND', Buffer.alloc(0))
      resolve(Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]))
    })
  })
}

async function drawTaiji(size, outputPath) {
  const center = size / 2
  const radius = size / 2 - 1
  
  const png = await createPNG(size, size, (x, y, w, h) => {
    const dx = x - center + 0.5
    const dy = y - center + 0.5
    const dist = Math.sqrt(dx * dx + dy * dy)
    
    if (dist > radius) {
      return { r: 0, g: 0, b: 0, a: 0 }
    }
    
    const edge = radius - dist
    const edgeAlpha = edge < 1 ? edge : 1
    
    const inLeft = dx < 0
    
    const smallRadius = radius / 2
    const topDotDist = Math.sqrt(dx * dx + (dy + radius / 2) * (dy + radius / 2))
    const bottomDotDist = Math.sqrt(dx * dx + (dy - radius / 2) * (dy - radius / 2))
    
    const inTopWhite = topDotDist < smallRadius
    const inBottomBlack = bottomDotDist < smallRadius
    
    const smallDotRadius = radius / 6
    const topSmallDotDist = Math.sqrt(dx * dx + (dy + radius / 2) * (dy + radius / 2))
    const bottomSmallDotDist = Math.sqrt(dx * dx + (dy - radius / 2) * (dy - radius / 2))
    
    const inTopBlackDot = topSmallDotDist < smallDotRadius
    const inBottomWhiteDot = bottomSmallDotDist < smallDotRadius
    
    let isBlack = inLeft
    
    if (inTopWhite) isBlack = false
    if (inBottomBlack) isBlack = true
    
    if (inTopBlackDot) isBlack = true
    if (inBottomWhiteDot) isBlack = false
    
    if (isBlack) {
      return { r: 26, g: 26, b: 26, a: Math.round(edgeAlpha * 255) }
    } else {
      return { r: 245, g: 245, b: 245, a: Math.round(edgeAlpha * 255) }
    }
  })
  
  fs.writeFileSync(outputPath, png)
  console.log(`Generated: ${outputPath} (${size}x${size})`)
}

async function main() {
  const iconDir = path.join(__dirname, '../resources/icons')
  
  if (!fs.existsSync(iconDir)) {
    fs.mkdirSync(iconDir, { recursive: true })
  }
  
  const sizes = [16, 32, 48, 64, 128, 256]
  
  for (const size of sizes) {
    await drawTaiji(size, path.join(iconDir, `icon-${size}.png`))
  }
  
  console.log('All icons generated!')
}

main().catch(console.error)
