/**
 * decimate-glb.cjs — GLB 模型减面工具
 * 使用 Three.js SimplifyModifier 将高面数模型降到目标面数
 * 用法: node decimate-glb.cjs <input.glb> [output.glb] [targetFaces]
 */
const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')
const THREE = require('three')

// DOM 环境
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>')
global.window = dom.window
global.document = dom.window.document
global.navigator = { userAgent: 'node.js' }
global.XMLHttpRequest = dom.window.XMLHttpRequest
global.Blob = dom.window.Blob
global.URL = dom.window.URL
global.self = global
global.HTMLCanvasElement = dom.window.HTMLCanvasElement
global.Image = dom.window.Image
if (!global.window.URL.createObjectURL) {
  global.window.URL.createObjectURL = function (b) { return 'blob:' + Math.random().toString(36).slice(2) }
  global.window.URL.revokeObjectURL = function () { }
}
// Polyfill FileReader
const _OriginalBlob = global.Blob
global.Blob = function(parts, options) {
  const blob = new _OriginalBlob(parts, options)
  blob._rawParts = parts
  return blob
}
global.Blob.prototype = _OriginalBlob.prototype
global.FileReader = class FileReader {
  constructor() {
    this.onloadend = null
    this.onload = null
    this.onerror = null
    this.result = null
  }
  readAsArrayBuffer(blob) {
    try {
      const parts = blob._rawParts || []
      let buffers = []
      for (const p of parts) {
        if (p instanceof ArrayBuffer) buffers.push(Buffer.from(p))
        else if (Buffer.isBuffer(p)) buffers.push(p)
        else if (p instanceof Uint8Array) buffers.push(Buffer.from(p.buffer, p.byteOffset, p.byteLength))
        else if (typeof p === 'string') buffers.push(Buffer.from(p, 'utf-8'))
      }
      const result = Buffer.concat(buffers)
      const ab = result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength)
      setImmediate(() => {
        this.result = ab
        if (this.onloadend) this.onloadend({ target: this })
        if (this.onload) this.onload({ target: this })
      })
    } catch (e) {
      console.error('FileReader error:', e.message)
      setImmediate(() => {
        if (this.onerror) this.onerror(e)
        if (this.onloadend) this.onloadend({ target: this })
      })
    }
  }
}

const { GLTFLoader } = require('three/examples/jsm/loaders/GLTFLoader.js')
const { GLTFExporter } = require('three/examples/jsm/exporters/GLTFExporter.js')
const { SimplifyModifier } = require('three/examples/jsm/modifiers/SimplifyModifier.js')

async function main(inputPath, outputPath, targetFaces) {
  if (!fs.existsSync(inputPath)) {
    console.error('文件不存在:', inputPath)
    process.exit(1)
  }

  if (!outputPath) {
    outputPath = inputPath.replace(/\.glb$/i, '_decimated.glb')
  }

  targetFaces = targetFaces || 50000

  console.log('=== GLB 减面工具 ===')
  console.log(`输入: ${inputPath}`)
  console.log(`输出: ${outputPath}`)
  console.log(`目标面数: ${targetFaces.toLocaleString()}`)

  // 1. 加载GLB
  console.log('\n[1/4] 加载GLB...')
  const buffer = fs.readFileSync(inputPath)
  const arrayBuffer = new Uint8Array(buffer).buffer

  const loader = new GLTFLoader()
  const gltf = await new Promise((resolve, reject) => {
    loader.parse(arrayBuffer, '', resolve, reject)
  })

  // 2. 统计所有mesh
  console.log('\n[2/4] 统计Mesh...')
  const meshes = []
  let totalOriginalFaces = 0
  gltf.scene.traverse((child) => {
    if (child.isMesh) {
      const geo = child.geometry
      const faceCount = geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3
      totalOriginalFaces += faceCount
      meshes.push({ mesh: child, faceCount })
    }
  })

  console.log(`  找到 ${meshes.length} 个Mesh`)
  console.log(`  原始总面数: ${totalOriginalFaces.toLocaleString()}`)
  meshes.forEach((m, i) => {
    console.log(`    Mesh[${i}]: ${m.mesh.name || '(unnamed)'}, ${m.faceCount.toLocaleString()} 面`)
  })

  // 3. 按比例减面
  console.log(`\n[3/4] 减面 (目标: ${targetFaces.toLocaleString()})...`)
  const ratio = targetFaces / totalOriginalFaces
  const modifier = new SimplifyModifier()

  let totalNewFaces = 0
  for (const m of meshes) {
    const targetForThis = Math.max(500, Math.round(m.faceCount * ratio))
    const removeCount = Math.max(0, m.faceCount - targetForThis)
    const geo = m.mesh.geometry

    if (removeCount > 0) {
      try {
        // SimplifyModifier.modify(geometry, count) — count是要移除的顶点数
        const newGeo = modifier.modify(geo, Math.floor(removeCount))
        const newFaceCount = newGeo.index ? newGeo.index.count / 3 : newGeo.attributes.position.count / 3
        m.mesh.geometry = newGeo
        m.mesh.name = (m.mesh.name || 'part') + '_decimated'
        totalNewFaces += newFaceCount
        console.log(`    ${m.mesh.name}: ${m.faceCount.toLocaleString()} → ${newFaceCount.toLocaleString()} 面`)
        geo.dispose()
      } catch (e) {
        console.log(`    ${m.mesh.name}: 跳过 (${e.message})`)
        totalNewFaces += m.faceCount
      }
    } else {
      totalNewFaces += m.faceCount
    }
  }

  console.log(`  新总面数: ${totalNewFaces.toLocaleString()}`)

  // 4. 导出GLB
  console.log('\n[4/4] 导出GLB...')
  const exporter = new GLTFExporter()

  const exportTimeout = setTimeout(() => {
    console.error('❌ GLB导出超时（120秒）')
    process.exit(1)
  }, 120000)

  try {
    const glbData = await new Promise((resolve, reject) => {
      try {
        exporter.parse(gltf.scene, (result) => {
          clearTimeout(exportTimeout)
          resolve(result)
        }, (err) => {
          clearTimeout(exportTimeout)
          reject(err)
        }, { binary: true, animations: [] })
      } catch (e) {
        clearTimeout(exportTimeout)
        reject(e)
      }
    })

    if (glbData instanceof ArrayBuffer) {
      fs.writeFileSync(outputPath, Buffer.from(glbData))
      const sizeKB = (glbData.byteLength / 1024).toFixed(1)
      const sizeMB = (glbData.byteLength / 1024 / 1024).toFixed(1)
      console.log(`✅ 导出成功: ${outputPath} (${sizeKB} KB / ${sizeMB} MB)`)
    } else {
      console.error('导出失败: 非ArrayBuffer, 类型=' + (typeof glbData))
      process.exit(1)
    }
  } catch (err) {
    clearTimeout(exportTimeout)
    console.error('导出失败:', err.message)
    process.exit(1)
  }
}

const input = process.argv[2]
const output = process.argv[3]
const targetFaces = parseInt(process.argv[4]) || 50000

if (!input) {
  console.log('用法: node decimate-glb.cjs <input.glb> [output.glb] [targetFaces]')
  process.exit(1)
}

main(input, output, targetFaces).catch(err => {
  console.error('失败:', err.message)
  console.error(err.stack)
  process.exit(1)
})