import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatMoney } from '../utils/format'

const BRAND = '#059669'
const shortDay = (iso) => {
  const d = new Date(`${iso}T00:00:00`)
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

function Tip({ active, payload }) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-sm">
      <div className="font-medium">{shortDay(p.date)}</div>
      <div>{formatMoney(p.revenue)} · {p.count} {p.count === 1 ? 'payment' : 'payments'}</div>
    </div>
  )
}

/** Daily simulated revenue (one series, so no legend box; the heading names it). Table view for accessibility. */
export default function RevenueChart({ days }) {
  const [asTable, setAsTable] = useState(false)
  const data = days.map((d) => ({ ...d, revenue: Number(d.revenue) }))
  const empty = data.every((d) => d.revenue === 0)
  return (
    <section aria-label="Revenue by day" className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">Simulated revenue, last {days.length} days</h2>
        <button type="button" className="text-xs font-semibold text-brand-600" onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'View chart' : 'View as table'}
        </button>
      </div>
      {asTable ? (
        <table className="mt-3 w-full text-left text-sm">
          <thead><tr className="border-b border-slate-200 text-slate-500"><th className="py-1 font-medium">Day</th><th className="py-1 font-medium">Revenue</th><th className="py-1 font-medium">Payments</th></tr></thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.date} className="border-b border-slate-100"><td className="py-1">{shortDay(d.date)}</td><td className="py-1">{formatMoney(d.revenue)}</td><td className="py-1">{d.count}</td></tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          {empty && <p className="mt-3 text-sm text-slate-500">No successful payments in this period yet.</p>}
          <div className="mt-3" aria-hidden={empty ? 'true' : undefined}>
            <ResponsiveContainer width="100%" height={200} initialDimension={{ width: 600, height: 200 }}>
              <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="#e2e8f0" />
                <XAxis dataKey="date" tickFormatter={shortDay} tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} width={48} allowDecimals={false} />
                <Tooltip content={<Tip />} cursor={{ fill: '#f1f5f9' }} />
                <Bar dataKey="revenue" fill={BRAND} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </section>
  )
}
