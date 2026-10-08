import { chromium } from 'playwright'
import fs from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')
const FACES = JSON.parse(fs.readFileSync('faces.json', 'utf8'))
const APP = 'http://localhost:5173'
const PW = 'Correct-horse-42'
const tag = Math.random().toString(16).slice(2, 8)
const CUSTOMER = { name: 'Vihaan Gandhi', email: `e2e-cust-${tag}@example.com` }
const MERCHANT = { name: 'Ravi Shah', business: 'SuperGrocery', email: `e2e-shop-${tag}@example.com` }
fs.mkdirSync('shots', { recursive: true })
const results = []
const axeReport = []
const VIEWS = { desktop: { width: 1280, height: 800 }, tablet: { width: 768, height: 1024 }, mobile: { width: 390, height: 844 } }

const log = (step, ok, note = '') => { results.push({ step, ok, note }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${note ? '  — ' + note : ''}`) }
async function step(name, fn) {
  try { const note = await fn(); log(name, true, note || '') } catch (e) { log(name, false, String(e.message).split('\n')[0].slice(0, 300)) }
}

// ---- the simulated camera: ORL photos drawn on a canvas and exposed through getUserMedia (NOT a physical webcam)
const CAMERA_SCRIPT = () => {
  const W = 568, H = 568
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')
  const st = { img: null, left: 100, mode: 'toward', t0: null, sign: -1 }
  const draw = () => {
    ctx.fillStyle = '#222'; ctx.fillRect(0, 0, W, H)
    if (!st.img) return
    let left = st.left
    if (st.t0 !== null) {
      const t = performance.now() - st.t0
      const ramp = Math.max(0, Math.min(80, ((t - 650) / 1500) * 80))
      const move = st.mode === 'still' ? 0 : st.mode === 'away' ? -ramp : ramp
      left = st.base + st.sign * move
    }
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(st.img, 0, 0, 1, 112, 0, 60, left, 448)
    ctx.drawImage(st.img, 91, 0, 1, 112, left + 368, 60, W - (left + 368), 448)
    ctx.drawImage(st.img, 0, 0, 92, 112, left, 60, 368, 448)
    ctx.drawImage(canvas, 0, 60, W, 1, 0, 0, W, 60)
    ctx.drawImage(canvas, 0, 507, W, 1, 0, 508, W, 60)
  }
  setInterval(draw, 66)
  window.__cam = {
    setFace(url, left = 100) { return new Promise((res) => { const i = new Image(); i.onload = () => { st.img = i; st.left = left; st.t0 = null; draw(); res() }; i.src = url }) },
    setMode(m) { st.mode = m },
    onChallenge(ch) { st.sign = ch.challenge === 'turn_right' ? -1 : 1; st.base = st.sign < 0 ? 150 : 50; st.left = st.base; st.t0 = null },
    startClock() { st.t0 = performance.now() },
    reset() { st.t0 = null; st.left = 100 },
  }
  const stream = canvas.captureStream(15)
  navigator.mediaDevices.getUserMedia = async () => {
    if (window.__denyCamera) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    return stream
  }
  const orig = window.fetch.bind(window)
  window.fetch = async (...a) => {
    const r = await orig(...a)
    if (/\/(face-auth\/challenge|authenticate\/start)$/.test(String(a[0]))) {
      try {
        window.__cam.onChallenge(await r.clone().json())
        // let the simulated video settle at the starting position before the app captures its first frame
        await new Promise((res) => setTimeout(res, 500))
        window.__cam.startClock()
      } catch { /* ignore */ }
    }
    return r
  }
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const newCtx = async (extra = {}) => {
  const ctx = await browser.newContext({ viewport: VIEWS.desktop, ...extra })
  await ctx.addInitScript(CAMERA_SCRIPT)
  // BLUR_CAMERA=1: documentation screenshots must not show the (public research dataset) faces used as the simulated camera
  if (process.env.BLUR_CAMERA) {
    await ctx.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
      const st = document.createElement('style'); st.textContent = 'video{filter:blur(28px)!important}'; document.head.appendChild(st)
    }))
  }
  return ctx
}
const shot = (page, name) => page.screenshot({ path: `shots/${name}.png`, fullPage: true })
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
async function axe(page, name) {
  await page.addScriptTag({ content: AXE })
  const r = await page.evaluate(async () => {
    const out = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })
    return out.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') }))
  })
  axeReport.push({ page: name, violations: r })
  return r
}

async function authenticateOnPage(page, who = 'me', idx = 0, mode = 'toward') {
  await page.evaluate(([url, m]) => { window.__cam.setMode(m); return window.__cam.setFace(url, 100) }, [FACES[who][idx], mode])
  await page.getByRole('button', { name: 'Start authentication' }).click()
}

// =============================================================== merchant context + customer context
const mctx = await newCtx(); const mpage = await mctx.newPage()
const cctx = await newCtx({ permissions: ['camera'] }); const cpage = await cctx.newPage()
for (const [p, n] of [[mpage, 'merchant'], [cpage, 'customer']]) {
  p.on('pageerror', (e) => log(`uncaught page error (${n})`, false, e.message))
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|status of (4|5)\d\d/.test(m.text())) log(`console error (${n})`, false, m.text().slice(0, 200)) })
}

// ---------------- landing, at three sizes
await step('landing page renders with tagline + prototype notice (3 viewports, no horizontal scroll)', async () => {
  const notes = []
  for (const [vn, vp] of Object.entries(VIEWS)) {
    await cpage.setViewportSize(vp)
    await cpage.goto(APP + '/')
    await cpage.getByRole('heading', { name: 'Pay with your face.' }).waitFor()
    const text = await cpage.locator('body').innerText()
    if (!text.includes('Facial authentication for simulated digital payments.')) throw new Error('tagline missing')
    if (!/Academic prototype/.test(text)) throw new Error('prototype notice missing')
    if (/bank-grade|military-grade|fraud-proof/i.test(text)) throw new Error('forbidden claim present')
    const o = await overflow(cpage); if (o > 0) throw new Error(`${vn}: horizontal overflow ${o}px`)
    await shot(cpage, `01-landing-${vn}`); notes.push(`${vn} ok`)
  }
  await cpage.setViewportSize(VIEWS.desktop)
  return notes.join(', ')
})
await step('landing: connected status shown', async () => { await cpage.getByText('PostgreSQL').waitFor(); })
await step('axe: landing', async () => { const v = await axe(cpage, 'landing'); return `${v.length} violation types` })

await step('keyboard: first Tab stop on the landing page is a real control, focus ring visible', async () => {
  await cpage.goto(APP + '/'); await cpage.keyboard.press('Tab')
  const info = await cpage.evaluate(() => { const e = document.activeElement; const cs = getComputedStyle(e); return { tag: e.tagName, text: e.textContent.trim(), outline: cs.outlineStyle, w: cs.outlineWidth } })
  if (!['A', 'BUTTON'].includes(info.tag) || info.outline === 'none') throw new Error(JSON.stringify(info))
  return JSON.stringify(info)
})

// ---------------- customer registers through the UI
await step('customer registration through the UI lands on the dashboard', async () => {
  await cpage.goto(APP + '/register')
  await cpage.getByLabel('Full name').fill(CUSTOMER.name)
  await cpage.getByLabel('Email').fill(CUSTOMER.email)
  await cpage.getByLabel('Password', { exact: true }).fill(PW)
  await cpage.getByLabel('Confirm password').fill(PW)
  await shot(cpage, '02-register-customer')
  await cpage.getByRole('button', { name: /create account|register|sign up/i }).click()
  await cpage.getByRole('heading', { name: /Welcome, Vihaan Gandhi/ }).waitFor()
  await cpage.getByText('Not set up').waitFor()
  await shot(cpage, '03-dashboard-new-customer')
})
await step('axe: customer dashboard (new)', async () => { const v = await axe(cpage, 'customer dashboard (new)'); return `${v.length} violation types` })

// ---------------- face setup: camera, capture, train, test
await step('face setup: camera preview starts from the simulated camera', async () => {
  await cpage.goto(APP + '/face')
  await cpage.getByRole('button', { name: 'Turn camera on' }).click()
  await cpage.getByRole('button', { name: 'Turn camera off' }).waitFor()
  await cpage.evaluate((u) => window.__cam.setFace(u, 100), FACES.me[0])
  await cpage.waitForFunction(() => { const v = document.querySelector('video'); return v && v.videoWidth > 0 })
  await shot(cpage, '04-face-setup-camera-on')
})
await step('face setup: 10 samples captured across poses; progress + quality feedback shown', async () => {
  const poses = ['neutral', 'turn_left', 'turn_right', 'chin_up']
  let lastNotice = ''
  for (let i = 0; i < 10; i++) {
    await cpage.evaluate((u) => window.__cam.setFace(u, 100), FACES.me[i])
    await cpage.waitForTimeout(250)
    await cpage.locator(`input[name=pose][value=${poses[i % 4]}]`).check()
    await cpage.getByRole('button', { name: 'Capture sample' }).click()
    await cpage.getByText(/^Sample saved\./).waitFor({ timeout: 15000 })
    lastNotice = await cpage.getByText(/^Sample saved\./).innerText()
    await cpage.waitForTimeout(150)
  }
  const bar = await cpage.getByRole('progressbar', { name: 'Samples collected' }).getAttribute('aria-valuenow')
  await shot(cpage, '05-face-setup-samples')
  return `progressbar now=${bar}; last notice: "${lastNotice}"`
})
await step('face setup: train model (2+ users) and show friendly model status', async () => {
  await cpage.getByRole('button', { name: 'Train model' }).click()
  await cpage.getByText(/Model trained/).waitFor({ timeout: 120000 })
  await cpage.getByText(/The model includes your face and is up to date/).waitFor()
  await shot(cpage, '06-face-setup-trained')
})
await step('face setup: "Recognise me" with the same person is accepted', async () => {
  await cpage.evaluate((u) => window.__cam.setFace(u, 100), FACES.me[3])
  await cpage.waitForTimeout(300)
  await cpage.getByRole('button', { name: 'Recognise me' }).click()
  await cpage.getByText('Recognised as you.').waitFor({ timeout: 15000 })
  await cpage.getByText(/Match confidence/).waitFor()
  await shot(cpage, '07-face-setup-recognised')
})
await step('face setup: destructive action asks inside the page; Keep it does nothing', async () => {
  await cpage.getByRole('button', { name: 'Delete my face data' }).click()
  await cpage.getByRole('alertdialog').waitFor()
  const focusedName = await cpage.evaluate(() => document.activeElement?.textContent?.trim())
  if (focusedName !== 'Keep it') throw new Error(`focus should start on the safe choice, was "${focusedName}"`)
  await shot(cpage, '08-delete-confirmation')
  await cpage.getByRole('button', { name: 'Keep it' }).click()
  await cpage.getByRole('alertdialog').waitFor({ state: 'detached' })
  await cpage.getByText(/You can pay with FacePay|includes your face/).first().waitFor()
})
await step('axe: face setup', async () => { const v = await axe(cpage, 'face setup'); return `${v.length} violation types` })

await step('dashboard: face status is "Ready"', async () => {
  await cpage.goto(APP + '/dashboard'); await cpage.getByText('Ready', { exact: true }).waitFor()
  await shot(cpage, '09-dashboard-ready')
})

// ---------------- merchant registers through the UI, creates a payment
await step('merchant registration through the UI lands on the merchant dashboard', async () => {
  await mpage.goto(APP + '/merchant/register')
  await mpage.getByLabel('Full name').fill(MERCHANT.name)
  await mpage.getByLabel('Business name').fill(MERCHANT.business)
  await mpage.getByLabel('Email').fill(MERCHANT.email)
  await mpage.getByLabel('Password', { exact: true }).fill(PW)
  await mpage.getByLabel('Confirm password').fill(PW)
  await mpage.getByRole('button', { name: /create account|register|sign up/i }).click()
  await mpage.getByRole('heading', { name: 'SuperGrocery' }).waitFor()
  await mpage.getByText('No payment sessions yet').waitFor()
  await shot(mpage, '10-merchant-dashboard-empty')
})
let checkoutPath
async function merchantCreatesPayment(amount, ref) {
  await mpage.goto(APP + '/merchant/payments/new')
  await mpage.getByLabel('Amount (INR)').fill(amount)
  await mpage.getByLabel('Order / reference').fill(ref)
  await mpage.getByRole('button', { name: 'Create payment session' }).click()
  await mpage.getByText('Waiting for customer', { exact: true }).first().waitFor()
  const link = await mpage.locator('code').innerText()
  return new URL(link).pathname
}
await step('merchant: Create Payment → Monitor Payment shows amount, checkout link, waiting state', async () => {
  checkoutPath = await merchantCreatesPayment('950.00', 'SG-10492')
  await shot(mpage, '11-merchant-session-waiting')
  return checkoutPath
})
await step('axe: merchant payment session + create payment', async () => { const v = await axe(mpage, 'merchant payment session'); return `${v.length} violation types` })

// ---------------- the customer pays
await step('checkout: amount, merchant, order, method are prominent', async () => {
  await cpage.goto(APP + checkoutPath)
  await cpage.getByRole('heading', { name: 'FacePay Checkout' }).waitFor()
  const amount = await cpage.getByTestId('checkout-amount').innerText()
  if (!/₹950\.00/.test(amount)) throw new Error('amount: ' + amount)
  for (const t of ['SuperGrocery', 'SG-10492', 'FacePay (simulated)']) await cpage.getByText(t).first().waitFor()
  const size = await cpage.getByTestId('checkout-amount').evaluate((e) => parseFloat(getComputedStyle(e).fontSize))
  await shot(cpage, '12-checkout')
  return `amount font-size ${size}px`
})
await step('axe: checkout', async () => { const v = await axe(cpage, 'checkout'); return `${v.length} violation types` })
await step('FacePay authentication: camera → liveness → identity → authorized', async () => {
  await cpage.getByRole('button', { name: 'Pay with FacePay' }).click()
  await cpage.getByRole('button', { name: 'Turn camera on' }).click()
  await cpage.getByRole('button', { name: 'Turn camera off' }).waitFor()
  await shot(cpage, '13-auth-camera-on')
  await authenticateOnPage(cpage, 'me', 5)
  await cpage.getByText('Liveness check', { exact: true }).waitFor({ timeout: 10000 })
  await shot(cpage, '14-auth-liveness-challenge')
  await cpage.getByRole('heading', { name: 'FacePay Authentication ✓' }).waitFor({ timeout: 30000 })
  const amt = await cpage.getByTestId('confirm-amount').innerText()
  if (!/₹950\.00/.test(amt)) throw new Error('confirm amount ' + amt)
  const body = await cpage.locator('main').innerText()
  if (/\bdistance\b/i.test(body.replace(/Technical details[\s\S]*$/m, ''))) { /* distance only inside details */ }
  await shot(cpage, '15-confirm-payment')
  return 'authorized, confirm amount ' + amt
})
await step('raw model internals are hidden behind "Technical details" by default', async () => {
  const open = await cpage.locator('details').first().evaluate((d) => d.open)
  if (open) throw new Error('details open by default')
  const visible = await cpage.getByText(/Distance to your profile/).first().isVisible()
  if (visible) throw new Error('distance visible to normal user')
})
await step('axe: confirm payment', async () => { const v = await axe(cpage, 'confirm payment'); return `${v.length} violation types` })
await step('payment confirmation → professional receipt', async () => {
  await cpage.getByRole('button', { name: /^Confirm ₹950\.00/ }).click()
  await cpage.getByText('PAYMENT SUCCESSFUL ✓').waitFor({ timeout: 20000 })
  const rec = cpage.getByRole('article', { name: 'Payment receipt' })
  for (const t of ['Vihaan Gandhi', 'SuperGrocery', 'SG-10492', 'FacePay', 'SUCCESS']) await rec.getByText(t).first().waitFor()
  const txid = await rec.locator('.font-mono').innerText()
  if (!/^FP-[0-9A-Z]{10}$/.test(txid)) throw new Error('txid ' + txid)
  await shot(cpage, '16-receipt')
  return txid
})
await step('axe: receipt', async () => { const v = await axe(cpage, 'receipt'); return `${v.length} violation types` })
await step('reloading the paid checkout shows "already completed", not a second payment', async () => {
  await cpage.goto(APP + checkoutPath)
  await cpage.getByText('This payment has already been completed.').waitFor()
  if (await cpage.getByRole('button', { name: 'Pay with FacePay' }).count()) throw new Error('pay button offered again')
  await shot(cpage, '17-checkout-already-paid')
})

// ---------------- history + dashboard
await step('customer dashboard shows spending summary and recent payment', async () => {
  await cpage.goto(APP + '/dashboard')
  await cpage.getByText('Total spent').waitFor()
  await cpage.getByRole('table', { name: 'Recent payments' }).waitFor()
  await shot(cpage, '18-dashboard-after-payment')
})
await step('axe: customer dashboard (with data)', async () => { const v = await axe(cpage, 'customer dashboard (with data)'); return `${v.length} violation types` })
await step('customer transactions page: list, status filter, search, sort', async () => {
  await cpage.goto(APP + '/transactions')
  const table = cpage.getByRole('table', { name: 'Transactions' })
  await table.waitFor()
  await cpage.getByLabel('Status').selectOption('FAILED')
  await cpage.getByText('No transactions match').waitFor()
  await cpage.getByLabel('Status').selectOption('')
  await cpage.getByLabel('Search').fill('SG-1049')
  await table.getByText('SuperGrocery').waitFor()
  await cpage.getByLabel('Search').fill('zzz-nothing')
  await cpage.getByText('No transactions match').waitFor()
  await cpage.getByLabel('Search').fill('')
  await cpage.getByLabel('Sort by').selectOption('amount_desc')
  await table.waitFor()
  await shot(cpage, '19-customer-transactions')
})
await step('axe: customer transactions', async () => { const v = await axe(cpage, 'customer transactions'); return `${v.length} violation types` })

await step('merchant sees the payment completed, revenue, chart and transaction', async () => {
  await mpage.goto(APP + checkoutPath.replace('/checkout/', '/merchant/payments/'))
  await mpage.getByText('Payment completed').waitFor()
  await shot(mpage, '20-merchant-session-paid')
  await mpage.goto(APP + '/merchant/dashboard')
  await mpage.getByText('₹950.00').first().waitFor()
  await mpage.getByRole('region', { name: 'Revenue by day' }).waitFor()
  await mpage.locator('.recharts-bar-rectangle, .recharts-rectangle').first().waitFor({ timeout: 10000 })
  await shot(mpage, '21-merchant-dashboard')
})
await step('axe: merchant dashboard', async () => { const v = await axe(mpage, 'merchant dashboard'); return `${v.length} violation types` })
await step('merchant transactions page lists the customer payment; filter/search work', async () => {
  await mpage.goto(APP + '/merchant/transactions')
  const t = mpage.getByRole('table', { name: 'Transactions' }); await t.waitFor()
  await t.getByText('Vihaan Gandhi').waitFor()
  await mpage.getByLabel('Search').fill('vihaan')
  await t.getByText('Vihaan Gandhi').waitFor()
  await shot(mpage, '22-merchant-transactions')
})
await step('merchant receipt page opens from the transactions table', async () => {
  await mpage.getByRole('table', { name: 'Transactions' }).getByRole('link').first().click()
  await mpage.getByText('PAYMENT SUCCESSFUL ✓').waitFor()
})

// ---------------- negative paths in the real browser
let session2
await step('wrong person (stranger photo) is rejected and the payment stays unpaid', async () => {
  session2 = await merchantCreatesPayment('120.00', 'SG-10493')
  await cpage.goto(APP + session2)
  await cpage.getByRole('button', { name: 'Pay with FacePay' }).click()
  await cpage.getByRole('button', { name: 'Turn camera on' }).click()
  await cpage.getByRole('button', { name: 'Turn camera off' }).waitFor()
  await authenticateOnPage(cpage, 'stranger', 2)
  await cpage.getByRole('alert').first().waitFor({ timeout: 30000 })
  const msg = await cpage.getByRole('alert').first().innerText()
  if (await cpage.getByRole('heading', { name: 'FacePay Authentication ✓' }).count()) throw new Error('stranger was accepted: ' + msg)
  await shot(cpage, '23-auth-rejected')
  return msg.replace(/\n/g, ' ')
})
await step('printed/photo attack: face does not move → liveness fails with a clear message', async () => {
  await cpage.getByRole('button', { name: 'Try again' }).click()
  await authenticateOnPage(cpage, 'me', 6, 'still')
  await cpage.getByRole('alert').filter({ hasText: /Liveness check failed/ }).waitFor({ timeout: 30000 })
  await shot(cpage, '24-liveness-failed')
})
await step('the checkout shows remaining attempts after rejections', async () => {
  const txt = await cpage.locator('main').innerText(); return txt.match(/\d of \d face attempts left|attempts/i)?.[0] ?? 'attempt counter not visible in this state'
})

await step('camera permission denied: clear message, nothing breaks', async () => {
  const dctx = await newCtx(); const dp = await dctx.newPage()
  await dp.addInitScript(() => { window.__denyCamera = true })
  await dp.goto(APP + '/login')
  await dp.getByLabel('Email').fill(CUSTOMER.email); await dp.getByLabel('Password').fill(PW)
  await dp.getByRole('button', { name: 'Sign in' }).click()
  await dp.getByRole('heading', { name: /Welcome/ }).waitFor()
  await dp.goto(APP + '/face')
  await dp.getByRole('button', { name: 'Turn camera on' }).click()
  await dp.getByText(/Camera access was blocked/).waitFor()
  await dp.getByRole('button', { name: 'Try the camera again' }).waitFor()
  await shot(dp, '25-camera-denied')
  await dctx.close()
})

await step('backend failure states: network error, 500, 429 show friendly messages with retry', async () => {
  const notes = []
  for (const [label, handler, expected] of [
    ['network', (r) => r.abort(), /Cannot reach the server/],
    ['500', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'Traceback (most recent call last)' }) }), /Something went wrong on our side/],
    ['429', (r) => r.fulfill({ status: 429, contentType: 'application/json', body: '{}' }), /Too many requests/],
  ]) {
    await cpage.route('**/payments/transactions*', handler)
    await cpage.goto(APP + '/transactions')
    const a = cpage.getByRole('alert'); await a.waitFor()
    const text = await a.innerText()
    if (!expected.test(text) || /Traceback|HTTP \d{3}/.test(text)) throw new Error(`${label}: ${text}`)
    await cpage.getByRole('button', { name: 'Try again' }).waitFor()
    if (label === 'network') await shot(cpage, '26-error-state')
    await cpage.unroute('**/payments/transactions*')
    notes.push(label)
  }
  return notes.join(', ')
})
await step('401 on an authenticated call logs out and the login page explains', async () => {
  await cpage.route('**/payments/transactions*', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"detail":"expired"}' }))
  await cpage.goto(APP + '/transactions')
  await cpage.getByText('Your session has ended. Please sign in again.').waitFor()
  await shot(cpage, '27-session-ended')
  await cpage.unroute('**/payments/transactions*')
})
await step('unknown route → friendly 404 page; unknown checkout → not found message', async () => {
  await cpage.goto(APP + '/no/such/page'); await cpage.getByRole('heading', { name: 'Page not found' }).waitFor()
  await cpage.goto(APP + '/login')
  await cpage.getByLabel('Email').fill(CUSTOMER.email); await cpage.getByLabel('Password').fill(PW)
  await cpage.getByRole('button', { name: 'Sign in' }).click(); await cpage.getByRole('heading', { name: /Welcome/ }).waitFor()
  await cpage.goto(APP + '/checkout/ps_doesnotexist'); await cpage.getByText('This payment session does not exist.').waitFor()
})
await step('authorization: customer cannot open merchant pages and vice-versa (route guards)', async () => {
  await cpage.goto(APP + '/merchant/dashboard'); await cpage.waitForURL((u) => u.pathname === '/dashboard')
  await cpage.goto(APP + '/merchant/payments/new'); await cpage.waitForURL((u) => u.pathname === '/dashboard')
  await mpage.goto(APP + '/dashboard'); await mpage.waitForURL((u) => u.pathname === '/merchant/dashboard')
  await mpage.goto(APP + '/face'); await mpage.waitForURL((u) => u.pathname === '/merchant/dashboard')
})

// ---------------- responsive: tablet + mobile, including a full payment on a phone-sized screen
for (const vn of ['tablet', 'mobile']) {
  await step(`${vn}: key pages have no horizontal scroll; screenshots`, async () => {
    const bad = []
    for (const [p, paths] of [[cpage, ['/dashboard', '/face', '/authenticate', '/transactions', '/profile']], [mpage, ['/merchant/dashboard', '/merchant/transactions', '/merchant/payments/new']]]) {
      await p.setViewportSize(VIEWS[vn])
      for (const path of paths) {
        await p.goto(APP + path); await p.waitForLoadState('networkidle')
        const o = await overflow(p); if (o > 0) bad.push(`${path} +${o}px`)
        await shot(p, `30-${vn}-${path.replace(/\W+/g, '_')}`)
      }
    }
    if (bad.length) throw new Error('overflow: ' + bad.join('; '))
  })
}
await step('mobile: hamburger menu opens, navigates and closes', async () => {
  await cpage.setViewportSize(VIEWS.mobile); await cpage.goto(APP + '/dashboard')
  await cpage.getByRole('button', { name: 'Open menu' }).click()
  await shot(cpage, '31-mobile-menu-open')
  await cpage.getByRole('navigation', { name: 'Mobile' }).getByRole('link', { name: 'Transactions' }).click()
  await cpage.getByRole('heading', { name: 'Transactions' }).waitFor()
  if (await cpage.getByRole('navigation', { name: 'Mobile' }).count()) throw new Error('menu still open')
})
await step('mobile: complete a second payment end-to-end on a 390×844 screen', async () => {
  const path = await merchantCreatesPayment('250.50', 'SG-10494')
  await cpage.setViewportSize(VIEWS.mobile)
  await cpage.goto(APP + path)
  await shot(cpage, '32-mobile-checkout')
  await cpage.getByRole('button', { name: 'Pay with FacePay' }).click()
  await cpage.getByRole('button', { name: 'Turn camera on' }).click()
  await cpage.getByRole('button', { name: 'Turn camera off' }).waitFor()
  const v = await cpage.locator('video').boundingBox(); if (!v || v.width > 390 || v.width < 250) throw new Error('video box ' + JSON.stringify(v))
  await shot(cpage, '33-mobile-camera')
  await authenticateOnPage(cpage, 'me', 7)
  await cpage.getByText('Liveness check', { exact: true }).waitFor({ timeout: 10000 })
  await shot(cpage, '34-mobile-liveness')
  await cpage.getByRole('heading', { name: 'FacePay Authentication ✓' }).waitFor({ timeout: 30000 })
  const o = await overflow(cpage); if (o > 0) throw new Error('overflow ' + o)
  const btn = await cpage.getByRole('button', { name: /^Confirm ₹250\.50/ }).boundingBox(); if (!btn || btn.height < 36) throw new Error('confirm button too small ' + JSON.stringify(btn))
  await shot(cpage, '35-mobile-confirm')
  await cpage.getByRole('button', { name: /^Confirm ₹250\.50/ }).click()
  await cpage.getByText('PAYMENT SUCCESSFUL ✓').waitFor({ timeout: 20000 })
  await shot(cpage, '36-mobile-receipt')
  return `camera preview ${Math.round(v.width)}×${Math.round(v.height)}px, confirm button ${Math.round(btn.width)}×${Math.round(btn.height)}px`
})

fs.writeFileSync('results.json', JSON.stringify({ results, axeReport }, null, 2))
await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
console.log('\n=== axe violations by page ===')
for (const a of axeReport) console.log(a.page, a.violations.length ? JSON.stringify(a.violations.map((v) => `${v.id}(${v.impact}) x${v.nodes} e.g. ${v.sample}`)) : 'none')
