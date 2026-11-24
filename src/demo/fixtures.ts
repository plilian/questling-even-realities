import type { SaveV1 } from '../shared/schema'
import type { CalendarEvent } from '../shared/calendar'
import { defaultSave } from '../storage/save'
import { applyGameCommand } from '../game/reducer'

/**
 * Deterministic synthetic demo: isolated save namespace, synthetic calendar,
 * times relative to the injected clock. Player L2 / 140 XP; 2 completed + 3 pending quests
 * (one overdue, one with an upcoming deadline, one 30-minute presentation task);
 * a synthetic meeting 15 minutes from now and a free slot after it.
 */
export function demoSave(now: number, tz: string): SaveV1 {
  let s = defaultSave({ companion: 'grumpy', avatar: 'adventurer', name: 'Demo Hero' })
  s = { ...s, preferences: { ...s.preferences, onboarded: true, goal: 'Ship the portfolio by Friday', quietHours: { enabled: false, start: '22:00', end: '08:00' } } }
  const add = (title: string, over: Record<string, unknown>) => {
    const r = applyGameCommand(s, { type: 'quest/create', input: { title, category: 'work', difficulty: 'normal', estimatedMinutes: 30, skill: 'DIS', source: 'demo', ...over } as never }, now - 3 * 3600_000, tz)
    s = r.save
    return s.quests[s.quests.length - 1]!
  }
  const run = add('Morning run 5k', { description: 'Easy pace — just get out the door.', category: 'daily', difficulty: 'hard', estimatedMinutes: 35, skill: 'STR' })
  const plan = add('Plan the week', { description: 'Block focus time and pick top priorities.', category: 'personal', difficulty: 'hard', estimatedMinutes: 25, skill: 'DIS' })
  s = applyGameCommand(s, { type: 'quest/complete', id: run.id, method: 'self_reported' }, now - 2 * 3600_000, tz).save
  s = applyGameCommand(s, { type: 'quest/complete', id: plan.id, method: 'self_reported' }, now - 90 * 60_000, tz).save
  add('Send invoice to client', { description: 'October hours, PDF to the client’s billing address.', deadline: { at: now - 40 * 60_000, tz }, skill: 'SOC', estimatedMinutes: 15, difficulty: 'easy' })
  add('Review pull request #42', { description: 'Check the tests and leave clear comments.', deadline: { at: now + 2 * 3600_000, tz }, skill: 'INT', estimatedMinutes: 20 })
  add('Finish presentation slides', { description: 'Polish the story and rehearse once out loud.', estimatedMinutes: 30, skill: 'INT' })
  // achievements/unlocks from the two completions are kept; mark demo as fresh for reminders
  return { ...s, revision: 0 }
}

export function demoEvents(now: number): CalendarEvent[] {
  const min = 60_000
  const round = (t: number) => Math.round(t / (5 * min)) * 5 * min
  // 14 minutes ahead (minute-aligned) so it is inside the default 15-minute reminder window
  const meetStart = Math.floor((now + 14 * min) / min) * min
  return [
    { id: 'demo_meeting_design', calendarId: 'demo', title: 'Design review with Alex (demo)', start: meetStart, end: meetStart + 30 * min, allDay: false, status: 'confirmed', transparent: false, etag: '"1"' },
    { id: 'demo_meeting_1on1', calendarId: 'demo', title: '1:1 with Sam (demo)', start: round(now + 150 * min), end: round(now + 180 * min), allDay: false, status: 'confirmed', transparent: false, etag: '"1"' },
  ]
}
