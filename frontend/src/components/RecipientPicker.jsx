import { useState } from 'react'
import { PersonCard } from './money'
import { Alert, Avatar, Button, EmptyState, FormField, Skeleton } from './ui'
import { useAuth } from '../hooks/useAuth'
import { useLoad } from '../hooks/useLoad'
import { getContacts, resolveRecipient } from '../services/transfers'
import { Link } from 'react-router-dom'
import { SCAN_PATH } from '../utils/roles'

/**
 * Step one of sending or requesting money: who. Enter a FacePay ID (or pick a contact, or arrive from a QR code), see the
 * name and masked ID the server resolves it to, and confirm it is the right person. Nothing else about them is shown.
 *
 * onPick({ id, display_name, masked_id }) is called when the person confirms the recipient.
 */
export default function RecipientPicker({ onPick, initial, actionLabel = 'Continue', prompt = 'Who are you paying?' }) {
  const { token } = useAuth()
  const [text, setText] = useState(initial ?? '')
  const [found, setFound] = useState(null) // { id, display_name, masked_id, is_self }
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const contacts = useLoad(() => getContacts(token), [token])

  const look = async (raw) => {
    const id = raw.trim()
    if (!id) {
      setError('Enter a FacePay ID, like asha.rao@facepay.')
      return
    }
    setBusy(true)
    setError(null)
    setFound(null)
    try {
      const r = await resolveRecipient(token, id)
      if (r.is_self) setError('That is your own FacePay ID. Enter someone else’s.')
      else setFound({ ...r, id })
    } catch (err) {
      setError(err.status === 404 ? 'No FacePay account has that ID. Check the spelling and try again.' : err.message)
    } finally {
      setBusy(false)
    }
  }

  const submit = (e) => {
    e.preventDefault()
    look(text)
  }

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={submit} noValidate className="flex flex-col gap-3 rounded-[1.25rem] border border-slate-200/80 bg-white p-5 shadow-card">
        <FormField
          label={prompt}
          id="recipient-id"
          value={text}
          onChange={(e) => { setText(e.target.value); setFound(null); setError(null) }}
          error={error}
          hint="Their FacePay ID, for example ravi.shah@facepay"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="email"
        />
        <Button type="submit" loading={busy} variant={found ? 'secondary' : 'primary'}>Find</Button>
        <p className="text-center text-xs text-slate-600">Have a QR code? <Link className="font-semibold text-brand-700 underline" to={SCAN_PATH}>Scan it instead</Link></p>
      </form>

      {found && (
        <section aria-label="Confirm recipient" className="flex flex-col gap-3 rounded-[1.25rem] border border-brand-200 bg-brand-50/50 p-5">
          <p className="text-sm font-semibold text-slate-800">Is this the right person?</p>
          <PersonCard name={found.display_name} maskedId={found.masked_id} />
          <Button size="lg" onClick={() => onPick({ id: found.id, display_name: found.display_name, masked_id: found.masked_id })}>{actionLabel}</Button>
        </section>
      )}

      {!found && (
        <section aria-label="Recent contacts">
          <h2 className="mb-2 text-sm font-bold text-slate-800">People you have paid or requested</h2>
          {contacts.loading ? (
            <div role="status" aria-label="Loading contacts"><Skeleton className="h-14 w-full" /></div>
          ) : contacts.error ? (
            <Alert tone="warning">Contacts could not be loaded. You can still enter an ID above.</Alert>
          ) : contacts.data.length === 0 ? (
            <EmptyState title="No contacts yet" icon="users">People appear here after you pay them or send them a request.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-[1.25rem] border border-slate-200/80 bg-white px-3 shadow-card">
              {contacts.data.map((c) => (
                <li key={c.facepay_id}>
                  <button type="button" onClick={() => onPick({ id: c.facepay_id, display_name: c.display_name, masked_id: c.masked_id })} className="flex min-h-14 w-full items-center gap-3 py-2 text-left">
                    <Avatar name={c.display_name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-bold">{c.display_name}</span>
                      <span className="block font-mono text-xs text-slate-600">{c.masked_id}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}
