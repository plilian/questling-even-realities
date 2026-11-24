import type { AiAction } from '../shared/ai'
import type { AiContext } from '../shared/ai'
import type { CompanionId, Emotion } from '../shared/schema'
import { COMPANIONS } from '../companion/roster'

/**
 * Offline / not-configured fallback. A small deterministic command parser — clearly labelled
 * "local (offline)" in the UI, never presented as Gemini. Produces the same validated action
 * shapes, so the trusted proposal pipeline is identical.
 */
export interface LocalReply {
  dialogue: string
  emotion: Emotion
  intent: string
  actions: AiAction[]
}

const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, 'forty five': 45, forty: 40, sixty: 60, ninety: 90 }

function num(s: string | undefined): number | null {
  if (!s) return null
  const t = s.trim().toLowerCase()
  if (/^\d+$/.test(t)) return Number(t)
  return NUM[t] ?? null
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}

/** "before 5", "by 17:30", "at 9am" → local YYYY-MM-DDTHH:mm (today, or tomorrow if passed). */
export function parseTimePhrase(text: string, nowLocal: string): string | null {
  const m = /\b(?:before|by|at|until)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i.exec(text)
  if (!m) return null
  let h = num(m[1])
  if (h === null || h > 23) return null
  const min = m[2] ? Number(m[2]) : 0
  const ap = m[3]?.toLowerCase().replace(/\./g, '')
  const [date, time] = nowLocal.split('T') as [string, string]
  const nowH = Number(time.slice(0, 2))
  if (ap === 'pm' && h < 12) h += 12
  else if (ap === 'am' && h === 12) h = 0
  else if (!ap && h <= 7 && nowH >= 8) h += 12 // "before five" during the day means 17:00
  let d = date
  if (h * 60 + min <= nowH * 60 + Number(time.slice(3, 5))) {
    const dt = new Date(`${date}T00:00:00Z`)
    dt.setUTCDate(dt.getUTCDate() + 1)
    d = dt.toISOString().slice(0, 10)
  }
  return `${d}T${pad(h)}:${pad(min)}`
}

export function localReply(message: string, companion: CompanionId, ctx: AiContext): LocalReply {
  const t = message.toLowerCase().trim()
  const name = COMPANIONS[companion].name
  const first = ctx.quests[0]
  const create = /\b(?:create|add|make|new)\b(?:\s+a)?\s+(?:quest|task|todo)\s+(?:to\s+)?(.+)/i.exec(message)
  if (create) {
    let title = create[1]!.replace(/\s+\b(?:before|by|at|until)\b.*$/i, '').replace(/[.?!]+$/, '').trim()
    title = title.charAt(0).toUpperCase() + title.slice(1)
    if (!title) return { dialogue: 'What should the quest be called?', emotion: 'thinking', intent: 'unclear', actions: [] }
    const deadline = parseTimePhrase(message, ctx.nowLocal)
    const skill = /\b(run|walk|gym|workout|stretch|bike|swim)\b/i.test(title) ? 'STR' : /\b(read|study|learn|research|course)\b/i.test(title) ? 'INT' : /\b(call|email|reply|message|meet|talk)\b/i.test(title) ? 'SOC' : 'DIS'
    return {
      dialogue: `Here’s the quest — check it before I add it.`,
      emotion: 'thinking',
      intent: 'quest_create',
      actions: [{ type: 'create_local_quest', title: title.slice(0, 80), category: /\b(work|report|slides|presentation|client|meeting|invoice)\b/i.test(title) ? 'work' : 'personal', difficulty: 'normal', estimatedMinutes: 30, deadlineLocal: deadline, skill }],
    }
  }
  if (/\bnext quest\b|what should i do|what now/.test(t)) {
    return first
      ? { dialogue: `Next: “${first.title}” (${first.estimatedMinutes} min)${first.overdue ? ' — it’s overdue.' : '.'}`, emotion: first.overdue ? 'annoyed' : 'idle', intent: 'chat', actions: [] }
      : { dialogue: 'No open quests. Add one!', emotion: 'happy', intent: 'chat', actions: [] }
  }
  if (/\b(calendar|schedule|agenda|meetings?)\b/.test(t) && !/\bfind\b/.test(t)) {
    if (!ctx.calendar) return { dialogue: 'Calendar isn’t connected. Connect it in Settings.', emotion: 'thinking', intent: 'calendar_query', actions: [] }
    const ev = ctx.calendar.events[0]
    return { dialogue: ev ? `Next up: “${ev.title}” at ${ev.startLocal.slice(11)}. ${ctx.calendar.events.length} event(s) ahead.` : 'Nothing else on your calendar today.', emotion: 'idle', intent: 'calendar_query', actions: [{ type: 'view_calendar' }] }
  }
  const find = /\bfind\s+(\d+|[a-z ]+?)\s*(?:min|minutes)\b/.exec(t)
  if (find) {
    const minutes = num(find[1]) ?? 30
    return { dialogue: `Looking for ${minutes} free minutes…`, emotion: 'thinking', intent: 'schedule', actions: [{ type: 'find_free_slot', durationMinutes: Math.min(240, Math.max(5, minutes)), questRef: first?.ref ?? null }] }
  }
  if (/\b(stop|mute|quiet|silence|shut up|leave me alone)\b/.test(t)) {
    const duration = /\b15\b|fifteen/.test(t) ? '15m' : /tomorrow|tonight|today/.test(t) ? 'tomorrow' : /forever|indefinitely|until i/.test(t) ? 'indefinite' : '1h'
    return { dialogue: 'Muting reminders.', emotion: 'concerned', intent: 'mute', actions: [{ type: 'mute_companion', duration }] }
  }
  if (/\b(complete|finish(ed)?|done with)\b.*\b(current|this|my)\b.*\bquest\b|\bi('m| am) done\b/.test(t)) {
    const active = ctx.quests.find((q) => q.status === 'in_progress') ?? first
    if (!active) return { dialogue: 'There’s no open quest to complete.', emotion: 'thinking', intent: 'quest_update', actions: [] }
    return { dialogue: `Mark “${active.title}” complete?`, emotion: 'happy', intent: 'quest_update', actions: [{ type: 'complete_local_quest', questRef: active.ref }] }
  }
  if (/what do you remember|what do you know about me/.test(t)) {
    return { dialogue: ctx.memory.length ? `I remember: ${ctx.memory.slice(0, 3).join('; ')}.` : 'Nothing saved yet. You control my memory in Settings.', emotion: 'thinking', intent: 'memory', actions: [] }
  }
  if (/why are you so/.test(t)) {
    return { dialogue: `I’m ${name}. ${COMPANIONS[companion].motivation.split('.')[0]}.`, emotion: 'happy', intent: 'chat', actions: [] }
  }
  if (/daily review|how did i do|review my day/.test(t)) {
    return { dialogue: `Today you completed ${ctx.completedToday.length} quest(s).`, emotion: 'happy', intent: 'review', actions: [{ type: 'daily_review' }] }
  }
  return {
    dialogue: 'I’m offline right now, so I only understand simple commands: “create a quest to…”, “what’s my next quest”, “find 30 minutes”, “mute for an hour”.',
    emotion: 'concerned',
    intent: 'unclear',
    actions: [],
  }
}
