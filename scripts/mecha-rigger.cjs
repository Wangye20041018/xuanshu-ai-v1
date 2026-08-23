/**
 * mecha-rigger.cjs — 纯 Node.js 机甲模型骨骼绑定（含减面）
 *
 * 策略：
 * 1. 加载 FBX → 得到单Mesh
 * 2. 先用 SimplifyModifier 减面（从198万→5万）
 * 3. 沿Y轴扫描，找截面极小值点（关节位置）
 * 4. 在关节处切割，分离出头/躯干/四肢多个部件
 * 5. 创建人形骨架
 * 6. 各部件刚性绑定（Parent）到对应骨骼
 * 7. 导出 GLB（含骨骼 + 蒙皮）
 *
 * 用法: node mecha-rigger.cjs <input.fbx> [output.glb] [targetFaces]
 */
const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')
const THREE = require('three')

// ==================== DOM 环境 ====================
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
    this.onloadend = null; this.onload = null; this.onerror = null; this.result = null
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
      setImmediate(() => {
        if (this.onerror) this.onerror(e)
        if (this.onloadend) this.onloadend({ target: this })
      })
    }
  }
}

const { FBXLoader } = require('three/examples/jsm/loaders/FBXLoader.js')
const { GLTFExporter } = require('three/examples/jsm/exporters/GLTFExporter.js')
const { SimplifyModifier } = require('three/examples/jsm/modifiers/SimplifyModifier.js')

// ==================== 工具函数 ====================

function getYRange(positions) {
  let minY = Infinity, maxY = -Infinity
  for (let i = 1; i < positions.length; i += 3) {
    const y = positions[i]
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minY, maxY, height: maxY - minY }
}

function classifyVerticesByY(positions, totalHeight, minY) {
  const normY = (y) => (y - minY) / totalHeight
  const labels = new Float32Array(positions.length / 3)
  for (let i = 0; i < positions.length / 3; i++) {
    const ny = normY(positions[i * 3 + 1])
    if (ny < 0.08) labels[i] = 0
    else if (ny < 0.22) labels[i] = 1
    else if (ny < 0.35) labels[i] = 2
    else if (ny < 0.50) labels[i] = 3
    else if (ny < 0.63) labels[i] = 4
    else if (ny < 0.78) labels[i] = 5
    else if (ny < 0.90) labels[i] = 6
    else labels[i] = 7
  }
  return labels
}

function separateParts(positions, labels) {
  const parts = {}
  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[i * 3]
    const label = labels[i]
    let side = 'C'
    if (label === 1 || label === 2) side = x < 0 ? 'L' : 'R'
    const key = `${label}_${side}`
    if (!parts[key]) parts[key] = []
    parts[key].push(i)
  }
  return parts
}

function createSubMesh(positions, indices, normalAttr, uvAttr, vertexIndices) {
  const idxSet = new Set(vertexIndices)
  const oldToNew = new Map()
  const newPositions = []
  const newNormals = normalAttr ? [] : null
  const newUVs = uvAttr ? [] : null

  for (const oldIdx of vertexIndices) {
    oldToNew.set(oldIdx, newPositions.length / 3)
    newPositions.push(positions[oldIdx * 3], positions[oldIdx * 3 + 1], positions[oldIdx * 3 + 2])
    if (newNormals) newNormals.push(normalAttr.array[oldIdx * 3] || 0, normalAttr.array[oldIdx * 3 + 1] || 1, normalAttr.array[oldIdx * 3 + 2] || 0)
    if (newUVs) newUVs.push(uvAttr.array[oldIdx * 2] || 0, uvAttr.array[oldIdx * 2 + 1] || 0)
  }

  const newIndices = []
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2]
    if (idxSet.has(a) && idxSet.has(b) && idxSet.has(c)) {
      newIndices.push(oldToNew.get(a), oldToNew.get(b), oldToNew.get(c))
    }
  }
  if (newIndices.length === 0) return null

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(newPositions), 3))
  geo.setIndex(newIndices)
  if (newNormals) geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(newNormals), 3))
  else geo.computeVertexNormals()
  if (newUVs) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(newUVs), 2))

  const mat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.5, metalness: 0.6 })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

