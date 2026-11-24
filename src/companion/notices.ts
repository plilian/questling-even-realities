import type { CompanionId, Emotion } from '../shared/schema'
import { formatDuration, formatTime } from '../shared/time'
import { newId } from '../shared/ids'
import type { DomainEvent } from '../game/reducer'
import { COMPANIONS } from './roster'
import { pickLine, type DialogueEvent, type DialogueVars } from './dialogue'
import type { LanguagePolicy, Line } from './policy'
import type { MuteDuration, NoticeCandidate } from './engine'
import type { MessageProviderId } from '../shared/messages'

export type NoticeAction =
  | { id: 'start'; label: string; questId: string }
  | { id: 'postpone'; label: string; questId: string; minutes: number }
  | { id: 'split'; label: string; questId: string }
  | { id: 'open_quest'; label: string; questId: string }
  | { id: 'complete'; label: string; questId: string }
  | { id: 'review_event'; label: string; eventId: string }
  | { id: 'schedule_slot'; label: string; questId: string; slotStart: number; minutes: number }
  | { id: 'daily_review'; label: string }
  | { id: 'snooze'; label: string; ms: number }
  | { id: 'mute'; label: string; duration: MuteDuration }
  | { id: 'dismiss'; label: string }
  | { id: 'talk'; label: string }
  | { id: 'open_message'; label: string; provider: MessageProviderId; messageId: string }
  | { id: 'plan_day'; label: string }
  | { id: 'catch_up'; label: string }
  | { id: 'prep_meeting'; label: string; eventId: string }
  | { id: 'running_late'; label: string; eventId: string }
  | { id: 'focus_complete'; label: string; questId: string }
  | { id: 'focus_extend'; label: string; minutes: number }
  | { id: 'focus_stop'; label: string }

export type NoticeKind = NoticeCandidate['type'] | 'CELEBRATION' | 'INFO'

export interface Notice {
  id: string
  key: string
  kind: NoticeKind
  companionId: CompanionId
  emotion: Emotion
  line: Line
  actions: NoticeAction[]
  createdAt: number
  solicited: boolean
  critical: boolean
  covers?: string[]
  /** short reward summary for celebrations */
  reward?: { xp: number; skill: string | null; skillPoints: number; level?: number; items: string[] }
  /** play the companion's signature reaction sequence */
  react: boolean
}

const SNOOZE_15 = { id: 'snooze', label: 'Snooze 15m', ms: 15 * 60_000 } as const
const SNOOZE_60 = { id: 'snooze', label: 'Snooze 1h', ms: 60 * 60_000 } as const
const DISMISS = { id: 'dismiss', label: 'Dismiss' } as const

function overdueActions(companion: CompanionId, questId: string): NoticeAction[] {
  const style = COMPANIONS[companion].overdueStyle
  switch (style) {
    case 'split':
      return [{ id: 'split', label: 'Split it smaller', questId }, { id: 'start', label: 'Start it', questId }, { id: 'postpone', label: 'Postpone 1h', questId, minutes: 60 }]
    case 'start':
      return [{ id: 'start', label: 'Start mission', questId }, { id: 'postpone', label: 'Reschedule +1h', questId, minutes: 60 }, { id: 'split', label: 'Break into 15m op', questId }]
    case 'smaller':
      return [{ id: 'split', label: 'Tiny first step', questId }, { id: 'start', label: 'Start now', questId }, { id: 'postpone', label: 'Try in 1h', questId, minutes: 60 }]
    case 'reflect':
      return [{ id: 'postpone', label: 'Re-plan: tomorrow', questId, minutes: 24 * 60 }, { id: 'start', label: 'Begin now', questId }, { id: 'split', label: 'Smaller step', questId }]
    case 'push':
      return [{ id: 'start', label: 'Do it now', questId }, { id: 'split', label: 'Split it', questId }, { id: 'postpone', label: 'Fine, 1h', questId, minutes: 60 }]
  }
}

