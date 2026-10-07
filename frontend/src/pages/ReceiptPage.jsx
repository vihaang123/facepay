import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Receipt } from '../components/payUi'
import { Alert, Spinner } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { getMerchantReceipt, getMyReceipt } from '../services/payments'
import { DASHBOARD_PATH } from '../utils/roles'

export default function ReceiptPage() {
  const { transactionId } = useParams()
  const { token, role } = useAuth()
  const [receipt, setReceipt] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let live = true
    const fetcher = role === 'merchant' ? getMerchantReceipt : getMyReceipt
    fetcher(token, transactionId)
      .then((r) => live && setReceipt(r))
      .catch((err) => live && setError(err.status === 404 ? 'Transaction not found.' : err.status >= 500 ? 'Something went wrong on our side. Please try again.' : err.message))
    return () => { live = false }
  }, [token, role, transactionId])

  return (
    <div className="flex flex-col items-center gap-4">
      {error && <Alert tone="error">{error}</Alert>}
      {!receipt && !error && <Spinner label="Loading receipt" />}
      {receipt && <Receipt receipt={receipt} />}
      <Link className="text-sm font-semibold text-brand-600" to={DASHBOARD_PATH[role]}>Back to dashboard</Link>
    </div>
  )
}
