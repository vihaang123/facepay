import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../services/api'
import { captureFrame } from '../utils/capture'
import { customerProfile, mockApi, renderApp, storeSession } from '../test/helpers'

const POSES = ['neutral', 'turn_left', 'turn_right', 'chin_up', 'smile', 'lighting']
const enrollment = (over = {}) => ({
  poses: POSES.map((pose) => ({ pose, instruction: `Instruction for ${pose}`, count: 0, target: 4 })),
  total_samples: 0,
  distinct_poses: 0,
  max_samples: 60,
  min_samples_to_train: 12,
  min_poses_to_train: 3,
  eligible: false,
  has_profile: false,
  ...over,
})
const modelBody = (over = {}) => ({
  version: '20261007-101010-abc123-ef01',
  trained_at: '2026-10-07T10:10:10Z',
  n_users: 2,
  n_samples: 24,
  classifier: 'pca_lda_knn',
  pca: { n_components: 9 },
  lda: { n_components: 1 },
  validation: 'group_kfold_by_pose(k=4)',
  comparison: {
    pca_knn: { accuracy: 0.9, macro_precision: 0.9, macro_recall: 0.9, macro_f1: 0.9, predict_ms_per_sample: 1 },
    pca_lda_knn: { accuracy: 0.95, macro_precision: 0.95, macro_recall: 0.95, macro_f1: 0.94, predict_ms_per_sample: 1 },
    pca_lda_svm: { accuracy: 0.93, macro_precision: 0.93, macro_recall: 0.93, macro_f1: 0.92, predict_ms_per_sample: 1 },
  },
  distance_threshold: 8.5,
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

beforeEach(() => {
  installCamera()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { value: 640, configurable: true })
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { value: 480, configurable: true })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() })
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,QUJDRA==')
  storeSession('customer')
})
afterEach(() => {
  vi.restoreAllMocks()
  delete navigator.mediaDevices
})

const baseRoutes = (extra = {}) => ({
  'GET /users/me': { body: customerProfile },
  'GET /faces/enrollment': { body: enrollment() },
  'GET /faces/model': { body: { model: null } },
  ...extra,
})

async function openPage(routes) {
  const api = mockApi(routes)
  renderApp('/face')
  await screen.findByRole('heading', { name: 'Face setup' })
  await screen.findByText('Instruction for neutral')
  return api
}

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

