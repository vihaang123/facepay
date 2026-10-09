import { Suspense, lazy, useState } from 'react'
import { Alert, Card, ErrorState, PageHeader, Skeleton, StatTile } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useLoad } from '../hooks/useLoad'
import { getMlAnalysis, getMlBenchmark, getMlOutcomes, getMlOverview } from '../services/admin'
import { formatDateTime, pct } from '../utils/format'

const VarianceChart = lazy(() => import('../components/LabCharts').then((m) => ({ default: m.VarianceChart })))
const ErrorRateChart = lazy(() => import('../components/LabCharts').then((m) => ({ default: m.ErrorRateChart })))
const MetricBars = lazy(() => import('../components/LabCharts').then((m) => ({ default: m.MetricBars })))
const OutcomeBars = lazy(() => import('../components/LabCharts').then((m) => ({ default: m.OutcomeBars })))

const TABS = [['overview', 'Overview'], ['pca', 'PCA'], ['classifiers', 'LDA and classifiers'], ['errors', 'Error rates'], ['outcomes', 'Live outcomes']]
const ChartFallback = () => <Skeleton className="h-56 w-full !rounded-[1.25rem]" />
const num = (v, d = 3) => (v === null || v === undefined ? 'n/a' : Number(v).toFixed(d))

function Section({ state, label, children }) {
  if (state.loading) return <div role="status" aria-label={`Loading ${label}`}><Skeleton className="h-40 w-full !rounded-[1.25rem]" /></div>
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />
  return children(state.data)
}

function Unavailable({ reason }) {
  const text = {
    NO_MODEL: 'No model has been trained yet, so there is nothing to analyse. Metrics appear after the first customer trains their face model.',
    MODEL_UNAVAILABLE: 'The trained model could not be loaded (for example after a library upgrade). Retrain it to see its analysis.',
  }[reason] ?? 'This analysis is not available.'
  return <Alert tone="info">{text}</Alert>
}

