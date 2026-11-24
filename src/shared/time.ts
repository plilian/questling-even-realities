/** Time helpers. All functions take an explicit `now`/timezone so tests can inject a clock. */

export interface Clock {
  now(): number
}
export const systemClock: Clock = { now: () => Date.now() }

/** A clock with a fixed offset from real time (demo mode) — still advances. */
export function offsetClock(base: Clock, offsetMs: number): Clock {
  return { now: () => base.now() + offsetMs }
}

export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

interface Parts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: string
}

const partsCache = new Map<string, Intl.DateTimeFormat>()
function fmt(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    })
    partsCache.set(tz, f)
  }
  return f
}

export function zonedParts(ms: number, tz: string): Parts {
  const out: Record<string, string> = {}
  for (const p of fmt(tz).formatToParts(new Date(ms))) out[p.type] = p.value
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: out.weekday ?? '',
  }
}

/** Local calendar day key, e.g. "2026-11-24". */
export function dayKey(ms: number, tz: string): string {
  const p = zonedParts(ms, tz)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

export function minutesOfDay(ms: number, tz: string): number {
  const p = zonedParts(ms, tz)
  return p.hour * 60 + p.minute
}

export function parseHHMM(s: string): number {
  const [h, m] = s.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/** True if local time-of-day falls in [start, end) — supports windows crossing midnight. */
export function inWindow(ms: number, tz: string, start: string, end: string): boolean {
  const m = minutesOfDay(ms, tz)
  const s = parseHHMM(start)
  const e = parseHHMM(end)
  if (s === e) return false
  return s < e ? m >= s && m < e : m >= s || m < e
}

/** Offset (ms) of `tz` from UTC at instant `ms`. */
export function tzOffsetMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(ms / 1000) * 1000
}

/**
 * Convert a wall-clock local time in `tz` to a UTC instant. Handles DST:
 * nonexistent times (spring-forward gap) resolve forward; ambiguous times resolve to the first occurrence.
 */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  let t = guess - tzOffsetMs(guess, tz)
  // second pass for DST transitions
  const off2 = tzOffsetMs(t, tz)
  t = guess - off2
  const p = zonedParts(t, tz)
  if (p.hour !== hour || p.minute !== minute) {
    // nonexistent local time: try the other offset
    const alt = guess - tzOffsetMs(guess - 3600_000 * 3, tz)
    const pa = zonedParts(alt, tz)
    if (pa.hour === hour && pa.minute === minute) return alt
  }
  return t
}

/** Parse "YYYY-MM-DDTHH:mm" (local wall clock in tz). Returns null if invalid. */
export function parseLocalDateTime(s: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number]
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null
  const t = zonedToUtc(y, mo, d, h, mi, tz)
  const p = zonedParts(t, tz)
  if (p.year !== y || p.month !== mo || p.day !== d) return null
  return t
}

export function toLocalInput(ms: number, tz: string): string {
  const p = zonedParts(ms, tz)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`
}

/** Start of local day (UTC instant) for the day containing ms. */
export function startOfLocalDay(ms: number, tz: string): number {
  const p = zonedParts(ms, tz)
  return zonedToUtc(p.year, p.month, p.day, 0, 0, tz)
}

export function addLocalDays(ms: number, days: number, tz: string): number {
  const p = zonedParts(ms, tz)
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days))
  return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), p.hour, p.minute, tz)
}

export function formatTime(ms: number, tz: string): string {
  const p = zonedParts(ms, tz)
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function formatDay(ms: number, tz: string): string {
  const p = zonedParts(ms, tz)
  return `${p.weekday} ${p.day} ${MONTHS[p.month - 1]}`
}

export function formatDateTime(ms: number, tz: string): string {
  return `${formatDay(ms, tz)} ${formatTime(ms, tz)}`
}

/** Relative "in 15 min", "2 h ago" style. */
export function formatRelative(target: number, now: number): string {
  const diff = target - now
  const abs = Math.abs(diff)
  const min = Math.round(abs / 60000)
  let s: string
  if (min < 1) s = 'now'
  else if (min < 60) s = `${min} min`
  else if (min < 60 * 24) s = `${Math.round(min / 60)} h`
  else s = `${Math.round(min / 1440)} d`
  if (s === 'now') return 'now'
  return diff >= 0 ? `in ${s}` : `${s} ago`
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h}h ${m}m` : `${h}h`
}
