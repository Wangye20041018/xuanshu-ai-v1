const { createCanvas } = require('canvas')
const fs = require('fs')
const path = require('path')

function drawTaiji(size, outputPath) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  
  const center = size / 2
  const radius = size / 2 - 2
  
  ctx.clearRect(0, 0, size, size)
  
  ctx.save()
  ctx.beginPath()
  ctx.arc(center, center, radius, 0, Math.PI * 2)
  ctx.clip()
  
  const gradient = ctx.createLinearGradient(0, 0, 0, size)
  gradient.addColorStop(0, '#e8e8e8')
  gradient.addColorStop(1, '#c0c0c0')
  
  ctx.fillStyle = '#f5f5f5'
  ctx.fillRect(0, 0, size, size)
  
  ctx.fillStyle = '#1a1a1a'
  ctx.beginPath()
  ctx.arc(center, center, radius, Math.PI * 1.5, Math.PI * 0.5, true)
  ctx.fill()
  
  ctx.fillStyle = '#1a1a1a'
  ctx.beginPath()
  ctx.arc(center, center + radius / 2, radius / 2, 0, Math.PI * 2)
  ctx.fill()
  
  ctx.fillStyle = '#f5f5f5'
  ctx.beginPath()
  ctx.arc(center, center - radius / 2, radius / 2, 0, Math.PI * 2)
  ctx.fill()
  
  ctx.fillStyle = '#f5f5f5'
  ctx.beginPath()
  ctx.arc(center, center - radius / 2, radius / 6, 0, Math.PI * 2)
  ctx.fill()
  
  ctx.fillStyle = '#1a1a1a'
  ctx.beginPath()
  ctx.arc(center, center + radius / 2, radius / 6, 0, Math.PI * 2)
  ctx.fill()
  
  ctx.restore()
  
  ctx.strokeStyle = 'rgba(0,0,0,0.2)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(center, center, radius - 1, 0, Math.PI * 2)
  ctx.stroke()
  
  const buffer = canvas.toBuffer('image/png')
  fs.writeFileSync(outputPath, buffer)
  console.log(`Generated: ${outputPath} (${size}x${size})`)
}

const iconDir = path.join(__dirname, '../resources/icons')

if (!fs.existsSync(iconDir)) {
  fs.mkdirSync(iconDir, { recursive: true })
}

const sizes = [16, 32, 48, 64, 128, 256, 512]

for (const size of sizes) {
  drawTaiji(size, path.join(iconDir, `icon-${size}.png`))
}

console.log('All icons generated!')
