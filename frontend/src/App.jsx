import { BrowserRouter } from 'react-router-dom'
import AppRoutes from './AppRoutes'
import ErrorBoundary from './components/ErrorBoundary'
import { AuthProvider } from './hooks/AuthProvider'

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  )
}
