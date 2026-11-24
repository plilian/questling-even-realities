import type { Quest, ReminderState, SaveV1 } from '../shared/schema'
import { dayKey, inWindow, minutesOfDay, zonedToUtc } from '../shared/time'
import { freeSlots, type CalendarEvent } from '../shared/calendar'
import type { InboxItem } from '../shared/messages'
import { isOpen, isOverdue, prioritizedQuests } from '../game/reducer'

/**
 * Proactive event engine. Pure and deterministic: given state,
 * calendar cache, an injected clock and the UI's busy flag, decide at most ONE
 * notice to deliver now, plus reminder-state bookkeeping. Works only while the
 * app is active — no background or closed-app delivery is claimed.
 */
export type EngineEventType =
  | 'DAY_STARTED'
  | 'USER_RETURNED'
  | 'QUEST_OVERDUE'
  | 'QUESTS_OVERDUE_SUMMARY'
  | 'CALENDAR_EVENT_UPCOMING'
  | 'CALENDAR_FREE_SLOT_FOUND'
  | 'DAILY_REVIEW_AVAILABLE'
  | 'MESSAGE_RECEIVED'

export interface NoticeCandidate {
  key: string
  type: EngineEventType
  /** meeting reminders are time-critical: they bypass cooldown/cap but still respect mute & quiet hours */
  critical: boolean
  priority: number
  /** counts toward the daily unsolicited nudge cap */
  countsAsNudge: boolean
  quest?: Pick<Quest, 'id' | 'title' | 'estimatedMinutes' | 'postponeCount'>
  event?: Pick<CalendarEvent, 'id' | 'title' | 'start' | 'end'>
  slot?: { start: number; end: number }
  message?: Pick<InboxItem, 'provider' | 'id' | 'from' | 'title' | 'where' | 'at'>
  count?: number
  /** additional keys this notice covers (summary consolidation) */
  covers?: string[]
}

export type Trigger = 'tick' | 'app_opened' | 'resumed'

export interface EngineInput {
  now: number
  tz: string
  save: Pick<SaveV1, 'quests' | 'reminders' | 'preferences' | 'rewardLedger'>
  calendar: { connected: boolean; events: CalendarEvent[]; fetchedAt: number | null }
  /** unread mail / Slack mentions from connected accounts (optional) */
  inbox?: InboxItem[]
  trigger: Trigger
  /** recording, confirming an action, or onboarding: hold unsolicited notices */
  busy: boolean
  /** a focus session is running: only critical heads-ups (meetings) come through */
  focusing?: boolean
  /** a notice is currently displayed */
  showing: boolean
}

export interface EngineOutput {
  notice: NoticeCandidate | null
  /** reminder state after bookkeeping (expiry of stale events, day rollover); delivery not yet recorded */
  reminders: ReminderState
  suppressedBy?: 'disabled' | 'muted' | 'quiet_hours' | 'busy' | 'showing' | 'cooldown' | 'daily_cap' | 'none'
}

export const RETURN_AFTER_MS = 3 * 3600_000
const FRESH_CALENDAR_MS = 30 * 60_000
/** only fresh, important messages get a heads-up; older ones wait quietly in the inbox */
export const MESSAGE_FRESH_MS = 2 * 3600_000

function recordBlocks(rem: ReminderState, key: string, now: number): boolean {
  const r = rem.records[key]
  if (!r) return false
  if (r.status === 'snoozed') return (r.snoozedUntil ?? 0) > now
  return true
}

export function isMuted(rem: ReminderState, now: number): boolean {
  return rem.mutedUntil !== null && rem.mutedUntil > now
}

export function isQuietHours(prefs: SaveV1['preferences'], now: number, tz: string): boolean {
  return prefs.quietHours.enabled && inWindow(now, tz, prefs.quietHours.start, prefs.quietHours.end)
}

