import { describe, expect, it } from 'vitest'
import { classifyError, classifyRejection } from './authMessages'
import { liveStages } from './faceStages'
import { newKey, toAmountString, validateAmount } from './money'

describe('amounts', () => {
  it.each([['250', null], ['250.5', null], ['1,250.50', null], ['0.01', null], ['', 'Enter an amount.'], ['0', 'The amount must be more than zero.'], ['0.00', 'The amount must be more than zero.'], ['-1', 'Enter an amount like 250 or 250.50.'], ['1e5', 'Enter an amount like 250 or 250.50.'], ['1.234', 'Enter an amount like 250 or 250.50.'], ['NaN', 'Enter an amount like 250 or 250.50.'], ['9999999999', 'Enter an amount like 250 or 250.50.']])('validates %j', (raw, expected) => {
    expect(validateAmount(raw)).toBe(expected)
  })
  it('applies a maximum', () => expect(validateAmount('500', { max: 100 })).toMatch(/more than 100/))
  it.each([['250', '250.00'], ['250.5', '250.50'], ['1,250.5', '1250.50'], ['007', '7.00'], ['0.5', '0.50']])('normalises %j to %j', (raw, out) => expect(toAmountString(raw)).toBe(out))
  it('makes distinct idempotency keys of an acceptable shape', () => {
    const a = newKey()
    expect(a).not.toBe(newKey())
    expect(a).toMatch(/^[A-Za-z0-9._-]{8,64}$/)
  })
})

describe('face check stages', () => {
  const passed = { stages: [{ stage: 'FACE_DETECTION', status: 'PASSED' }, { stage: 'LIVENESS', status: 'PASSED' }, { stage: 'IDENTITY', status: 'PASSED' }], reason: null }
  const states = (rows) => Object.fromEntries(rows.map((r) => [r.key, r.state]))

  it('marks nothing done that has not happened', () => {
    expect(states(liveStages({ cameraStatus: 'idle', phase: 'idle' }))).toEqual({ camera: 'todo', face: 'todo', quality: 'todo', liveness: 'todo', identity: 'todo', authorization: 'todo', confirm: 'todo' })
    expect(states(liveStages({ cameraStatus: 'active', phase: 'turn' }))).toMatchObject({ camera: 'done', liveness: 'current', identity: 'todo' })
    expect(states(liveStages({ cameraStatus: 'active', phase: 'verifying' }))).toMatchObject({ face: 'current', quality: 'current', identity: 'current' })
  })
  it('follows the server’s stage results and names the confirmation step once authorized', () => {
    const rows = liveStages({ cameraStatus: 'active', phase: 'done', result: passed, authorized: true })
    expect(states(rows)).toEqual({ camera: 'done', face: 'done', quality: 'done', liveness: 'done', identity: 'done', authorization: 'done', confirm: 'current' })
    expect(rows.map((r) => r.label)).toEqual(['Camera ready', 'Face detected', 'Image quality checked', 'Basic liveness passed', 'Identity matched', 'Authorization created', 'Confirmation required'])
  })
  it('a mismatch fails identity only; poor quality fails quality but not detection; no face fails detection', () => {
    const mismatch = { reason: 'IDENTITY_MISMATCH', stages: [{ stage: 'FACE_DETECTION', status: 'PASSED' }, { stage: 'LIVENESS', status: 'PASSED' }, { stage: 'IDENTITY', status: 'FAILED' }] }
    expect(states(liveStages({ cameraStatus: 'active', phase: 'done', result: mismatch }))).toMatchObject({ face: 'done', quality: 'done', liveness: 'done', identity: 'failed', authorization: 'todo' })
    const blurry = { reason: 'POOR_IMAGE_QUALITY', stages: [{ stage: 'FACE_DETECTION', status: 'FAILED' }, { stage: 'LIVENESS', status: 'SKIPPED' }, { stage: 'IDENTITY', status: 'SKIPPED' }] }
    expect(states(liveStages({ cameraStatus: 'active', phase: 'done', result: blurry }))).toMatchObject({ face: 'done', quality: 'failed', liveness: 'todo' })
    const none = { reason: 'FACE_NOT_DETECTED', stages: blurry.stages }
    expect(states(liveStages({ cameraStatus: 'active', phase: 'done', result: none }))).toMatchObject({ face: 'failed', quality: 'todo' })
  })
  it('reports a blocked camera as failed', () => {
    expect(states(liveStages({ cameraStatus: 'denied', phase: 'idle' })).camera).toBe('failed')
  })
})

describe('failure categories', () => {
  it.each([
    ['IDENTITY_MISMATCH', 'mismatch'], ['LOW_CONFIDENCE', 'mismatch'], ['DISTANCE_TOO_HIGH', 'mismatch'],
    ['POOR_IMAGE_QUALITY', 'quality'], ['FACE_NOT_DETECTED', 'quality'], ['FACE_TOO_SMALL', 'quality'], ['MULTIPLE_FACES_DETECTED', 'quality'],
    ['LIVENESS_FAILED', 'liveness'], ['NOT_ENROLLED', 'enrollment'], ['MODEL_UNAVAILABLE', 'model'], ['CHALLENGE_EXPIRED', 'challenge'], ['ACCOUNT_DISABLED', 'account'],
  ])('%s is a %s problem', (reason, category) => {
    expect(classifyRejection({ reason, detail: null }).category).toBe(category)
  })
  it('a network, timeout or server failure is never a mismatch', () => {
    for (const err of [{ status: 0 }, { status: 0, code: 'TIMEOUT' }, { status: 500 }, { status: 502 }, { status: 503 }]) {
      const found = classifyError(err)
      expect(['network', 'server']).toContain(found.category)
      expect(found.message).not.toMatch(/did not match|could not verify that this is you/i)
    }
    expect(classifyError({ status: 429 }).category).toBe('limit')
  })
})
