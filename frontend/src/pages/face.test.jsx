import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../services/api'
import { captureFrame } from '../utils/capture'
import { customerProfile, mockApi, renderApp, storeSession } from '../test/helpers'
import { ENROLL_CONFIG } from '../utils/enrollConfig'


// Live readings come from the canvas in a real browser; here the test decides what the camera "sees".
const metrics = vi.hoisted(() => ({ value: { brightness: 120, sharpness: 50, motion: 0 } }))
vi.mock('../utils/frameMetrics', () => ({ measureFrame: () => ({ ...metrics.value, signature: new Float32Array(1) }) }))

const SEQ = ['neutral', 'turn_left', 'turn_right', 'chin_up', 'chin_down']
const guidedOf = (counts = {}) => {
  const sequence = SEQ.map((pose) => ({ pose, instruction: `Instruction for ${pose}`, count: counts[pose] ?? 0, target: 3 }))
  const captured = sequence.reduce((n, p) => n + p.count, 0)
  const next = sequence.find((p) => p.count < p.target)
  return { sequence, captured, required: 15, next_pose: next?.pose ?? null, complete: !next }
}
const enrollmentOf = (counts = {}, over = {}) => {
  const g = guidedOf(counts)
  return {
    guided: g, poses: [], total_samples: g.captured, distinct_poses: g.sequence.filter((p) => p.count).length,
    max_samples: 60, min_samples_to_train: 12, min_poses_to_train: 3, eligible: g.captured >= 12, has_profile: false, ...over,
  }
}
// What a customer's model endpoint returns: readiness only. Settings and scores are administrator-only.
const modelBody = (over = {}) => ({
  version: '20261007-101010-abc123-ef01',
  trained_at: '2026-10-07T10:10:10Z',
  includes_you: true,
  stale: false,
  ...over,
})
const quality = { sharpness: 300, brightness: 120, face_size: 150, aligned: true }

let stopTrack
function installCamera({ reject } = {}) {
  stopTrack = vi.fn()
  const getUserMedia = reject
    ? vi.fn().mockRejectedValue(Object.assign(new Error('no'), { name: reject }))
    : vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] })
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
  return getUserMedia
}


const GOOD = { state: 'OK', faces: 1, face: { cx: 0.5, cy: 0.5, width: 0.4, height: 0.5 } }
const TURNED = { state: 'OK', faces: 1, face: { cx: 0.6, cy: 0.5, width: 0.4, height: 0.5 } } // moved toward the user's left

let counts
let scene // what the server's live check reports; each test changes it
const FAST = { pollIntervalMs: 5, stableMs: 40, cooldownMs: 20, successFlashMs: 25, successFlashReducedMs: 10, nextPoseMs: 25, poseRelaxMs: 60_000 }
const ORIGINAL = { ...ENROLL_CONFIG }

beforeEach(() => {
  Object.assign(ENROLL_CONFIG, FAST)
  counts = {}
  scene = GOOD
  metrics.value = { brightness: 120, sharpness: 50, motion: 0 }
  installCamera()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { value: 640, configurable: true })
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { value: 480, configurable: true })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() })
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,QUJDRA==')
  storeSession('customer')
})
afterEach(() => {
  Object.assign(ENROLL_CONFIG, ORIGINAL)
  vi.restoreAllMocks()
  delete navigator.mediaDevices
  delete window.matchMedia
})

const routes = (extra = {}) => ({
  'GET /users/me': { body: customerProfile },
  'GET /faces/enrollment': () => ({ body: enrollmentOf(counts) }),
  'GET /faces/model': { body: { model: null } },
  'POST /faces/assess': () => ({ body: scene }),
  'POST /faces/samples': ({ body }) => {
    counts[body.pose] = (counts[body.pose] ?? 0) + 1
    const e = enrollmentOf(counts)
    return { status: 201, body: { accepted: true, quality, next_pose: e.guided.next_pose, progress: { captured: e.guided.captured, required: 15 }, enrollment: e } }
  },
  ...extra,
})

