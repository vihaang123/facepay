import { apiFetch } from './api'

// Sign-up and sign-in by mobile number. The one-time code is a DEMO code the server returns for display: FacePay sends no SMS.
export const requestOtp = (mobile, purpose = 'signup') => apiFetch('/auth/number/otp', { method: 'POST', json: { mobile, purpose } })
export const verifyOtp = (challengeId, code) => apiFetch('/auth/number/verify', { method: 'POST', json: { challenge_id: challengeId, code } })
export const numberSignUp = (data) => apiFetch('/auth/number/signup', { method: 'POST', json: data })
export const numberSignIn = (mobile, passcode) => apiFetch('/auth/number/signin', { method: 'POST', json: { mobile, passcode } })
// An older account (made with an email) adds its number. Needs the signed-in token.
export const claimNumber = (token, challengeId, passcode) =>
  apiFetch('/auth/number/claim', { method: 'POST', token, json: { challenge_id: challengeId, passcode } })
