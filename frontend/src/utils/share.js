/**
 * Shares a FacePay ID through the device's share sheet when there is one, otherwise copies it.
 * Returns 'shared' | 'copied' | 'cancelled' | 'failed'. Only the ID is shared: never an email, phone number or token.
 */
export async function shareFacePayId({ name, id }) {
  const text = `Pay ${name} on FacePay: ${id}`
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: 'My FacePay ID', text })
      return 'shared'
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled'
    }
  }
  try {
    await navigator.clipboard.writeText(id)
    return 'copied'
  } catch {
    return 'failed'
  }
}
