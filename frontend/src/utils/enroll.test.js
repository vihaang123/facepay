import { describe, expect, it } from 'vitest'
import { ENROLL_CONFIG, FEEDBACK } from './enrollConfig'
import { evaluateFrame, poseReached } from './enrollGuidance'
import { enrollReducer, initialState, PHASE } from './enrollMachine'

const cfg = { ...ENROLL_CONFIG, stableMs: 1000, cooldownMs: 1500, poseRelaxMs: 7000 }
const run = (state, ...events) => events.reduce((s, e) => enrollReducer(s, e, cfg), state)
const guided = { captured: 0, required: 15, next_pose: 'neutral' }
const ok = { ok: true, key: 'GOOD', message: 'Hold still' }
const bad = (key, message) => ({ ok: false, key, message })
const ready = () => run(initialState(guided), { type: 'START' }, { type: 'CAMERA_READY', now: 0 })

describe('enrollment state machine', () => {
  it('starts idle with the server’s progress', () => {
    const s = initialState({ captured: 6, required: 15, next_pose: 'turn_right' })
    expect(s).toMatchObject({ phase: PHASE.IDLE, pose: 'turn_right', captured: 6, required: 15 })
  })

  it('IDLE → CAMERA_STARTING → POSITION_FACE', () => {
    let s = run(initialState(guided), { type: 'START' })
    expect(s.phase).toBe(PHASE.CAMERA_STARTING)
    s = run(s, { type: 'CAMERA_READY', now: 5 })
    expect(s.phase).toBe(PHASE.POSITION_FACE)
  })

  it('a refused camera ends in ERROR, and START can try again', () => {
    const s = run(initialState(guided), { type: 'START' }, { type: 'CAMERA_FAILED', message: 'camera' })
    expect(s).toMatchObject({ phase: PHASE.ERROR, error: 'camera' })
    expect(run(s, { type: 'START' }).phase).toBe(PHASE.CAMERA_STARTING)
  })

  it('shows feedback while a condition fails and never leaves POSITION_FACE', () => {
    const s = run(ready(), { type: 'FRAME', now: 100, evaluation: bad('TOO_FAR', FEEDBACK.TOO_FAR) }, { type: 'FRAME', now: 5000, evaluation: bad('TOO_FAR', FEEDBACK.TOO_FAR) })
    expect(s).toMatchObject({ phase: PHASE.POSITION_FACE, message: 'Move a little closer', stableSince: null })
  })

  it('needs the full stability window before capturing', () => {
    let s = run(ready(), { type: 'FRAME', now: 2000, evaluation: ok })
    expect(s.phase).toBe(PHASE.CHECKING_QUALITY)
    s = run(s, { type: 'FRAME', now: 2900, evaluation: ok })
    expect(s.phase).toBe(PHASE.CHECKING_QUALITY)
    s = run(s, { type: 'FRAME', now: 3000, evaluation: ok })
    expect(s.phase).toBe(PHASE.CAPTURING)
  })

  it('a bad frame in the middle restarts the window', () => {
    let s = run(ready(), { type: 'FRAME', now: 2000, evaluation: ok }, { type: 'FRAME', now: 2600, evaluation: bad('HOLD_STILL', 'Hold still') })
    expect(s).toMatchObject({ phase: PHASE.POSITION_FACE, stableSince: null })
    s = run(s, { type: 'FRAME', now: 3100, evaluation: ok }, { type: 'FRAME', now: 3500, evaluation: ok })
    expect(s.phase).toBe(PHASE.CHECKING_QUALITY) // 400 ms into a new window, not 1500 ms since the first good frame
  })

  it('a capture is only taken once the cooldown has passed', () => {
    let s = run(ready(), { type: 'CAPTURE_REJECTED', now: 0, message: 'x' }) // ignored: not capturing
    expect(s.phase).toBe(PHASE.POSITION_FACE)
    s = { ...ready(), cooldownUntil: 10_000 }
    s = run(s, { type: 'FRAME', now: 2000, evaluation: ok }, { type: 'FRAME', now: 4000, evaluation: ok })
    expect(s.phase).toBe(PHASE.CHECKING_QUALITY)
    s = run(s, { type: 'FRAME', now: 10_000, evaluation: ok })
    expect(s.phase).toBe(PHASE.CAPTURING)
  })

  const capturing = () => run(ready(), { type: 'FRAME', now: 1, evaluation: ok }, { type: 'FRAME', now: 1001, evaluation: ok })

  it('CAPTURING → CAPTURE_SUCCESS updates progress from the server’s answer', () => {
    const s = run(capturing(), { type: 'CAPTURE_OK', result: { next_pose: 'neutral', progress: { captured: 1, required: 15 } } })
    expect(s).toMatchObject({ phase: PHASE.CAPTURE_SUCCESS, captured: 1, required: 15, complete: false })
  })

  it('stays on the same pose until the server says the pose is done, without a NEXT_POSE screen', () => {
    let s = run(capturing(), { type: 'CAPTURE_OK', result: { next_pose: 'neutral', progress: { captured: 1, required: 15 } } }, { type: 'FLASH_DONE', now: 2000 })
    expect(s).toMatchObject({ phase: PHASE.POSITION_FACE, pose: 'neutral', cooldownUntil: 3500 })
    s = run(s, { type: 'ADVANCE', now: 2100 })
    expect(s.phase).toBe(PHASE.POSITION_FACE)
  })

  it('moves through NEXT_POSE when the server advances to a new pose', () => {
    let s = run(capturing(), { type: 'CAPTURE_OK', result: { next_pose: 'turn_left', progress: { captured: 3, required: 15 } } }, { type: 'FLASH_DONE', now: 2000 })
    expect(s).toMatchObject({ phase: PHASE.NEXT_POSE, pose: 'turn_left' })
    s = run(s, { type: 'ADVANCE', now: 3000 })
    expect(s).toMatchObject({ phase: PHASE.POSITION_FACE, pose: 'turn_left', poseSince: 3000 })
  })

  it('walks the whole sequence in the server’s order and ends in COMPLETED', () => {
    const order = ['neutral', 'turn_left', 'turn_right', 'chin_up', 'chin_down']
    let s = ready()
    let t = 10
    const poses = []
    for (let i = 0; i < order.length; i++) {
      for (let k = 1; k <= 3; k++) {
        poses.push(s.pose)
        s = run(s, { type: 'FRAME', now: t, evaluation: ok })
        t += 1000
        s = run(s, { type: 'FRAME', now: t, evaluation: ok })
        expect(s.phase).toBe(PHASE.CAPTURING)
        const captured = i * 3 + k
        const nextPose = captured === 15 ? null : order[Math.floor(captured / 3)]
        s = run(s, { type: 'CAPTURE_OK', result: { next_pose: nextPose, progress: { captured, required: 15 } } })
        t += 2000
        s = run(s, { type: 'FLASH_DONE', now: t })
        if (s.phase === PHASE.NEXT_POSE) s = run(s, { type: 'ADVANCE', now: (t += 1000) })
        t += 2000
      }
    }
    expect(s.phase).toBe(PHASE.COMPLETED)
    expect(s.captured).toBe(15)
    expect(poses).toEqual(order.flatMap((p) => [p, p, p]))
  })

  it('a server rejection returns to POSITION_FACE with a cooldown and the reason', () => {
    const s = run(capturing(), { type: 'CAPTURE_REJECTED', now: 5000, message: 'Hold still' })
    expect(s).toMatchObject({ phase: PHASE.POSITION_FACE, message: 'Hold still', cooldownUntil: 6500, stableSince: null })
  })

  it('ignores events that do not belong to the current phase', () => {
    const idle = initialState(guided)
    expect(run(idle, { type: 'FRAME', now: 1, evaluation: ok })).toBe(idle)
    expect(run(idle, { type: 'CAPTURE_OK', result: { next_pose: null, progress: { captured: 15, required: 15 } } })).toBe(idle)
    expect(run(idle, { type: 'FLASH_DONE', now: 1 })).toBe(idle)
  })

  it('SYNC re-seeds an idle machine but never disturbs a run in progress', () => {
    const next = { captured: 9, required: 15, next_pose: 'chin_up' }
    expect(run(initialState(guided), { type: 'SYNC', guided: next })).toMatchObject({ pose: 'chin_up', captured: 9 })
    const live = ready()
    expect(run(live, { type: 'SYNC', guided: next })).toBe(live)
  })

  it('CANCEL goes back to IDLE', () => {
    expect(run(ready(), { type: 'CANCEL' }).phase).toBe(PHASE.IDLE)
  })
})

