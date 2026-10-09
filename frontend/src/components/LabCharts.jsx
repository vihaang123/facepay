import { Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

// Two categorical colours, picked to stay apart for common colour-vision differences, plus a text legend on every
// multi-series chart so colour is never the only cue.
const TEAL = '#0a6f68'
const AMBER = '#b45309'
const GRID = '#e2e8f0'
const tick = { fontSize: 11, fill: '#475569' }
const pctText = (v) => `${(Number(v) * 100).toFixed(1)}%`

/** PCA: bars are each component's share of variance, the line is the running total. Both come from the trained model. */
export function VarianceChart({ explained, cumulative }) {
  const data = explained.map((v, i) => ({ component: i + 1, explained: v, cumulative: cumulative[i] }))
  return (
    <ResponsiveContainer width="100%" height={260} initialDimension={{ width: 600, height: 260 }}>
      <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 16, left: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="component" tick={tick} tickLine={false} axisLine={false} interval="preserveStartEnd" label={{ value: 'Principal component', position: 'insideBottom', offset: -10, fontSize: 11, fill: '#475569' }} />
        <YAxis tick={tick} tickLine={false} axisLine={false} width={44} domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} />
        <Tooltip formatter={(v, n) => [pctText(v), n]} labelFormatter={(l) => `Component ${l}`} />
        <Legend verticalAlign="top" height={28} iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="explained" name="Explained variance" fill={TEAL} maxBarSize={10} radius={[3, 3, 0, 0]} isAnimationActive={false} />
        <Line dataKey="cumulative" name="Cumulative variance" stroke={AMBER} strokeWidth={2} dot={false} isAnimationActive={false} type="monotone" />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

/** Offline benchmark: genuine users wrongly rejected and impostors wrongly accepted, across the distance threshold choices. */
export function ErrorRateChart({ rows }) {
  const data = rows.map((r) => ({ percentile: r.percentile, reject: r.false_reject_rate, accept: r.far_random_claim }))
  return (
    <ResponsiveContainer width="100%" height={260} initialDimension={{ width: 600, height: 260 }}>
      <LineChart data={data} margin={{ top: 4, right: 8, bottom: 16, left: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="percentile" tick={tick} tickLine={false} axisLine={false} label={{ value: 'Threshold percentile of genuine distances', position: 'insideBottom', offset: -10, fontSize: 11, fill: '#475569' }} />
        <YAxis tick={tick} tickLine={false} axisLine={false} width={44} domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} />
        <Tooltip formatter={(v, n) => [pctText(v), n]} labelFormatter={(l) => `Percentile ${l}`} />
        <Legend verticalAlign="top" height={28} iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
        <Line dataKey="reject" name="Genuine user rejected" stroke={TEAL} strokeWidth={2} dot={{ r: 4 }} isAnimationActive={false} />
        <Line dataKey="accept" name="Impostor accepted" stroke={AMBER} strokeWidth={2} dot={{ r: 4 }} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}

/** Classifier comparison: one bar per variant for a single chosen metric. */
export function MetricBars({ rows, metric, label }) {
  const data = rows.map((r) => ({ name: r.name, value: r[metric] }))
  return (
    <ResponsiveContainer width="100%" height={220} initialDimension={{ width: 600, height: 220 }}>
      <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="name" tick={tick} tickLine={false} axisLine={false} />
        <YAxis tick={tick} tickLine={false} axisLine={false} width={44} domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} />
        <Tooltip formatter={(v) => [pctText(v), label]} />
        <Bar dataKey="value" name={label} fill={TEAL} maxBarSize={36} radius={[4, 4, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  )
}

/** Authentication outcomes per day from the audit log (counts, not rates). */
export function OutcomeBars({ days }) {
  return (
    <ResponsiveContainer width="100%" height={220} initialDimension={{ width: 600, height: 220 }}>
      <BarChart data={days} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="date" tick={tick} tickLine={false} axisLine={false} interval="preserveStartEnd" />
        <YAxis tick={tick} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
        <Tooltip />
        <Legend verticalAlign="top" height={28} wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="success" name="Verified" stackId="a" fill={TEAL} maxBarSize={22} isAnimationActive={false} />
        <Bar dataKey="failed" name="Not verified" stackId="a" fill={AMBER} maxBarSize={22} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  )
}
