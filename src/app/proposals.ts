import type { Category, Difficulty, Quest, SaveV1, Skill } from '../shared/schema'
import { newId } from '../shared/ids'
import { formatDateTime, formatDuration, formatTime, parseLocalDateTime } from '../shared/time'
import { busyIntervals, type CalendarEvent } from '../shared/calendar'
import type { AiAction } from '../shared/ai'
import type { TaskProviderId } from '../shared/tasks'
import { MESSAGE_PROVIDER_LABELS, REPLY_MAX, type MessageProviderId } from '../shared/messages'
import { containsForbidden, containsProfanity } from '../companion/policy'
import type { RefMap } from './context'
import { rewardFor } from '../game/rules'

/**
 * Action lifecycle: intent → validate & resolve refs → immutable proposal
 * (id, normalized params, target, expiry, version) → explicit user confirmation → staleness
 * re-check → trusted executor → verified result. Confirmation requirements are decided HERE,
 * in trusted code — never by a model-provided flag.
 */
export const PROPOSAL_TTL_MS = 5 * 60_000

export type ProposalParams =
  | { kind: 'create_quests'; quests: Array<{ title: string; category: Exclude<Category, 'boss'>; difficulty: Difficulty; estimatedMinutes: number; skill: Skill | null; deadline?: { at: number; tz: string } }> }
  | { kind: 'update_quest'; questId: string; questUpdatedAt: number; title?: string; deadline?: { at: number; tz: string }; estimatedMinutes?: number }
  | { kind: 'start_quest'; questId: string; questUpdatedAt: number }
  | { kind: 'complete_quest'; questId: string; questUpdatedAt: number }
  | { kind: 'postpone_quest'; questId: string; questUpdatedAt: number; deadline: { at: number; tz: string } | null }
  | { kind: 'calendar_create'; title: string; start: number; end: number; timeZone: string; questId?: string }
  | { kind: 'calendar_create_many'; blocks: Array<{ title: string; start: number; end: number; questId?: string }>; timeZone: string }
  | { kind: 'calendar_update'; eventId: string; etag?: string; oldStart: number; oldEnd: number; start: number; end: number; timeZone: string; title: string }
  | { kind: 'reminder_prefs'; meetingReminderMinutes?: number; maxNudgesPerDay?: number }
  | { kind: 'task_complete'; provider: TaskProviderId; taskId: string; title: string; questId: string }
  | { kind: 'message_reply'; provider: MessageProviderId; messageId: string; to: string; about: string; body: string }
  | { kind: 'message_mark_read'; provider: MessageProviderId; messageId: string; title: string }

export interface Proposal {
  id: string
  params: ProposalParams
  title: string
  lines: string[]
  target: string
  external: boolean
  source: 'ai' | 'voice' | 'notice' | 'user'
  createdAt: number
  expiresAt: number
  baseRevision: number
  status: 'pending' | 'executing' | 'done' | 'cancelled' | 'expired' | 'failed'
  resultLines?: string[]
  warnings: string[]
}

function mk(params: ProposalParams, title: string, lines: string[], target: string, external: boolean, source: Proposal['source'], now: number, revision: number, warnings: string[] = []): Proposal {
  return { id: newId('prop'), params, title, lines, target, external, source, createdAt: now, expiresAt: now + PROPOSAL_TTL_MS, baseRevision: revision, status: 'pending', warnings }
}

export function questCreateLines(q: { title: string; difficulty: Difficulty; estimatedMinutes: number; skill: Skill | null; deadline?: { at: number; tz: string } }, tz: string): string {
  const r = rewardFor(q.difficulty, q.skill)
  return `“${q.title}” · ${formatDuration(q.estimatedMinutes)} · +${r.xp} XP${q.skill ? ` ${q.skill}+${r.skillPoints}` : ''}${q.deadline ? ` · by ${formatDateTime(q.deadline.at, tz)}` : ''}`
}

export function conflictsWith(events: CalendarEvent[], start: number, end: number, ignoreId?: string): CalendarEvent[] {
  return events.filter((e) => e.id !== ignoreId && e.status !== 'cancelled' && !e.transparent && !e.allDay && e.start < end && e.end > start)
}

