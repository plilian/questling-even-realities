import type { SaveV1 } from '../shared/schema'
import type { AiContext } from '../shared/ai'
import type { CalendarEvent } from '../shared/calendar'
import { MESSAGE_PROVIDER_LABELS, type InboxItem, type MessageProviderId } from '../shared/messages'
import { dayKey, toLocalInput, zonedParts } from '../shared/time'
import { levelInfo } from '../game/rules'
import { isOverdue, prioritizedQuests } from '../game/reducer'

/**
 * Build the minimized Gemini context: opaque refs instead of IDs, only the fields needed,
 * no tokens, no attendees, no descriptions, no full save. Returns the ref map so model
 * output can be resolved back by trusted code.
 */
export interface RefMap {
  quests: Record<string, string>
  events: Record<string, { id: string; etag?: string; start: number; end: number; title: string }>
  messages: Record<string, { provider: MessageProviderId; id: string; from: string; title: string; where: string; canReply: boolean }>
}

export function buildContext(
  save: SaveV1,
  now: number,
  tz: string,
  calendar: { connected: boolean; events: CalendarEvent[]; freeSlots: Array<{ start: number; end: number }>; fetchedAt: number | null },
  sessionTurns: Array<{ role: 'user' | 'companion'; text: string }>,
  inbox: { items: InboxItem[]; replyingTo?: { provider: MessageProviderId; id: string } | null } = { items: [] },
): { context: AiContext; refs: RefMap } {
  const refs: RefMap = { quests: {}, events: {}, messages: {} }
  const quests = prioritizedQuests(save, now)
    .slice(0, 15)
    .map((q, i) => {
      const ref = `Q${i + 1}`
      refs.quests[ref] = q.id
      return {
        ref,
        title: q.title,
        status: q.status as 'pending' | 'in_progress' | 'postponed',
        category: q.category,
        difficulty: q.difficulty,
        estimatedMinutes: q.estimatedMinutes,
        ...(q.deadline ? { deadlineLocal: toLocalInput(q.deadline.at, tz) } : {}),
        overdue: isOverdue(q, now),
        postponeCount: q.postponeCount,
      }
    })
  const today = dayKey(now, tz)
  const completedToday = save.quests
    .filter((q) => q.status === 'completed' && q.completedAt && dayKey(q.completedAt, tz) === today)
    .slice(-10)
    .map((q) => q.title)
  let cal: AiContext['calendar'] = null
  if (calendar.connected && calendar.fetchedAt !== null) {
    const events = calendar.events
      .filter((e) => e.status !== 'cancelled' && !e.allDay && e.end > now)
      .sort((a, b) => a.start - b.start)
      .slice(0, 10)
      .map((e, i) => {
        const ref = `E${i + 1}`
        refs.events[ref] = { id: e.id, etag: e.etag, start: e.start, end: e.end, title: e.title }
        return { ref, title: e.title.slice(0, 100), startLocal: toLocalInput(e.start, tz), endLocal: toLocalInput(e.end, tz) }
      })
    cal = {
      events,
      freeSlots: calendar.freeSlots.slice(0, 6).map((s) => ({ startLocal: toLocalInput(s.start, tz), endLocal: toLocalInput(s.end, tz) })),
      fetchedMinutesAgo: Math.max(0, Math.round((now - calendar.fetchedAt) / 60000)),
    }
  }
  const memory = save.memory.enabled ? save.memory.entries.map((m) => `${m.kind}: ${m.text}`) : []
  const recent = (save.memory.enabled ? save.memory.recentTurns.map((t) => ({ role: t.role, text: t.text })) : []).concat(sessionTurns).slice(-12)
  // newest first; the message being replied to is always included
  const focus = inbox.replyingTo ?? null
  const sorted = [...inbox.items].sort((a, b) => b.at - a.at)
  const chosen = sorted.slice(0, 6)
  if (focus && !chosen.some((m) => m.provider === focus.provider && m.id === focus.id)) {
    const f = sorted.find((m) => m.provider === focus.provider && m.id === focus.id)
    if (f) chosen.splice(5, 1, f)
  }
  let replyingTo: string | null = null
  const messages = chosen.map((m, i) => {
    const ref = `M${i + 1}`
    refs.messages[ref] = { provider: m.provider, id: m.id, from: m.from, title: m.title, where: m.where, canReply: m.canReply }
    if (focus && focus.provider === m.provider && focus.id === m.id) replyingTo = ref
    return { ref, app: MESSAGE_PROVIDER_LABELS[m.provider], from: m.from, where: m.where, title: m.title, preview: m.preview, receivedLocal: toLocalInput(m.at, tz), canReply: m.canReply }
  })
  const p = zonedParts(now, tz)
  const context: AiContext = {
    nowLocal: toLocalInput(now, tz),
    weekday: p.weekday,
    tz,
    ...(save.player.name ? { userName: save.player.name } : {}),
    ...(save.preferences.goal ? { goal: save.preferences.goal } : {}),
    level: levelInfo(save.player.totalXp).level,
    quests,
    completedToday,
    calendar: cal,
    memory,
    recentTurns: recent,
    messages,
    replyingTo,
  }
  return { context, refs }
}
