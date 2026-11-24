import { z } from 'zod'
import { inWindow, parseHHMM, startOfLocalDay, zonedParts, zonedToUtc } from './time'

/** Normalized, minimized calendar event (no attendees, no descriptions). */
export const CalendarEventSchema = z.object({
  id: z.string().min(1).max(1024),
  calendarId: z.string().min(1).max(256),
  title: z.string().max(200),
  start: z.number(),
  end: z.number(),
  allDay: z.boolean(),
  status: z.enum(['confirmed', 'tentative', 'cancelled']),
  transparent: z.boolean(),
  timeZone: z.string().max(64).optional(),
  etag: z.string().max(200).optional(),
  createdByQuestling: z.boolean().optional(),
})
export type CalendarEvent = z.infer<typeof CalendarEventSchema>

export interface TimeWindow {
  start: number
  end: number
}

/** Busy intervals: confirmed/tentative, opaque events. All-day opaque events block the whole window. */
export function busyIntervals(events: CalendarEvent[]): TimeWindow[] {
  const raw = events
    .filter((e) => e.status !== 'cancelled' && !e.transparent && e.end > e.start)
    .map((e) => ({ start: e.start, end: e.end }))
    .sort((a, b) => a.start - b.start)
  const merged: TimeWindow[] = []
  for (const iv of raw) {
    const last = merged[merged.length - 1]
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end)
    else merged.push({ ...iv })
  }
  return merged
}

/** Active-hours windows (local wall clock, DST-aware) intersecting [from, to). */
export function activeWindows(from: number, to: number, tz: string, active: { start: string; end: string }): TimeWindow[] {
  const out: TimeWindow[] = []
  let day = startOfLocalDay(from, tz)
  const sMin = parseHHMM(active.start)
  const eMin = parseHHMM(active.end)
  for (let i = 0; i < 15 && day < to; i++) {
    const p = zonedParts(day, tz)
    const ws = zonedToUtc(p.year, p.month, p.day, Math.floor(sMin / 60), sMin % 60, tz)
    let we = zonedToUtc(p.year, p.month, p.day, Math.floor(eMin / 60), eMin % 60, tz)
    if (eMin <= sMin) we = zonedToUtc(p.year, p.month, p.day + 1, Math.floor(eMin / 60), eMin % 60, tz)
    const s = Math.max(ws, from)
    const e = Math.min(we, to)
    if (e > s) out.push({ start: s, end: e })
    const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1))
    day = zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, tz)
  }
  return out
}

/**
 * Free slots of at least `durationMin` minutes inside active hours, avoiding busy events.
 * Slots start on 5-minute boundaries. Returned windows are the full free gaps.
 */
export function freeSlots(
  events: CalendarEvent[],
  range: TimeWindow,
  durationMin: number,
  tz: string,
  active: { start: string; end: string },
): TimeWindow[] {
  if (durationMin <= 0 || range.end <= range.start) return []
  const need = durationMin * 60_000
  const busy = busyIntervals(events)
  const out: TimeWindow[] = []
  for (const w of activeWindows(range.start, range.end, tz, active)) {
    let cursor = Math.ceil(w.start / 300_000) * 300_000
    for (const b of busy) {
      if (b.end <= cursor) continue
      if (b.start >= w.end) break
      if (b.start - cursor >= need) out.push({ start: cursor, end: Math.min(b.start, w.end) })
      cursor = Math.max(cursor, Math.ceil(b.end / 300_000) * 300_000)
      if (cursor >= w.end) break
    }
    if (w.end - cursor >= need) out.push({ start: cursor, end: w.end })
  }
  return out
}

export function upcomingEvents(events: CalendarEvent[], now: number, horizonMs: number): CalendarEvent[] {
  return events
    .filter((e) => e.status !== 'cancelled' && !e.allDay && e.start >= now && e.start <= now + horizonMs)
    .sort((a, b) => a.start - b.start)
}

export function nextEvent(events: CalendarEvent[], now: number): CalendarEvent | undefined {
  return events.filter((e) => e.status !== 'cancelled' && !e.allDay && e.end > now).sort((a, b) => a.start - b.start)[0]
}

export { inWindow }
