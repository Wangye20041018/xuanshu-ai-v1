// 模型切换「窗口/面板移位」诊断：CDP 时间线采样
// 用法：node switch-layout.mjs <toModelId> <backModelId>
import http from 'node:http'
import WebSocket from 'ws'

const CDP_PORT = 9222
const toModel = process.argv[2] || 'deepseek-math-9b'
const backModel = process.argv[3] || 'qwen-coder-9b'

function httpGet(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = ''
      res.on('data', c => (data += c))
      res.on('end', () => resolve(data))
    })
    req.setTimeout(timeout, () => { req.destroy(new Error('timeout')) })
    req.on('error', reject)
  })
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function cdpConnect() {
  const targets = JSON.parse(await httpGet(`http://127.0.0.1:${CDP_PORT}/json/list`))
  const page = targets.find(t => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 })
  let msgId = 0
  const pending = new Map()
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  ws.on('message', data => {
    const msg = JSON.parse(data.toString())
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
    }
  })
  await new Promise(r => ws.on('open', r))
  return { ws, send }
}

const SAMPLE_EXPR = `(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } }
  const btn = [...document.querySelectorAll('button')].find(b => (b.innerText||'').includes('推理模型') || (b.innerText||'').includes('云端：'))
  const newChat = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '新建会话')
  const hist = [...document.querySelectorAll('button')].find(b => (b.title||'').includes('展开历史'))
  const panel = [...document.querySelectorAll('button')].find(b => (b.title||'').includes('工作面板'))
  const chatArea = document.querySelector('[class*="chat"]') || null
  return JSON.stringify({
    win: { sx: window.screenX, sy: window.screenY, ow: window.outerWidth, oh: window.outerHeight, iw: window.innerWidth, ih: window.innerHeight, scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight },
    modelBtn: r(btn), newChat: r(newChat), hist: r(hist), panel: r(panel),
    bodyText: (document.body.innerText || '').slice(0, 40),
  })
})()`

async function main() {
  const conn = await cdpConnect()
  async function sample(tag) {
    const r = await conn.send('Runtime.evaluate', { expression: SAMPLE_EXPR, returnByValue: true })
    const v = JSON.parse(r?.result?.value || '{}')
    console.log(`\n[SAMPLE ${tag}]`)
    console.log('  win:', JSON.stringify(v.win))
    console.log('  modelBtn:', JSON.stringify(v.modelBtn))
    console.log('  newChat:', JSON.stringify(v.newChat))
    console.log('  chatArea:', JSON.stringify(v.chatArea))
    return v
  }

  await sample('before')
  // 触发切换
  const switchExpr = `(async () => {
    const res = await window.api.invoke('tandem:switch-model', '${toModel}').catch(e => ({ success: false, error: String(e) }))
    return JSON.stringify(res)
  })()`
  const sr = await conn.send('Runtime.evaluate', { expression: switchExpr, awaitPromise: true, returnByValue: true })
  console.log('\n[SWITCH CALL]', JSON.stringify(sr?.result?.value))
  // 切换过程中持续采样（模型重新加载可能耗时）
  for (let i = 1; i <= 12; i++) {
    await sleep(1000)
    await sample(`during-${i}s`)
  }
  await sample('after')
  conn.ws.close()
}

main().catch(e => { console.error('ERR', e); process.exit(1) })