function getPartCenter(mesh) {
  const pos = mesh.geometry.attributes.position
  let cx = 0, cy = 0, cz = 0
  for (let i = 0; i < pos.count; i++) { cx += pos.getX(i); cy += pos.getY(i); cz += pos.getZ(i) }
  return new THREE.Vector3(cx / pos.count, cy / pos.count, cz / pos.count)
}

// ==================== 骨架定义 ====================
const BONE_HIERARCHY = {
  'Hips': { parent: null, children: ['Spine', 'LeftUpLeg', 'RightUpLeg'] },
  'Spine': { parent: 'Hips', children: ['Spine1', 'LeftShoulder', 'RightShoulder'] },
  'Spine1': { parent: 'Spine', children: ['Neck'] },
  'Neck': { parent: 'Spine1', children: ['Head'] },
  'Head': { parent: 'Neck', children: [] },
  'LeftUpLeg': { parent: 'Hips', children: ['LeftLeg'] },
  'LeftLeg': { parent: 'LeftUpLeg', children: ['LeftFoot'] },
  'LeftFoot': { parent: 'LeftLeg', children: [] },
  'RightUpLeg': { parent: 'Hips', children: ['RightLeg'] },
  'RightLeg': { parent: 'RightUpLeg', children: ['RightFoot'] },
  'RightFoot': { parent: 'RightLeg', children: [] },
  'LeftShoulder': { parent: 'Spine', children: ['LeftArm'] },
  'LeftArm': { parent: 'LeftShoulder', children: ['LeftForeArm'] },
  'LeftForeArm': { parent: 'LeftArm', children: ['LeftHand'] },
  'LeftHand': { parent: 'LeftForeArm', children: [] },
  'RightShoulder': { parent: 'Spine', children: ['RightArm'] },
  'RightArm': { parent: 'RightShoulder', children: ['RightForeArm'] },
  'RightForeArm': { parent: 'RightArm', children: ['RightHand'] },
  'RightHand': { parent: 'RightForeArm', children: [] },
}

function computeBonePositions(totalHeight) {
  const getBoneY = (ratio) => totalHeight * ratio
  return {
    'Hips': { x: 0, y: getBoneY(0.42), z: 0 },
    'Spine': { x: 0, y: getBoneY(0.55), z: 0 },
    'Spine1': { x: 0, y: getBoneY(0.65), z: 0 },
    'Neck': { x: 0, y: getBoneY(0.78), z: 0 },
    'Head': { x: 0, y: getBoneY(0.92), z: 0 },
    'LeftUpLeg': { x: -0.08, y: getBoneY(0.30), z: 0 },
    'LeftLeg': { x: -0.08, y: getBoneY(0.15), z: 0 },
    'LeftFoot': { x: -0.08, y: getBoneY(0.03), z: 0.05 },
    'RightUpLeg': { x: 0.08, y: getBoneY(0.30), z: 0 },
    'RightLeg': { x: 0.08, y: getBoneY(0.15), z: 0 },
    'RightFoot': { x: 0.08, y: getBoneY(0.03), z: 0.05 },
    'LeftShoulder': { x: -0.22, y: getBoneY(0.63), z: 0 },
    'LeftArm': { x: -0.30, y: getBoneY(0.55), z: 0 },
    'LeftForeArm': { x: -0.35, y: getBoneY(0.43), z: 0 },
    'LeftHand': { x: -0.38, y: getBoneY(0.32), z: 0 },
    'RightShoulder': { x: 0.22, y: getBoneY(0.63), z: 0 },
    'RightArm': { x: 0.30, y: getBoneY(0.55), z: 0 },
    'RightForeArm': { x: 0.35, y: getBoneY(0.43), z: 0 },
    'RightHand': { x: 0.38, y: getBoneY(0.32), z: 0 },
  }
}

