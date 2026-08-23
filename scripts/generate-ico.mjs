import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function createICO(pngPaths, outputPath) {
  const pngBuffers = pngPaths.map(p => fs.readFileSync(p))
  
  const headerSize = 6
  const entrySize = 16
  const numImages = pngBuffers.length
  
  let dataOffset = headerSize + entrySize * numImages
  
  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(numImages, 4)
  
  const entries = []
  for (let i = 0; i < numImages; i++) {
    const pngBuffer = pngBuffers[i]
    const size = pngBuffer.length
    
    const entry = Buffer.alloc(entrySize)
    
    let width = 0
    let height = 0
    
    if (pngBuffer[0] === 0x89 && pngBuffer[1] === 0x50 && pngBuffer[2] === 0x4E && pngBuffer[3] === 0x47) {
      width = pngBuffer.readUInt32BE(16)
      height = pngBuffer.readUInt32BE(20)
    }
    
    entry[0] = width >= 256 ? 0 : width
    entry[1] = height >= 256 ? 0 : height
    entry[2] = 0
    entry[3] = 0
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(size, 8)
    entry.writeUInt32LE(dataOffset, 12)
    
    entries.push(entry)
    dataOffset += size
  }
  
  const parts = [header, ...entries, ...pngBuffers]
  const icoBuffer = Buffer.concat(parts)
  
  fs.writeFileSync(outputPath, icoBuffer)
  console.log(`Generated ICO: ${outputPath} (${icoBuffer.length} bytes)`)
}

const iconDir = path.join(__dirname, '../resources/icons')
const sizes = [256, 128, 64, 48, 32, 16]
const pngPaths = sizes.map(s => path.join(iconDir, `icon-${s}.png`))

createICO(pngPaths, path.join(iconDir, 'icon.ico'))

console.log('ICO generation complete!')
