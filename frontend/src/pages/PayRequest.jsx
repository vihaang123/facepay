import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Icon from '../components/Icon'
import { Button, Card, FormField, PageHeader } from '../components/ui'
import { sessionIdFrom } from '../utils/paymentLink'
import { CHECKOUT_PATH } from '../utils/roles'

export default function PayRequest() {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [error, setError] = useState(null)

  const submit = (e) => {
    e.preventDefault()
    const id = sessionIdFrom(text)
    if (!id) {
      setError('That does not look like a FacePay payment link. Paste the full link the merchant shared.')
      return
    }
    navigate(CHECKOUT_PATH(id))
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5">
      <PageHeader title="Pay a request" subtitle="Open the payment link a merchant shared with you to pay with your face." />
      <Card>
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <FormField
            label="Payment link"
            id="payment-link"
            value={text}
            onChange={(e) => { setText(e.target.value); setError(null) }}
            error={error}
            hint="For example https://…/checkout/ps_…"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck="false"
          />
          <Button type="submit" size="lg" disabled={!text.trim()}>
            <Icon name="arrow" className="h-4 w-4" />Open payment
          </Button>
        </form>
      </Card>
      <p className="text-center text-xs text-slate-600">Payments here are simulated. No real money moves.</p>
    </div>
  )
}
