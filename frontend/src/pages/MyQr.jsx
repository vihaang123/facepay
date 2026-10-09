import { useCallback, useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from '../components/Icon'
import { IdChip } from '../components/money'
import QrCode from '../components/QrCode'
import { Alert, Button, ErrorState, Skeleton } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useLoad } from '../hooks/useLoad'
import { getMyFacePay } from '../services/transfers'
import { downloadQr } from '../utils/qrDownload'
import { SCAN_PATH } from '../utils/roles'

export default function MyQr() {
  const { token } = useAuth()
  const state = useLoad(() => getMyFacePay(token), [token])
  const [svg, setSvg] = useState(null)
  const [notice, setNotice] = useState(null)
  const onReady = useCallback((markup) => setSvg(markup), [])

  const save = async () => {
    const kind = await downloadQr(svg, 'facepay-qr')
    setNotice(kind === 'png' ? 'QR code saved as an image.' : 'QR code saved as an SVG file.')
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-5">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">My QR</h1>
        <p className="mt-1 text-sm text-slate-600">Anyone can scan this to start paying you. It holds your FacePay ID and nothing else.</p>
      </div>
      {state.loading && <div role="status" aria-label="Loading your QR code"><Skeleton className="mx-auto h-72 w-72 !rounded-[1.5rem]" /></div>}
      {state.error && <ErrorState message={state.error} onRetry={state.reload} />}
      {state.data && (
        <section aria-label="Your FacePay QR code" className="flex flex-col items-center gap-4 rounded-[1.5rem] border border-slate-200/80 bg-white p-6 shadow-card">
          <p className="text-lg font-extrabold">{state.data.display_name}</p>
          <QrCode value={state.data.qr_payload} label={`QR code for ${state.data.facepay_id}`} onReady={onReady} />
          <IdChip id={state.data.facepay_id} name={state.data.display_name} onNotice={setNotice} size="lg" />
          <Button variant="secondary" onClick={save} disabled={!svg} className="w-full"><Icon name="download" className="h-4 w-4" />Download QR</Button>
          <p className="text-center text-xs text-slate-600">A scan only fills in who to pay. The sender still checks the details, verifies their face and confirms.</p>
        </section>
      )}
      {notice && <Alert tone="info">{notice}</Alert>}
      <p className="text-center text-sm"><Link className="font-semibold text-brand-700 underline" to={SCAN_PATH}>Scan someone else&apos;s QR</Link></p>
    </div>
  )
}
