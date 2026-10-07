import { Component } from 'react'

/** Last line of defence: a rendering bug shows a calm message and a way back, never a blank page or a stack trace. */
export default class ErrorBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    // Logged for developers only; nothing technical is shown to the user.
    console.error('Unhandled UI error:', error)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-2xl font-bold">Something went wrong</h1>
        <p className="text-sm text-slate-600">This page hit an unexpected problem. Your payments and data are not affected.</p>
        <a href="/" className="rounded-lg bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white">Back to FacePay</a>
      </main>
    )
  }
}