function Table({ label, head, rows }) {
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full min-w-[26rem] text-left text-sm">
        <thead><tr>{head.map((h) => <th key={h} scope="col" className="border-b border-slate-200 py-2 pr-3 text-xs font-semibold text-slate-600">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="border-b border-slate-100">{r.map((c, j) => <td key={j} className="py-2 pr-3">{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}

// ------------------------------------------------------------ overview
function Overview({ token }) {
  const state = useLoad(() => getMlOverview(token), [token])
  return (
    <Section state={state} label="overview">
      {(o) => (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile icon="cpu" label="Model version" value={o.model?.version ?? 'None'} hint={o.model ? `Trained ${formatDateTime(o.model.trained_at)}` : 'Not trained yet'} />
            <StatTile icon="refresh" label="Training status" value={{ current: 'Current', stale: 'Out of date', no_model: 'No model' }[o.training_status]} hint={o.training_status === 'stale' ? 'Enrolment data changed since training' : undefined} />
            <StatTile icon="users" label="Enrolled customers" value={o.dataset.enrolled_customers} hint={`${o.dataset.customers} accounts`} />
            <StatTile icon="database" label="Stored samples" value={o.dataset.stored_samples} hint="Encrypted face crops" />
          </div>
          {o.model && (
            <Card title="Deployed model">
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                {[
                  ['Classifier', o.model.classifier],
                  ['Samples / classes', `${o.model.n_samples} / ${o.model.n_classes}`],
                  ['Distance threshold', num(o.model.distance_threshold, 4)],
                  ['Threshold percentile', o.model.threshold_percentile ?? 'n/a'],
                  ['KNN k', o.model.knn_k ?? 'n/a'],
                  ['Dataset fingerprint', o.model.dataset_fingerprint],
                ].map(([k, v]) => <div key={k} className="flex justify-between gap-3 border-b border-slate-100 py-1.5"><dt className="text-slate-600">{k}</dt><dd className="font-semibold">{v}</dd></div>)}
              </dl>
              {o.model.validation && <p className="mt-3 text-sm text-slate-700">Validation scheme: {String(o.model.validation)}</p>}
            </Card>
          )}
          {o.history.length > 0 && (
            <Card title="Version history">
              <Table label="Model versions" head={['Version', 'Status', 'Trained', 'Classifier', 'Samples', 'Classes']} rows={o.history.map((h) => [h.version, h.status, formatDateTime(h.trained_at), h.classifier, h.n_samples, h.n_classes])} />
            </Card>
          )}
          <Card title="Dataset and methodology">
            <dl className="flex flex-col gap-3 text-sm">
              {Object.entries(o.methodology).map(([k, v]) => <div key={k}><dt className="font-semibold capitalize">{k}</dt><dd className="text-slate-700">{v}</dd></div>)}
            </dl>
          </Card>
        </div>
      )}
    </Section>
  )
}

// ------------------------------------------------------------ PCA
function Pca({ token }) {
  const state = useLoad(() => getMlAnalysis(token), [token])
  const [table, setTable] = useState(false)
  return (
    <Section state={state} label="PCA analysis">
      {(a) => !a.available ? <Unavailable reason={a.reason} /> : (
        <Card title="PCA explained and cumulative variance" action={<button type="button" className="text-xs font-semibold text-brand-700" onClick={() => setTable((t) => !t)}>{table ? 'View chart' : 'View as table'}</button>}>
          <p className="mb-3 text-sm text-slate-700">{a.pca.components} components keep {a.pca.total_explained === null ? 'n/a' : pct(a.pca.total_explained)} of the variance in the training samples (model {a.model_version}).</p>
          {table ? (
            <div className="max-h-80 overflow-y-auto"><Table label="PCA variance" head={['Component', 'Explained', 'Cumulative']} rows={a.pca.explained_variance_ratio.map((v, i) => [i + 1, pct(v), pct(a.pca.cumulative_variance[i])])} /></div>
          ) : (
            <Suspense fallback={<ChartFallback />}><VarianceChart explained={a.pca.explained_variance_ratio} cumulative={a.pca.cumulative_variance} /></Suspense>
          )}
        </Card>
      )}
    </Section>
  )
}

// ------------------------------------------------------------ LDA + classifiers
function Matrix({ labels, matrix }) {
  const max = Math.max(1, ...matrix.flat())
  return (
    <div className="overflow-x-auto">
      <table aria-label="Confusion matrix" className="border-separate border-spacing-0.5 text-center text-xs">
        <thead><tr><th scope="col" className="p-1 text-slate-600">Actual \ Predicted</th>{labels.map((l) => <th key={l} scope="col" className="p-1 font-semibold text-slate-600">{l}</th>)}</tr></thead>
        <tbody>
          {matrix.map((row, i) => (
            <tr key={labels[i]}>
              <th scope="row" className="p-1 text-right font-semibold text-slate-600">{labels[i]}</th>
              {row.map((v, j) => (
                <td key={j} className="h-8 min-w-8 rounded" style={{ background: `rgba(10,111,104,${0.08 + 0.85 * (v / max)})`, color: v / max > 0.5 ? '#fff' : '#0b1b33' }}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Classifiers({ token }) {
  const state = useLoad(() => getMlAnalysis(token), [token])
  const [pick, setPick] = useState(null)
  return (
    <Section state={state} label="classifier analysis">
      {(a) => {
        if (!a.available) return <Unavailable reason={a.reason} />
        const rows = Object.entries(a.classifiers).map(([name, v]) => ({ name, ...v }))
        const chosen = rows.find((r) => r.name === (pick ?? a.deployed_classifier)) ?? rows[0]
        return (
          <div className="flex flex-col gap-5">
            {a.class_separation && (
              <Card title="LDA class separation">
                <p className="mb-3 text-sm text-slate-700">How far apart the customers&apos; samples sit relative to their own spread, before PCA, after PCA and after LDA. Higher between/within means better separated.</p>
                <Table
                  label="Class separation"
                  head={['Space', 'Dimensions', 'Within-class', 'Between-class', 'Between / within', 'Fisher criterion']}
                  rows={Object.entries(a.class_separation).map(([k, v]) => [k.replace('_space', '').replace('_', ' '), v.dim, num(v.trace_within, 1), num(v.trace_between, 1), num(v.between_over_within), num(v.fisher_criterion)])}
                />
              </Card>
            )}
            <Card title="Classifier comparison">
              <Table label="Classifiers" head={['Classifier', 'Accuracy', 'Macro precision', 'Macro recall', 'Macro F1', 'ms / sample']} rows={rows.map((r) => [`${r.name}${r.deployed ? ' (deployed)' : ''}`, pct(r.accuracy ?? 0), pct(r.macro_precision ?? 0), pct(r.macro_recall ?? 0), pct(r.macro_f1 ?? 0), num(r.predict_ms_per_sample, 2)])} />
              <div className="mt-4"><Suspense fallback={<ChartFallback />}><MetricBars rows={rows} metric="macro_f1" label="Macro F1" /></Suspense></div>
            </Card>
            <Card title="Confusion matrix" action={
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-700">Classifier
                <select value={chosen.name} onChange={(e) => setPick(e.target.value)} className="min-h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm">{rows.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}</select>
              </label>}>
              <p className="mb-3 text-xs text-slate-600">Out-of-fold predictions. Classes are anonymous (C1, C2, …); no customer is identified.</p>
              {chosen.confusion_matrix ? <Matrix labels={chosen.classes} matrix={chosen.confusion_matrix} /> : <p className="text-sm text-slate-600">No confusion matrix was stored for this classifier.</p>}
            </Card>
          </div>
        )
      }}
    </Section>
  )
}

// ------------------------------------------------------------ error rates (offline benchmark)
function ErrorRates({ token }) {
  const state = useLoad(() => getMlBenchmark(token), [token])
  return (
    <Section state={state} label="benchmark">
      {(b) => !b.available ? <Alert tone="info">The offline benchmark file is not part of this build, so no error rates can be shown.</Alert> : (
        <div className="flex flex-col gap-5">
          <Alert tone="warning">{b.scope} The live deployment has too few users to measure false accept or false reject rates, so none are shown for it.</Alert>
          <Card title="Genuine rejection and impostor acceptance">
            <p className="mb-3 text-sm text-slate-700">{b.open_set.setup}. The deployed setting is the {b.open_set.deployed_percentile}th percentile. Lower thresholds reject more genuine users but accept fewer impostors.</p>
            <Suspense fallback={<ChartFallback />}><ErrorRateChart rows={b.open_set.by_threshold_percentile} /></Suspense>
            <div className="mt-4">
              <Table
                label="Error rates by threshold"
                head={['Percentile', 'Genuine rejected', 'Impostor accepted (random claim)', 'Impostor accepted (claims predicted identity)']}
                rows={b.open_set.by_threshold_percentile.map((r) => [r.percentile, `${pct(r.false_reject_rate)} ± ${pct(r.false_reject_rate_std)}`, `${pct(r.far_random_claim)} ± ${pct(r.far_random_claim_std)}`, `${pct(r.far_predicted_identity)} ± ${pct(r.far_predicted_identity_std)}`])}
              />
            </div>
          </Card>
          <Card title="Closed-set results">
            <p className="mb-3 text-sm text-slate-700">{b.dataset}. {b.closed_set.protocol}.</p>
            <Table label="Closed-set variants" head={['Pipeline', 'Accuracy', 'Macro precision', 'Macro recall', 'Macro F1']} rows={Object.entries(b.closed_set.variants).map(([k, v]) => [k, pct(v.accuracy), pct(v.macro_precision), pct(v.macro_recall), pct(v.macro_f1)])} />
          </Card>
          <Card title="Liveness">
            <p className="text-sm text-slate-700">{b.liveness.method}</p>
            <p className="mt-2 text-sm text-amber-900">{b.liveness.note}</p>
          </Card>
        </div>
      )}
    </Section>
  )
}

// ------------------------------------------------------------ live outcomes
function Outcomes({ token }) {
  const [days, setDays] = useState(30)
  const state = useLoad(() => getMlOutcomes(token, days), [token, days])
  return (
    <div className="flex flex-col gap-4">
      <label className="flex items-center gap-2 self-start text-sm font-semibold">Period
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="min-h-10 rounded-lg border border-slate-300 bg-white px-2">
          {[7, 30, 90].map((d) => <option key={d} value={d}>Last {d} days</option>)}
        </select>
      </label>
      <Section state={state} label="outcomes">
        {(o) => (
          <div className="flex flex-col gap-5">
            <div className="grid grid-cols-3 gap-3">
              <StatTile label="Face checks" value={o.attempts} />
              <StatTile label="Verified" value={o.successful} />
              <StatTile label="Not verified" value={o.failed} />
            </div>
            <Alert tone="info">{o.note}</Alert>
            <Card title="Why checks did not verify">
              {o.failure_categories.length === 0 ? <p className="text-sm text-slate-600">No failed checks in this period.</p> : (
                <Table label="Failure categories" head={['Category', 'Count']} rows={o.failure_categories.map((c) => [c.category, c.count])} />
              )}
            </Card>
            {o.per_day.length > 0 && <Card title="Checks per day"><Suspense fallback={<ChartFallback />}><OutcomeBars days={o.per_day} /></Suspense></Card>}
          </div>
        )}
      </Section>
    </div>
  )
}

export default function AdminLab() {
  const { token } = useAuth()
  const [tab, setTab] = useState('overview')
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="ML Lab" subtitle="Administrator view of the face recognition pipeline. Customers and merchants never see this." />
      <div role="tablist" aria-label="ML Lab sections" className="-mx-4 flex gap-1 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        {TABS.map(([id, label]) => (
          <button key={id} id={`tab-${id}`} role="tab" type="button" aria-selected={tab === id} aria-controls="lab-panel" onClick={() => setTab(id)} className={`min-h-10 shrink-0 rounded-lg px-4 text-sm font-semibold transition ${tab === id ? 'bg-brand-700 text-white' : 'bg-white text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50'}`}>{label}</button>
        ))}
      </div>
      <div id="lab-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'overview' && <Overview token={token} />}
        {tab === 'pca' && <Pca token={token} />}
        {tab === 'classifiers' && <Classifiers token={token} />}
        {tab === 'errors' && <ErrorRates token={token} />}
        {tab === 'outcomes' && <Outcomes token={token} />}
      </div>
    </div>
  )
}