export function calendarCreateProposal(
  input: { title: string; start: number; minutes: number; questId?: string },
  ctx: { now: number; tz: string; revision: number; events: CalendarEvent[]; calendarLabel: string; source: Proposal['source'] },
): Proposal | string {
  const title = input.title.trim().slice(0, 100)
  if (!title) return 'missing_title'
  if (!(input.minutes >= 5 && input.minutes <= 480)) return 'invalid_duration'
  if (input.start < ctx.now - 60_000) return 'start_in_past'
  if (input.start > ctx.now + 60 * 86400_000) return 'start_too_far'
  const end = input.start + input.minutes * 60_000
  const conflicts = conflictsWith(ctx.events, input.start, end)
  const warnings = conflicts.map((c) => `Overlaps “${c.title}” (${formatTime(c.start, ctx.tz)}–${formatTime(c.end, ctx.tz)})`)
  return mk(
    { kind: 'calendar_create', title, start: input.start, end, timeZone: ctx.tz, questId: input.questId },
    'Create calendar event',
    [`“${title}”`, `${formatDateTime(input.start, ctx.tz)}–${formatTime(end, ctx.tz)} (${ctx.tz})`, `${formatDuration(input.minutes)} · no attendees · default reminders`, ...warnings],
    ctx.calendarLabel,
    true,
    ctx.source,
    ctx.now,
    ctx.revision,
    warnings,
  )
}

/** “Plan my day”: book several focus blocks with ONE confirmation; each block is created and verified separately. */
export function calendarBlocksProposal(
  blocks: Array<{ title: string; start: number; end: number; questId?: string }>,
  ctx: { now: number; tz: string; revision: number; events: CalendarEvent[]; calendarLabel: string; source: Proposal['source'] },
): Proposal | string {
  if (!blocks.length) return 'no_free_time_found'
  if (blocks.length > 4) return 'too_many_blocks'
  const clean: Array<{ title: string; start: number; end: number; questId?: string }> = []
  const lines: string[] = []
  const warnings: string[] = []
  for (const b of blocks) {
    const title = b.title.trim().slice(0, 100)
    const minutes = Math.round((b.end - b.start) / 60_000)
    if (!title) return 'missing_title'
    if (!(minutes >= 5 && minutes <= 480)) return 'invalid_duration'
    if (b.start < ctx.now - 60_000) return 'start_in_past'
    if (b.start > ctx.now + 60 * 86400_000) return 'start_too_far'
    clean.push({ title, start: b.start, end: b.end, questId: b.questId })
    lines.push(`“${title}” · ${formatDateTime(b.start, ctx.tz)}–${formatTime(b.end, ctx.tz)}`)
    for (const c of conflictsWith(ctx.events, b.start, b.end)) warnings.push(`“${title}” overlaps “${c.title}” (${formatTime(c.start, ctx.tz)}–${formatTime(c.end, ctx.tz)})`)
  }
  return mk(
    { kind: 'calendar_create_many', blocks: clean, timeZone: ctx.tz },
    clean.length === 1 ? 'Book 1 focus block' : `Book ${clean.length} focus blocks`,
    [...lines, `${ctx.tz} · no attendees · default reminders`, ...warnings],
    ctx.calendarLabel,
    true,
    ctx.source,
    ctx.now,
    ctx.revision,
    warnings,
  )
}