async function openPage(extra) {
  const api = mockApi(routes(extra))
  renderApp('/face')
  await screen.findByRole('heading', { name: 'Face setup' })
  await screen.findByRole('button', { name: /(Start|Continue) face setup|Finish setup/ })
  return api
}

describe('recognition status on the setup page', () => {
  const checks = (o = {}) => ({ samples: { have: 15, need: 12 }, poses: { have: 5, need: 3 }, people_with_finished_setup: { enough: false }, model_active: false, you_are_in_model: false, ...o })
  it('says exactly why recognition cannot run and never offers to invent a second person', async () => {
    await openPage({ 'GET /faces/readiness': { body: { ready: false, code: 'INSUFFICIENT_IDENTITIES', message: 'The recognition model needs at least two people with a finished face setup.', next_action: 'WAIT_FOR_SECOND_PERSON', stale: false, model_version: null, checks: checks() } } })
    const panel = await screen.findByRole('region', { name: 'Recognition status' })
    expect(panel).toHaveTextContent('needs at least two people')
    expect(panel).toHaveTextContent('Usable samples: 15 of 12 needed')
    expect(panel).toHaveTextContent('No trained model yet.')
    expect(panel).toHaveTextContent('never creates a second person')
  })
  it('reports ready when the server says so', async () => {
    await openPage({ 'GET /faces/readiness': { body: { ready: true, code: null, message: '', next_action: null, stale: false, model_version: 3, checks: checks({ people_with_finished_setup: { enough: true }, model_active: true, you_are_in_model: true }) } } })
    expect(await screen.findByText('Face recognition is ready for your account.')).toBeInTheDocument()
  })
})

const phase = () => screen.getByTestId('enroll-stage').dataset.phase
const startSetup = async (user) => user.click(screen.getByRole('button', { name: /(Start|Continue) face setup/ }))
const until = (fn, timeout = 4000) => waitFor(fn, { timeout })


describe('captureFrame', () => {
  it('returns bare base64 JPEG and downsizes large frames', () => {
    const video = { videoWidth: 1920, videoHeight: 1080 }
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }), toDataURL: () => 'data:image/jpeg;base64,AAAA' }
    vi.spyOn(document, 'createElement').mockReturnValue(canvas)
    expect(captureFrame(video)).toBe('AAAA')
    expect(Math.max(canvas.width, canvas.height)).toBe(640)
  })
  it('refuses when the camera has no frame yet', () => {
    expect(() => captureFrame({ videoWidth: 0, videoHeight: 0 })).toThrow(/not ready/)
  })
})

describe('api errors with reason codes', () => {
  it('exposes message and code from {code, message} details', async () => {
    mockApi({ 'GET /x': { status: 422, body: { detail: { code: 'TOO_BLURRY', message: 'The image is blurry.' } } } })
    const { apiFetch } = await import('../services/api')
    await expect(apiFetch('/x')).rejects.toMatchObject({ message: 'The image is blurry.', code: 'TOO_BLURRY', status: 422 })
    expect(new ApiError('m', 400).code).toBeNull()
  })
})

