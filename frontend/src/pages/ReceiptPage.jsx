import { useParams } from 'react-router-dom'
import Icon from '../components/Icon'
import { Receipt } from '../components/payUi'
import { Button, ButtonLink, ErrorState, Skeleton } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useLoad } from '../hooks/useLoad'
import { getMerchantReceipt, getMyReceipt } from '../services/payments'
import { TRANSACTIONS_PATH } from '../utils/roles'

export default function ReceiptPage() {
  const { transactionId } = useParams()
  const { token, role } = useAuth()
  const fetcher = role === 'merchant' ? getMerchantReceipt : getMyReceipt
  const state = useLoad(() => fetcher(token, transactionId), [token, role, transactionId])
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <h1 className="text-2xl font-extrabold tracking-tight">Transaction details</h1>
      {state.loading && <div role="status" aria-label="Loading receipt"><Skeleton className="h-96 w-full !rounded-[1.25rem]" /></div>}
      {state.error && <ErrorState message={state.error} onRetry={state.reload} />}
      {state.data && (
        <Receipt receipt={state.data}>
          <Button variant="secondary" onClick={() => window.print()}><Icon name="print" className="h-4 w-4" />Download / Print receipt</Button>
          <ButtonLink to={TRANSACTIONS_PATH[role]}>Done</ButtonLink>
        </Receipt>
      )}
      {!state.data && <ButtonLink to={TRANSACTIONS_PATH[role]} variant="secondary" className="no-print">Back to transactions</ButtonLink>}
    </div>
  )
}
