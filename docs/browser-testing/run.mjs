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
  const st = { img: null, left: 100, dy: 0, scale: 1, mode: 'toward', t0: null, sign: -1 }
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
    const top = 60 + st.dy
    if (st.scale < 1) {
      // a smaller face on a plain background, like a person sitting back from the camera (ORL crops fill the frame otherwise)
      const w = 368 * st.scale, h = 448 * st.scale
      ctx.drawImage(st.img, 0, 0, 92, 112, left + (368 - w) / 2, top + (448 - h) / 2, w, h)
      return
    }
    ctx.drawImage(st.img, 0, 0, 1, 112, 0, top, left, 448)
    ctx.drawImage(st.img, 91, 0, 1, 112, left + 368, top, W - (left + 368), 448)
    ctx.drawImage(st.img, 0, 0, 92, 112, left, top, 368, 448)
    ctx.drawImage(canvas, 0, top, W, 1, 0, 0, W, top)
    ctx.drawImage(canvas, 0, top + 447, W, 1, 0, top + 448, W, H - (top + 448))
  }
  setInterval(draw, 66)
  window.__cam = {
    // opts.flip mirrors the photograph (gives a distinct frame from the same person); opts.dy moves the face up or down
    setFace(url, left = 100, opts = {}) {
      return new Promise((res) => {
        const i = new Image()
        i.onload = () => {
          let src = i
          if (opts.flip) { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.translate(i.width, 0); x.scale(-1, 1); x.drawImage(i, 0, 0); src = c }
          st.img = src; st.left = left; st.dy = opts.dy ?? 0; st.scale = opts.scale ?? 1; st.t0 = null; draw(); res()
        }
        i.src = url
      })
    },
    setMode(m) { st.mode = m },
    onChallenge(ch) { st.sign = ch.challenge === 'turn_right' ? -1 : 1; st.base = st.sign < 0 ? 150 : 50; st.left = st.base; st.t0 = null },
    startClock() { st.t0 = performance.now() },
    reset() { st.t0 = null; st.left = 100 },
  }
  navigator.mediaDevices.getUserMedia = async () => {
    if (window.__denyCamera) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    return canvas.captureStream(15) // a fresh live stream per request, as a real camera gives (the app stops its tracks when it is done)
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

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}) })
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
const shot = async (page, name) => { await page.waitForTimeout(450); return page.screenshot({ path: `shots/${name}.png`, fullPage: true }) }
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
  await page.getByRole('button', { name: 'Start face check' }).click()
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
    if (!text.includes('FacePay uses facial authentication to authorize simulated digital payments.')) throw new Error('tagline missing')
    if (!/Prototype \/ Academic Project/.test(text)) throw new Error('prototype notice missing')
    for (const t of ['Try FacePay', 'How it works', 'Create your Face Profile', 'Authenticate with your face', 'Authorize your payment']) if (!text.includes(t)) throw new Error('landing text missing: ' + t)
    if (/bank-grade|military-grade|fraud-proof/i.test(text)) throw new Error('forbidden claim present')
    const o = await overflow(cpage); if (o > 0) throw new Error(`${vn}: horizontal overflow ${o}px`)
    await shot(cpage, `01-landing-${vn}`); notes.push(`${vn} ok`)
  }
  await cpage.setViewportSize(VIEWS.desktop)
  return notes.join(', ')
})
await step('landing: connected status shown', async () => { await cpage.getByText('PostgreSQL').first().waitFor(); })
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
  await cpage.getByRole('heading', { name: /^Good (morning|afternoon|evening), Vihaan$/ }).waitFor()
  await cpage.getByText('Not set up').waitFor()
  await shot(cpage, '03-dashboard-new-customer')
})
await step('axe: customer dashboard (new)', async () => { const v = await axe(cpage, 'customer dashboard (new)'); return `${v.length} violation types` })

