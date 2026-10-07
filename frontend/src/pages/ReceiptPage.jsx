import { useParams } from 'react-router-dom'
import { Receipt } from '../components/payUi'
import { Button, ButtonLink, ErrorState, Spinner } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useLoad } from '../hooks/useLoad'
import { getMerchantReceipt, getMyReceipt } from '../services/payments'
import { DASHBOARD_PATH, TRANSACTIONS_PATH } from '../utils/roles'

export default function ReceiptPage() {
  const { transactionId } = useParams()
  const { token, role } = useAuth()
  const fetcher = role === 'merchant' ? getMerchantReceipt : getMyReceipt
  const state = useLoad(() => fetcher(token, transactionId), [token, role, transactionId])
  return (
    <div className="flex flex-col items-center gap-4">
      {state.loading && <Spinner label="Loading receipt" />}
      {state.error && <ErrorState message={state.error} onRetry={state.reload} />}
      {state.data && (
        <Receipt receipt={state.data}>
          <Button variant="secondary" onClick={() => window.print()}>Print receipt</Button>
          <ButtonLink to={TRANSACTIONS_PATH[role]} variant="secondary">All transactions</ButtonLink>
          <ButtonLink to={DASHBOARD_PATH[role]}>Back to dashboard</ButtonLink>
        </Receipt>
      )}
      {!state.data && <ButtonLink to={DASHBOARD_PATH[role]} variant="secondary" className="no-print">Back to dashboard</ButtonLink>}
    </div>
  )
}
