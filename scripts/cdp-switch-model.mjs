// 通过 CDP 调用 tandem:switch-model 切换当前推理模型（诊断/回归辅助）
// 用法：node scripts/cdp-switch-model.mjs <modelId>
import http from 'node:http'
import WebSocket from 'ws'

const CDP_PORT = 9222
function httpGet(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve(d)) })
    req.setTimeout(timeout, () => { req.destroy(new Error('timeout')) })
    req.on('error', reject)
  })
}
async function main() {
  const target = process.argv[2]
  if (!target) { console.error('缺少 modelId'); process.exit(1) }
  const targets = JSON.parse(await httpGet(`http://127.0.0.1:${CDP_PORT}/json/list`))
  const page = targets.find(t => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 16 * 1024 * 1024 })
  let id = 0; const pending = new Map()
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
  ws.on('message', data => {
    const m = JSON.parse(data.toString())
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) }
  })
  await new Promise(r => ws.on('open', r))
  const r = await send('Runtime.evaluate', { expression: `window.api.invoke('tandem:switch-model','${target}').then(x=>JSON.stringify(x)).catch(e=>JSON.stringify({success:false,error:String(e)}))`, awaitPromise: true, returnByValue: true })
  console.log(JSON.stringify(r?.result?.value))
  ws.close()
}
main().catch(e => { console.error('ERR', e); process.exit(1) })
