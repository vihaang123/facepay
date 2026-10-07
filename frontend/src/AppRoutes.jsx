import { Link, Route, Routes } from 'react-router-dom'
import { GuestRoute, ProtectedRoute } from './components/RouteGuards'
import DashboardLayout from './layouts/DashboardLayout'
import Checkout from './pages/Checkout'
import CreatePayment from './pages/CreatePayment'
import { CustomerDashboard, MerchantDashboard } from './pages/Dashboards'
import FaceAuthentication from './pages/FaceAuthentication'
import FaceRegistration from './pages/FaceRegistration'
import Home from './pages/Home'
import Login from './pages/Login'
import MerchantPaymentSession from './pages/MerchantPaymentSession'
import Profile from './pages/Profile'
import ReceiptPage from './pages/ReceiptPage'
import Register from './pages/Register'
import Transactions from './pages/Transactions'

function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="text-sm text-slate-600">That page does not exist or has moved.</p>
      <Link to="/" className="font-semibold text-brand-700 underline">
        Back to FacePay
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
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/face" element={<FaceRegistration />} />
          <Route path="/authenticate" element={<FaceAuthentication />} />
          <Route path="/checkout/:sessionId" element={<Checkout />} />
          <Route path="/receipts/:transactionId" element={<ReceiptPage />} />
        </Route>
      </Route>

      <Route element={<ProtectedRoute role="merchant" />}>
        <Route element={<DashboardLayout />}>
          <Route path="/merchant/dashboard" element={<MerchantDashboard />} />
          <Route path="/merchant/profile" element={<Profile />} />
          <Route path="/merchant/transactions" element={<Transactions />} />
          <Route path="/merchant/payments/new" element={<CreatePayment />} />
          <Route path="/merchant/payments/:sessionId" element={<MerchantPaymentSession />} />
          <Route path="/merchant/receipts/:transactionId" element={<ReceiptPage />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
