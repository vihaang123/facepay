import { BrowserRouter } from 'react-router-dom'
import AppRoutes from './AppRoutes'
import { AuthProvider } from './hooks/AuthProvider'

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  )
}
