import { describe, expect, it } from 'vitest'
import { getAdvW } from '@evenrealities/pretext'
import { buildScreen, clipBytes, resolveInput, type GlassesModel, type GlassesScreen } from '../../src/glasses/screens'
import { validatePage } from '../../src/glasses/page'
import { fitText, glassSafe, LINE_H } from '../../src/glasses/text'
import { measureTextWrap } from '@evenrealities/pretext'
import { defaultSave } from '../../src/storage/save'
import { applyGameCommand } from '../../src/game/reducer'
import { noticeFromCandidate } from '../../src/companion/notices'
import { AdultSettingsSchema } from '../../src/shared/schema'
import { policyFrom } from '../../src/companion/policy'
import { COMPANION_ORDER } from '../../src/companion/roster'
import { planDay } from '../../src/app/planner'

const NOW = Date.UTC(2026, 10, 24, 9, 0)
const TZ = 'Europe/Istanbul'

function model(over: Partial<GlassesModel> = {}): GlassesModel {
  let save = defaultSave({ companion: 'savage' })
  const titles = ['Finish the quarterly presentation slides for the board meeting', 'Run 5k', 'Call mom', 'Read chapter 4', 'Reply to Alex']
  for (const t of titles) save = applyGameCommand(save, { type: 'quest/create', input: { title: t, category: 'work', difficulty: 'normal', estimatedMinutes: 30, skill: 'INT', source: 'manual', deadline: { at: NOW - 600_000, tz: TZ } } }, NOW, TZ).save
  const policy = policyFrom(AdultSettingsSchema.parse({}), 'medium')
  const notice = noticeFromCandidate({ key: 'k', type: 'QUEST_OVERDUE', critical: false, priority: 50, countsAsNudge: true, quest: { id: save.quests[0]!.id, title: save.quests[0]!.title, estimatedMinutes: 30, postponeCount: 0 } }, 'savage', policy, { now: NOW, tz: TZ })
  return {
    screen: { name: 'home' },
    save,
    now: NOW,
    tz: TZ,
    companionId: 'savage',
    notice,
    noticeText: notice.line.text,
    idleLine: 'Ready when you are.',
    emotion: 'annoyed',
    portraitFrame: null,
    proposal: { id: 'prop_abcdefgh', title: 'Create calendar event', lines: ['“Focus: slides”', 'Tue 24 Nov 14:00–14:30 (Europe/Istanbul)', '30 min · no attendees'], target: 'Google Calendar · primary', external: true, status: 'pending' },
    voice: { state: 'listening', elapsedMs: 4200, limitMs: 15000, level: 0.1 },
    calendar: { label: 'Google', connected: true, events: [{ id: 'e1', calendarId: 'primary', title: 'Design review with the whole product team', start: NOW + 900_000, end: NOW + 2700_000, allDay: false, status: 'confirmed', transparent: false }], freeSlots: [{ start: NOW + 3600_000, end: NOW + 7200_000 }], stale: false },
    inbox: {
      connected: true,
      labels: ['Gmail', 'Slack · Acme'],
      items: [
        { id: 'm1', provider: 'gmail', from: 'Sam Lee', title: 'Budget review — numbers by 3? Also the forecast for next quarter please', preview: '', where: 'Inbox', at: NOW - 600_000, important: true, canReply: true },
        { id: '5550001:41', provider: 'telegram', from: 'Mira Hansen-Okonkwo', title: 'Are we still on for the 1:1 at 12:30?', preview: 'Are we still on for the 1:1 at 12:30? I can do 1 instead if that’s easier for you — just say.', where: 'Telegram', at: NOW - 300_000, important: true, canReply: true },
        { id: 'C1:1.2', provider: 'slack', from: 'Alexandra', title: 'Alexandra in #design', preview: '@you can you look at the deck before 3? Mostly the pricing slide and the closing summary 🙏', where: '#design', at: NOW - 900_000, important: true, canReply: false },
      ],
    },
    aiLabel: 'Gemini',
    demo: false,
    assetBase: './assets/',
    plan: null,
    focus: null,
    brief: null,
    replySuggestions: {},
    messageNotes: {},
    triage: {},
    captures: [],
    aiReady: false,
    notes: { ready: false, questions: [] },
    digestReady: false,
    assisting: null,
    ...over,
  }
}