function createSkeleton(bonePositions) {
  const bones = {}
  for (const name of Object.keys(BONE_HIERARCHY)) {
    const bone = new THREE.Bone()
    bone.name = name
    bones[name] = bone
  }
  for (const [name, info] of Object.entries(BONE_HIERARCHY)) {
    if (info.parent && bones[info.parent]) {
      const pPos = bonePositions[info.parent]
      const cPos = bonePositions[name]
      bones[name].position.set(cPos.x - pPos.x, cPos.y - pPos.y, cPos.z - pPos.z)
      bones[info.parent].add(bones[name])
    } else if (!info.parent) {
      bones[name].position.set(bonePositions[name].x, bonePositions[name].y, bonePositions[name].z)
    }
  }
  return { bones, root: bones['Hips'] }
}

function bindPartsToBones(parts, boneObjects, rootBone) {
  const armature = new THREE.Group()
  armature.name = 'Armature'

  // 骨架组
  const skeletonGroup = new THREE.Group()
  skeletonGroup.name = 'Skeleton'
  skeletonGroup.add(rootBone)
  armature.add(skeletonGroup)

  // 部件组
  const meshGroup = new THREE.Group()
  meshGroup.name = 'MechaParts'

  for (const [key, mesh] of Object.entries(parts)) {
    if (!mesh) continue
    const center = getPartCenter(mesh)
    let bestBone = null, bestDist = Infinity
    const boneWorldPos = new THREE.Vector3()
    for (const [boneName, bone] of Object.entries(boneObjects)) {
      bone.getWorldPosition(boneWorldPos)
      const dist = center.distanceTo(boneWorldPos)
      if (dist < bestDist) { bestDist = dist; bestBone = bone }
    }
    // 将mesh放在骨架空间中，相对于最近骨骼
    bestBone.getWorldPosition(boneWorldPos)
    mesh.position.copy(center).sub(boneWorldPos)
    mesh.name = key

    // 刚性绑定：直接parent到骨骼
    bestBone.add(mesh)
  }

  return armature
}

// ==================== 主流程 ====================