describe('face setup page', () => {
  it('is reachable from the customer navigation', async () => {
    mockApi(baseRoutes())
    renderApp('/dashboard')
    expect(await screen.findByRole('link', { name: 'Face setup' })).toHaveAttribute('href', '/face')
  })

  it('shows pose instructions and progress from the server', async () => {
    await openPage(baseRoutes({ 'GET /faces/enrollment': { body: enrollment({ total_samples: 2, distinct_poses: 1, poses: enrollment().poses.map((p) => (p.pose === 'neutral' ? { ...p, count: 2 } : p)) }) } }))
    expect(screen.getByTestId('count-neutral')).toHaveTextContent('2/4')
    expect(screen.getByText(/you have 2 across 1/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Train model' })).toBeDisabled()
  })

  it('explains a blocked camera', async () => {
    installCamera({ reject: 'NotAllowedError' })
    const user = userEvent.setup()
    await openPage(baseRoutes())
    await user.click(screen.getByRole('button', { name: 'Turn camera on' }))
    expect(await screen.findByText(/Camera access was blocked/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Capture sample' })).toBeDisabled()
  })

  it('reports an unsupported browser', async () => {
    delete navigator.mediaDevices
    await openPage(baseRoutes())
    expect(screen.getByText(/cannot access a camera/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Turn camera on' })).toBeDisabled()
  })

  it('captures the selected pose, posts bare base64 and updates progress', async () => {
    const user = userEvent.setup()
    const api = await openPage(
      baseRoutes({
        'POST /faces/samples': {
          status: 201,
          body: { accepted: true, quality, enrollment: enrollment({ total_samples: 1, distinct_poses: 1, poses: enrollment().poses.map((p) => (p.pose === 'turn_left' ? { ...p, count: 1 } : p)) }) },
        },
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Turn camera on' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Capture sample' })).toBeEnabled())
    await user.click(screen.getByLabelText(/Instruction for turn_left/))
    await user.click(screen.getByRole('button', { name: 'Capture sample' }))
    expect(await screen.findByText(/^Sample saved\./)).toBeInTheDocument()
    const call = api.callsTo('POST /faces/samples')[0]
    expect(call.body).toEqual({ image_base64: 'QUJDRA==', pose: 'turn_left' })
    expect(call.headers.Authorization).toBe('Bearer token-for-customer')
    expect(screen.getByTestId('count-turn_left')).toHaveTextContent('1/4')
  })

  it('shows the server’s reason when a sample is rejected', async () => {
    const user = userEvent.setup()
    await openPage(baseRoutes({ 'POST /faces/samples': { status: 422, body: { detail: { code: 'TOO_BLURRY', message: 'The image is blurry. Hold still and try again.' } } } }))
    await user.click(screen.getByRole('button', { name: 'Turn camera on' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Capture sample' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Capture sample' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The image is blurry. Hold still and try again.')
  })

  it('trains when eligible and shows the real comparison returned by the server', async () => {
    const user = userEvent.setup()
    let trained = false
    const api = await openPage(
      baseRoutes({
        'GET /faces/enrollment': () => ({ body: enrollment({ total_samples: 12, distinct_poses: 4, eligible: true, has_profile: trained }) }),
        'GET /faces/model': () => ({ body: { model: trained ? modelBody() : null } }),
        'POST /faces/train': () => {
          trained = true
          return { body: modelBody() }
        },
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Train model' }))
    const panel = await screen.findByRole('region', { name: 'Model' })
    expect(api.callsTo('POST /faces/train')).toHaveLength(1)
    const rows = within(panel).getAllByRole('row').map((r) => r.textContent)
    expect(rows.some((t) => t.includes('PCA + LDA + KNN') && t.includes('95.0%'))).toBe(true)
    expect(rows.some((t) => t.includes('PCA + KNN') && t.includes('90.0%'))).toBe(true)
    expect(within(panel).getByText('group_kfold_by_pose(k=4)')).toBeInTheDocument()
  })

  it('surfaces the two-user requirement from the server', async () => {
    const user = userEvent.setup()
    await openPage(
      baseRoutes({
        'GET /faces/enrollment': { body: enrollment({ total_samples: 12, distinct_poses: 4, eligible: true }) },
        'POST /faces/train': { status: 422, body: { detail: { code: 'NOT_ENOUGH_USERS', message: 'At least 2 enrolled users are required: LDA separates classes, so it needs 2 or more.' } } },
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Train model' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('At least 2 enrolled users are required')
  })

  it.each([
    [{ matched: true, reason: 'MATCH', predicted_is_you: true, user_id: 1, confidence: 0.87, distance_to_you: 3.2, distance_threshold: 8.5 }, 'Recognised as you.', 'status'],
    [{ matched: false, reason: 'WRONG_IDENTITY', predicted_is_you: false, user_id: null, confidence: 0.71, distance_to_you: 14.1, distance_threshold: 8.5 }, 'The model thinks this is someone else.', 'alert'],
    [{ matched: false, reason: 'TOO_FAR_FROM_PROFILE', predicted_is_you: true, user_id: 1, confidence: 0.63, distance_to_you: 12, distance_threshold: 8.5 }, 'not close enough', 'alert'],
  ])('shows the recognition outcome %#', async (body, text, role) => {
    const user = userEvent.setup()
    const api = await openPage(
      baseRoutes({
        'GET /faces/model': { body: { model: modelBody() } },
        'POST /faces/recognize': { body: { model_version: 'v', quality, ...body } },
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Turn camera on' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Recognise me' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Recognise me' }))
    const alert = await screen.findAllByRole(role)
    expect(alert.some((a) => a.textContent.includes(text))).toBe(true)
    expect(screen.getByText(`${(body.confidence * 100).toFixed(1)}%`)).toBeInTheDocument()
    expect(api.callsTo('POST /faces/recognize')[0].body).toEqual({ image_base64: 'QUJDRA==' })
  })

  it('does not allow recognition before the user is in a model', async () => {
    await openPage(baseRoutes())
    expect(screen.getByRole('button', { name: 'Recognise me' })).toBeDisabled()
  })

  it('deletes face data only after an in-page confirmation', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm')
    const api = await openPage(
      baseRoutes({
        'GET /faces/enrollment': { body: enrollment({ total_samples: 5, distinct_poses: 2 }) },
        'DELETE /faces/samples': { status: 204, body: null },
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Delete my face data' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('cannot be undone')
    await user.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(api.callsTo('DELETE /faces/samples')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Delete my face data' }))
    await user.click(screen.getByRole('button', { name: 'Delete face data' }))
    expect(await screen.findByText('Your face data was deleted.')).toBeInTheDocument()
    expect(api.callsTo('DELETE /faces/samples')).toHaveLength(1)
    expect(confirm).not.toHaveBeenCalled() // no browser dialog
  })

  it('stops the camera when leaving the page', async () => {
    const user = userEvent.setup()
    mockApi(baseRoutes())
    const { unmount } = renderApp('/face')
    await screen.findByText('Instruction for neutral')
    await user.click(screen.getByRole('button', { name: 'Turn camera on' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Turn camera off' })).toBeInTheDocument())
    unmount()
    expect(stopTrack).toHaveBeenCalled()
  })

  it('never renders an image of the user', async () => {
    const user = userEvent.setup()
    await openPage(baseRoutes())
    await user.click(screen.getByRole('button', { name: 'Turn camera on' }))
    expect(document.querySelectorAll('img, canvas')).toHaveLength(0)
  })
})