export function noticeFromCandidate(
  c: NoticeCandidate,
  companion: CompanionId,
  policy: LanguagePolicy,
  ctx: { now: number; tz: string; nextQuestTitle?: string; intensity?: 'gentle' | 'balanced' | 'intense' },
): Notice {
  let event: DialogueEvent
  const vars: DialogueVars = { next: ctx.nextQuestTitle ? `“${ctx.nextQuestTitle}”` : 'one small quest', count: c.count ?? 0 }
  let actions: NoticeAction[] = []
  switch (c.type) {
    case 'DAY_STARTED':
      event = 'morning'
      actions = [{ id: 'plan_day', label: 'Plan my day' }, ...(c.quest ? [{ id: 'open_quest' as const, label: 'Open next quest', questId: c.quest.id }] : [])]
      break
    case 'USER_RETURNED':
      event = 'returned'
      actions = [{ id: 'catch_up', label: 'Catch me up' }, { id: 'plan_day', label: 'Plan my day' }]
      break
    case 'QUEST_OVERDUE':
      event = c.quest!.postponeCount >= 3 ? 'postponed_again' : 'overdue'
      vars.quest = c.quest!.title
      vars.count = c.quest!.postponeCount
      actions = overdueActions(companion, c.quest!.id)
      break
    case 'QUESTS_OVERDUE_SUMMARY':
      event = 'overdue_many'
      vars.quest = c.quest?.title
      actions = c.quest ? overdueActions(companion, c.quest.id).slice(0, 2) : []
      break
    case 'CALENDAR_EVENT_UPCOMING': {
      event = 'meeting'
      const mins = Math.max(1, Math.round((c.event!.start - ctx.now) / 60000))
      vars.event = c.event!.title || 'Meeting'
      vars.minutes = mins
      vars.time = formatTime(c.event!.start, ctx.tz)
      actions = [
        { id: 'review_event', label: 'Review meeting', eventId: c.event!.id },
        { id: 'prep_meeting', label: 'Prep me', eventId: c.event!.id },
        { id: 'running_late', label: 'Running late', eventId: c.event!.id },
      ]
      break
    }
    case 'CALENDAR_FREE_SLOT_FOUND': {
      event = 'free_slot'
      const mins = Math.round((c.slot!.end - c.slot!.start) / 60000)
      vars.minutes = Math.min(mins, 120)
      vars.time = formatTime(c.slot!.start, ctx.tz)
      vars.quest = c.quest!.title
      actions = [
        { id: 'schedule_slot', label: `Book ${formatDuration(c.quest!.estimatedMinutes)} at ${formatTime(c.slot!.start, ctx.tz)}`, questId: c.quest!.id, slotStart: c.slot!.start, minutes: c.quest!.estimatedMinutes },
        { id: 'start', label: 'Start now', questId: c.quest!.id },
      ]
      break
    }
    case 'DAILY_REVIEW_AVAILABLE':
      event = 'daily_review'
      actions = [{ id: 'daily_review', label: 'Daily review' }]
      break
    case 'MESSAGE_RECEIVED': {
      const m = c.message!
      event = m.provider === 'gmail' ? 'mail' : 'mention'
      // third-party text: short, and the whole line still goes through final-render language validation
      vars.from = m.from.slice(0, 40)
      vars.subject = m.title.length > 60 ? `${m.title.slice(0, 59)}…` : m.title
      vars.where = (m.provider === 'telegram' && m.where.startsWith('@') ? 'Telegram' : m.where).slice(0, 40)
      actions = [{ id: 'open_message', label: 'Reply', provider: m.provider, messageId: m.id }]
      break
    }
  }
  const { line, emotion } = pickLine(companion, event, vars, policy, { seed: c.key, intensity: ctx.intensity })
  const tail: NoticeAction[] = c.type === 'CALENDAR_EVENT_UPCOMING' ? [{ ...SNOOZE_15, label: 'Snooze 5m', ms: 5 * 60_000 }, DISMISS] : [SNOOZE_15, SNOOZE_60, DISMISS]
  return {
    id: newId('ntc'),
    key: c.key,
    kind: c.type,
    companionId: companion,
    emotion,
    line,
    actions: [...actions, ...tail, { id: 'mute', label: 'Mute 1h', duration: '1h' }],
    createdAt: ctx.now,
    solicited: false,
    critical: c.critical,
    covers: c.covers,
    react: c.critical || c.type === 'QUEST_OVERDUE',
  }
}