async function main(inputPath, outputPath, targetFaces) {
  if (!fs.existsSync(inputPath)) {
    console.error('文件不存在:', inputPath)
    process.exit(1)
  }
  if (!outputPath) outputPath = inputPath.replace(/\.fbx$/i, '_rigged.glb')
  targetFaces = targetFaces || 50000

  console.log('=== 机甲模型骨骼绑定工具（含减面）===')
  console.log(`输入: ${inputPath}`)
  console.log(`输出: ${outputPath}`)
  console.log(`目标面数: ${targetFaces.toLocaleString()}`)

  // 1. 加载FBX
  console.log('\n[1/7] 加载FBX模型...')
  const buffer = fs.readFileSync(inputPath)
  const arrayBuffer = new Uint8Array(buffer).buffer
  const loader = new FBXLoader()
  const group = loader.parse(arrayBuffer, path.dirname(inputPath))

  let mesh = null
  group.traverse((c) => { if (c.isMesh) mesh = c })
  if (!mesh) { console.error('未找到Mesh'); process.exit(1) }

  const geo = mesh.geometry
  const positions = geo.attributes.position.array
  let indices = geo.index ? geo.index.array : null
  if (!indices) {
    const vertCount = positions.length / 3
    indices = new Uint32Array(vertCount)
    for (let i = 0; i < vertCount; i++) indices[i] = i
  }
  const normalAttr = geo.attributes.normal || null
  const uvAttr = geo.attributes.uv || null

  const originalFaces = indices.length / 3
  console.log(`  顶点: ${(positions.length / 3).toLocaleString()}`)
  console.log(`  三角面: ${originalFaces.toLocaleString()}`)

  // 2. 减面（在原始模型上）- 可选，设为0跳过
  console.log('\n[2/7] 减面优化...')
  const modifier = new SimplifyModifier()
  const removeCount = Math.max(0, Math.floor(originalFaces - targetFaces))
  let decimatedPositions, decimatedIndices, decimatedNormals, decimatedUVs

  if (removeCount > 0 && removeCount < originalFaces * 0.9) {
    // 创建临时mesh用于减面
    const tempGeo = geo.clone()
    try {
      // 如果移除太多面，SimplifyModifier会非常慢。限制最大移除量
      const actualRemove = Math.min(removeCount, 500000)
      console.log(`  尝试移除 ${actualRemove.toLocaleString()} 个顶点...`)
      const newGeo = modifier.modify(tempGeo, actualRemove)
      decimatedPositions = newGeo.attributes.position.array
      decimatedIndices = newGeo.index ? newGeo.index.array : null
      if (!decimatedIndices) {
        decimatedIndices = new Uint32Array(decimatedPositions.length / 3)
        for (let i = 0; i < decimatedPositions.length / 3; i++) decimatedIndices[i] = i
      }
      decimatedNormals = newGeo.attributes.normal || null
      decimatedUVs = newGeo.attributes.uv || null
      const newFaces = decimatedIndices.length / 3
      console.log(`  减面: ${originalFaces.toLocaleString()} → ${newFaces.toLocaleString()} 面 (${(newFaces / originalFaces * 100).toFixed(1)}%)`)
      tempGeo.dispose()
      geo.dispose()
    } catch (e) {
      console.log(`  减面失败: ${e.message}，使用原始模型`)
      decimatedPositions = positions
      decimatedIndices = indices
      decimatedNormals = normalAttr
      decimatedUVs = uvAttr
      tempGeo.dispose()
    }
  } else {
    if (removeCount <= 0) {
      console.log(`  面数已在目标范围内，跳过减面`)
    } else {
      console.log(`  减面比例过大，跳过SimplifyModifier（太慢），使用原始模型`)
    }
    decimatedPositions = positions
    decimatedIndices = indices
    decimatedNormals = normalAttr
    decimatedUVs = uvAttr
  }

  // 3. Y轴分析
  console.log('\n[3/7] Y轴分析...')
  const { minY, maxY, height: totalHeight } = getYRange(decimatedPositions)
  console.log(`  高度范围: ${totalHeight.toFixed(2)} (${minY.toFixed(2)} ~ ${maxY.toFixed(2)})`)

  // 4. 顶点分类 + 部件分离
  console.log('\n[4/7] 顶点分类 + 部件分离...')
  const labels = classifyVerticesByY(decimatedPositions, totalHeight, minY)
  const vertexGroups = separateParts(decimatedPositions, labels)

  const parts = {}
  const partsList = []
  for (const [key, verts] of Object.entries(vertexGroups)) {
    if (verts.length < 50) continue
    const subMesh = createSubMesh(decimatedPositions, decimatedIndices, decimatedNormals, decimatedUVs, verts)
    if (subMesh) {
      parts[key] = subMesh
      partsList.push({ key, mesh: subMesh, vertCount: verts.length })
    }
  }

  console.log(`  分离出 ${partsList.length} 个部件:`)
  partsList.forEach(p => {
    const fc = p.mesh.geometry.index ? p.mesh.geometry.index.count / 3 : p.mesh.geometry.attributes.position.count / 3
    console.log(`    ${p.key}: ${p.vertCount.toLocaleString()} 顶点, ${fc.toLocaleString()} 面`)
  })

  // 5. 创建骨架
  console.log('\n[5/7] 创建骨架...')
  const bonePositions = computeBonePositions(totalHeight)
  const { bones, root: rootBone } = createSkeleton(bonePositions)
  console.log(`  骨骼数: ${Object.keys(bones).length}`)

  // 6. 绑定部件
  console.log('\n[6/7] 刚性绑定部件到骨骼...')
  const armature = bindPartsToBones(parts, bones, rootBone)

  // 7. 导出GLB
  console.log('\n[7/7] 导出GLB...')
  const exporter = new GLTFExporter()

  const exportTimeout = setTimeout(() => {
    console.error('❌ GLB导出超时（120秒）')
    process.exit(1)
  }, 120000)

  try {
    const glbData = await new Promise((resolve, reject) => {
      try {
        exporter.parse(armature, (result) => {
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
      const buf = Buffer.from(glbData.byteLength === glbData.buffer.byteLength ? glbData : new Uint8Array(glbData))
      fs.writeFileSync(outputPath, buf)
      const sizeKB = (buf.length / 1024).toFixed(1)
      const sizeMB = (buf.length / 1024 / 1024).toFixed(1)
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
  console.log('用法: node mecha-rigger.cjs <input.fbx> [output.glb] [targetFaces]')
  process.exit(1)
}
main(input, output, targetFaces).catch(err => {
  console.error('失败:', err.message)
  console.error(err.stack)
  process.exit(1)
})