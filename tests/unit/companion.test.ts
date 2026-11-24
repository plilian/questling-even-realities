import { describe, expect, it } from 'vitest'
import { evaluate, isQuietHours, muteUntil, recordDelivery, recordResponse, type EngineInput } from '../../src/companion/engine'
import { adultLinesFor, cleanLinesFor, fullLinesFor, pickLine, type DialogueEvent } from '../../src/companion/dialogue'
import { containsForbidden, containsProfanity, finalizeLine, persistableText, policyFrom, type LanguagePolicy } from '../../src/companion/policy'
import { celebrationFromEvents, noticeFromCandidate } from '../../src/companion/notices'
import { COMPANION_ORDER } from '../../src/companion/roster'
import { defaultSave } from '../../src/storage/save'
import { AdultSettingsSchema, type Quest, type SaveV1 } from '../../src/shared/schema'
import type { CalendarEvent } from '../../src/shared/calendar'
import { freeSlots } from '../../src/shared/calendar'
import { zonedToUtc } from '../../src/shared/time'

const TZ = 'Europe/Istanbul'
const at = (h: number, m = 0, d = 24) => zonedToUtc(2026, 11, d, h, m, TZ)
const CLEAN: LanguagePolicy = policyFrom(AdultSettingsSchema.parse({}), 'medium')
const ADULT: LanguagePolicy = policyFrom(
  AdultSettingsSchema.parse({ adultLanguageEnabled: true, attestedAt: 1, profanityLevel: 'strong', policyRevision: 3 }),
  'medium',
)

function quest(over: Partial<Quest> = {}): Quest {
  return {
    id: 'q_overdue01',
    title: 'Send invoice',
    category: 'work',
    difficulty: 'normal',
    estimatedMinutes: 30,
    status: 'pending',
    source: 'manual',
    skill: 'DIS',
    reward: { xp: 40, skillPoints: 2 },
    createdAt: at(8),
    updatedAt: at(8),
    postponeCount: 0,
    ...over,
  }
}

function input(over: Partial<EngineInput> & { save?: SaveV1 } = {}): EngineInput {
  const save = over.save ?? defaultSave()
  return {
    now: at(12),
    tz: TZ,
    save,
    calendar: { connected: false, events: [], fetchedAt: null },
    trigger: 'tick',
    busy: false,
    showing: false,
    ...over,
  }
}

const meeting = (startH: number, startM: number, id = 'evt_1'): CalendarEvent => ({
  id,
  calendarId: 'primary',
  title: 'Design review',
  start: at(startH, startM),
  end: at(startH, startM) + 30 * 60_000,
  allDay: false,
  status: 'confirmed',
  transparent: false,
})

