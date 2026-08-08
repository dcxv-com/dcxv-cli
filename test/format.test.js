import { test, expect, describe } from 'bun:test'
import { money, ts, formatTable, formatKeyVals, stripAnsi, parseProgress, parseStat, formatUptime, bytesHuman, sparkline, seriesStats } from '../src/output.js'
import { coerce } from '../src/cli.js'

// Color is auto-disabled when stdout is not a TTY (as under the test runner),
// so these assertions compare against plain, un-escaped strings.

describe('money', () => {
  test('formats integers and floats to 2 dp', () => {
    expect(money(10)).toBe('10.00')
    expect(money(10.5)).toBe('10.50')
    expect(money(0)).toBe('0.00')
  })
  test('negative and sign', () => {
    expect(money(-3.2)).toBe('-3.20')
    expect(money(5, '$')).toBe('$5.00')
  })
  test('non-numeric edge cases', () => {
    expect(money(null)).toBe('')
    expect(money(undefined)).toBe('')
    expect(money('abc')).toBe('abc')
    expect(money(NaN)).toBe('NaN')
  })
})

describe('ts', () => {
  test('non-positive / NaN -> empty', () => {
    expect(ts(0)).toBe('')
    expect(ts(-5)).toBe('')
    expect(ts(NaN)).toBe('')
    expect(ts('nope')).toBe('')
  })
  test('epoch seconds -> YYYY-MM-DD HH:MM', () => {
    expect(ts(1700000000)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})

describe('coerce', () => {
  test('numbers', () => {
    expect(coerce('4')).toBe(4)
    expect(coerce('4.5')).toBe(4.5)
    expect(coerce('-3')).toBe(-3)
  })
  test('booleans', () => {
    expect(coerce('true')).toBe(true)
    expect(coerce('false')).toBe(false)
  })
  test('strings and edges stay strings', () => {
    expect(coerce('vps')).toBe('vps')
    expect(coerce('')).toBe('')
    expect(coerce('1e3')).toBe('1e3') // exponent not matched -> string
    expect(coerce('Ubuntu 24.04')).toBe('Ubuntu 24.04')
    expect(coerce('01')).toBe(1) // numeric-looking -> number
  })
})

describe('parseProgress', () => {
  test('plain numbers', () => {
    expect(parseProgress(0)).toEqual({ pct: 0, stage: '' })
    expect(parseProgress(100)).toEqual({ pct: 100, stage: '' })
    expect(parseProgress(45)).toEqual({ pct: 45, stage: '' })
  })
  test('"NN%|stage" strings from productSub', () => {
    expect(parseProgress('90%|booting')).toEqual({ pct: 90, stage: 'booting' })
    expect(parseProgress('80%|config')).toEqual({ pct: 80, stage: 'config' })
    expect(parseProgress('100%|done')).toEqual({ pct: 100, stage: 'done' })
  })
  test('numeric string without stage', () => {
    expect(parseProgress('55')).toEqual({ pct: 55, stage: '' })
    expect(parseProgress('55%')).toEqual({ pct: 55, stage: '' })
  })
  test('null/empty/non-numeric -> pct 0', () => {
    expect(parseProgress(null)).toEqual({ pct: 0, stage: '' })
    expect(parseProgress(undefined)).toEqual({ pct: 0, stage: '' })
    expect(parseProgress('')).toEqual({ pct: 0, stage: '' })
    expect(parseProgress('booting')).toEqual({ pct: 0, stage: '' })
  })
})

describe('parseStat', () => {
  test('parses productMon.stat JSON', () => {
    expect(parseStat('{"status":"UP","uptime":10,"cpu":1.5}')).toEqual({ status: 'UP', uptime: 10, cpu: 1.5 })
  })
  test('non-JSON/empty/null -> {}', () => {
    expect(parseStat('')).toEqual({})
    expect(parseStat(null)).toEqual({})
    expect(parseStat(undefined)).toEqual({})
    expect(parseStat('not json')).toEqual({})
    expect(parseStat('null')).toEqual({})
  })
})

describe('formatUptime', () => {
  test('days/hours/minutes/seconds tiers', () => {
    expect(formatUptime(90000)).toBe('1d 1h')
    expect(formatUptime(7500)).toBe('2h 5m')
    expect(formatUptime(125)).toBe('2m')
    expect(formatUptime(45)).toBe('45s')
  })
  test('zero/negative/NaN -> empty', () => {
    expect(formatUptime(0)).toBe('')
    expect(formatUptime(-5)).toBe('')
    expect(formatUptime(NaN)).toBe('')
  })
})

describe('bytesHuman', () => {
  test('scales units', () => {
    expect(bytesHuman(0)).toBe('0 B')
    expect(bytesHuman(500)).toBe('500 B')
    expect(bytesHuman(1024)).toBe('1.0 KB')
    expect(bytesHuman(1024 * 1024 * 500)).toBe('500 MB')
    expect(bytesHuman(1024 * 1024 * 1500)).toBe('1.5 GB') // >1GB rolls over to the next unit
    expect(bytesHuman(8388608000)).toBe('7.8 GB')
  })
  test('negative/NaN -> empty', () => {
    expect(bytesHuman(-1)).toBe('')
    expect(bytesHuman(NaN)).toBe('')
    expect(bytesHuman(null)).toBe('')
  })
})

describe('sparkline', () => {
  test('renders one char per value, scaled to range', () => {
    const s = sparkline([0, 50, 100])
    expect(s.length).toBe(3)
    expect(s[0]).not.toBe(s[2])
  })
  test('flat series -> all same char', () => {
    const s = sparkline([5, 5, 5])
    expect(s[0]).toBe(s[1])
    expect(s[1]).toBe(s[2])
  })
  test('empty/non-numeric -> empty string / space filler', () => {
    expect(sparkline([])).toBe('')
    expect(sparkline([null, undefined])).toBe('')
  })
})

describe('seriesStats', () => {
  test('computes min/max/avg/last', () => {
    expect(seriesStats([10, 20, 30])).toEqual({ min: 10, max: 30, avg: 20, last: 30 })
  })
  test('empty/non-numeric -> null', () => {
    expect(seriesStats([])).toBeNull()
    expect(seriesStats([null, undefined])).toBeNull()
  })
})

describe('stripAnsi', () => {
  test('removes color escapes', () => {
    expect(stripAnsi('\x1b[32mhi\x1b[0m')).toBe('hi')
    expect(stripAnsi('plain')).toBe('plain')
  })
})

describe('formatTable', () => {
  const cols = [{ key: 'id', label: 'ID' }, { key: 'name', label: 'NAME' }]
  test('empty -> (none)', () => {
    expect(formatTable([], cols)).toBe('(none)')
    expect(formatTable(null, cols)).toBe('(none)')
  })
  test('renders header + aligned rows', () => {
    const out = formatTable([{ id: 1, name: 'alpha' }, { id: 22, name: 'b' }], cols)
    const lines = out.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('ID')
    expect(lines[0]).toContain('NAME')
    expect(lines[1]).toContain('alpha')
    // id column padded to width of the widest value ("22")
    expect(lines[1].startsWith('1 ')).toBe(true)
  })
  test('fmt callback and null cells', () => {
    const out = formatTable([{ id: 1, name: null }], [
      { key: 'id', label: 'ID', fmt: (v) => `#${v}` },
      { key: 'name', label: 'NAME' },
    ])
    expect(out).toContain('#1')
  })
})

describe('formatKeyVals', () => {
  test('skips null/empty values', () => {
    const out = formatKeyVals([['A', 'x'], ['B', null], ['C', ''], ['D', 0]])
    expect(out).toContain('A:')
    expect(out).toContain('x')
    expect(out).not.toContain('B:')
    expect(out).not.toContain('C:')
    // 0 is a real value and should be shown
    expect(out).toContain('D:')
  })
  test('all-empty -> empty string', () => {
    expect(formatKeyVals([['A', null], ['B', '']])).toBe('')
  })
})