function withPlan(over: Partial<GlassesModel> = {}): GlassesModel {
  const m = model(over)
  return { ...m, plan: planDay({ save: m.save, now: m.now, tz: m.tz, events: m.calendar.events, calendarConnected: m.calendar.connected, inbox: m.inbox.items }) }
}

const screens: GlassesScreen[] = [
  { name: 'home' },
  { name: 'companion' },
  { name: 'journal' },
  { name: 'character' },
  { name: 'voice' },
  { name: 'confirm', proposalId: 'prop_abcdefgh' },
  { name: 'calendar' },
  { name: 'inbox' },
  { name: 'message', provider: 'gmail', messageId: 'm1' },
  { name: 'message', provider: 'slack', messageId: 'C1:1.2' },
  { name: 'message', provider: 'telegram', messageId: '5550001:41' },
  { name: 'quickreply', provider: 'gmail', messageId: 'm1' },
  { name: 'quickreply', provider: 'telegram', messageId: '5550001:41' },
  { name: 'plan' },
  { name: 'setup' },
]

describe('glasses screens', () => {
  it('every screen produces a page within verified SDK limits', () => {
    const m = model()
    const qid = m.save.quests[0]!.id
    for (const s of [...screens, { name: 'quest', questId: qid } as GlassesScreen]) {
      for (const cid of COMPANION_ORDER) {
        const b = buildScreen(withPlan({ screen: s, companionId: cid }))
        expect(validatePage(b.page), `${s.name}/${cid}`).toEqual([])
      }
    }
  })

  it('all text uses only glyphs present in the firmware font', () => {
    const m = model()
    for (const s of [...screens, { name: 'quest', questId: m.save.quests[0]!.id } as GlassesScreen]) {
      const b = buildScreen(withPlan({ screen: s }))
      const strings = [...b.page.texts.map((t) => t.content), ...b.page.lists.flatMap((l) => l.items)]
      for (const str of strings) for (const ch of str) if (ch !== '\n' && ch !== ' ') expect(getAdvW(ch.codePointAt(0)!), `glyph ${JSON.stringify(ch)} in ${s.name}`).toBeGreaterThan(0)
    }
  })

  it('text boxes never overflow their height (no firmware scrollbar)', () => {
    for (const s of screens) {
      const b = buildScreen(withPlan({ screen: s }))
      for (const t of b.page.texts) {
        const inset = (t.padding ?? 0) + (t.border ?? 0)
        const m = measureTextWrap(t.content, t.w - 2 * inset)
        expect(m.lineCount * LINE_H, `${s.name}/${t.name}`).toBeLessThanOrEqual(t.h - 2 * inset + 1)
      }
    }
  })

  it('home: double-tap → system exit; list selection maps to intents', () => {
    const b = buildScreen(model())
    expect(resolveInput(b, { kind: 'double' })).toEqual({ type: 'exit' })
    expect(resolveInput(b, { kind: 'select', index: 0 })).toEqual({ type: 'nav', screen: { name: 'companion' } })
    // protobuf zero omission: index undefined ⇒ 0
    expect(resolveInput(b, { kind: 'select' })).toEqual({ type: 'nav', screen: { name: 'companion' } })
  })

  it('confirm screen: double-tap cancels, never confirms', () => {
    const b = buildScreen(model({ screen: { name: 'confirm', proposalId: 'prop_abcdefgh' } }))
    expect(resolveInput(b, { kind: 'double' })).toEqual({ type: 'cancel', proposalId: 'prop_abcdefgh' })
    expect(resolveInput(b, { kind: 'select', index: 1 })).toEqual({ type: 'cancel', proposalId: 'prop_abcdefgh' })
  })

  it('companion notice shows personality-specific actions', () => {
    const b = buildScreen(model({ screen: { name: 'companion' } }))
    expect(b.page.lists[0]!.items[0]).toBe('Do it now')
  })

  it('glassSafe strips emoji and unsupported symbols; fitText truncates with ellipsis', () => {
    expect(glassSafe('Done ✓ 🎉 ok')).toBe('Done √ ok')
    const t = fitText('word '.repeat(200), 200, 2)
    expect(t.split('\n')).toHaveLength(2)
    expect(t.endsWith('…')).toBe(true)
  })
})

