import { describe, expect, it } from 'vitest'
import { positionHint } from './positionHint'

const at = (o) => ({ state: 'OK', faces: 1, face: { cx: 0.5, cy: 0.45, width: 0.4, height: 0.5 }, ...o })

describe('positionHint', () => {
  it('tells someone whose face sits low in the frame to raise the phone', () => {
    const h = positionHint(at({ face: { cx: 0.5, cy: 0.7, width: 0.4, height: 0.5 } }))
    expect(h).toMatchObject({ tone: 'warn', key: 'LOW' })
    expect(h.message).toMatch(/eye level/)
  })
  it('gives concrete advice for each framing problem', () => {
    expect(positionHint(at({ face: { cx: 0.5, cy: 0.2, width: 0.4, height: 0.5 } })).key).toBe('HIGH')
    expect(positionHint(at({ face: { cx: 0.9, cy: 0.45, width: 0.4, height: 0.5 } })).key).toBe('OFF_CENTER')
    expect(positionHint(at({ face: { cx: 0.5, cy: 0.45, width: 0.1, height: 0.2 } })).key).toBe('FAR')
    expect(positionHint(at({ face: { cx: 0.5, cy: 0.45, width: 0.9, height: 0.9 } })).key).toBe('CLOSE')
    expect(positionHint(at({ state: 'TOO_DARK' })).key).toBe('LIGHT')
    expect(positionHint(at({ state: 'NO_FACE', face: null, faces: 0 })).key).toBe('NO_FACE')
    expect(positionHint(at({ faces: 2 })).key).toBe('MULTIPLE')
    expect(positionHint(at({ faces: 2 })).message).toMatch(/private spot/)
    expect(positionHint(at({ face: { cx: 0.5, cy: 0.45, width: 0.7, height: 0.5 } })).key).toBe('GOOD')
    expect(positionHint(at({ face: { cx: 0.64, cy: 0.45, width: 0.72, height: 0.5 } })).key).toBe('CROPPED')
  })
  it('says good only when the face is in position, and never names left or right', () => {
    expect(positionHint(at())).toMatchObject({ tone: 'ok', key: 'GOOD' })
    expect(positionHint(null)).toBeNull()
  })
})