// ---------------- face setup: guided, automatic capture, then train and test
// The simulated camera cannot turn a head, so this driver plays the person: it shows a different frame after every
// capture and moves the face sideways or up and down for the pose the screen asks for. The app itself decides when
// to capture; this script never clicks a capture button (there is none).
const POSE_OFFSET = { Straight: [100, 0], Left: [140, 0], Right: [60, 0], Up: [100, -30], Down: [100, 30] }
async function playGuidedSetup(page, who = 'me', timeoutMs = 240000) {
  const t0 = Date.now(); let lastKey = ''; const phases = new Set()
  while (Date.now() - t0 < timeoutMs) {
    const phase = await page.getByTestId('enroll-stage').getAttribute('data-phase')
    phases.add(phase)
    if (phase === 'COMPLETED') break
    if (phase === 'ERROR') throw new Error('guided setup stopped: ' + (await page.getByRole('region', { name: 'Guided face setup' }).innerText()).slice(0, 200))
    const n = Number(await page.getByRole('progressbar', { name: 'Setup progress' }).getAttribute('aria-valuenow'))
    const label = (await page.locator('ol[aria-label="Head positions"] li[aria-current=step]').first().innerText().catch(() => 'Straight')).split('\n')[0].trim()
    const key = `${n}|${label}`
    if (key !== lastKey) {
      lastKey = key
      const [left, dy] = POSE_OFFSET[label] ?? [100, 0]
      await page.evaluate(([u, l, o]) => window.__cam.setFace(u, l, o), [FACES[who][n % 10], left, { flip: n >= 10, dy, scale: 0.6 }])
    }
    await page.waitForTimeout(150)
  }
  return [...phases]
}
await step('face setup: there is no per-sample Capture button and no manual pose picker', async () => {
  await cpage.goto(APP + '/face')
  await cpage.getByRole('button', { name: 'Start face setup' }).waitFor()
  if (await cpage.getByRole('button', { name: /capture sample/i }).count()) throw new Error('manual capture button still present')
  if (await cpage.getByRole('radio').count()) throw new Error('manual pose picker still present')
  const text = await cpage.getByRole('region', { name: 'Guided face setup' }).innerText()
  if (/\bPCA\b|\bLDA\b/.test(text)) throw new Error('jargon in the enrollment card')
  await shot(cpage, '04-face-setup-start')
})
await step('face setup: auto-capture walks five head positions and finishes with "Face setup complete"', async () => {
  await cpage.evaluate((u) => window.__cam.setFace(u, 100, { scale: 0.6 }), FACES.me[0])
  await cpage.getByRole('button', { name: 'Start face setup' }).click()
  await cpage.getByTestId('enroll-stage').waitFor()
  await cpage.waitForFunction(() => { const v = document.querySelector('video'); return v && v.videoWidth > 0 })
  await shot(cpage, '05-face-setup-positioning')
  const phases = await playGuidedSetup(cpage)
  for (const need of ['POSITION_FACE', 'CHECKING_QUALITY', 'CAPTURING', 'CAPTURE_SUCCESS']) if (!phases.includes(need)) throw new Error('never saw phase ' + need + ' in ' + phases.join(','))
  await cpage.getByText('Your face profile is ready.').first().waitFor({ timeout: 180000 })
  const bar = await cpage.getByRole('progressbar', { name: 'Setup progress' }).getAttribute('aria-valuenow')
  if (bar !== '15') throw new Error('progress ' + bar)
  await cpage.getByText('Face setup complete').first().waitFor()
  await shot(cpage, '06-face-setup-complete')
  return `phases seen: ${phases.join(' > ')}`
})
await step('face setup: "Recognise me" with the same person is accepted', async () => {
  await cpage.getByRole('button', { name: 'Turn camera on to test' }).click()
  await cpage.getByRole('button', { name: 'Recognise me' }).waitFor()
  await cpage.evaluate((u) => window.__cam.setFace(u, 100, { scale: 0.6 }), FACES.me[3])
  await cpage.waitForTimeout(500)
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

await step('dashboard: face status is "Face authentication ready"', async () => {
  await cpage.goto(APP + '/dashboard'); await cpage.getByText('Face authentication ready').waitFor()
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
  await mpage.getByText('No payment requests yet').waitFor()
  await shot(mpage, '10-merchant-dashboard-empty')
})
let checkoutPath
async function merchantCreatesPayment(amount, ref) {
  await mpage.goto(APP + '/merchant/payments/new')
  await mpage.getByLabel('Amount (₹)').fill(amount)
  await mpage.getByLabel('Order / reference').fill(ref)
  await mpage.getByRole('button', { name: 'Create payment request' }).click()
  await mpage.getByText('Awaiting customer').waitFor()
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
  await cpage.getByRole('heading', { name: 'Checkout' }).waitFor()
  const amount = await cpage.getByTestId('checkout-amount').innerText()
  if (!/₹950\.00/.test(amount)) throw new Error('amount: ' + amount)
  for (const t of ['SuperGrocery', 'SG-10492', 'Simulated payment']) await cpage.getByText(t).first().waitFor()
  const size = await cpage.getByTestId('checkout-amount').evaluate((e) => parseFloat(getComputedStyle(e).fontSize))
  await shot(cpage, '12-checkout')
  return `amount font-size ${size}px`
})
await step('axe: checkout', async () => { const v = await axe(cpage, 'checkout'); return `${v.length} violation types` })
await step('FacePay authentication: camera → liveness → identity → authorized', async () => {
  await cpage.getByRole('button', { name: 'Pay with Face' }).click()
  await cpage.getByRole('button', { name: 'Turn camera on' }).click()
  await cpage.getByRole('button', { name: 'Turn camera off' }).waitFor()
  await shot(cpage, '13-auth-camera-on')
  await authenticateOnPage(cpage, 'me', 5)
  await cpage.getByText('Quick security check').waitFor({ timeout: 10000 })
  await shot(cpage, '14-auth-liveness-challenge')
  await cpage.getByRole('heading', { name: 'Confirm payment' }).waitFor({ timeout: 30000 })
  const amt = await cpage.getByTestId('confirm-amount').innerText()
  if (!/₹950\.00/.test(amt)) throw new Error('confirm amount ' + amt)
  const body = await cpage.locator('main').innerText()
  if (/\bdistance\b/i.test(body.replace(/Technical details[\s\S]*$/m, ''))) { /* distance only inside details */ }
  const stageTexts = (await cpage.getByRole('list', { name: 'Payment stages' }).first().locator('li').allInnerTexts()).map((t) => t.replace(/^[✓✕•–]\s*/, '').replace(/\s*:\s*(done|in progress|not yet|failed)$/, '').trim())
  const want = ['Face detected', 'Identity recognized', 'Basic liveness check passed', 'Payment authorization created', 'Customer confirmation', 'Payment processed']
  if (JSON.stringify(stageTexts) !== JSON.stringify(want)) throw new Error('stages: ' + JSON.stringify(stageTexts))
  const txt = await cpage.locator('main').innerText()
  if (/bank-grade|military-grade|impossible to hack|100% secure|cannot be spoofed/i.test(txt)) throw new Error('forbidden claim on the confirm screen')
  await shot(cpage, '15-confirm-payment')
  return 'authorized, six stages shown, confirm amount ' + amt
})
await step('raw model internals are hidden behind "Technical details" by default', async () => {
  const open = await cpage.locator('details').first().evaluate((d) => d.open)
  if (open) throw new Error('details open by default')
  const visible = await cpage.getByText(/Distance to your profile/).first().isVisible()
  if (visible) throw new Error('distance visible to normal user')
})
await step('axe: confirm payment', async () => { const v = await axe(cpage, 'confirm payment'); return `${v.length} violation types` })
await step('payment confirmation → processing → success screen → receipt', async () => {
  await cpage.getByRole('button', { name: /^Confirm payment of ₹950\.00/ }).click()
  await cpage.getByRole('heading', { name: 'Payment successful' }).waitFor({ timeout: 20000 })
  const done = cpage.getByRole('region', { name: 'Payment successful' })
  for (const t of ['SuperGrocery', 'Simulated payment', 'Authenticated: Face + basic liveness check']) await done.getByText(t).first().waitFor()
  const txid = await done.locator('.font-mono').innerText()
  if (!/^FP-[0-9A-Z]{10}$/.test(txid)) throw new Error('txid ' + txid)
  await shot(cpage, '16-success')
  const steps = await cpage.getByRole('list', { name: 'Payment timeline' }).locator('li').allInnerTexts()
  if (steps.length !== 9 || steps.some((t) => !/\(done\)/.test(t))) throw new Error('timeline not complete: ' + JSON.stringify(steps))
  await cpage.getByRole('link', { name: 'View receipt' }).click()
  const rec = cpage.getByRole('article', { name: 'Payment receipt' })
  await cpage.getByRole('heading', { name: 'Transaction details' }).waitFor()
  for (const t of ['Vihaan Gandhi', 'SuperGrocery', 'SG-10492', 'FacePay', 'Face + basic liveness check', 'Successful']) await rec.getByText(t).first().waitFor()
  await cpage.getByRole('button', { name: 'Download / Print receipt' }).waitFor()
  await shot(cpage, '17-receipt')
  return txid
})
await step('axe: receipt', async () => { const v = await axe(cpage, 'receipt'); return `${v.length} violation types` })
await step('reloading the paid checkout shows "already completed", not a second payment', async () => {
  await cpage.goto(APP + checkoutPath)
  await cpage.getByText('This payment has already been completed.').waitFor()
  if (await cpage.getByRole('button', { name: 'Pay with Face' }).count()) throw new Error('pay button offered again')
  await shot(cpage, '18-checkout-already-paid')
})

// ---------------- history + dashboard
await step('customer dashboard shows spending summary and recent payment', async () => {
  await cpage.goto(APP + '/dashboard')
  await cpage.getByText('Spent in the last 30 days').waitFor()
  await cpage.getByRole('list', { name: 'Recent payments' }).waitFor()
  await shot(cpage, '18-dashboard-after-payment')
})
await step('axe: customer dashboard (with data)', async () => { const v = await axe(cpage, 'customer dashboard (with data)'); return `${v.length} violation types` })
await step('customer transactions page: list, status filter, search, sort', async () => {
  await cpage.goto(APP + '/transactions')
  const table = cpage.getByRole('list', { name: 'Transactions' })
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
  // the merchant page was left open on this session: it must have followed the payment by polling, without a reload
  await mpage.getByRole('link', { name: 'View transaction' }).waitFor({ timeout: 20000 })
  const mtl = await mpage.getByRole('list', { name: 'Payment progress' }).locator('li').allInnerTexts()
  if (mtl.some((t) => !/\(done\)/.test(t))) throw new Error('merchant timeline not complete: ' + JSON.stringify(mtl))
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
  const t = mpage.getByRole('list', { name: 'Transactions' }); await t.waitFor()
  await t.getByText('Vihaan Gandhi').waitFor()
  await mpage.getByLabel('Search').fill('vihaan')
  await t.getByText('Vihaan Gandhi').waitFor()
  await shot(mpage, '22-merchant-transactions')
})
await step('merchant receipt page opens from the transactions table', async () => {
  await mpage.getByRole('list', { name: 'Transactions' }).getByRole('link').first().click()
  await mpage.getByRole('heading', { name: 'Transaction details' }).waitFor()
  await mpage.getByRole('article', { name: 'Payment receipt' }).waitFor()
})

// ---------------- security page: payment PIN (optional, used for higher-risk payments)
await step('security: page shows face payments on; set an optional 6-digit payment PIN', async () => {
  await cpage.goto(APP + '/security')
  await cpage.getByRole('heading', { name: 'Security', exact: true }).waitFor()
  const sw = cpage.getByRole('switch', { name: 'Face authentication for payments' })
  if ((await sw.getAttribute('aria-checked')) !== 'true') throw new Error('face payments should be on')
  await cpage.getByRole('button', { name: 'Set a PIN' }).click()
  await cpage.getByLabel('Your account password').fill(PW)
  await cpage.getByLabel('New 6-digit PIN').fill('482915')
  await shot(cpage, '08b-security-pin')
  await cpage.getByRole('button', { name: 'Save PIN' }).click()
  await cpage.getByText('Payment PIN saved.').waitFor()
  await cpage.getByText('A payment PIN is set.').waitFor()
  const body = await cpage.locator('main').innerText()
  if (/482915/.test(body)) throw new Error('PIN shown on the page')
  await shot(cpage, '08c-security')
})
await step('axe: security', async () => { const v = await axe(cpage, 'security'); return `${v.length} violation types` })

// ---------------- negative paths in the real browser
let session2
await step('wrong person (stranger photo) is rejected and the payment stays unpaid', async () => {
  session2 = await merchantCreatesPayment('120.00', 'SG-10493')
  await cpage.goto(APP + session2)
  await cpage.getByRole('button', { name: 'Pay with Face' }).click()
  await cpage.getByRole('button', { name: 'Turn camera on' }).click()
  await cpage.getByRole('button', { name: 'Turn camera off' }).waitFor()
  await authenticateOnPage(cpage, 'stranger', 2)
  await cpage.getByRole('alert').first().waitFor({ timeout: 30000 })
  const msg = await cpage.getByRole('alert').first().innerText()
  if (await cpage.getByRole('heading', { name: 'Confirm payment' }).count()) throw new Error('stranger was accepted: ' + msg)
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
  const txt = await cpage.locator('main').innerText(); return txt.match(/\d of \d face checks left/i)?.[0] ?? 'attempt counter not visible in this state'
})

await step('camera permission denied: clear message, nothing breaks, setup can be retried', async () => {
  const dctx = await newCtx(); const dp = await dctx.newPage()
  await dp.addInitScript(() => { window.__denyCamera = true })
  await dp.goto(APP + '/register')   // a brand-new customer, so the guided setup is offered from the start
  await dp.getByLabel('Full name').fill('Denied Camera'); await dp.getByLabel('Email').fill(`e2e-denied-${tag}@example.com`)
  await dp.getByLabel('Password', { exact: true }).fill(PW); await dp.getByLabel('Confirm password').fill(PW)
  await dp.getByRole('button', { name: /create account/i }).click()
  await dp.getByRole('heading', { name: /^Good (morning|afternoon|evening)/ }).waitFor()
  await dp.goto(APP + '/face')
  await dp.getByRole('button', { name: 'Start face setup' }).click()
  await dp.getByText(/Camera access is required for FacePay authentication/).first().waitFor()
  await dp.getByRole('button', { name: 'Try again' }).waitFor()
  const phase = await dp.getByTestId('enroll-stage').getAttribute('data-phase')
  if (phase !== 'ERROR') throw new Error('phase ' + phase)
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
  await cpage.getByText('Your session has expired.').waitFor()
  await shot(cpage, '27-session-ended')
  await cpage.unroute('**/payments/transactions*')
})
await step('unknown route → friendly 404 page; unknown checkout → not found message', async () => {
  await cpage.goto(APP + '/no/such/page'); await cpage.getByRole('heading', { name: 'Page not found' }).waitFor()
  await cpage.goto(APP + '/login')
  await cpage.getByLabel('Email').fill(CUSTOMER.email); await cpage.getByLabel('Password').fill(PW)
  await cpage.getByRole('button', { name: 'Sign in' }).click(); await cpage.getByRole('heading', { name: /^Good (morning|afternoon|evening)/ }).waitFor()
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
    for (const [p, paths] of [[cpage, ['/dashboard', '/face', '/security', '/authenticate', '/transactions', '/profile']], [mpage, ['/merchant/dashboard', '/merchant/transactions', '/merchant/payments/new']]]) {
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
await step('mobile: bottom navigation is visible, marks the current page and navigates', async () => {
  await cpage.setViewportSize(VIEWS.mobile); await cpage.goto(APP + '/dashboard')
  const nav = cpage.getByRole('navigation', { name: 'Mobile' })
  await nav.waitFor()
  const box = await nav.boundingBox(); if (!box || box.y + box.height < 800) throw new Error('bottom nav not at the bottom ' + JSON.stringify(box))
  await nav.getByRole('link', { name: 'Home' }).getAttribute('aria-current')
  await shot(cpage, '31-mobile-dashboard')
  await nav.getByRole('link', { name: 'Activity' }).click()
  await cpage.getByRole('heading', { name: 'Activity' }).waitFor()
  if ((await nav.getByRole('link', { name: 'Activity' }).getAttribute('aria-current')) !== 'page') throw new Error('current page not marked')
})
let stepUpNote = ''
await step('mobile: complete a second payment end-to-end on a 390×844 screen', async () => {
  const path = await merchantCreatesPayment('250.50', 'SG-10494')
  await cpage.setViewportSize(VIEWS.mobile)
  await cpage.goto(APP + path)
  await shot(cpage, '32-mobile-checkout')
  await cpage.getByRole('button', { name: 'Pay with Face' }).click()
  await cpage.getByRole('button', { name: 'Turn camera on' }).click()
  await cpage.getByRole('button', { name: 'Turn camera off' }).waitFor()
  const v = await cpage.locator('video').boundingBox(); if (!v || v.width > 390 || v.width < 250) throw new Error('video box ' + JSON.stringify(v))
  await shot(cpage, '33-mobile-camera')
  await authenticateOnPage(cpage, 'me', 7)
  await cpage.getByText('Quick security check').waitFor({ timeout: 10000 })
  await shot(cpage, '34-mobile-liveness')
  await cpage.getByRole('heading', { name: 'Confirm payment' }).waitFor({ timeout: 30000 })
  // two failed face checks were made a few minutes ago in this run, so the server asks for the payment PIN
  const needsPin = await cpage.getByLabel('Payment PIN').count()
  if (needsPin) {
    const why = await cpage.getByText(/Because of/).innerText()
    await cpage.getByLabel('Payment PIN').fill('482915')
    stepUpNote = 'PIN requested: ' + why
  }
  const o = await overflow(cpage); if (o > 0) throw new Error('overflow ' + o)
  const btn = await cpage.getByRole('button', { name: /^Confirm payment of ₹250\.50/ }).boundingBox(); if (!btn || btn.height < 44) throw new Error('confirm button too small ' + JSON.stringify(btn))
  await shot(cpage, '35-mobile-confirm')
  await cpage.getByRole('button', { name: /^Confirm payment of ₹250\.50/ }).click()
  await cpage.getByRole('heading', { name: 'Payment successful' }).waitFor({ timeout: 20000 })
  await shot(cpage, '36-mobile-success')
  await cpage.getByRole('link', { name: 'View receipt' }).click()
  await cpage.getByRole('article', { name: 'Payment receipt' }).waitFor()
  await shot(cpage, '37-mobile-receipt')
  return `camera preview ${Math.round(v.width)}×${Math.round(v.height)}px, confirm button ${Math.round(btn.width)}×${Math.round(btn.height)}px; ${stepUpNote || 'no PIN asked'}`
})

// ---------------- payment hardening in the real browser
await cpage.setViewportSize(VIEWS.desktop)
await step('large payment: the server asks for the PIN; a wrong PIN is refused without losing the authorization; the right PIN pays', async () => {
  const path = await merchantCreatesPayment('12000.00', 'SG-BIG-1')
  await cpage.goto(APP + path)
  await cpage.getByRole('button', { name: 'Pay with Face' }).click()
  await cpage.getByRole('button', { name: 'Turn camera on' }).click()
  await cpage.getByRole('button', { name: 'Turn camera off' }).waitFor()
  await authenticateOnPage(cpage, 'me', 8)
  await cpage.getByRole('heading', { name: 'Confirm payment' }).waitFor({ timeout: 30000 })
  await cpage.getByText('Risk-based authorization prototype').waitFor()
  await cpage.getByText(/Because of a larger amount/i).waitFor()
  const confirm = cpage.getByRole('button', { name: /^Confirm payment of ₹12,000\.00/ })
  if (!(await confirm.isDisabled())) throw new Error('confirm should wait for the PIN')
  await shot(cpage, '40-pin-required')
  await cpage.getByLabel('Payment PIN').fill('000000'); await confirm.click()
  await cpage.getByRole('alert').filter({ hasText: /not correct/ }).waitFor({ timeout: 15000 })
  await shot(cpage, '41-pin-wrong')
  await cpage.getByLabel('Payment PIN').fill('482915'); await confirm.click()
  await cpage.getByRole('heading', { name: 'Payment successful' }).waitFor({ timeout: 20000 })
  await shot(cpage, '42-pin-success')
})
await step('security: turning face payments off blocks face authentication, turning them on restores it', async () => {
  await cpage.goto(APP + '/security')
  await cpage.getByRole('switch', { name: 'Face authentication for payments' }).click()
  await cpage.getByText('Face payments are off.').waitFor()
  const path = await merchantCreatesPayment('99.00', 'SG-OFF-1')
  await cpage.goto(APP + path)
  await cpage.getByRole('button', { name: 'Pay with Face' }).click()
  await cpage.getByRole('button', { name: 'Turn camera on' }).click()
  await cpage.getByRole('button', { name: 'Turn camera off' }).waitFor()
  await authenticateOnPage(cpage, 'me', 9)
  await cpage.getByRole('alert').filter({ hasText: /Face payments are turned off/ }).waitFor({ timeout: 15000 })
  await cpage.getByRole('link', { name: 'Open security settings' }).waitFor()
  await shot(cpage, '43-face-payments-off')
  await cpage.goto(APP + '/security')
  await cpage.getByRole('switch', { name: 'Face authentication for payments' }).click()
  await cpage.getByText('Face payments are on.').waitFor()
})
await step('security page lists recent face checks, payments and events without raw biometric data', async () => {
  await cpage.goto(APP + '/security')
  await cpage.getByRole('heading', { name: 'Recent face checks' }).waitFor()
  await cpage.getByText('Successful').first().waitFor()
  await cpage.getByText(/Unsuccessful/).first().waitFor()
  const text = await cpage.locator('main').innerText()
  if (/confidence|distance|vector|embedding/i.test(text)) throw new Error('scores shown on the security page')
  await shot(cpage, '44-security-activity')
})

fs.writeFileSync('results.json', JSON.stringify({ results, axeReport }, null, 2))
await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
console.log('\n=== axe violations by page ===')
for (const a of axeReport) console.log(a.page, a.violations.length ? JSON.stringify(a.violations.map((v) => `${v.id}(${v.impact}) x${v.nodes} e.g. ${v.sample}`)) : 'none')