export function evaluate(input: EngineInput): EngineOutput {
  const { now, tz, save, calendar, trigger } = input
  const prefs = save.preferences
  const today = dayKey(now, tz)
  let rem: ReminderState = { ...save.reminders, records: { ...save.reminders.records } }
  if (rem.nudgeDay !== today) rem = { ...rem, nudgeDay: today, nudgesToday: 0 }

  // Expire stale meeting reminders (no backlog spam after resume).
  for (const e of calendar.events) {
    const key = `meeting:${e.id}:${e.start}`
    if (e.start <= now && !rem.records[key]) rem.records[key] = { status: 'expired', at: now }
  }
  // Bound bookkeeping: drop records older than 14 days.
  for (const [k, r] of Object.entries(rem.records)) if (now - r.at > 14 * 86400_000 && r.status !== 'snoozed') delete rem.records[k]

  const out = (notice: NoticeCandidate | null, suppressedBy: EngineOutput['suppressedBy'] = 'none'): EngineOutput => ({ notice, reminders: rem, suppressedBy })

  if (!prefs.proactiveEnabled) return out(null, 'disabled')
  if (isMuted(rem, now)) return out(null, 'muted')
  if (isQuietHours(prefs, now, tz)) return out(null, 'quiet_hours')
  if (input.busy) return out(null, 'busy')
  if (input.showing) return out(null, 'showing')

  const candidates: NoticeCandidate[] = []
  const open = save.quests.filter(isOpen)
  const overdue = open.filter((q) => isOverdue(q, now))
  const overdueKeys = overdue.map((q) => `overdue:${q.id}:${q.deadline!.at}`)
  const freshOverdue = overdue.filter((_, i) => !recordBlocks(rem, overdueKeys[i]!, now))

  // 1) Upcoming meeting — critical
  if (calendar.connected) {
    const windowMs = prefs.meetingReminderMinutes * 60_000
    const upcoming = calendar.events
      .filter((e) => e.status !== 'cancelled' && !e.allDay && e.start > now && e.start - now <= windowMs)
      .sort((a, b) => a.start - b.start)
    for (const e of upcoming) {
      const key = `meeting:${e.id}:${e.start}`
      if (recordBlocks(rem, key, now)) continue
      candidates.push({ key, type: 'CALENDAR_EVENT_UPCOMING', critical: true, priority: 100, countsAsNudge: false, event: { id: e.id, title: e.title, start: e.start, end: e.end } })
      break
    }
  }

  // 2) Session summary on open/resume — one useful summary, consolidating overdue items
  const lastActive = rem.lastActiveAt
  if (trigger !== 'tick') {
    if (rem.lastBriefingDay !== today) {
      candidates.push({ key: `briefing:${today}`, type: 'DAY_STARTED', critical: false, priority: 90, countsAsNudge: false, count: open.length, covers: freshOverdue.map((q) => `overdue:${q.id}:${q.deadline!.at}`) })
    } else if (lastActive !== null && now - lastActive >= RETURN_AFTER_MS) {
      candidates.push({ key: `returned:${today}:${Math.floor(now / RETURN_AFTER_MS)}`, type: 'USER_RETURNED', critical: false, priority: 80, countsAsNudge: false, count: open.length, covers: freshOverdue.map((q) => `overdue:${q.id}:${q.deadline!.at}`) })
    }
  }

  // 3) Overdue quests
  if (freshOverdue.length === 1) {
    const q = freshOverdue[0]!
    candidates.push({ key: `overdue:${q.id}:${q.deadline!.at}`, type: 'QUEST_OVERDUE', critical: false, priority: 50, countsAsNudge: true, quest: pick(q) })
  } else if (freshOverdue.length > 1) {
    const keys = freshOverdue.map((q) => `overdue:${q.id}:${q.deadline!.at}`)
    candidates.push({ key: `overdue_many:${keys.join('|').length}:${today}`, type: 'QUESTS_OVERDUE_SUMMARY', critical: false, priority: 50, countsAsNudge: true, count: freshOverdue.length, quest: pick(freshOverdue[0]!), covers: keys })
  }

  // 3b) A fresh important email or a Slack mention — one heads-up per message, never a backlog
  const fresh = (input.inbox ?? []).filter((m) => m.important && now - m.at <= MESSAGE_FRESH_MS && m.at <= now + 60_000).sort((a, b) => b.at - a.at)
  for (const m of fresh) {
    const key = `msg:${m.provider}:${m.id}`
    if (recordBlocks(rem, key, now)) continue
    candidates.push({ key, type: 'MESSAGE_RECEIVED', critical: false, priority: 55, countsAsNudge: true, message: { provider: m.provider, id: m.id, from: m.from, title: m.title, where: m.where, at: m.at } })
    break
  }

  // 4) Free slot that fits a pending quest — only with fresh authorized data
  if (calendar.connected && calendar.fetchedAt !== null && now - calendar.fetchedAt <= FRESH_CALENDAR_MS && open.length) {
    const target = prioritizedQuests({ ...save, quests: open } as SaveV1, now).find((q) => q.estimatedMinutes <= 120)
    if (target) {
      const slots = freeSlots(calendar.events, { start: now + 5 * 60_000, end: now + 90 * 60_000 }, Math.max(15, target.estimatedMinutes), tz, prefs.activeHours)
      const s = slots[0]
      if (s && s.start - now <= 30 * 60_000) {
        const key = `freeslot:${today}:${s.start}`
        if (!recordBlocks(rem, key, now))
          candidates.push({ key, type: 'CALENDAR_FREE_SLOT_FOUND', critical: false, priority: 30, countsAsNudge: true, quest: pick(target), slot: { start: s.start, end: s.end } })
      }
    }
  }

  // 5) Daily review: evening, once per day, only if something happened today
  if (minutesOfDay(now, tz) >= 18 * 60 && rem.lastReviewDay !== today) {
    const doneToday = save.rewardLedger.filter((r) => dayKey(r.at, tz) === today).length
    if (doneToday > 0) candidates.push({ key: `review:${today}`, type: 'DAILY_REVIEW_AVAILABLE', critical: false, priority: 20, countsAsNudge: true, count: doneToday })
  }

  candidates.sort((a, b) => b.priority - a.priority)
  let suppressed: EngineOutput['suppressedBy'] = 'none'
  for (const c of candidates) {
    if (input.focusing && !c.critical) {
      suppressed = 'busy'
      continue
    }
    if (!c.critical && c.countsAsNudge) {
      if (rem.lastUnsolicitedAt !== null && now - rem.lastUnsolicitedAt < prefs.cooldownMinutes * 60_000) {
        suppressed = 'cooldown'
        continue
      }
      if (rem.nudgesToday >= prefs.maxNudgesPerDay) {
        suppressed = 'daily_cap'
        continue
      }
    }
    return out(c)
  }
  return out(null, suppressed)
}

