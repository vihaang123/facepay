import { describe, expect, it } from 'vitest'
import { formatFeedTime, greeting } from './format'
import { sessionIdFrom } from './paymentLink'
import { customerTimeline, merchantTimeline } from './timeline'

describe('feed time and greeting', () => {
  const now = new Date(2026, 9, 8, 18, 50)
  it('says Today, Yesterday or the date', () => {
    expect(formatFeedTime(new Date(2026, 9, 8, 18, 42).toISOString(), now)).toMatch(/^Today • /)
    expect(formatFeedTime(new Date(2026, 9, 7, 9, 5).toISOString(), now)).toMatch(/^Yesterday • /)
    expect(formatFeedTime(new Date(2026, 8, 1, 9, 5).toISOString(), now)).toMatch(/^1 Sep/)
    expect(formatFeedTime(null, now)).toBe('—')
  })
  it('greets by the hour', () => {
    expect(greeting(new Date(2026, 9, 8, 7))).toBe('Good morning')
    expect(greeting(new Date(2026, 9, 8, 14))).toBe('Good afternoon')
    expect(greeting(new Date(2026, 9, 8, 20))).toBe('Good evening')
  })
})

describe('payment link parsing', () => {
  const id = 'abcDEF123_-xyz789'
  it('accepts a full checkout link, a path or a bare id', () => {
    expect(sessionIdFrom(`https://facepay.example/checkout/${id}`)).toBe(id)
    expect(sessionIdFrom(`  /checkout/${id}  `)).toBe(id)
    expect(sessionIdFrom(id)).toBe(id)
  })
  it('rejects anything else', () => {
    for (const bad of ['', 'hello world', 'short', 'https://x.test/other/path']) expect(sessionIdFrom(bad)).toBeNull()
  })
})

describe('customer payment timeline', () => {
  const stages = (f, l, i) => [{ stage: 'FACE_DETECTION', status: f }, { stage: 'LIVENESS', status: l }, { stage: 'IDENTITY', status: i }]
  const state = (steps) => steps.map((s) => s.state[0]).join('')

  it('starts with only the first two steps done and the face step current', () => {
    const steps = customerTimeline({ session: { status: 'CREATED' } })
    expect(steps).toHaveLength(9)
    expect(state(steps)).toBe('ddctttttt')
  })
  it('follows the server stage results and the receipt', () => {
    const outcome = { result: 'AUTHENTICATED', stages: stages('PASSED', 'PASSED', 'PASSED') }
    expect(state(customerTimeline({ session: { status: 'AUTHENTICATED' }, outcome, authorized: true }))).toBe('ddddddctt')
    const paid = customerTimeline({ session: { status: 'PAID' }, outcome, authorized: true, receipt: { transaction_id: 'FP-1' } })
    expect(paid.every((s) => s.state === 'done')).toBe(true)
  })
  it('marks the step that failed', () => {
    const outcome = { result: 'REJECTED', stages: stages('PASSED', 'FAILED', 'SKIPPED') }
    const steps = customerTimeline({ session: { status: 'CREATED' }, outcome })
    expect(steps.find((s) => s.state === 'failed').label).toBe('Identity recognized')
  })
})

describe('merchant payment timeline', () => {
  it('waits for the customer while the request is open', () => {
    const steps = merchantTimeline('CREATED')
    expect(steps.map((s) => s.state)).toEqual(['done', 'current', 'todo', 'todo', 'todo'])
    expect(steps[1].label).toBe('Waiting for customer')
  })
  it('renames steps once the customer is authenticated and completes on payment', () => {
    expect(merchantTimeline('AUTHENTICATED').map((s) => s.label)).toContain('Customer authenticated')
    expect(merchantTimeline('PAID').every((s) => s.state === 'done')).toBe(true)
  })
  it('shows why a request stopped', () => {
    const steps = merchantTimeline('EXPIRED')
    expect(steps.find((s) => s.state === 'failed').note).toBe('Session expired')
  })
})
