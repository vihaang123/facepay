import { useCallback, useState } from 'react'
import FaceAuthFlow from '../components/FaceAuthFlow'
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
      <div>
        <h1 className="text-2xl font-bold tracking-tight">FacePay Authentication</h1>
        <p className="mt-1 text-sm text-slate-600">
          Look at the camera, then follow the on-screen instruction. Your face is checked for a live head movement and then
          verified by the PCA → LDA model. Academic prototype: not production-grade anti-spoofing.
        </p>
      </div>

      <FaceAuthFlow
        requestChallenge={() => requestChallenge(token)}
        verify={(payload, opts) => verifyFace(token, payload, opts)}
        onOutcome={loadAttempts}
      />

      {attempts.length > 0 && (
        <section aria-label="Recent attempts" className="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="font-semibold">Recent attempts</h2>
          <table className="mt-3 w-full text-left text-sm">
            <thead><tr className="border-b border-slate-200 text-slate-500"><th className="py-1 pr-3 font-medium">When</th><th className="py-1 pr-3 font-medium">Result</th><th className="py-1 font-medium">Reason</th></tr></thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a.id} className="border-b border-slate-100">
                  <td className="py-1 pr-3">{new Date(a.timestamp).toLocaleString()}</td>
                  <td className="py-1 pr-3">{a.result === 'SUCCESS' ? 'Authenticated' : 'Rejected'}</td>
                  <td className="py-1">{a.failure_reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}
