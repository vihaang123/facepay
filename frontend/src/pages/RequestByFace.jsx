import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import FaceFinder from '../components/FaceFinder'
import { PersonCard } from '../components/money'
import RequestDetails from '../components/RequestDetails'
import { ButtonLink, PageHeader } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { createFaceRequest } from '../services/faceLookup'
import { DASHBOARD_PATH, MERCHANT_SESSION_PATH } from '../utils/roles'

/** A shop points the rear camera at a customer, sees who they are, states the amount, purpose and reference, and the request
 * lands on that customer's phone. The customer approves it with their own face check. */
export default function RequestByFace() {
  const { token } = useAuth()
  const navigate = useNavigate()
  const [found, setFound] = useState(null)

  const submit = async ({ amount, purpose, reference }) => {
    const session = await createFaceRequest(token, { lookupToken: found.lookupToken, amount, purpose, reference })
    navigate(MERCHANT_SESSION_PATH(session.session_id))
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5">
      <PageHeader title="Request by face" subtitle="Scan a customer’s face with the rear camera, then ask them to pay. They approve it on their own phone. Simulated payment: no real money moves." />
      {found ? (
        <div className="flex flex-col gap-5">
          <PersonCard name={found.person.display_name} maskedId={found.person.masked_id} caption="Requesting from" />
          <RequestDetails onSubmit={submit} submitLabel="Send request" onBack={() => setFound(null)} backLabel="Scan someone else" />
        </div>
      ) : (
        <FaceFinder actionLabel="Continue" onFound={setFound} />
      )}
      <ButtonLink to={DASHBOARD_PATH.merchant} variant="ghost">Cancel</ButtonLink>
    </div>
  )
}
