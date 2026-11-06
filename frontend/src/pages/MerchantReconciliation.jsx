import { PageHeader } from '../components/ui'
import { Reconciliation } from './Dashboards'

/** The full reconciliation: every request against the server transaction that settled it. */
export default function MerchantReconciliation() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Reconciliation" subtitle="Each payment request is matched to the transaction the server recorded for it. Mismatches are listed here, never hidden." />
      <Reconciliation rowLimit={50} />
    </div>
  )
}
