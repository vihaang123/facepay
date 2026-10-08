/** Steps and states for the whole payment, from the data the page really has. */
export function customerTimeline({ session, outcome, authorized = false, receipt = null }) {
  const stage = (n) => outcome?.stages?.find((s) => s.stage === n)?.status
  const failedAt = outcome && outcome.result !== 'AUTHENTICATED'
  const paid = Boolean(receipt)
  const ended = ['FAILED', 'EXPIRED', 'CANCELLED'].includes(session?.status)
  const flow = [
    ['Merchant creates payment', true],
    ['Customer opens checkout', true],
    ['Face detected', stage('FACE_DETECTION') === 'PASSED'],
    ['Identity recognized', stage('IDENTITY') === 'PASSED'],
    ['Basic liveness check passed', stage('LIVENESS') === 'PASSED'],
    ['Payment authorization created', authorized || paid],
    ['Customer confirmation', paid],
    ['Payment processed', paid],
    ['Receipt generated', paid],
  ]
  const firstOpen = flow.findIndex(([, done]) => !done)
  return flow.map(([label, done], i) => ({
    label,
    state: done ? 'done' : i === firstOpen ? (failedAt || ended ? 'failed' : 'current') : 'todo',
  }))
}

/** The merchant's view of one payment session, straight from its status. */
export function merchantTimeline(status) {
  const stopped = ['FAILED', 'EXPIRED', 'CANCELLED'].includes(status)
  const notes = { FAILED: 'Too many failed face attempts', EXPIRED: 'Session expired', CANCELLED: 'Cancelled by you' }
  const authenticated = status === 'AUTHENTICATED' || status === 'PAID'
  const labels = [
    'Payment request created',
    'Customer opened checkout',
    authenticated ? 'Customer authenticated' : 'Face authentication',
    authenticated ? 'Payment authorized' : 'Authorization',
    'Payment completed',
  ]
  // How many steps are finished. The customer's checkout visit is not tracked separately, so step 2 completes with authentication.
  const done = { CREATED: 1, AUTHENTICATED: 4, PAID: 5 }[status] ?? 1
  return labels.map((label, i) => ({
    label: i === 1 && !authenticated ? 'Waiting for customer' : label,
    note: stopped && i === done ? notes[status] : undefined,
    state: i < done ? 'done' : i === done ? (stopped ? 'failed' : 'current') : 'todo',
  }))
}

