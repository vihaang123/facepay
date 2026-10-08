/**
 * The six separate steps of a FacePay payment, each with its own state. They are never collapsed into one "Success":
 * recognising a face, the liveness check, the authorization, the customer's own confirmation and the payment are
 * different decisions made at different times.
 *
 *   state: 'done' | 'current' | 'failed' | 'todo'
 */
export function paymentStageList({ outcome, authorized = false, confirming = false, paid = false }) {
  const status = (n) => outcome?.stages?.find((s) => s.stage === n)?.status
  const fromStage = (n) => (status(n) === 'PASSED' ? 'done' : status(n) === 'FAILED' ? 'failed' : 'todo')
  const rows = [
    ['Face detected', fromStage('FACE_DETECTION')],
    ['Identity recognized', fromStage('IDENTITY')],
    ['Basic liveness check passed', fromStage('LIVENESS')],
    ['Payment authorization created', authorized || paid ? 'done' : 'todo'],
    ['Customer confirmation', paid || confirming ? 'done' : authorized ? 'current' : 'todo'],
    ['Payment processed', paid ? 'done' : confirming ? 'current' : 'todo'],
  ]
  return rows.map(([label, state]) => ({ label, state }))
}

