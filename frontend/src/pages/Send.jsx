import { useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { PersonCard } from '../components/money'
import RecipientPicker from '../components/RecipientPicker'
import { Alert, Button, FormField, Skeleton } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useLoad } from '../hooks/useLoad'
import { getWallet, prepareTransfer, resolveRecipient } from '../services/transfers'
import { formatMoney } from '../utils/format'
import { MAX_AMOUNT, newKey, toAmountString, validateAmount } from '../utils/money'
import { CHECKOUT_PATH } from '../utils/roles'

function AmountStep({ recipient, onBack }) {
  const { token } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const wallet = useLoad(() => getWallet(token), [token])
  const [amount, setAmount] = useState(params.get('amount') ?? '')
  const [note, setNote] = useState('')
  const [error, setError] = useState(null)
  const [formError, setFormError] = useState(null)
  const [busy, setBusy] = useState(false)
  const key = useRef(newKey()) // one key per attempt: a double tap cannot prepare two payments

  const balance = wallet.data ? Number(wallet.data.balance) : undefined

  const submit = async (e) => {
    e.preventDefault()
    const problem = validateAmount(amount, { max: MAX_AMOUNT })
    setError(problem)
    setFormError(null)
    if (problem) return
    setBusy(true)
    try {
      const session = await prepareTransfer(token, { recipient: recipient.id, amount: toAmountString(amount), note: note.trim() }, key.current)
      navigate(CHECKOUT_PATH(session.session_id))
    } catch (err) {
      key.current = newKey() // the inputs may change after an error
      if (err.fieldErrors?.amount) setError(err.fieldErrors.amount)
      else setFormError(err.message)
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <PersonCard name={recipient.display_name} maskedId={recipient.masked_id} caption="Paying" />
      <div className="flex flex-col gap-4 rounded-[1.25rem] border border-slate-200/80 bg-white p-5 shadow-card">
        {formError && <Alert tone="error">{formError}</Alert>}
        <FormField
          label="Amount (₹)"
          id="amount"
          value={amount}
          onChange={(e) => { setAmount(e.target.value); setError(null) }}
          error={error}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          hint={wallet.loading ? 'Checking your balance…' : balance !== undefined ? `Available: ${formatMoney(wallet.data.balance, wallet.data.currency)} (simulated)` : undefined}
        />
        <FormField label="Note (optional)" id="note" value={note} onChange={(e) => setNote(e.target.value.slice(0, 140))} maxLength={140} autoComplete="off" placeholder="What is it for?" hint={`${note.length} of 140`} />
      </div>
      <div className="flex flex-col gap-2">
        <Button size="lg" type="submit" loading={busy}>Review payment</Button>
        <Button variant="ghost" onClick={onBack} disabled={busy}>Change recipient</Button>
      </div>
      <p className="text-center text-xs text-slate-600">Next you review the payment, verify your face and confirm. Nothing is sent until you confirm.</p>
    </form>
  )
}

export default function Send() {
  const { token } = useAuth()
  const [params] = useSearchParams()
  const linked = params.get('to')
  const [picked, setPicked] = useState(null)
  const [dismissed, setDismissed] = useState(false)
  // Arriving from a QR code, contact or link: resolve the ID the same way as typing it.
  const lookup = useLoad(() => (linked ? resolveRecipient(token, linked) : Promise.resolve(null)), [linked, token])
  const fromLink = lookup.data && !lookup.data.is_self ? { id: linked, display_name: lookup.data.display_name, masked_id: lookup.data.masked_id } : null
  const recipient = picked ?? (dismissed ? null : fromLink)

  return (
    <div className="mx-auto flex max-w-md flex-col gap-5">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Send money</h1>
        <p className="mt-1 text-sm text-slate-600">Simulated payment to another FacePay customer.</p>
      </div>
      {linked && lookup.loading ? (
        <div role="status" aria-label="Finding recipient"><Skeleton className="h-24 w-full !rounded-[1.25rem]" /></div>
      ) : recipient ? (
        <AmountStep recipient={recipient} onBack={() => { setPicked(null); setDismissed(true) }} />
      ) : (
        <>
          {linked && lookup.error && <Alert tone="error">{lookup.error}</Alert>}
          {linked && lookup.data?.is_self && <Alert tone="warning">That is your own FacePay ID.</Alert>}
          <RecipientPicker onPick={setPicked} actionLabel="Continue" />
        </>
      )}
    </div>
  )
}
