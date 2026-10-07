import { Link } from 'react-router-dom'
import { StatusBadge } from './payUi'
import { TableWrap, Th } from './ui'
import { formatDateTime, formatMoney } from '../utils/format'
import { RECEIPT_PATH } from '../utils/roles'

const METHOD = { FACE_PAY: 'FacePay' }

/** One table for both roles: customers see the merchant, merchants see the customer. */
export default function TransactionTable({ rows, role, label = 'Transactions' }) {
  const isMerchant = role === 'merchant'
  return (
    <TableWrap label={label}>
      <thead>
        <tr>
          <Th>Transaction</Th>
          <Th>{isMerchant ? 'Customer' : 'Merchant'}</Th>
          <Th className="hidden md:table-cell">Order</Th>
          <Th className="hidden lg:table-cell">Method</Th>
          <Th className="text-right">Amount</Th>
          <Th>Status</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((t) => (
          <tr key={t.transaction_id} className="border-b border-slate-100 last:border-0">
            <td className="py-2.5 pr-3">
              <Link className="font-mono text-xs font-semibold text-brand-700 underline-offset-2 hover:underline" to={RECEIPT_PATH[role](t.transaction_id)}>
                {t.transaction_id}
              </Link>
              <div className="whitespace-nowrap text-xs text-slate-600">{formatDateTime(t.timestamp)}</div>
            </td>
            <td className="py-2.5 pr-3">{isMerchant ? t.payer_name : t.merchant_name}</td>
            <td className="hidden py-2.5 pr-3 md:table-cell">{t.order_reference ?? '—'}</td>
            <td className="hidden py-2.5 pr-3 lg:table-cell">{METHOD[t.payment_method] ?? t.payment_method}</td>
            <td className="whitespace-nowrap py-2.5 pr-3 text-right font-semibold tabular-nums">{formatMoney(t.amount, t.currency)}</td>
            <td className="py-2.5"><StatusBadge status={t.status} /></td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  )
}
