import type { Quest, SaveV1 } from '../shared/schema'
import { freeSlots, type CalendarEvent } from '../shared/calendar'
import type { InboxItem, MessageProviderId } from '../shared/messages'
import { addLocalDays, formatTime, startOfLocalDay } from '../shared/time'
import { isOverdue, prioritizedQuests } from '../game/reducer'

/**
 * “Plan my day” — a deterministic, local planner (works offline and in demo; labelled “Local plan”).
 * It reads only what the app already has: open quests, calendar events/free time and the inbox.
 * It never writes anything: booking the focus blocks is a separate, confirm-first calendar proposal.
 * When an AI provider is configured the user can ask the companion to refine it in conversation.
 */

export interface PlanFocus {
  questId: string
  title: string
  minutes: number
  why: string
}
export interface PlanBlock {
  questId: string
  title: string
  start: number
  end: number
}
export interface PlanReply {
  provider: MessageProviderId
  id: string
  from: string
  title: string
}
export interface DayPlan {
  at: number
  day: 'today' | 'tomorrow'
  focus: PlanFocus[]
  blocks: PlanBlock[]
  meetings: Array<{ title: string; start: number; end: number }>
  replies: PlanReply[]
  calendarConnected: boolean
  summary: string
}

const BUFFER_MS = 10 * 60_000
const MAX_BLOCK_MIN = 120

function why(q: Quest, now: number, tz: string): string {
  if (q.status === 'in_progress') return 'in progress'
  if (isOverdue(q, now)) return 'overdue'
  if (q.category === 'boss') return 'boss milestone'
  if (q.deadline) return q.deadline.at - now < 24 * 3600_000 ? `due ${formatTime(q.deadline.at, tz)}` : 'has a deadline'
  return 'next up'
}

function fit(focus: PlanFocus[], events: CalendarEvent[], window: { start: number; end: number }, tz: string, active: { start: string; end: string }): PlanBlock[] {
  const gaps = freeSlots(events, window, 15, tz, active).map((g) => ({ ...g }))
  const out: PlanBlock[] = []
  for (const f of focus) {
    // don't double-book a quest that already has its own block on the calendar
    if (events.some((e) => e.status !== 'cancelled' && e.title === `Quest: ${f.title}` && e.end > window.start)) continue
    const need = Math.min(MAX_BLOCK_MIN, Math.max(15, f.minutes)) * 60_000
    const gap = gaps.find((g) => g.end - g.start >= need)
    if (!gap) continue
    const start = Math.ceil(gap.start / 300_000) * 300_000
    if (gap.end - start < need) continue
    out.push({ questId: f.questId, title: f.title, start, end: start + need })
    gap.start = start + need + BUFFER_MS
  }
  return out
}

export function planDay(input: {
  save: SaveV1
  now: number
  tz: string
  events: CalendarEvent[]
  calendarConnected: boolean
  inbox: InboxItem[]
}): DayPlan {
  const { save, now, tz } = input
  const active = save.preferences.activeHours
  const focus: PlanFocus[] = prioritizedQuests(save, now)
    .slice(0, 3)
    .map((q) => ({ questId: q.id, title: q.title, minutes: q.estimatedMinutes, why: why(q, now, tz) }))

  let day: DayPlan['day'] = 'today'
  let blocks: PlanBlock[] = []
  if (input.calendarConnected && focus.length) {
    const today0 = startOfLocalDay(now, tz)
    const tomorrow0 = addLocalDays(today0, 1, tz)
    blocks = fit(focus, input.events, { start: now + 5 * 60_000, end: tomorrow0 }, tz, active)
    if (!blocks.length) {
      // late in the day: plan tomorrow's active hours instead (said so on screen)
      const t = fit(focus, input.events, { start: tomorrow0, end: addLocalDays(tomorrow0, 1, tz) }, tz, active)
      if (t.length) {
        blocks = t
        day = 'tomorrow'
      }
    }
  }

  const dayEnd = addLocalDays(startOfLocalDay(now, tz), 1, tz)
  const meetings = input.events
    .filter((e) => e.status !== 'cancelled' && !e.allDay && e.end > now && e.start < dayEnd && !e.title.startsWith('Quest: '))
    .sort((a, b) => a.start - b.start)
    .slice(0, 3)
    .map((e) => ({ title: e.title, start: e.start, end: e.end }))

  const replies = input.inbox
    .filter((m) => m.important && m.canReply)
    .sort((a, b) => b.at - a.at)
    .slice(0, 3)
    .map((m) => ({ provider: m.provider, id: m.id, from: m.from, title: m.title }))

  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
  const summary = [
    focus.length ? n(focus.length, 'quest', 'quests') : 'no open quests',
    meetings.length ? n(meetings.length, 'meeting', 'meetings') : null,
    replies.length ? `${n(replies.length, 'reply', 'replies')} waiting` : null,
    blocks.length ? `${n(blocks.length, 'focus block', 'focus blocks')} ready to book${day === 'tomorrow' ? ' for tomorrow' : ''}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return { at: now, day, focus, blocks, meetings, replies, calendarConnected: input.calendarConnected, summary }
}

/** One short line per item, for the glasses and the companion bubble. */
export function planLines(p: DayPlan, tz: string): string[] {
  const lines: string[] = []
  p.focus.forEach((f, i) => {
    const b = p.blocks.find((x) => x.questId === f.questId)
    lines.push(`${i + 1}. ${f.title} · ${b ? `${formatTime(b.start, tz)}–${formatTime(b.end, tz)}` : `${f.minutes}m`} · ${f.why}`)
  })
  if (p.meetings.length) lines.push(`Meetings: ${p.meetings.map((m) => `${formatTime(m.start, tz)} ${m.title}`).join(', ')}`)
  if (p.replies.length) lines.push(`Reply to: ${p.replies.map((r) => r.from).join(', ')}`)
  if (!lines.length) lines.push('Nothing urgent. Add a quest or enjoy the quiet.')
  return lines
}

/** The text sent to the AI when the user asks the companion to refine the plan (minimized, no ids). */
export function planPrompt(p: DayPlan, tz: string): string {
  return [`Plan my day (${p.day}). My local draft:`, ...planLines(p, tz).map((l) => l.slice(0, 90)), 'Re-order if something matters more. Keep it short. Propose a calendar block or a reply only if it helps.'].join('\n').slice(0, 500)
}
