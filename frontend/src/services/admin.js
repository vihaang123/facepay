import { apiFetch } from './api'

export const getMlOverview = (token) => apiFetch('/admin/ml/overview', { token })
export const getMlAnalysis = (token) => apiFetch('/admin/ml/analysis', { token })
export const getMlBenchmark = (token) => apiFetch('/admin/ml/benchmark', { token })
export const getMlOutcomes = (token, days = 30) => apiFetch(`/admin/ml/outcomes?days=${days}`, { token })
