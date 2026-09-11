// CDP 截图 + DOM 快照（诊断用）
import http from 'node:http'
import fs from 'node:fs'
import WebSocket from 'ws'

const CDP_PORT = 9222
const OUT_PNG = process.argv[2] || 'home.png'
const OUT_TXT = OUT_PNG.replace(/\.png$/, '.txt')

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
async function cdpConnect() {
  const targets = JSON.parse(await httpGet(`http://127.0.0.1:${CDP_PORT}/json/list`))
  const page = targets.find(t => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
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

const DOM_EXPR = `(() => {
  const sel = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null)
  const btns = sel.map(b => {
    const r = b.getBoundingClientRect()
    return { text: (b.innerText||'').replace(/\\n/g,' ').slice(0,60), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cls: (b.className||'').toString().slice(0,50) }
  }).filter(b => b.y < 120)
  return JSON.stringify({ url: location.pathname, btns })
})()`

async function main() {
  const conn = await cdpConnect()
  const [dom, shot] = await Promise.all([
    conn.send('Runtime.evaluate', { expression: DOM_EXPR, returnByValue: true }),
    conn.send('Page.captureScreenshot', { format: 'png' }),
  ])
  const info = JSON.parse(dom?.result?.value || '{}')
  let txt = `URL=${info.url}\n`
  for (const b of info.btns || []) txt += `btn [${b.text}] x=${b.x} y=${b.y} w=${b.w} h=${b.h} cls=${b.cls}\n`
  fs.writeFileSync(OUT_TXT, txt)
  fs.writeFileSync(OUT_PNG, Buffer.from(shot.data, 'base64'))
  console.log('URL:', info.url)
  console.log(txt)
  conn.ws.close()
}
main().catch(e => { console.error('ERR', e); process.exit(1) })
