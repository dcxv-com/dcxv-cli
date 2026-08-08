// Output helpers. The format* functions are PURE (return strings) so command
// handlers can be unit-tested by capturing their output. Only progressBar/endLine
// write directly (to stderr) and are used solely by the live `watch` view.

const useColor = process.stdout.isTTY && !process.env.NO_COLOR

const c = (code, s) => useColor ? `\x1b[${code}m${s}\x1b[0m` : s
export const color = {
  bold: (s) => c('1', s),
  dim: (s) => c('2', s),
  green: (s) => c('32', s),
  red: (s) => c('31', s),
  yellow: (s) => c('33', s),
  cyan: (s) => c('36', s),
}

export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex -- intentional ANSI escape match
  return String(s).replace(/\x1b\[[0-9;]*m/g, '')
}

export function formatJson(data) {
  return JSON.stringify(data, null, 2)
}

// rows: array of objects; columns: [{ key, label, fmt? }] -> aligned table string.
export function formatTable(rows, columns) {
  if (!rows?.length) return color.dim('(none)')
  const cells = rows.map(r => columns.map(col => {
    const v = col.fmt ? col.fmt(r[col.key], r) : r[col.key]
    return v == null ? '' : String(v)
  }))
  const widths = columns.map((col, i) =>
    Math.max(col.label.length, ...cells.map(row => stripAnsi(row[i]).length)))
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - stripAnsi(s).length))
  const lines = [columns.map((col, i) => color.bold(pad(col.label, widths[i]))).join('  ')]
  for (const row of cells) lines.push(row.map((s, i) => pad(s, widths[i])).join('  '))
  return lines.join('\n')
}

// Aligned "label: value" pairs; null/empty values are skipped. pairs: [[label, value], ...]
export function formatKeyVals(pairs) {
  const shown = pairs.filter(([, v]) => v != null && v !== '')
  if (!shown.length) return ''
  const width = Math.max(...shown.map(([k]) => k.length))
  return shown.map(([k, v]) => `  ${color.dim((k + ':').padEnd(width + 1))} ${v}`).join('\n')
}

// Format a number as money with an optional currency sign/symbol.
// null/undefined -> '' (blank); 0 -> '0.00'; non-numeric -> the value as-is.
export function money(value, sign = '') {
  if (value == null) return ''
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  return `${sign}${n.toFixed(2)}`
}

// Epoch seconds -> "YYYY-MM-DD HH:MM" (local). Non-positive/NaN -> ''.
export function ts(epochSeconds) {
  const n = Number(epochSeconds)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n * 1000)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// Backend progress can arrive as a plain number (0-100) or as "NN%|stage" (e.g.
// "90%|booting"). Extract { pct, stage } from either; non-numeric/empty -> pct 0.
export function parseProgress(value) {
  if (value == null || value === '') return { pct: 0, stage: '' }
  if (typeof value === 'number') return { pct: value, stage: '' }
  const s = String(value)
  const m = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*%?\s*(?:\|\s*(.*))?$/)
  if (m) return { pct: Number(m[1]), stage: m[2] || '' }
  const n = Number(s)
  return { pct: Number.isFinite(n) ? n : 0, stage: '' }
}

// Render an in-place progress bar to stderr (keeps stdout clean for piping).
// `pct` accepts anything parseProgress understands (number or "NN%|stage" string).
export function progressBar(label, pct) {
  const { pct: raw, stage } = parseProgress(pct)
  const width = 24
  const clamped = Math.max(0, Math.min(100, raw || 0))
  const filled = Math.round((clamped / 100) * width)
  const bar = '#'.repeat(filled) + '-'.repeat(width - filled)
  const suffix = stage ? ` ${stage}` : ''
  const line = `\r${label} [${bar}] ${clamped.toString().padStart(3)}%${suffix}`
  // \x1b[K (erase to end of line) — without it, a shorter line (e.g. "100% done" after
  // a longer "90% installing software") leaves the previous line's trailing characters
  // visible past the new content, since \r only rewinds the cursor, it doesn't clear.
  if (process.stderr.isTTY) process.stderr.write(line + '\x1b[K')
  else process.stderr.write(line.trim() + '\n')
}

export function endLine() {
  if (process.stderr.isTTY) process.stderr.write('\n')
}

// productMon.stat arrives as a JSON string: { status, uptime, mem:[used,total],
// net:[in,out], disk:[used,total], cpu }. Parse defensively; non-JSON/empty -> {}.
export function parseStat(raw) {
  if (!raw || typeof raw !== 'string') return {}
  try {
    const s = JSON.parse(raw)
    return s && typeof s === 'object' ? s : {}
  } catch {
    return {}
  }
}

// Seconds -> "3d 4h", "2h 15m", "45m", "30s". 0/negative/NaN -> ''.
export function formatUptime(seconds) {
  const n = Number(seconds)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = Math.floor(n / 86400)
  const h = Math.floor((n % 86400) / 3600)
  const m = Math.floor((n % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${Math.floor(n)}s`
}

// Bytes -> "1.2 GB" etc. null/NaN -> ''.
export function bytesHuman(bytes) {
  const n = Number(bytes)
  if (bytes == null) return ''
  if (!Number.isFinite(n) || n < 0) return ''
  if (n === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const idx = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
  const value = n / 1024 ** idx
  return `${value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`
}

const SPARK_BLOCKS = '▁▂▃▄▅▆▇█'

// A missing sample (null/undefined) is excluded from the series, not coerced to 0 —
// a gap in resource-usage history shouldn't read as "0% CPU".
const finiteValues = (values) => values.filter(v => v != null).map(Number).filter(Number.isFinite)

// Render a compact unicode sparkline for a numeric series. Empty/all-null -> ''.
export function sparkline(values) {
  const nums = finiteValues(values)
  if (!nums.length) return ''
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  const range = max - min
  return values.map(v => {
    if (v == null) return ' '
    const n = Number(v)
    if (!Number.isFinite(n)) return ' '
    const idx = range === 0 ? 0 : Math.round(((n - min) / range) * (SPARK_BLOCKS.length - 1))
    return SPARK_BLOCKS[idx]
  }).join('')
}

// Summarize a numeric series as { min, max, avg, last } (2-decimal rounded), or
// null if the series has no finite values.
export function seriesStats(values) {
  const nums = finiteValues(values)
  if (!nums.length) return null
  const round = (x) => Math.round(x * 100) / 100
  return {
    min: round(Math.min(...nums)),
    max: round(Math.max(...nums)),
    avg: round(nums.reduce((a, b) => a + b, 0) / nums.length),
    last: round(nums[nums.length - 1]),
  }
}