describe('glasses inbox', () => {
  it('home offers the inbox only when an account is connected; message screens offer voice reply only when allowed', () => {
    const on = buildScreen(model({ notice: null }))
    expect(on.page.lists[0]!.items).toContain('Inbox (3)')
    expect(on.page.lists[0]!.items).toContain('Plan my day')
    const off = buildScreen(model({ notice: null, inbox: { connected: false, items: [], labels: [] } }))
    expect(off.page.lists[0]!.items.some((i) => i.startsWith('Inbox'))).toBe(false)
    const gm = buildScreen(model({ screen: { name: 'message', provider: 'gmail', messageId: 'm1' } }))
    expect(gm.items[0]).toEqual({ type: 'nav', screen: { name: 'quickreply', provider: 'gmail', messageId: 'm1' } })
    expect(gm.items[1]).toEqual({ type: 'reply_voice', provider: 'gmail', messageId: 'm1' })
    const qr = buildScreen(model({ screen: { name: 'quickreply', provider: 'telegram', messageId: '5550001:41' } }))
    expect(qr.items.filter((i) => i.type === 'quick_reply')).toHaveLength(4)
    expect(qr.items[0]).toMatchObject({ type: 'quick_reply', provider: 'telegram', messageId: '5550001:41' })
    const sl = buildScreen(model({ screen: { name: 'message', provider: 'slack', messageId: 'C1:1.2' } }))
    expect(sl.items).toEqual([{ type: 'message_quest', provider: 'slack', messageId: 'C1:1.2' }, { type: 'back' }]) // read-only: no reply, but it can become a quest
    expect(sl.page.texts[0]!.content).not.toMatch(/🙏/) // firmware-unsafe glyphs stripped
  })

  it('plan screen: local plan lines, book focus blocks only with a calendar, reply shortcuts', () => {
    const p = buildScreen(withPlan({ screen: { name: 'plan' } }))
    expect(p.page.texts[0]!.content).toMatch(/^PLAN · (TODAY|TOMORROW) · local plan/)
    expect(p.items.some((i) => i.type === 'book_plan')).toBe(true)
    expect(p.items.some((i) => i.type === 'open_message')).toBe(true)
    const noCal = withPlan({ screen: { name: 'plan' }, calendar: { label: '', connected: false, events: [], freeSlots: [], stale: false } })
    expect(buildScreen(noCal).items.some((i) => i.type === 'book_plan')).toBe(false)
  })

  it('inbox rows stay within the SDK 63-byte list-item limit (regression found in the official simulator)', () => {
    const long = (i: number, provider: 'gmail' | 'slack') => ({
      id: `x${i}`,
      provider,
      from: 'Priya Raman-Okonkwo',
      title: 'Check-in is open for your Friday flight — gate info inside',
      preview: '@you the demo video link is in the doc — thumbs up when you’ve watched it',
      where: '#launch',
      at: Date.parse('2026-11-24T12:00:00Z') - i * 60_000,
      important: false,
      canReply: true,
    })
    const b = buildScreen(model({ screen: { name: 'inbox' }, inbox: { connected: true, items: [long(1, 'gmail'), long(2, 'slack')], labels: ['Gmail', 'Slack'] } }))
    expect(validatePage(b.page)).toEqual([])
    for (const it of b.page.lists[0]!.items) expect(new TextEncoder().encode(it).length).toBeLessThanOrEqual(63)
    expect(clipBytes('a·b')).toBe('a·b')
    const c = clipBytes('·'.repeat(40))
    expect(new TextEncoder().encode(c).length).toBeLessThanOrEqual(63)
    expect(c.endsWith('…')).toBe(true)
  })
})