/** Coalesce domain events into a single celebration notice (quest complete + level-up + unlocks). */
export function celebrationFromEvents(
  events: DomainEvent[],
  companion: CompanionId,
  policy: LanguagePolicy,
  ctx: { now: number; tz: string; intensity?: 'gentle' | 'balanced' | 'intense'; nextQuestId?: string },
): Notice | null {
  const done = events.find((e) => e.type === 'QUEST_COMPLETED')
  const lvl = events.find((e) => e.type === 'LEVEL_UP')
  const bossDef = events.find((e) => e.type === 'BOSS_DEFEATED')
  const bossDmg = events.find((e) => e.type === 'BOSS_DAMAGED')
  const items = events.filter((e) => e.type === 'ITEM_UNLOCKED').map((e) => (e as { name: string }).name)
  const postponed = events.find((e) => e.type === 'QUEST_POSTPONED')
  let ev: DialogueEvent | null = null
  const vars: DialogueVars = {}
  if (bossDef) ev = 'boss_defeated'
  else if (lvl && lvl.type === 'LEVEL_UP') {
    ev = 'level_up'
    vars.level = lvl.to
  } else if (bossDmg && bossDmg.type === 'BOSS_DAMAGED') {
    ev = 'boss_damaged'
    vars.xp = bossDmg.damage
  } else if (done && done.type === 'QUEST_COMPLETED') {
    ev = 'completed'
    vars.quest = done.title
    vars.xp = done.xp
  } else if (postponed && postponed.type === 'QUEST_POSTPONED') {
    ev = postponed.postponeCount >= 3 ? 'postponed_again' : 'postponed'
    vars.quest = postponed.title
    vars.count = postponed.postponeCount
  } else if (items.length) {
    ev = 'unlock'
    vars.item = items[0]
  }
  if (!ev) return null
  const { line, emotion } = pickLine(companion, ev, vars, policy, { seed: `${ctx.now}`, intensity: ctx.intensity })
  const reward =
    done && done.type === 'QUEST_COMPLETED'
      ? { xp: done.xp, skill: done.skill, skillPoints: done.skillPoints, level: lvl && lvl.type === 'LEVEL_UP' ? lvl.to : undefined, items }
      : undefined
  const isCelebration = !!(done || lvl || bossDef || bossDmg || items.length)
  return {
    id: newId('ntc'),
    key: `celebrate:${ctx.now}`,
    kind: isCelebration ? 'CELEBRATION' : 'INFO',
    companionId: companion,
    emotion,
    line,
    actions: ctx.nextQuestId ? [{ id: 'open_quest', label: 'Next quest', questId: ctx.nextQuestId }, { id: 'dismiss', label: 'Continue' }] : [{ id: 'dismiss', label: 'Continue' }],
    createdAt: ctx.now,
    solicited: true,
    critical: false,
    reward,
    react: isCelebration,
  }
}

/** A simple solicited info line (confirmation results, mute acknowledgement, offline notice). */
export function infoNotice(companion: CompanionId, ev: DialogueEvent, vars: DialogueVars, policy: LanguagePolicy, now: number): Notice {
  const { line, emotion } = pickLine(companion, ev, vars, policy, { seed: `${ev}:${now}` })
  return {
    id: newId('ntc'),
    key: `info:${ev}:${now}`,
    kind: 'INFO',
    companionId: companion,
    emotion,
    line,
    actions: [{ id: 'dismiss', label: 'OK' }],
    createdAt: now,
    solicited: true,
    critical: false,
    react: false,
  }
}
