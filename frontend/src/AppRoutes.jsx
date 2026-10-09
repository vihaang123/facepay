import { Navigate, Route, Routes } from 'react-router-dom'
import { ButtonLink, Logo } from './components/ui'
import { GuestRoute, ProtectedRoute } from './components/RouteGuards'
import { ToastProvider } from './components/Toast'
import DashboardLayout from './layouts/DashboardLayout'
import Checkout from './pages/Checkout'
import CreatePayment from './pages/CreatePayment'
import { MerchantDashboard } from './pages/Dashboards'
import Activity from './pages/Activity'
import ActivityDetail from './pages/ActivityDetail'
import AdminLab from './pages/AdminLab'
import CustomerHome from './pages/CustomerHome'
import MyQr from './pages/MyQr'
import RequestMoney from './pages/RequestMoney'
import Requests from './pages/Requests'
import Scan from './pages/Scan'
import Send from './pages/Send'
import FaceAuthentication from './pages/FaceAuthentication'
import FaceRegistration from './pages/FaceRegistration'
import Home from './pages/Home'
import Login from './pages/Login'
import MerchantPaymentSession from './pages/MerchantPaymentSession'
import PayRequest from './pages/PayRequest'
import Profile from './pages/Profile'
import ReceiptPage from './pages/ReceiptPage'
import Register from './pages/Register'
import Security from './pages/Security'
import Transactions from './pages/Transactions'

function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <Logo className="text-lg" />
      <h1 className="mt-4 text-2xl font-extrabold">Page not found</h1>
      <p className="text-sm text-slate-600">That page does not exist or has moved.</p>
      <ButtonLink to="/" variant="secondary" className="mt-2">Back to FacePay</ButtonLink>
    </main>
  )
}

export default function AppRoutes() {
  return (
    <ToastProvider>
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
          <Route path="/dashboard" element={<CustomerHome />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/send" element={<Send />} />
          <Route path="/request" element={<RequestMoney />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/scan" element={<Scan />} />
          <Route path="/my-qr" element={<MyQr />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/activity/:ref" element={<ActivityDetail />} />
          <Route path="/transactions" element={<Navigate to="/activity" replace />} />
          <Route path="/face" element={<FaceRegistration />} />
          <Route path="/security" element={<Security />} />
          <Route path="/authenticate" element={<FaceAuthentication />} />
          <Route path="/pay" element={<PayRequest />} />
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

      <Route element={<ProtectedRoute role="admin" />}>
        <Route element={<DashboardLayout />}>
          <Route path="/admin" element={<AdminLab />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
    </ToastProvider>
  )
}
