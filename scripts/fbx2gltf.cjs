/**
 * FBX → GLB 转换脚本 (Node.js + Three.js)
 * 用法: node fbx2gltf.cjs <input.fbx> [output.glb]
 */
const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')
const THREE = require('three')

// 设置 DOM 环境
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

// Polyfill URL.createObjectURL (jsdom 可能不支持)
if (!global.window.URL.createObjectURL) {
  global.window.URL.createObjectURL = function(blob) {
    return 'blob:nodejs/' + Math.random().toString(36).slice(2)
  }
  global.window.URL.revokeObjectURL = function() {}
}

// 加载 FBXLoader
const { FBXLoader } = require('three/examples/jsm/loaders/FBXLoader.js')
const { GLTFExporter } = require('three/examples/jsm/exporters/GLTFExporter.js')

async function convert(inputPath, outputPath) {
  if (!fs.existsSync(inputPath)) {
    console.error('❌ 输入文件不存在:', inputPath)
    process.exit(1)
  }

  if (!outputPath) {
    outputPath = inputPath.replace(/\.fbx$/i, '.glb')
  }

  console.log(`📂 读取: ${inputPath}`)
  const buffer = fs.readFileSync(inputPath)

  const loader = new FBXLoader()

  try {
    // 直接使用 parse 方法（Node.js 环境不支持 URL.createObjectURL）
    // 构造干净的 ArrayBuffer
    const arrayBuffer = new Uint8Array(buffer).buffer
    const group = loader.parse(arrayBuffer, path.dirname(inputPath))

    console.log(`✅ 加载成功, 子对象: ${group.children.length}`)
    let meshCount = 0
    let boneCount = 0
    group.traverse((child) => {
      if (child.isMesh) {
        meshCount++
        console.log(`   Mesh: ${child.name || '(unnamed)'}, triangles: ${child.geometry.index ? Math.floor(child.geometry.index.count / 3) : Math.floor(child.geometry.attributes.position.count / 3)}`)
      }
      if (child.isBone || child.type === 'Bone') {
        boneCount++
        console.log(`   Bone: ${child.name}`)
      }
    })
    console.log(`   总计: ${meshCount} meshes, ${boneCount} bones`)

    // 去掉所有纹理引用（Node.js 环境无法加载嵌入的FBX纹理）
    group.traverse((child) => {
      if (child.isMesh && child.material) {
        const materials = Array.isArray(child.material) ? child.material : [child.material]
        materials.forEach(mat => {
          // 保存基本颜色
          if (mat.color) {
            const c = mat.color
            mat.roughness = mat.roughness || 0.7
            mat.metalness = mat.metalness || 0.0
          }
          // 清除所有纹理引用
          mat.map = null
          mat.normalMap = null
          mat.roughnessMap = null
          mat.metalnessMap = null
          mat.aoMap = null
          mat.emissiveMap = null
          mat.bumpMap = null
          mat.alphaMap = null
          mat.envMap = null
          mat.lightMap = null
        })
      }
    })

    // 导出 GLB
    const exporter = new GLTFExporter()
    const glbData = await new Promise((resolve, reject) => {
      exporter.parse(group, resolve, reject, { binary: true })
    })

    // 写出
    if (glbData instanceof ArrayBuffer) {
      fs.writeFileSync(outputPath, Buffer.from(glbData))
      const sizeKB = (glbData.byteLength / 1024).toFixed(1)
      console.log(`✅ 导出成功: ${outputPath} (${sizeKB} KB)`)
    } else {
      // JSON 格式
      const jsonStr = JSON.stringify(glbData)
      const jsonPath = outputPath.replace(/\.glb$/, '.gltf')
      fs.writeFileSync(jsonPath, jsonStr)
      console.log(`✅ 导出成功 (glTF JSON): ${jsonPath}`)
    }
  } catch (err) {
    console.error('❌ 转换失败:', err.message)
    console.error(err.stack)
    process.exit(1)
  }
}

const input = process.argv[2]
const output = process.argv[3]

if (!input) {
  console.log('用法: node fbx2gltf.cjs <input.fbx> [output.glb]')
  process.exit(1)
}

convert(input, output)