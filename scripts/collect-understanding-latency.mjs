import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const STAGE_TAG = '[ASVA_UNDERSTANDING_STAGE_MS]'
export const METRICS = ['queue_wait_ms', 'feishu_read_ms', 'processing_write_ms', 'deepseek_ms', 'terminal_write_ms', 'execution_ms']
const ALLOWED_RESULTS = new Set(['FRESH', 'STRUCTURED_FALLBACK', 'STATUS_WRITE_UNKNOWN', 'REUSED_FRESH', 'REUSED_PROCESSING', 'INCOMPLETE'])
const MAX_PAGES = 3
const PAGE_SIZE = 100
const ENV_ID = 'root-journey-prod-d4d7pzd0a8f805'
const QUERY = 'function_name:"asva-api" AND log:"ASVA_UNDERSTANDING_STAGE_MS"'

function jsonRoot(output) {
  const raw = String(output || '').trim()
  try { return JSON.parse(raw) } catch { /* CLI may prefix status lines before JSON */ }
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '{' && raw[i] !== '[') continue
    try { return JSON.parse(raw.slice(i)) } catch { /* keep searching */ }
  }
  throw new Error('LOG_RESPONSE_NOT_JSON')
}

function supportedShape(value) {
  if (Array.isArray(value)) return true
  if (!value || typeof value !== 'object') return false
  return ['data', 'Data', 'result', 'Result', 'Response', 'response', 'logs', 'Logs', 'calls', 'Calls', 'LogResults', 'logResults', 'records', 'Records', 'items', 'Items'].some((key) => Array.isArray(value[key]) || value[key] && typeof value[key] === 'object')
}

export function parseLogPage(output) {
  const root = jsonRoot(output)
  if (!supportedShape(root)) throw new Error('LOG_RESPONSE_UNKNOWN_SHAPE')
  const entries = []
  const visited = new Set()
  function visit(value, key = '') {
    if (entries.length > 3000) throw new Error('LOG_RESPONSE_TOO_LARGE')
    if (typeof value === 'string') {
      if (key === 'log' || key === 'message' || key === 'content' || key === 'text' || key === 'Log' || key === 'Message' || key === 'Content' || key === 'Text' || key === '') entries.push(value)
      return
    }
    if (!value || typeof value !== 'object' || visited.has(value)) return
    visited.add(value)
    if (Array.isArray(value)) { for (const x of value) visit(x, ''); return }
    for (const [k, v] of Object.entries(value)) {
      if (k === 'raw' || k === 'request' || k === 'response_body' || k === 'payload' || k === 'prompt') continue
      if (v && typeof v === 'object') visit(v, k)
      else if (typeof v === 'string') visit(v, k)
    }
  }
  visit(root)
  const items = []
  for (const entry of entries) {
    // Only isolate the explicitly scoped, single-line metrics line. Other lines are discarded.
    for (const line of entry.split(/\r?\n/)) {
      const pos = line.indexOf(STAGE_TAG)
      if (pos < 0) continue
      const jsonText = line.slice(pos + STAGE_TAG.length).trim()
      if (!jsonText.startsWith('{')) continue
      let parsed
      try { parsed = JSON.parse(jsonText) } catch { continue }
      if (!parsed || typeof parsed !== 'object' || !ALLOWED_RESULTS.has(parsed.result)) continue
      const metric = { result: parsed.result }
      let valid = true
      for (const name of METRICS) {
        const v = parsed[name]
        if (v === null) { metric[name] = null; continue }
        if (!Number.isInteger(v) || v < 0 || v > 3600000) { valid = false; break }
        metric[name] = v
      }
      if (valid) items.push(metric)
    }
  }
  const cursor = [root?.Context, root?.context, root?.data?.Context, root?.data?.context, root?.Data?.Context, root?.result?.Context, root?.Result?.Context, root?.Response?.Context].find((x) => typeof x === 'string' && x.length > 0) || null
  return { items, cursor }
}

export function latencyReport(items, { window = '1d', truncated = false, pages = 1 } = {}) {
  const status = items.length >= 10 && !truncated ? 'MEASURED' : 'INSUFFICIENT_DATA'
  const counts = Object.fromEntries([...ALLOWED_RESULTS].map((s) => [s, 0]))
  const metrics = {}
  for (const item of items) { if (ALLOWED_RESULTS.has(item.result)) counts[item.result] += 1 }
  for (const field of METRICS) {
    const values = items.map((item) => item[field]).filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
    const rank = (p) => values.length ? values[Math.max(0, Math.ceil(values.length * p) - 1)] : null
    metrics[field] = { n: values.length, p50_ms: rank(0.5), p90_ms: values.length >= 10 ? rank(0.9) : null }
  }
  return { status, query_window: window, observed_metric_entries: items.length, pages_queried: pages, truncated, result_counts: counts, metrics, note: 'Only matching anonymized metric entries observed; no matches does not mean zero business calls. P90 requires >=10 non-null samples. No client round-trip measured.' }
}

function printReport(report) {
  const text = JSON.stringify(report)
  process.stdout.write(`${text}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = Object.entries(report.metrics || {}).map(([key, val]) => `| ${key} | ${val.n} | ${val.p50_ms ?? 'unknown'} | ${val.p90_ms ?? 'unknown'} |`).join('\n')
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ASVA consultation latency: ${report.status}\n\nTime range: ${report.query_window || 'unknown'}; matching metric entries: ${report.observed_metric_entries ?? 'unknown'}; truncated: ${report.truncated ?? 'unknown'}\n\n| Stage | Non-null N | P50 ms | P90 ms |\n| --- | ---: | ---: | ---: |\n${rows}\n\nThis summary contains aggregate scalar timings only. No raw logs stored.\n`)
  }
}

export function runReadOnlySample({ window = '1d', envId = process.env.TCB_ENV_ID } = {}) {
  if (envId !== ENV_ID || !['6h', '1d'].includes(window)) throw new Error('DIAGNOSTIC_TARGET_REJECTED')
  const collected = []
  let context = null
  let pages = 0
  let truncated = false
  do {
    const args = ['logs', 'search', '-e', ENV_ID, '-q', QUERY, '-t', window, '-l', String(PAGE_SIZE), '--sort', 'desc', '--json']
    if (context) args.push('--context', context)
    let output
    try {
      // Capture output privately. Never echo CLI output or stderr in Actions.
      output = execFileSync('tcb', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CI: 'true' } })
    } catch { throw new Error('LOG_QUERY_UNAVAILABLE') }
    const page = parseLogPage(output)
    collected.push(...page.items)
    pages += 1
    context = page.cursor
    truncated = Boolean(context && pages >= MAX_PAGES)
  } while (context && pages < MAX_PAGES)
  return latencyReport(collected, { window, pages, truncated })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = runReadOnlySample({ window: process.env.LATENCY_WINDOW || '1d' })
    printReport(report)
    if (report.status !== 'MEASURED') process.exitCode = 0 // insufficient data is a valid read-only outcome
  } catch (err) {
    // Do not leak raw CLI error strings, stdout, tokens, names or customer data.
    const reason = ['DIAGNOSTIC_TARGET_REJECTED', 'LOG_QUERY_UNAVAILABLE', 'LOG_RESPONSE_NOT_JSON', 'LOG_RESPONSE_UNKNOWN_SHAPE', 'LOG_RESPONSE_TOO_LARGE'].includes(err?.message) ? err.message : 'LOG_DIAGNOSTIC_FAILED'
    printReport({ status: 'BLOCKED', reason, query_window: process.env.LATENCY_WINDOW || '1d', observed_metric_entries: null, metrics: {} })
    process.exitCode = 1
  }
}