describe('quality guidance', () => {
  const good = { state: 'OK', faces: 1, face: { cx: 0.5, cy: 0.5, width: 0.4, height: 0.5 } }
  const local = { brightness: 120, sharpness: 50, motion: 0 }
  const check = (over = {}) => evaluateFrame({ assess: good, local, pose: 'neutral', baseline: null, config: ENROLL_CONFIG, ...over })

  it('accepts a centred, well-sized, steady, well-lit face', () => {
    expect(check()).toMatchObject({ ok: true })
  })

  it.each([
    ['no face', { assess: { state: 'NO_FACE', faces: 0, face: null } }, 'Face the camera'],
    ['several faces', { assess: { ...good, faces: 2 } }, 'Only one face should be visible'],
    ['too small', { assess: { ...good, face: { ...good.face, width: 0.1 } } }, 'Move a little closer'],
    ['too large', { assess: { ...good, face: { ...good.face, width: 0.75 } } }, 'Move slightly farther away'],
    ['off to the side', { assess: { ...good, face: { ...good.face, cx: 0.9 } } }, 'Center your face'],
    ['too high', { assess: { ...good, face: { ...good.face, cy: 0.1 } } }, 'Center your face'],
    ['dark room', { local: { ...local, brightness: 10 } }, 'Improve the lighting'],
    ['glare', { local: { ...local, brightness: 250 } }, 'Improve the lighting'],
    ['moving', { local: { ...local, motion: 60 } }, 'Hold still'],
    ['soft image', { local: { ...local, sharpness: 0.5 } }, 'Hold still'],
    ['server says blurry', { assess: { ...good, state: 'TOO_BLURRY' } }, 'Hold still'],
  ])('%s', (_n, over, message) => {
    expect(check(over)).toMatchObject({ ok: false, message })
  })

  it('reports multiple faces ahead of every other problem', () => {
    expect(check({ assess: { state: 'MULTIPLE_FACES', faces: 2, face: good.face }, local: { ...local, brightness: 5 } }).message).toBe('Only one face should be visible')
  })

  it('suggests removing sunglasses once no face has been found for a while', () => {
    const none = { state: 'NO_FACE', faces: 0, face: null }
    expect(check({ assess: none, noFaceStreak: 1 }).message).toBe('Face the camera')
    expect(check({ assess: none, noFaceStreak: ENROLL_CONFIG.noFaceHintAfter }).message).toMatch(/sunglasses/)
  })

  it('never shows numbers or threshold names', () => {
    for (const over of [{ local: { ...local, brightness: 1 } }, { assess: { ...good, face: { ...good.face, width: 0.9 } } }]) {
      expect(check(over).message).not.toMatch(/\d|threshold/i)
    }
  })

  describe('head position', () => {
    const turned = (dx, dy = 0) => ({ ...good, face: { ...good.face, cx: 0.5 + dx, cy: 0.5 + dy } })
    it('asks for more movement until the face has moved the right way', () => {
      expect(check({ pose: 'turn_left' })).toMatchObject({ ok: false, message: 'Turn a little more to the left' })
      expect(check({ pose: 'turn_left', assess: turned(0.08) })).toMatchObject({ ok: true })
      expect(check({ pose: 'turn_right', assess: turned(0.08) })).toMatchObject({ ok: false }) // wrong way
      expect(check({ pose: 'turn_right', assess: turned(-0.08) })).toMatchObject({ ok: true })
      expect(check({ pose: 'chin_up', assess: turned(0, -0.06) })).toMatchObject({ ok: true })
      expect(check({ pose: 'chin_down', assess: turned(0, 0.06) })).toMatchObject({ ok: true })
      expect(check({ pose: 'chin_down', assess: turned(0, -0.06) })).toMatchObject({ ok: false })
    })

    it('measures from where the face sat when looking straight', () => {
      const base = { cx: 0.42, cy: 0.5 }
      expect(poseReached('turn_left', { cx: 0.44, cy: 0.5 }, base)).toBe(false)
      expect(poseReached('turn_left', { cx: 0.5, cy: 0.5 }, base)).toBe(true)
    })

    it('stops waiting for the head position after the relax timeout, but every other check still applies', () => {
      expect(check({ pose: 'turn_left', relaxPose: true })).toMatchObject({ ok: true })
      expect(check({ pose: 'turn_left', relaxPose: true, local: { ...local, motion: 99 } })).toMatchObject({ ok: false, message: 'Hold still' })
      expect(check({ pose: 'turn_left', relaxPose: true, assess: { state: 'NO_FACE', faces: 0, face: null } }).ok).toBe(false)
    })

    it('does not demand a centred face once the person has turned, but keeps it in view', () => {
      expect(check({ pose: 'turn_left', assess: turned(0.2) })).toMatchObject({ ok: true })
      expect(check({ pose: 'turn_left', assess: turned(0.4) })).toMatchObject({ ok: false, message: 'Keep your face inside the frame' })
    })
  })
})
