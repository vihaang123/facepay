import { useCallback, useState } from 'react'
import FaceAuthFlow from '../components/FaceAuthFlow'
import { Card, PageHeader, TableWrap, Th } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { getAttempts, requestChallenge, verifyFace } from '../services/faceAuth'

export default function FaceAuthentication() {
  const { token } = useAuth()
  const [attempts, setAttempts] = useState([])

  const loadAttempts = useCallback(async () => {
    try {
      setAttempts(await getAttempts(token))
    } catch {
      setAttempts([])
    }
  }, [token])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="FacePay Authentication"
        subtitle="Practise the same face check used at checkout, without making a payment. You will look at the camera, follow one instruction, and see the result. Academic prototype: not production-grade anti-spoofing."
      />

      <FaceAuthFlow
        requestChallenge={() => requestChallenge(token)}
        verify={(payload, opts) => verifyFace(token, payload, opts)}
        onOutcome={loadAttempts}
      />

      {attempts.length > 0 && (
        <Card title="Recent attempts" aria-label="Recent attempts">
          <TableWrap label="Recent attempts">
            <thead><tr><Th>When</Th><Th>Result</Th><Th>Reason</Th></tr></thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a.id} className="border-b border-slate-100 last:border-0">
                  <td className="py-2 pr-3">{new Date(a.timestamp).toLocaleString()}</td>
                  <td className="py-2 pr-3">{a.result === 'SUCCESS' ? 'Authenticated' : 'Rejected'}</td>
                  <td className="py-2">{a.failure_reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Card>
      )}
    </div>
  )
}