function pick(q: Quest): NoticeCandidate['quest'] {
  return { id: q.id, title: q.title, estimatedMinutes: q.estimatedMinutes, postponeCount: q.postponeCount }
}

/** Record that a notice was shown. */
export function recordDelivery(rem: ReminderState, c: NoticeCandidate, now: number, tz: string): ReminderState {
  const records = { ...rem.records, [c.key]: { status: 'delivered' as const, at: now } }
  for (const k of c.covers ?? []) records[k] = { status: 'delivered', at: now }
  const next: ReminderState = { ...rem, records }
  if (c.type === 'DAY_STARTED') next.lastBriefingDay = dayKey(now, tz)
  if (c.type === 'DAILY_REVIEW_AVAILABLE') next.lastReviewDay = dayKey(now, tz)
  // Every unsolicited delivery starts the global cooldown (no back-to-back nudges);
  // only noncritical nudges count toward the daily cap.
  next.lastUnsolicitedAt = now
  if (c.countsAsNudge) {
    next.nudgesToday = (rem.nudgeDay === dayKey(now, tz) ? rem.nudgesToday : 0) + 1
    next.nudgeDay = dayKey(now, tz)
  }
  return next
}

export function recordResponse(
  rem: ReminderState,
  c: Pick<NoticeCandidate, 'key' | 'covers'>,
  response: { kind: 'dismiss' } | { kind: 'acted' } | { kind: 'snooze'; ms: number },
  now: number,
): ReminderState {
  const rec =
    response.kind === 'snooze'
      ? { status: 'snoozed' as const, at: now, snoozedUntil: now + response.ms }
      : { status: response.kind === 'dismiss' ? ('dismissed' as const) : ('acted' as const), at: now }
  const records = { ...rem.records, [c.key]: rec }
  if (response.kind === 'snooze') for (const k of c.covers ?? []) records[k] = rec
  return { ...rem, records }
}

export type MuteDuration = '15m' | '1h' | 'tomorrow' | 'indefinite'
export function muteUntil(d: MuteDuration, now: number, tz: string, quietEnd = '08:00'): number | null {
  switch (d) {
    case '15m':
      return now + 15 * 60_000
    case '1h':
      return now + 3600_000
    case 'indefinite':
      return Number.MAX_SAFE_INTEGER
    case 'tomorrow': {
      // until quiet hours end on the next local day (default 08:00)
      const [h, m] = quietEnd.split(':').map(Number)
      const endMin = (h ?? 8) * 60 + (m ?? 0)
      // after midnight but before the morning: "tomorrow" means this morning
      const base = minutesOfDay(now, tz) < endMin ? now : now + 86400_000
      const day = dayKey(base, tz).split('-').map(Number) as [number, number, number]
      return zonedToUtc(day[0], day[1], day[2], h ?? 8, m ?? 0, tz)
    }
  }
}