describe('proactive engine', () => {
  it('nudges about an overdue quest once, with dedupe', () => {
    const save = { ...defaultSave(), quests: [quest({ deadline: { at: at(11), tz: TZ } })] }
    const r = evaluate(input({ save }))
    expect(r.notice?.type).toBe('QUEST_OVERDUE')
    const rem = recordDelivery(r.reminders, r.notice!, at(12), TZ)
    const r2 = evaluate(input({ save: { ...save, reminders: rem }, now: at(13) }))
    expect(r2.notice).toBeNull()
  })

  it('respects quiet hours, mute, busy and showing', () => {
    const save = { ...defaultSave(), quests: [quest({ deadline: { at: at(11), tz: TZ } })] }
    expect(evaluate(input({ save, now: at(23) })).suppressedBy).toBe('quiet_hours')
    expect(evaluate(input({ save, now: at(7, 30) })).suppressedBy).toBe('quiet_hours')
    expect(isQuietHours(save.preferences, at(9), TZ)).toBe(false)
    const muted = { ...save, reminders: { ...save.reminders, mutedUntil: at(13) } }
    expect(evaluate(input({ save: muted })).suppressedBy).toBe('muted')
    expect(evaluate(input({ save, busy: true })).suppressedBy).toBe('busy')
    expect(evaluate(input({ save, showing: true })).suppressedBy).toBe('showing')
  })

  it('enforces global cooldown and daily cap for noncritical nudges', () => {
    const q1 = quest({ id: 'q_aaaaaaaa', deadline: { at: at(11), tz: TZ } })
    let save: SaveV1 = { ...defaultSave(), quests: [q1] }
    const r = evaluate(input({ save }))
    save = { ...save, reminders: recordDelivery(r.reminders, r.notice!, at(12), TZ) }
    const q2 = quest({ id: 'q_bbbbbbbb', title: 'Second', deadline: { at: at(12, 5), tz: TZ } })
    save = { ...save, quests: [q1, q2] }
    expect(evaluate(input({ save, now: at(12, 10) })).suppressedBy).toBe('cooldown')
    expect(evaluate(input({ save, now: at(12, 25) })).notice?.quest?.id).toBe('q_bbbbbbbb')
    const capped = { ...save, reminders: { ...save.reminders, nudgesToday: 4, nudgeDay: '2026-11-24', lastUnsolicitedAt: null } }
    expect(evaluate(input({ save: capped, now: at(12, 25) })).suppressedBy).toBe('daily_cap')
  })

  it('meeting reminder is critical: bypasses cooldown but not quiet hours', () => {
    const save = { ...defaultSave(), reminders: { ...defaultSave().reminders, lastUnsolicitedAt: at(11, 59) } }
    const cal = { connected: true, events: [meeting(12, 10)], fetchedAt: at(11, 55) }
    const r = evaluate(input({ save, calendar: cal }))
    expect(r.notice?.type).toBe('CALENDAR_EVENT_UPCOMING')
    expect(r.notice?.critical).toBe(true)
    // outside the 15-minute window: nothing
    expect(evaluate(input({ save, calendar: { ...cal, events: [meeting(12, 40)] } })).notice?.type).not.toBe('CALENDAR_EVENT_UPCOMING')
  })

  it('prioritizes a meeting over an overdue quest', () => {
    const save = { ...defaultSave(), quests: [quest({ deadline: { at: at(11), tz: TZ } })] }
    const r = evaluate(input({ save, calendar: { connected: true, events: [meeting(12, 10)], fetchedAt: at(12) } }))
    expect(r.notice?.type).toBe('CALENDAR_EVENT_UPCOMING')
  })

  it('expires stale meetings on resume instead of showing them', () => {
    const r = evaluate(input({ trigger: 'resumed', calendar: { connected: true, events: [meeting(11, 0)], fetchedAt: at(12) } }))
    expect(r.notice?.type).not.toBe('CALENDAR_EVENT_UPCOMING')
    expect(Object.values(r.reminders.records).some((x) => x.status === 'expired')).toBe(true)
  })

  it('shows ONE summary on app open that consolidates overdue backlog', () => {
    const quests = [1, 2, 3].map((i) => quest({ id: `q_over000${i}`, title: `Q${i}`, deadline: { at: at(8 + i), tz: TZ } }))
    const save = { ...defaultSave(), quests }
    const r = evaluate(input({ save, trigger: 'app_opened' }))
    expect(r.notice?.type).toBe('DAY_STARTED')
    expect(r.notice?.covers).toHaveLength(3)
    const rem = recordDelivery(r.reminders, r.notice!, at(12), TZ)
    // later ticks do not replay the three individual overdue notices
    expect(evaluate(input({ save: { ...save, reminders: rem }, now: at(12, 30) })).notice).toBeNull()
  })

  it('snooze re-arms after the snooze period', () => {
    const save = { ...defaultSave(), quests: [quest({ deadline: { at: at(11), tz: TZ } })] }
    const r = evaluate(input({ save }))
    const rem = recordResponse(recordDelivery(r.reminders, r.notice!, at(12), TZ), r.notice!, { kind: 'snooze', ms: 15 * 60_000 }, at(12))
    const remNoCooldown = { ...rem, lastUnsolicitedAt: null }
    expect(evaluate(input({ save: { ...save, reminders: remNoCooldown }, now: at(12, 10) })).notice).toBeNull()
    expect(evaluate(input({ save: { ...save, reminders: remNoCooldown }, now: at(12, 16) })).notice?.type).toBe('QUEST_OVERDUE')
  })

  it('suggests a real free slot from authorized calendar data', () => {
    const save = { ...defaultSave(), quests: [quest({ deadline: undefined, estimatedMinutes: 25 })] }
    const events = [meeting(13, 0)]
    const r = evaluate(input({ save, calendar: { connected: true, events, fetchedAt: at(11, 55) } }))
    expect(r.notice?.type).toBe('CALENDAR_FREE_SLOT_FOUND')
    expect(r.notice!.slot!.end).toBeLessThanOrEqual(at(13, 0))
    // stale calendar data: no availability claim
    const stale = evaluate(input({ save, calendar: { connected: true, events, fetchedAt: at(10) } }))
    expect(stale.notice).toBeNull()
  })

  it('mute until tomorrow ends at next morning; after midnight means this morning', () => {
    expect(muteUntil('tomorrow', at(15), TZ)).toBe(at(8, 0, 25))
    expect(muteUntil('tomorrow', at(1), TZ)).toBe(at(8, 0, 24))
  })

  it('handles DST in free-slot windows (America/New_York, 2026-11-01)', () => {
    const tz = 'America/New_York'
    const start = zonedToUtc(2026, 11, 1, 0, 30, tz)
    const slots = freeSlots([], { start, end: start + 24 * 3600_000 }, 60, tz, { start: '08:00', end: '22:00' })
    expect(slots).toHaveLength(1)
    expect(slots[0]!.end - slots[0]!.start).toBe(14 * 3600_000)
  })
})