describe('guided face setup', () => {
  it('has no per-sample capture button and no manual pose picker', async () => {
    await openPage()
    expect(screen.queryByRole('button', { name: /capture sample/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start face setup' })).toBeEnabled()
    expect(phase()).toBe('IDLE')
  })

  it('is reachable from the customer navigation', async () => {
    mockApi(routes())
    renderApp('/dashboard')
    expect((await screen.findAllByRole('link', { name: 'Face profile' }))[0]).toHaveAttribute('href', '/face')
  })

  it('shows five head positions and overall progress from the server', async () => {
    counts = { neutral: 3, turn_left: 1 }
    await openPage()
    const steps = within(screen.getByRole('list', { name: 'Head positions' })).getAllByRole('listitem')
    expect(steps.map((li) => li.textContent.replace(/\s+/g, ' ').trim())).toEqual([
      expect.stringContaining('Straight'), expect.stringContaining('Left'), expect.stringContaining('Right'), expect.stringContaining('Up'), expect.stringContaining('Down'),
    ])
    expect(within(steps[0]).getByText('done')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Setup progress' })).toHaveAttribute('aria-valuenow', '4')
    expect(screen.getByText('4 of 15')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue face setup' })).toBeInTheDocument() // resumes where the server says
  })

  it('walks CAMERA_STARTING → POSITION_FACE → CHECKING_QUALITY → CAPTURING → CAPTURE_SUCCESS on its own', async () => {
    const user = userEvent.setup()
    const api = await openPage()
    const seen = new Set()
    const watcher = setInterval(() => { try { seen.add(phase()) } catch { /* unmounted */ } }, 2)
    await startSetup(user)
    await until(() => expect(api.callsTo('POST /faces/samples').length).toBeGreaterThanOrEqual(1))
    await until(() => expect(screen.getByTestId('pose-samples')).toHaveTextContent('Straight: 1 of 3'))
    clearInterval(watcher)
    for (const p of ['CAMERA_STARTING', 'POSITION_FACE', 'CHECKING_QUALITY', 'CAPTURING', 'CAPTURE_SUCCESS']) expect(seen).toContain(p)
    const first = api.callsTo('POST /faces/samples')[0]
    expect(first.body).toEqual({ image_base64: 'QUJDRA==', pose: 'neutral' })
    expect(first.headers.Authorization).toBe('Bearer token-for-customer')
    expect(screen.getByRole('progressbar', { name: 'Setup progress' })).toHaveAttribute('aria-valuenow', '1')
  })

  it('does not capture on a good frame that is not held: the stability window has to run uninterrupted', async () => {
    let n = 0
    const user = userEvent.setup()
    const api = await openPage({ 'POST /faces/assess': () => ({ body: n++ % 2 ? GOOD : { state: 'NO_FACE', faces: 0, face: null } }) })
    await startSetup(user)
    await until(() => expect(api.callsTo('POST /faces/assess').length).toBeGreaterThan(20))
    expect(api.callsTo('POST /faces/samples')).toHaveLength(0)
    expect(counts).toEqual({})
  })

  it('moves on to the next position after the current one is complete, and asks for the head movement', async () => {
    counts = { neutral: 2 }
    const user = userEvent.setup()
    await openPage()
    await startSetup(user)
    // the last straight sample is captured, then the prompt for the next position appears
    await until(() => expect(screen.getByText(/Next: slowly turn your head to the left/i)).toBeInTheDocument())
    expect(counts.neutral).toBe(3)
    // still centred, so the turn has not happened yet: the guidance says so and nothing is captured
    await until(() => expect(screen.getAllByText('Turn a little more to the left').length).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 200))
    expect(counts.turn_left).toBeUndefined()
    // now the face moves toward the user's left, and captures begin with the right pose label
    scene = TURNED
    await until(() => expect(counts.turn_left).toBeGreaterThanOrEqual(1))
  })

  it.each([
    ['no face', { state: 'NO_FACE', faces: 0, face: null }, 'Face the camera'],
    ['two faces', { state: 'OK', faces: 2, face: GOOD.face }, 'Only one face should be visible'],
    ['too far', { state: 'FACE_TOO_SMALL', faces: 1, face: { ...GOOD.face, width: 0.1 } }, 'Move a little closer'],
    ['too close', { state: 'OK', faces: 1, face: { ...GOOD.face, width: 0.8 } }, 'Move slightly farther away'],
    ['off centre', { state: 'OK', faces: 1, face: { ...GOOD.face, cx: 0.85 } }, 'Center your face'],
    ['dark (server)', { state: 'TOO_DARK', faces: 1, face: GOOD.face }, 'Improve the lighting'],
    ['blurry (server)', { state: 'TOO_BLURRY', faces: 1, face: GOOD.face }, 'Hold still'],
  ])('tells the person what to fix: %s', async (_name, reading, message) => {
    scene = reading
    const user = userEvent.setup()
    const api = await openPage()
    await startSetup(user)
    await until(() => expect(screen.getAllByText(message).length).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 150))
    expect(api.callsTo('POST /faces/samples')).toHaveLength(0) // nothing is captured while a condition fails
    expect(document.body.textContent).not.toMatch(/\b0\.\d{2}\b|width|threshold|sharpness/i) // no raw numbers or jargon
  })

  it('treats poor lighting measured in the browser the same way', async () => {
    metrics.value = { brightness: 12, sharpness: 50, motion: 0 }
    const user = userEvent.setup()
    const api = await openPage()
    await startSetup(user)
    await until(() => expect(screen.getAllByText('Improve the lighting').length).toBeGreaterThan(0))
    expect(api.callsTo('POST /faces/samples')).toHaveLength(0)
  })

  it('asks the person to hold still while they are moving', async () => {
    metrics.value = { brightness: 120, sharpness: 50, motion: 40 }
    const user = userEvent.setup()
    const api = await openPage()
    await startSetup(user)
    await until(() => expect(screen.getAllByText('Hold still').length).toBeGreaterThan(0))
    expect(api.callsTo('POST /faces/samples')).toHaveLength(0)
  })

  it('suggests removing sunglasses when no face is found for a while', async () => {
    scene = { state: 'NO_FACE', faces: 0, face: null }
    const user = userEvent.setup()
    await openPage()
    await startSetup(user)
    await until(() => expect(screen.getAllByText(/remove sunglasses/i).length).toBeGreaterThan(0))
  })

  it('shows the server’s reason when a captured sample is declined, then tries again', async () => {
    let first = true
    const user = userEvent.setup()
    const api = await openPage({
      'POST /faces/samples': ({ body }) => {
        if (first) { first = false; return { status: 422, body: { detail: { code: 'TOO_BLURRY', message: 'The image is blurry.' } } } }
        counts[body.pose] = (counts[body.pose] ?? 0) + 1
        const e = enrollmentOf(counts)
        return { status: 201, body: { accepted: true, quality, next_pose: e.guided.next_pose, progress: { captured: e.guided.captured, required: 15 }, enrollment: e } }
      },
    })
    await startSetup(user)
    await until(() => expect(api.callsTo('POST /faces/samples').length).toBeGreaterThanOrEqual(2))
    await until(() => expect(counts.neutral).toBe(1)) // the declined frame did not count, the next one did
    expect(screen.queryByText('The image is blurry.')).not.toBeInTheDocument() // the friendly wording is shown instead
  })

  it('asks for a small movement when the server finds a duplicate frame', async () => {
    let first = true
    const user = userEvent.setup()
    await openPage({
      'POST /faces/samples': () => {
        if (first) { first = false; return { status: 409, body: { detail: { code: 'DUPLICATE_SAMPLE', message: 'dup' } } } }
        return { status: 409, body: { detail: { code: 'DUPLICATE_SAMPLE', message: 'dup' } } }
      },
    })
    await startSetup(user)
    await until(() => expect(screen.getAllByText('Move slightly and hold still').length).toBeGreaterThan(0))
  })

  it('completes after the last sample, releases the camera and prepares the profile', async () => {
    counts = { neutral: 3, turn_left: 3, turn_right: 3, chin_up: 3, chin_down: 2 }
    scene = { state: 'OK', faces: 1, face: { cx: 0.5, cy: 0.57, width: 0.4, height: 0.5 } } // chin lowered
    let trained = false
    const user = userEvent.setup()
    const api = await openPage({
      'GET /faces/model': () => ({ body: { model: trained ? modelBody() : null } }),
      'POST /faces/train': () => { trained = true; return { body: modelBody() } },
    })
    await startSetup(user)
    await until(() => expect(screen.getAllByText(/Your face profile is ready/).length).toBeGreaterThan(0))
    expect(counts.chin_down).toBe(3)
    expect(api.callsTo('POST /faces/train')).toHaveLength(1)
    expect(screen.getAllByText('Face setup complete').length).toBeGreaterThan(0)
    expect(stopTrack).toHaveBeenCalled()
    expect(screen.getByRole('progressbar', { name: 'Setup progress' })).toHaveAttribute('aria-valuenow', '15')
  })

  it('offers to finish again when preparing the profile fails', async () => {
    counts = { neutral: 3, turn_left: 3, turn_right: 3, chin_up: 3, chin_down: 2 }
    scene = { state: 'OK', faces: 1, face: { cx: 0.5, cy: 0.57, width: 0.4, height: 0.5 } }
    const user = userEvent.setup()
    await openPage({ 'POST /faces/train': { status: 422, body: { detail: { code: 'NOT_ENOUGH_USERS', message: 'At least 2 enrolled users are required: LDA separates classes, so it needs 2 or more.' } } } })
    await startSetup(user)
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent('At least 2 enrolled users are required')
    expect(screen.getByRole('button', { name: 'Finish setup' })).toBeInTheDocument()
  })

  it('explains a blocked camera and lets the person try again', async () => {
    installCamera({ reject: 'NotAllowedError' })
    const user = userEvent.setup()
    await openPage()
    await startSetup(user)
    expect((await screen.findAllByText(/Camera access is required/)).length).toBeGreaterThan(0)
    expect(phase()).toBe('ERROR')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
  })

  it('reports an unsupported browser', async () => {
    delete navigator.mediaDevices
    const user = userEvent.setup()
    await openPage()
    await startSetup(user)
    expect((await screen.findAllByText(/cannot access a camera/)).length).toBeGreaterThan(0)
    expect(phase()).toBe('ERROR')
  })

  it('stops and says so when the connection to FacePay keeps failing', async () => {
    Object.assign(ENROLL_CONFIG, { maxConsecutiveErrors: 3 })
    const user = userEvent.setup()
    await openPage({ 'POST /faces/assess': { status: 500, body: { detail: 'boom' } } })
    await startSetup(user)
    await until(() => expect(phase()).toBe('ERROR'))
    expect(screen.getAllByText(/could not reach FacePay|Face setup stopped/).length).toBeGreaterThan(0)
  })

  it('cancelling returns to the start and turns the camera off', async () => {
    scene = { state: 'NO_FACE', faces: 0, face: null }
    const user = userEvent.setup()
    await openPage()
    await startSetup(user)
    await until(() => expect(phase()).toBe('POSITION_FACE'))
    await user.click(screen.getByRole('button', { name: 'Cancel setup' }))
    expect(phase()).toBe('IDLE')
    expect(stopTrack).toHaveBeenCalled()
  })

  it('uses a shorter, calmer confirmation when the system asks for reduced motion', async () => {
    window.matchMedia = vi.fn().mockImplementation((query) => ({ matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    await openPage()
    expect(screen.getByTestId('enroll-stage')).toHaveAttribute('data-motion', 'reduced')
  })

  it('keeps full motion by default', async () => {
    window.matchMedia = vi.fn().mockImplementation((query) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    await openPage()
    expect(screen.getByTestId('enroll-stage')).toHaveAttribute('data-motion', 'full')
  })

  it('is built for a phone first and announces progress to screen readers', async () => {
    const user = userEvent.setup()
    await openPage()
    const start = screen.getByRole('button', { name: 'Start face setup' })
    expect(start.className).toMatch(/min-h-14/) // a thumb-sized target
    expect(start.className).toMatch(/w-full/)
    expect(screen.getByTestId('enroll-stage').querySelector('.aspect-\\[3\\/4\\]')).not.toBeNull() // portrait preview on small screens
    expect(screen.getAllByRole('status').some((el) => el.getAttribute('aria-live') === 'polite')).toBe(true)
    await startSetup(user)
    await until(() => expect(screen.getByRole('listitem', { current: 'step' })).toBeInTheDocument())
  })

  it('does not use recognition jargon while enrolling', async () => {
    const user = userEvent.setup()
    await openPage()
    await startSetup(user)
    const card = screen.getByRole('region', { name: 'Guided face setup' })
    expect(card.textContent).not.toMatch(/\bPCA\b|\bLDA\b|eigen|classifier/i)
    expect(screen.getByText('How FacePay works')).toBeInTheDocument() // the explanation lives in its own section
  })

  it('never renders an image of the user', async () => {
    const user = userEvent.setup()
    await openPage()
    await startSetup(user)
    await until(() => expect(phase()).not.toBe('IDLE'))
    expect(document.querySelectorAll('img, canvas')).toHaveLength(0)
  })

  it('stops the camera when leaving the page', async () => {
    const user = userEvent.setup()
    mockApi(routes())
    const { unmount } = renderApp('/face')
    await user.click(await screen.findByRole('button', { name: 'Start face setup' }))
    await until(() => expect(phase()).not.toBe('CAMERA_STARTING'))
    unmount()
    expect(stopTrack).toHaveBeenCalled()
  })
})

describe('face data controls and recognition test', () => {
  it('deletes face data only after an in-page confirmation', async () => {
    counts = { neutral: 3, turn_left: 2 }
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm')
    const api = await openPage({ 'DELETE /faces/samples': () => { counts = {}; return { status: 204, body: null } } })
    await user.click(screen.getByRole('button', { name: 'Delete my face data' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('cannot be undone')
    await user.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(api.callsTo('DELETE /faces/samples')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Delete my face data' }))
    await user.click(screen.getByRole('button', { name: 'Delete face data' }))
    expect(await screen.findByText(/Your face data was deleted/)).toBeInTheDocument()
    expect(api.callsTo('DELETE /faces/samples')).toHaveLength(1)
    expect(confirm).not.toHaveBeenCalled() // no browser dialog
    // re-enrolling starts from the beginning again
    expect(await screen.findByRole('button', { name: 'Start face setup' })).toBeInTheDocument()
  })

  it('shows whether the model includes the customer and nothing about how it works', async () => {
    await openPage({ 'GET /faces/model': { body: { model: modelBody() } } })
    const panel = await screen.findByRole('region', { name: 'Model' })
    expect(within(panel).getByText(/part of the current model/)).toBeInTheDocument()
    expect(panel.textContent).not.toMatch(/PCA|LDA|KNN|SVM|accuracy|F1|threshold|validation|classifier/i)
  })

  it('does not allow recognition before the user is in a model', async () => {
    await openPage()
    expect(screen.getByRole('button', { name: 'Turn camera on to test' })).toBeDisabled()
  })

  it.each([
    [{ matched: true, reason: 'MATCH', predicted_is_you: true }, 'Recognised as you.', 'status'],
    [{ matched: false, reason: 'WRONG_IDENTITY', predicted_is_you: false }, 'The model thinks this is someone else.', 'alert'],
    [{ matched: false, reason: 'TOO_FAR_FROM_PROFILE', predicted_is_you: true }, 'not close enough', 'alert'],
  ])('shows the recognition outcome %#', async (body, text, role) => {
    const user = userEvent.setup()
    const api = await openPage({
      'GET /faces/model': { body: { model: modelBody() } },
      'POST /faces/recognize': { body: { model_version: 'v', quality, ...body } },
    })
    await user.click(screen.getByRole('button', { name: 'Turn camera on to test' }))
    await user.click(await screen.findByRole('button', { name: 'Recognise me' }))
    const alert = await screen.findAllByRole(role)
    expect(alert.some((a) => a.textContent.includes(text))).toBe(true)
    expect(document.body.textContent).not.toMatch(/confidence|distance|\d+\.\d%/i) // no scores for customers
    expect(api.callsTo('POST /faces/recognize')[0].body).toEqual({ image_base64: 'QUJDRA==' })
  })
})