/** Convert one validated AI action into a proposal (or an error code). Read-only actions return null. */
export function proposalFromAction(
  a: AiAction,
  ctx: { save: SaveV1; now: number; tz: string; refs: RefMap; events: CalendarEvent[]; calendarConnected: boolean; calendarLabel: string; source: Proposal['source']; inboxLabel?: (p: MessageProviderId) => string },
): Proposal | string | null {
  const findQuest = (ref: string | null | undefined): Quest | undefined => {
    const id = ref ? ctx.refs.quests[ref] : undefined
    return id ? ctx.save.quests.find((q) => q.id === id) : undefined
  }
  const parse = (s: string | null | undefined) => (s ? parseLocalDateTime(s, ctx.tz) : null)
  const rev = ctx.save.revision
  switch (a.type) {
    case 'create_local_quest': {
      const deadlineAt = parse(a.deadlineLocal)
      if (a.deadlineLocal && deadlineAt === null) return 'invalid_deadline'
      const q = { title: a.title, category: a.category, difficulty: a.difficulty, estimatedMinutes: a.estimatedMinutes, skill: a.skill ?? null, ...(deadlineAt ? { deadline: { at: deadlineAt, tz: ctx.tz } } : {}) }
      return mk({ kind: 'create_quests', quests: [q] }, 'Create quest', [questCreateLines(q, ctx.tz), `${q.category} · ${q.difficulty}`], 'Local quest journal', false, ctx.source, ctx.now, rev)
    }
    case 'propose_quest_update': {
      const q = findQuest(a.questRef)
      if (!q) return 'unknown_quest_ref'
      if (q.status === 'completed' || q.status === 'archived') return 'quest_closed'
      const deadlineAt = parse(a.deadlineLocal)
      const lines = [`“${q.title}”`]
      if (a.title) lines.push(`Title → “${a.title}”`)
      if (deadlineAt) lines.push(`Deadline → ${formatDateTime(deadlineAt, ctx.tz)}`)
      if (a.estimatedMinutes) lines.push(`Estimate → ${formatDuration(a.estimatedMinutes)}`)
      if (lines.length === 1) return 'empty_update'
      return mk(
        { kind: 'update_quest', questId: q.id, questUpdatedAt: q.updatedAt, ...(a.title ? { title: a.title } : {}), ...(deadlineAt ? { deadline: { at: deadlineAt, tz: ctx.tz } } : {}), ...(a.estimatedMinutes ? { estimatedMinutes: a.estimatedMinutes } : {}) },
        'Update quest',
        lines,
        'Local quest journal',
        false,
        ctx.source,
        ctx.now,
        rev,
      )
    }
    case 'start_quest': {
      const q = findQuest(a.questRef)
      if (!q) return 'unknown_quest_ref'
      return mk({ kind: 'start_quest', questId: q.id, questUpdatedAt: q.updatedAt }, 'Start quest', [`“${q.title}”`], 'Local quest journal', false, ctx.source, ctx.now, rev)
    }
    case 'complete_local_quest': {
      const q = findQuest(a.questRef)
      if (!q) return 'unknown_quest_ref'
      if (q.status === 'completed') return 'already_completed'
      return mk(
        { kind: 'complete_quest', questId: q.id, questUpdatedAt: q.updatedAt },
        'Complete quest',
        [`“${q.title}”`, `Reward +${q.reward.xp} XP${q.skill ? ` · ${q.skill} +${q.reward.skillPoints}` : ''}`, 'Only confirm if you actually did it.'],
        'Local quest journal',
        false,
        ctx.source,
        ctx.now,
        rev,
      )
    }
    case 'postpone_quest': {
      const q = findQuest(a.questRef)
      if (!q) return 'unknown_quest_ref'
      const at = parse(a.deadlineLocal) ?? Math.max(ctx.now, q.deadline?.at ?? ctx.now) + 3600_000
      return mk({ kind: 'postpone_quest', questId: q.id, questUpdatedAt: q.updatedAt, deadline: { at, tz: ctx.tz } }, 'Postpone quest', [`“${q.title}”`, `New deadline ${formatDateTime(at, ctx.tz)}`], 'Local quest journal', false, ctx.source, ctx.now, rev)
    }
    case 'propose_calendar_event': {
      if (!ctx.calendarConnected) return 'calendar_not_connected'
      const start = parse(a.startLocal)
      if (start === null) return 'invalid_start'
      const q = findQuest(a.questRef)
      return calendarCreateProposal({ title: a.title, start, minutes: a.durationMinutes, questId: q?.id }, { now: ctx.now, tz: ctx.tz, revision: rev, events: ctx.events, calendarLabel: ctx.calendarLabel, source: ctx.source })
    }
    case 'propose_calendar_update': {
      if (!ctx.calendarConnected) return 'calendar_not_connected'
      const ev = ctx.refs.events[a.eventRef]
      if (!ev) return 'unknown_event_ref'
      const start = parse(a.startLocal)
      if (start === null) return 'invalid_start'
      if (start < ctx.now - 60_000) return 'start_in_past'
      const dur = a.durationMinutes ? a.durationMinutes * 60_000 : ev.end - ev.start
      const end = start + dur
      const conflicts = conflictsWith(ctx.events, start, end, ev.id).map((c) => `Overlaps “${c.title}”`)
      return mk(
        { kind: 'calendar_update', eventId: ev.id, etag: ev.etag, oldStart: ev.start, oldEnd: ev.end, start, end, timeZone: ctx.tz, title: ev.title },
        'Reschedule event',
        [`“${ev.title}”`, `From ${formatDateTime(ev.start, ctx.tz)}–${formatTime(ev.end, ctx.tz)}`, `To ${formatDateTime(start, ctx.tz)}–${formatTime(end, ctx.tz)}`, 'Attendees are not notified', ...conflicts],
        ctx.calendarLabel,
        true,
        ctx.source,
        ctx.now,
        rev,
        conflicts,
      )
    }
    case 'set_reminder_preferences': {
      const lines: string[] = []
      if (a.meetingReminderMinutes) lines.push(`Meeting reminder → ${a.meetingReminderMinutes} min before`)
      if (a.maxNudgesPerDay !== undefined && a.maxNudgesPerDay !== null) lines.push(`Max nudges per day → ${a.maxNudgesPerDay}`)
      if (!lines.length) return 'empty_update'
      return mk(
        { kind: 'reminder_prefs', ...(a.meetingReminderMinutes ? { meetingReminderMinutes: a.meetingReminderMinutes } : {}), ...(a.maxNudgesPerDay !== undefined && a.maxNudgesPerDay !== null ? { maxNudgesPerDay: a.maxNudgesPerDay } : {}) },
        'Change reminder settings',
        lines,
        'Local settings',
        false,
        ctx.source,
        ctx.now,
        rev,
      )
    }
    case 'propose_message_reply': {
      const m = ctx.refs.messages[a.messageRef]
      if (!m) return 'unknown_message_ref'
      return messageReplyProposal(
        { provider: m.provider, messageId: m.id, to: m.from, about: m.title, where: m.where, body: a.body, canReply: m.canReply },
        { now: ctx.now, revision: rev, source: ctx.source, target: ctx.inboxLabel?.(m.provider) ?? MESSAGE_PROVIDER_LABELS[m.provider] },
      )
    }
    default:
      return null // read-only / navigation actions are handled by the controller
  }
}