describe('dialogue and personalities', () => {
  const events = ['morning', 'overdue', 'meeting', 'completed', 'free_slot', 'rest'] as const
  it('each companion has distinct lines for the matrix events', () => {
    for (const ev of events) {
      const firsts = COMPANION_ORDER.map((c) => cleanLinesFor(c, ev).join('|'))
      expect(new Set(firsts).size).toBe(5)
      for (const c of COMPANION_ORDER) expect(cleanLinesFor(c, ev).length).toBeGreaterThan(0)
    }
  })
  it('every clean line is free of profanity (including the Savage)', () => {
    const all = ['morning', 'returned', 'overdue', 'overdue_many', 'postponed', 'postponed_again', 'meeting', 'free_slot', 'started', 'created', 'completed', 'level_up', 'rest', 'daily_review', 'boss_damaged', 'boss_defeated', 'unlock', 'muted', 'offline', 'overload', 'stop', 'confirm', 'done', 'cancelled', 'empty', 'intro'] as const
    for (const c of COMPANION_ORDER) for (const ev of all) for (const l of cleanLinesFor(c, ev)) expect(containsProfanity(l), `${c}/${ev}: ${l}`).toBe(false)
  })
  it('only the Savage has adult variants, and they actually swear', () => {
    for (const c of COMPANION_ORDER.filter((x) => x !== 'savage')) expect(adultLinesFor(c, 'overdue')).toHaveLength(0)
    expect(adultLinesFor('savage', 'overdue').some(containsProfanity)).toBe(true)
  })
  it('Full 18+ is a separate, harder tier: only the Savage, only when chosen, never forbidden content', () => {
    const FULL = policyFrom(AdultSettingsSchema.parse({ adultLanguageEnabled: true, attestedAt: 1, profanityLevel: 'uncensored', policyRevision: 3 }), 'savage')
    const events: DialogueEvent[] = ['morning', 'overdue', 'overdue_many', 'postponed_again', 'meeting', 'completed', 'level_up', 'mail', 'mention']
    for (const c of COMPANION_ORDER.filter((x) => x !== 'savage')) for (const ev of events) expect(fullLinesFor(c, ev)).toHaveLength(0)
    for (const ev of events) {
      const lines = fullLinesFor('savage', ev)
      expect(lines.length, ev).toBeGreaterThan(0)
      for (const l of lines) {
        expect(containsForbidden(l), l).toBe(false)
        expect(containsProfanity(l), `really 18+: ${l}`).toBe(true)
      }
      expect(lines.every((l) => !adultLinesFor('savage', ev).includes(l))).toBe(true) // really a different tier, not the Strong lines
    }
    const vars = { quest: 'Send invoice', count: 3, minutes: 15, next: '“Send invoice”', level: 4, xp: 20, from: 'Sam', subject: 'Budget', where: '#design', event: 'Standup', time: '10:00' }
    const full = pickLine('savage', 'overdue', vars, FULL, { seed: 'x' })
    expect(full.line.tier).toBe('uncensored')
    expect(fullLinesFor('savage', 'overdue').map((t) => t.replace('{quest}', 'Send invoice'))).toContain(full.line.text)
    expect(pickLine('savage', 'overdue', vars, ADULT, { seed: 'x' }).line.tier).toBe('strong') // Strong stays Strong
    expect(pickLine('savage', 'overdue', vars, CLEAN, { seed: 'x' }).line.tier).toBe('clean')
    // turning 18+ off makes a displayed Full line render clean immediately
    const off = policyFrom(AdultSettingsSchema.parse({ adultLanguageEnabled: false, profanityLevel: 'none', policyRevision: 4 }), 'savage')
    expect(containsProfanity(finalizeLine(full.line, off, 'savage').text)).toBe(false)
  })

  it('the same overdue event yields different emotion/actions per companion', () => {
    const c = { key: 'overdue:q_x:1', type: 'QUEST_OVERDUE' as const, critical: false, priority: 50, countsAsNudge: true, quest: { id: 'q_xxxxxxxx', title: 'Report', estimatedMinutes: 30, postponeCount: 0 } }
    const notices = COMPANION_ORDER.map((id) => noticeFromCandidate(c, id, CLEAN, { now: at(12), tz: TZ }))
    expect(new Set(notices.map((n) => n.actions[0]!.label)).size).toBe(5)
    expect(new Set(notices.map((n) => n.line.text)).size).toBe(5)
  })
})

