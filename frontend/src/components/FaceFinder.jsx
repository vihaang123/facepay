import { useEffect, useRef, useState } from 'react'
import CameraView from './CameraView'
import { PersonCard } from './money'
import { Alert, Button } from './ui'
import { useAuth } from '../hooks/useAuth'
import { useCamera } from '../hooks/useCamera'
import { findByFace } from '../services/faceLookup'
import { SCAN } from '../utils/authTiming'
import { captureFrame } from '../utils/capture'


const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Point the rear camera at a customer to find them. Shows the name and masked FacePay ID the server found, and asks the
 * person scanning to confirm it is who they meant. Nothing is paid or sent here; onFound only hands over the single-use scan
 * ticket so a request can be sent to that one customer.
 *
 * onFound({ lookupToken, person: { display_name, masked_id }, expiresInSeconds })
 */
export default function FaceFinder({ onFound, actionLabel = 'Continue' }) {
  const { token } = useAuth()
  const camera = useCamera({ facing: 'environment' })
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState(null)
  const [match, setMatch] = useState(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true // re-arm: React StrictMode runs the cleanup once on mount in development
    return () => { alive.current = false }
  }, [])

  const scan = async () => {
    setBusy(true)
    setProblem(null)
    try {
      const frames = []
      for (let i = 0; i < SCAN.frames; i += 1) {
        if (i) await wait(SCAN.gapMs)
        frames.push(captureFrame(camera.videoRef.current, { maxSide: 480, quality: 0.7 }))
      }
      const result = await findByFace(token, frames)
      if (!alive.current) return
      if (result.matched) {
        setMatch(result)
        camera.stop()
      } else {
        setProblem(result.message ?? 'No FacePay customer found.')
      }
    } catch (err) {
      if (alive.current) setProblem(err.message)
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  if (match) {
    return (
      <section aria-label="Confirm the person found" className="flex flex-col gap-3 rounded-[1.25rem] border border-brand-200 bg-brand-50/50 p-5">
        <p className="text-sm font-semibold text-slate-800">Found a FacePay customer. Is this who you meant?</p>
        <PersonCard name={match.person.display_name} maskedId={match.person.masked_id} />
        <p className="text-xs text-slate-600">This only lets you send them a request. They approve it themselves with their own face check.</p>
        <Button size="lg" onClick={() => onFound({ lookupToken: match.lookup_token, person: match.person, expiresInSeconds: match.expires_in_seconds })}>{actionLabel}</Button>
        <Button variant="ghost" onClick={() => { setMatch(null); setProblem(null) }}>Not them, scan again</Button>
      </section>
    )
  }

  const on = camera.status === 'active'
  return (
    <section aria-label="Scan a face" className="flex flex-col gap-4">
      <CameraView
        camera={camera}
        busy={busy}
        flippable
        scanning={busy}
        guide
        overlay={on && !busy ? 'Point the rear camera at one face' : null}
        footnote="Only people who turned on “find me by face” can be found. Nothing is recorded, and no picture is kept."
      />
      {problem && <Alert tone="warning">{problem}</Alert>}
      {on && <Button size="lg" onClick={scan} loading={busy}>Scan face</Button>}
    </section>
  )
}