/** Merge several AI create_local_quest proposals (goal breakdown) into one reviewable batch. */
export function mergeQuestProposals(ps: Proposal[], tz: string): Proposal {
  const quests = ps.flatMap((p) => (p.params.kind === 'create_quests' ? p.params.quests : []))
  const first = ps[0]!
  return { ...first, params: { kind: 'create_quests', quests }, title: `Create ${quests.length} quests`, lines: quests.map((q) => questCreateLines(q, tz)) }
}

/** Re-check that a proposal is still current before executing (expiry, replay, stale data). */
/**
 * A reply the user sends from their own Gmail/Slack. Shown verbatim; the exact text is what gets sent.
 * Outgoing text is always clean, whatever the companion's language mode (it speaks for the user).
 */
export function messageReplyProposal(
  input: { provider: MessageProviderId; messageId: string; to: string; about: string; where: string; body: string; canReply: boolean },
  ctx: { now: number; revision: number; source: Proposal['source']; target: string },
): Proposal | string {
  const body = input.body.trim().replace(/\r\n?/g, '\n')
  if (!body) return 'empty_reply'
  if (body.length > REPLY_MAX) return 'reply_too_long'
  if (!input.canReply) return 'reply_not_allowed'
  if (containsProfanity(body) || containsForbidden(body)) return 'reply_must_be_clean'
  const app = MESSAGE_PROVIDER_LABELS[input.provider]
  return mk(
    { kind: 'message_reply', provider: input.provider, messageId: input.messageId, to: input.to, about: input.about, body },
    input.provider === 'gmail' ? 'Send this email reply?' : input.provider === 'telegram' ? 'Send this Telegram reply?' : 'Post this Slack reply?',
    [
      input.provider === 'gmail' ? `To ${input.to} · Re: ${input.about}` : input.provider === 'telegram' ? `To ${input.to} · ${input.where === 'Telegram' ? 'private chat' : input.where}` : `To ${input.to} · thread in ${input.where}`,
      `“${body}”`,
      // Telegram bot mode (DM to the bot or a group it is in) answers as the bot; Business connections answer as the user
      input.provider === 'telegram' && input.where !== 'Telegram' ? `Sent by your Telegram bot. Nothing is sent until you confirm.` : `Sent from your ${app} as you. Nothing is sent until you confirm.`,
    ],
    ctx.target,
    true,
    ctx.source,
    ctx.now,
    ctx.revision,
  )
}

/** Write-back of a finished quest to the task list it came from. External, so it always needs confirmation. */
export function taskCompleteProposal(
  input: { provider: TaskProviderId; taskId: string; title: string; questId: string },
  ctx: { now: number; revision: number; source: Proposal['source']; target: string },
): Proposal {
  return mk(
    { kind: 'task_complete', ...input },
    'Tick it off at the source?',
    [`Mark “${input.title}” as done`, `in ${ctx.target}`, 'Your quest reward is already counted — this only updates that list.'],
    ctx.target,
    true,
    ctx.source,
    ctx.now,
    ctx.revision,
  )
}

export function staleReason(p: Proposal, save: SaveV1, now: number): string | null {
  if (p.status !== 'pending') return `not_pending_${p.status}`
  if (now > p.expiresAt) return 'expired'
  const prm = p.params
  if ('questId' in prm && prm.kind !== 'calendar_create') {
    const q = save.quests.find((x) => x.id === prm.questId)
    if (!q) return 'quest_missing'
    if ('questUpdatedAt' in prm && q.updatedAt !== prm.questUpdatedAt) return 'quest_changed'
  }
  return null
}

export function busySummary(events: CalendarEvent[]): number {
  return busyIntervals(events).reduce((s, b) => s + (b.end - b.start), 0)
}