describe('18+ language policy', () => {
  it('is off by default; Savage speaks clean', () => {
    expect(CLEAN.adultEnabled).toBe(false)
    const r = pickLine('savage', 'overdue', { quest: 'Taxes' }, CLEAN, { seed: 'a' })
    expect(r.line.tier).toBe('clean')
    expect(containsProfanity(r.line.text)).toBe(false)
  })
  it('requires attestation: enabled flag without attestedAt stays off', () => {
    const p = policyFrom(AdultSettingsSchema.parse({ adultLanguageEnabled: true, attestedAt: null, profanityLevel: 'strong' }), 'medium')
    expect(p.adultEnabled).toBe(false)
    expect(pickLine('savage', 'completed', { xp: 40 }, p).line.tier).toBe('clean')
  })
  it('minor lock keeps it disabled', () => {
    const p = policyFrom(AdultSettingsSchema.parse({ adultLanguageEnabled: true, attestedAt: 1, profanityLevel: 'strong', minorLock: true }), 'medium')
    expect(p.adultEnabled).toBe(false)
  })
  it('enabled mode produces strong language for the Savage only', () => {
    const s = pickLine('savage', 'completed', { xp: 40, quest: 'X' }, ADULT, { seed: 'z' })
    expect(s.line.tier).toBe('strong')
    expect(containsProfanity(s.line.text)).toBe(true)
    expect(containsProfanity(s.line.cleanText)).toBe(false)
    const g = pickLine('grumpy', 'completed', { xp: 40 }, ADULT)
    expect(g.line.tier).toBe('clean')
  })
  it('final-render gate replaces explicit lines immediately after disable (revision bump)', () => {
    const s = pickLine('savage', 'meeting', { minutes: 10, event: 'Standup', time: '10:00' }, ADULT, { seed: 'm' })
    expect(finalizeLine(s.line, ADULT, 'savage').text).toBe(s.line.text)
    const disabled = { ...CLEAN, revision: ADULT.revision + 1 }
    const out = finalizeLine(s.line, disabled, 'savage')
    expect(out.tier).toBe('clean')
    expect(containsProfanity(out.text)).toBe(false)
  })
  it('stale explicit line from an older revision is rejected even if adult is enabled again', () => {
    const s = pickLine('savage', 'completed', { xp: 1 }, ADULT, { seed: 'q' })
    const reEnabled = { ...ADULT, revision: ADULT.revision + 2 }
    expect(finalizeLine(s.line, reEnabled, 'savage').origin).toBe('fallback')
  })
  it('AI text claiming clean but containing profanity is caught in clean mode', () => {
    const out = finalizeLine({ text: 'Do the damn thing', tier: 'clean', cleanText: '', revision: 0, origin: 'ai' }, CLEAN, 'savage')
    expect(containsProfanity(out.text)).toBe(false)
  })
  it('forbidden content is replaced in every mode', () => {
    const out = finalizeLine({ text: 'go die', tier: 'strong', cleanText: 'Keep going.', revision: 3, origin: 'ai' }, ADULT, 'savage')
    expect(out.text).toBe('Keep going.')
  })
  it('explicit text is never persisted to history', () => {
    const s = pickLine('savage', 'completed', { xp: 40 }, ADULT, { seed: 'p' })
    const p = persistableText(s.line)
    expect(containsProfanity(p.text)).toBe(false)
  })
  it('celebrations coalesce quest complete + level up into one notice', () => {
    const n = celebrationFromEvents(
      [
        { type: 'QUEST_COMPLETED', questId: 'q_aaaaaaaa', title: 'Run', xp: 40, skill: 'STR', skillPoints: 2 },
        { type: 'LEVEL_UP', from: 1, to: 2 },
      ],
      'commander',
      CLEAN,
      { now: at(12), tz: TZ },
    )!
    expect(n.kind).toBe('CELEBRATION')
    expect(n.reward).toMatchObject({ xp: 40, level: 2 })
  })
})

describe('cooldown after critical reminders', () => {
  it('a delivered meeting reminder starts the global cooldown for ordinary nudges', () => {
    const save = { ...defaultSave(), quests: [quest({ deadline: { at: at(11), tz: TZ } })] }
    const cal = { connected: true, events: [meeting(12, 10)], fetchedAt: at(12) }
    const r = evaluate(input({ save, calendar: cal }))
    expect(r.notice?.type).toBe('CALENDAR_EVENT_UPCOMING')
    const rem = recordDelivery(r.reminders, r.notice!, at(12), TZ)
    expect(rem.nudgesToday).toBe(0)
    const after = evaluate(input({ save: { ...save, reminders: rem }, now: at(12, 5), calendar: cal }))
    expect(after.notice).toBeNull()
    expect(after.suppressedBy).toBe('cooldown')
  })
})
