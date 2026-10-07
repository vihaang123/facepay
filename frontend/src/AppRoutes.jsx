import { Link, Route, Routes } from 'react-router-dom'
import { GuestRoute, ProtectedRoute } from './components/RouteGuards'
import DashboardLayout from './layouts/DashboardLayout'
import { CustomerDashboard, MerchantDashboard } from './pages/Dashboards'
import Home from './pages/Home'
import Login from './pages/Login'
import Profile from './pages/Profile'
import Register from './pages/Register'

function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <Link to="/" className="font-semibold text-brand-600">
        Back to home
      </Link>
    </main>
  )
}

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />

      <Route element={<GuestRoute />}>
        <Route path="/login" element={<Login role="customer" />} />
        <Route path="/register" element={<Register role="customer" />} />
        <Route path="/merchant/login" element={<Login role="merchant" />} />
        <Route path="/merchant/register" element={<Register role="merchant" />} />
      </Route>

      <Route element={<ProtectedRoute role="customer" />}>
        <Route element={<DashboardLayout />}>
          <Route path="/dashboard" element={<CustomerDashboard />} />
          <Route path="/profile" element={<Profile />} />
        </Route>
      </Route>

      <Route element={<ProtectedRoute role="merchant" />}>
        <Route element={<DashboardLayout />}>
          <Route path="/merchant/dashboard" element={<MerchantDashboard />} />
          <Route path="/merchant/profile" element={<Profile />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
