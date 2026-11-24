import type { CompanionId, Emotion, Quest, SaveV1 } from '../shared/schema'
import { SKILLS } from '../shared/schema'
import { formatDateTime, formatDuration, formatRelative, formatTime } from '../shared/time'
import type { CalendarEvent } from '../shared/calendar'
import { MESSAGE_PROVIDER_LABELS, QUICK_REPLIES, type InboxItem, type MessageProviderId } from '../shared/messages'
import { planLines, type DayPlan } from '../app/planner'
import { levelInfo } from '../game/rules'
import { isOverdue, prioritizedQuests, todayProgress } from '../game/reducer'
import { COMPANIONS } from '../companion/roster'
import type { Notice, NoticeAction } from '../companion/notices'
import type { GameCommand } from '../game/reducer'
import { bar, fitText, glassSafe, truncate } from './text'
import type { PageSpec } from './page'

/**
 * Glasses UI: one interaction grammar for every screen.
 *  - swipe up/down: move the list selection (native firmware scroll)
 *  - tap: activate the selected item
 *  - double-tap: back (on Home: system exit dialog, required by Even QA)
 */
export type GlassesScreen =
  | { name: 'home' }
  | { name: 'companion' }
  | { name: 'journal' }
  | { name: 'quest'; questId: string }
  | { name: 'character' }
  | { name: 'voice' }
  | { name: 'confirm'; proposalId: string }
  | { name: 'calendar' }
  | { name: 'inbox' }
  | { name: 'message'; provider: MessageProviderId; messageId: string }
  | { name: 'quickreply'; provider: MessageProviderId; messageId: string }
  | { name: 'plan' }
  | { name: 'focus' }
  | { name: 'brief' }
  | { name: 'setup' }

export type Intent =
  | { type: 'nav'; screen: GlassesScreen }
  | { type: 'back' }
  | { type: 'exit' }
  | { type: 'notice'; action: NoticeAction }
  | { type: 'quest'; cmd: GameCommand }
  | { type: 'confirm'; proposalId: string }
  | { type: 'cancel'; proposalId: string }
  | { type: 'voice_start' }
  | { type: 'voice_stop' }
  | { type: 'voice_cancel' }
  | { type: 'find_slot'; questId: string | null }
  | { type: 'refresh_calendar' }
  | { type: 'open_message'; provider: MessageProviderId; messageId: string }
  | { type: 'reply_voice'; provider: MessageProviderId; messageId: string }
  | { type: 'refresh_inbox' }
  | { type: 'plan_day' }
  | { type: 'book_plan' }
  | { type: 'quick_reply'; provider: MessageProviderId; messageId: string; text: string }
  | { type: 'catch_up' }
  | { type: 'recap_day' }
  | { type: 'focus_start'; questId: string | null }
  | { type: 'focus_stop' }
  | { type: 'focus_complete' }
  | { type: 'message_help'; provider: MessageProviderId; messageId: string; kind: 'summary' | 'translation' }
  | { type: 'suggest_replies'; provider: MessageProviderId; messageId: string }
  | { type: 'add_capture'; provider: MessageProviderId; id: string }
  | { type: 'message_quest'; provider: MessageProviderId; messageId: string }
  | { type: 'mark_read'; provider: MessageProviderId; messageId: string }
  | { type: 'running_late'; eventId: string }
  | { type: 'prep_meeting'; eventId: string }
  | { type: 'noop' }

export interface VoiceView {
  state: 'idle' | 'listening' | 'processing' | 'result' | 'error' | 'unsupported'
  elapsedMs: number
  limitMs: number
  level: number
  transcript?: string
  message?: string
}

export interface ProposalView {
  id: string
  title: string
  lines: string[]
  target: string
  external: boolean
  status: string
}

export interface GlassesModel {
  screen: GlassesScreen
  save: SaveV1
  now: number
  tz: string
  companionId: CompanionId
  notice: Notice | null
  /** rendered, policy-validated line for the current notice */
  noticeText: string | null
  idleLine: string
  emotion: Emotion
  /** portrait frame override during a reaction sequence */
  portraitFrame: string | null
  proposal: ProposalView | null
  voice: VoiceView
  calendar: { label: string; connected: boolean; events: CalendarEvent[]; freeSlots: Array<{ start: number; end: number }>; stale: boolean }
  /** unread Gmail + Slack mentions from connected accounts, newest first */
  inbox: { connected: boolean; items: InboxItem[]; labels: string[] }
  /** “Plan my day” result (local planner), null until asked */
  plan: DayPlan | null
  focus: { questId: string; title: string; endsAt: number; minutes: number; ended: boolean } | null
  brief: { kind: string; title: string; text: string; origin: 'ai' | 'local'; actions: Array<{ label: string; intent: Intent }> } | null
  replySuggestions: Record<string, string[]>
  messageNotes: Record<string, { kind: 'summary' | 'translation'; text: string }>
  triage: Record<string, 'reply' | 'later' | 'fyi'>
  captures: Array<{ id: string; text: string; from: string; at: number; provider: MessageProviderId }>
  aiReady: boolean
  assisting: string | null
  aiLabel: string
  demo: boolean
  assetBase: string
}

export interface BuiltScreen {
  page: PageSpec
  items: Intent[]
  tap: Intent
  double: Intent
  up?: Intent
  down?: Intent
}

const PORTRAIT = { id: 1, name: 'portrait', x: 4, y: 4, w: 144, h: 144 }
const RIGHT_X = 156
const RIGHT_W = 576 - RIGHT_X - 4

function portraitSrc(m: GlassesModel, emotion: Emotion): string {
  const frame = m.portraitFrame ?? emotion
  return `${m.assetBase}glasses/companions/${m.companionId}/${frame}.png`
}

/** List items: fit the width, then the SDK's 63-byte UTF-8 limit (·, —, ✉ are multi-byte). */
const LIST_ITEM_BYTES = 63
const utf8 = new TextEncoder()
export function clipBytes(s: string, maxBytes = LIST_ITEM_BYTES): string {
  if (utf8.encode(s).length <= maxBytes) return s
  const chars = Array.from(s)
  while (chars.length && utf8.encode(chars.join('').trimEnd() + '…').length > maxBytes) chars.pop()
  return chars.join('').trimEnd() + '…'
}
function label(s: string, max = 520): string {
  return clipBytes(truncate(s, max))
}

function questLine(q: Quest, now: number): string {
  const flag = q.status === 'in_progress' ? '▶ ' : isOverdue(q, now) ? '! ' : '• '
  const due = q.deadline ? (isOverdue(q, now) ? ' · late' : ` · ${formatRelative(q.deadline.at, now)}`) : ''
  return label(`${flag}${q.title} · ${formatDuration(q.estimatedMinutes)}${due}`)
}

export function buildScreen(m: GlassesModel): BuiltScreen {
  const b = buildScreenRaw(m)
  // belt and braces: no list item may exceed the SDK byte limit, whatever produced it
  return { ...b, page: { ...b.page, lists: b.page.lists.map((l) => ({ ...l, items: l.items.map((it) => clipBytes(it)) })) } }
}

function buildScreenRaw(m: GlassesModel): BuiltScreen {
  switch (m.screen.name) {
    case 'home':
      return home(m)
    case 'companion':
      return companion(m)
    case 'journal':
      return journal(m)
    case 'quest':
      return questDetail(m, m.screen.questId)
    case 'character':
      return character(m)
    case 'voice':
      return voice(m)
    case 'confirm':
      return confirm(m)
    case 'calendar':
      return calendar(m)
    case 'inbox':
      return inbox(m)
    case 'message':
      return message(m, m.screen.provider, m.screen.messageId)
    case 'quickreply':
      return quickReply(m, m.screen.provider, m.screen.messageId)
    case 'plan':
      return plan(m)
    case 'focus':
      return focus(m)
    case 'brief':
      return brief(m)
    case 'setup':
      return setup(m)
  }
}

function home(m: GlassesModel): BuiltScreen {
  const c = COMPANIONS[m.companionId]
  const li = levelInfo(m.save.player.totalXp)
  const open = prioritizedQuests(m.save, m.now)
  const next = open[0]
  const prog = todayProgress(m.save, m.now, m.tz)
  const nextEv = m.calendar.events.filter((e) => e.status !== 'cancelled' && !e.allDay && e.end > m.now).sort((a, b) => a.start - b.start)[0]
  const needs = m.inbox.items.filter((x) => (m.triage[`${x.provider}:${x.id}`] ?? (x.important && x.canReply ? 'reply' : 'later')) === 'reply')
  // assistant first: what's next, what's due, who needs you — progress last
  const lines = [
    nextEv ? `→ ${formatTime(nextEv.start, m.tz)} ${truncate(nextEv.title, 240)} · ${nextEv.start > m.now ? formatRelative(nextEv.start, m.now) : 'now'}` : m.calendar.connected ? '→ No more meetings today' : '',
    next ? `▶ ${truncate(next.title, 300)} · ${formatDuration(next.estimatedMinutes)}${isOverdue(next, m.now) ? ' · late' : ''}` : '▶ No open quests — add one',
    m.inbox.connected ? (needs.length ? `Inbox: ${needs.length} need you · ${truncate(needs[0]!.from, 160)}` : 'Inbox: all caught up') : '',
    `${m.demo ? 'DEMO · ' : ''}Lv ${li.level} · ${li.into}/${li.need} XP · ${prog.done}/${Math.max(prog.total, prog.done)} done today`,
    truncate(`${c.name}: ${m.notice ? 'has something for you ★' : m.idleLine}`, RIGHT_W - 12),
  ].filter(Boolean)
  const items: Intent[] = []
  const names: string[] = []
  if (m.notice) {
    names.push(label(`★ ${c.name} says…`))
    items.push({ type: 'nav', screen: { name: 'companion' } })
  }
  if (m.focus && !m.focus.ended) {
    names.push(`Focus · ${Math.max(1, Math.ceil((m.focus.endsAt - m.now) / 60_000))} min left`)
    items.push({ type: 'nav', screen: { name: 'focus' } })
  }
  names.push('Plan my day')
  items.push({ type: 'plan_day' })
  if (Number(formatTime(m.now, m.tz).slice(0, 2)) >= 17) {
    names.push('Recap my day')
    items.push({ type: 'recap_day' })
  }
  names.push(next ? 'Next quest' : 'Quest journal')
  items.push(next ? { type: 'nav', screen: { name: 'quest', questId: next.id } } : { type: 'nav', screen: { name: 'journal' } })
  if (m.inbox.connected) {
    names.push(`Inbox${m.inbox.items.length ? ` (${m.inbox.items.length})` : ''}`)
    items.push({ type: 'nav', screen: { name: 'inbox' } })
  }
  names.push('Catch me up')
  items.push({ type: 'catch_up' })
  names.push('Talk (voice)', 'Quest journal', 'Character', 'Calendar')
  items.push({ type: 'voice_start' }, { type: 'nav', screen: { name: 'journal' } }, { type: 'nav', screen: { name: 'character' } }, { type: 'nav', screen: { name: 'calendar' } })
  return {
    page: {
      screen: 'home',
      images: [{ ...PORTRAIT, src: portraitSrc(m, m.notice ? m.emotion : m.emotion) }],
      texts: [{ id: 2, name: 'status', x: RIGHT_X, y: 4, w: RIGHT_W, h: 148, content: fitText(lines.join('\n'), RIGHT_W - 8, 5), padding: 4 }],
      lists: [{ id: 3, name: 'menu', x: 0, y: 156, w: 576, h: 132, items: names, capture: true }],
    },
    items,
    tap: { type: 'noop' },
    double: { type: 'exit' },
  }
}

function plan(m: GlassesModel): BuiltScreen {
  const p = m.plan
  if (!p) return home(m)
  const head = `PLAN · ${p.day === 'tomorrow' ? 'TOMORROW' : 'TODAY'} · local plan${m.demo ? ' · DEMO' : ''}`
  const text = [head, ...planLines(p, m.tz)].join('\n')
  const names: string[] = []
  const items: Intent[] = []
  if (p.blocks.length && m.calendar.connected) {
    names.push(p.blocks.length === 1 ? 'Book 1 focus block' : `Book ${p.blocks.length} focus blocks`)
    items.push({ type: 'book_plan' })
  }
  const top = p.focus[0]
  if (top) {
    names.push(label(`Open: ${top.title}`))
    items.push({ type: 'nav', screen: { name: 'quest', questId: top.questId } })
  }
  for (const r of p.replies.slice(0, 2)) {
    names.push(label(`Reply: ${r.from}`))
    items.push({ type: 'open_message', provider: r.provider, messageId: r.id })
  }
  names.push('Back')
  items.push({ type: 'back' })
  return {
    page: {
      screen: 'plan',
      images: [],
      texts: [{ id: 1, name: 'plan', x: 0, y: 0, w: 576, h: 196, content: fitText(text, 576 - 12, 6), padding: 6 }],
      lists: [{ id: 2, name: 'planactions', x: 0, y: 200, w: 576, h: 88, items: names, capture: true }],
    },
    items,
    tap: { type: 'noop' },
    double: { type: 'back' },
  }
}

function focus(m: GlassesModel): BuiltScreen {
  const f = m.focus
  if (!f) return home(m)
  const left = Math.max(0, f.endsAt - m.now)
  const mins = Math.floor(left / 60_000)
  const text = [`FOCUS · ${f.ended ? 'time’s up' : `${mins} min left`}${m.demo ? ' · DEMO' : ''}`, `▶ ${f.title}`, `${bar(1 - left / (f.minutes * 60_000), 16)}`, 'Heads-ups wait until you’re done. Meetings still come through.'].join('\n')
  return {
    page: {
      screen: 'focus',
      images: [{ ...PORTRAIT, src: portraitSrc(m, 'thinking') }],
      texts: [{ id: 2, name: 'focus', x: RIGHT_X, y: 4, w: RIGHT_W, h: 148, content: fitText(text, RIGHT_W - 8, 5), padding: 4 }],
      lists: [{ id: 3, name: 'focusacts', x: 0, y: 156, w: 576, h: 132, items: ['★ Done — complete it', 'Stop focus', 'Back'], capture: true }],
    },
    items: [{ type: 'focus_complete' }, { type: 'focus_stop' }, { type: 'back' }],
    tap: { type: 'noop' },
    double: { type: 'back' },
  }
}

function brief(m: GlassesModel): BuiltScreen {
  const b = m.brief
  if (!b) return home(m)
  const head = `${b.title.toUpperCase()} · ${b.origin === 'ai' ? m.aiLabel : 'local'}${m.demo ? ' · DEMO' : ''}`
  const names = [...b.actions.map((a) => label(a.label)), 'Back']
  const items: Intent[] = [...b.actions.map((a) => a.intent), { type: 'back' }]
  return {
    page: {
      screen: 'brief',
      images: [],
      texts: [{ id: 1, name: 'brief', x: 0, y: 0, w: 576, h: 196, content: fitText(`${head}\n${b.text}`, 576 - 12, 6), padding: 6 }],
      lists: [{ id: 2, name: 'briefacts', x: 0, y: 200, w: 576, h: 88, items: names, capture: true }],
    },
    items,
    tap: { type: 'noop' },
    double: { type: 'back' },
  }
}

function quickReply(m: GlassesModel, provider: MessageProviderId, id: string): BuiltScreen {
  const x = m.inbox.items.find((i) => i.provider === provider && i.id === id)
  if (!x) return inbox(m)
  const waiting = m.assisting === `suggest:${provider}:${id}`
  const text = `QUICK REPLY · ${MESSAGE_PROVIDER_LABELS[provider]} · ${x.from}\n${provider === 'gmail' ? `“${x.title}”` : x.preview}\n${waiting ? 'Writing replies for this message…' : 'Pick one — you confirm the exact text next.'}`
  const ai = m.replySuggestions[`${provider}:${id}`] ?? []
  const options = [...ai, ...QUICK_REPLIES.filter((q) => !ai.includes(q))]
  const names = [...options.map((q, i) => label(i < ai.length ? `AI: ${q}` : q)), 'Back']
  const items: Intent[] = [...options.map((q) => ({ type: 'quick_reply', provider, messageId: id, text: q }) as Intent), { type: 'back' }]
  return {
    page: {
      screen: 'quickreply',
      images: [],
      texts: [{ id: 1, name: 'qrhead', x: 0, y: 0, w: 576, h: 100, content: fitText(text, 576 - 12, 3), padding: 6 }],
      lists: [{ id: 2, name: 'qrlist', x: 0, y: 104, w: 576, h: 184, items: names, capture: true }],
    },
    items,
    tap: { type: 'noop' },
    double: { type: 'back' },
  }
}

function companion(m: GlassesModel): BuiltScreen {
  const c = COMPANIONS[m.companionId]
  const header = `${c.name.toUpperCase()} · ${c.title}${m.notice?.line.origin === 'ai' ? ' · AI' : ''}`
  const body = m.notice ? (m.noticeText ?? '') : m.idleLine
  const reward = m.notice?.reward ? `+${m.notice.reward.xp} XP${m.notice.reward.skill ? ` · ${m.notice.reward.skill} +${m.notice.reward.skillPoints}` : ''}${m.notice.reward.level ? ` · LEVEL ${m.notice.reward.level}!` : ''}` : ''
  const text = [header, reward, body].filter(Boolean).join('\n')
  const actions = m.notice ? m.notice.actions.slice(0, 6) : []
  const names = actions.length ? actions.map((a) => label(a.label)) : ['Talk (voice)', 'Back']
  const items: Intent[] = actions.length ? actions.map((a) => ({ type: 'notice', action: a }) as Intent) : [{ type: 'voice_start' }, { type: 'back' }]
  return {
    page: {
      screen: 'companion',
      images: [{ ...PORTRAIT, src: portraitSrc(m, m.notice?.emotion ?? m.emotion) }],
      texts: [{ id: 2, name: 'speech', x: RIGHT_X, y: 4, w: RIGHT_W, h: 148, content: fitText(text, RIGHT_W - 8, 5), padding: 4 }],
      lists: [{ id: 3, name: 'actions', x: 0, y: 156, w: 576, h: 132, items: names, capture: true }],
    },
    items,
    tap: { type: 'noop' },
    double: { type: 'back' },
  }
}

function journal(m: GlassesModel): BuiltScreen {
  const open = prioritizedQuests(m.save, m.now).slice(0, 18)
  const header = `QUEST JOURNAL · ${open.length} open${m.demo ? ' · DEMO' : ''}`
  if (!open.length) {
    return {
      page: {
        screen: 'journal-empty',
        images: [],
        texts: [{ id: 1, name: 'title', x: 0, y: 0, w: 576, h: 40, content: header, padding: 6 }],
        lists: [{ id: 2, name: 'quests', x: 0, y: 44, w: 576, h: 244, items: ['+ New quest by voice', 'Back'], capture: true }],
      },
      items: [{ type: 'voice_start' }, { type: 'back' }],
      tap: { type: 'noop' },
      double: { type: 'back' },
    }
  }
  const names = open.map((q) => questLine(q, m.now))
  names.push('+ New quest by voice')
  return {
    page: {
      screen: 'journal',
      images: [],
      texts: [{ id: 1, name: 'title', x: 0, y: 0, w: 576, h: 40, content: header, padding: 6 }],
      lists: [{ id: 2, name: 'quests', x: 0, y: 44, w: 576, h: 244, items: names, capture: true }],
    },
    items: [...open.map((q) => ({ type: 'nav', screen: { name: 'quest', questId: q.id } }) as Intent), { type: 'voice_start' }],
    tap: { type: 'noop' },
    double: { type: 'back' },
  }
}

function questDetail(m: GlassesModel, questId: string): BuiltScreen {
  const q = m.save.quests.find((x) => x.id === questId)
  if (!q) return journal({ ...m, screen: { name: 'journal' } })
  const skill = q.skill ? `${q.skill} +${q.reward.skillPoints}` : 'no skill'
  const due = q.deadline ? `${isOverdue(q, m.now) ? 'Overdue · ' : 'Due '}${formatDateTime(q.deadline.at, m.tz)}` : 'No deadline'
  const lines = [
    q.title,
    `${q.status.replace('_', ' ').toUpperCase()} · ${q.category} · ${q.difficulty} · ${formatDuration(q.estimatedMinutes)}`,
    `Reward +${q.reward.xp} XP · ${skill}`,
    due,
    q.postponeCount ? `Postponed ${q.postponeCount}×` : q.source === 'ai' ? 'Created with AI' : q.source === 'todoist' ? 'From Todoist' : q.source === 'notion' ? 'From Notion' : q.source === 'google_tasks' ? 'From Google Tasks' : '',
  ].filter(Boolean)
  const names: string[] = []
  const items: Intent[] = []
  if (q.status === 'pending' || q.status === 'postponed') {
    names.push('▶ Start')
    items.push({ type: 'quest', cmd: { type: 'quest/start', id: q.id } })
  }
  if (q.status !== 'completed' && q.status !== 'archived') {
    names.push(m.focus?.questId === q.id && !m.focus.ended ? 'Back to focus' : `Focus ${Math.max(5, Math.min(90, q.estimatedMinutes))} min`)
    items.push(m.focus?.questId === q.id && !m.focus.ended ? { type: 'nav', screen: { name: 'focus' } } : { type: 'focus_start', questId: q.id })
    names.push('★ Complete')
    items.push({ type: 'quest', cmd: { type: 'quest/complete', id: q.id, method: 'self_reported' } })
    names.push('Postpone 1h')
    items.push({ type: 'quest', cmd: { type: 'quest/postpone', id: q.id, deadline: { at: Math.max(m.now, q.deadline?.at ?? m.now) + 3600_000, tz: m.tz } } })
    if (m.calendar.connected) {
      names.push('Find time in calendar')
      items.push({ type: 'find_slot', questId: q.id })
    }
  }
  names.push('Back')
  items.push({ type: 'back' })
  return {
    page: {
      screen: 'quest',
      images: [],
      texts: [{ id: 1, name: 'detail', x: 0, y: 0, w: 576, h: 152, content: fitText(lines.join('\n'), 576 - 16, 5), padding: 6, border: 1, borderColor: 6, radius: 6 }],
      lists: [{ id: 2, name: 'qactions', x: 0, y: 156, w: 576, h: 132, items: names, capture: true }],
    },
    items,
    tap: { type: 'noop' },
    double: { type: 'back' },
  }
}

function character(m: GlassesModel): BuiltScreen {
  const p = m.save.player
  const li = levelInfo(p.totalXp)
  const max = Math.max(10, ...SKILLS.map((s) => p.skills[s]))
  const lines = [
    `${(p.name || 'Adventurer').toUpperCase()} · ${p.avatar} · Lv ${li.level}`,
    `XP ${bar(li.into / li.need, 8)} ${li.into}/${li.need}`,
    ...SKILLS.map((s) => `${s} ${bar(p.skills[s] / max, 6, '█', '▒')} ${p.skills[s]}`),
  ]
  const done = m.save.rewardLedger.length
  return {
    page: {
      screen: 'character',
      images: [{ ...PORTRAIT, src: `${m.assetBase}glasses/avatars/${p.avatar}.png` }],
      texts: [
        { id: 2, name: 'stats', x: RIGHT_X, y: 4, w: RIGHT_W, h: 200, content: fitText(lines.join('\n'), RIGHT_W - 8, 7), padding: 4 },
        { id: 3, name: 'summary', x: 4, y: 206, w: 568, h: 78, content: fitText(`${done} quest${done === 1 ? '' : 's'} done · ${m.save.cosmetics.unlocked.length} item${m.save.cosmetics.unlocked.length === 1 ? '' : 's'} · ${m.save.achievements.length} badge${m.save.achievements.length === 1 ? '' : 's'}\nTap or double-tap: back`, 552, 2), padding: 4, capture: true },
      ],
      lists: [],
    },
    items: [],
    tap: { type: 'back' },
    double: { type: 'back' },
  }
}

function voice(m: GlassesModel): BuiltScreen {
  const v = m.voice
  const secs = (ms: number) => `0:${String(Math.floor(ms / 1000)).padStart(2, '0')}`
  let text: string
  let tap: Intent = { type: 'noop' }
  let double: Intent = { type: 'voice_cancel' }
  switch (v.state) {
    case 'listening': {
      const meter = bar(Math.min(1, v.level * 6), 10, '█', '▒')
      text = `● REC  ${secs(v.elapsedMs)} / ${secs(v.limitMs)}\n${meter}\nSpeak now — e.g. “Create a quest to finish my slides before five”\nTap: send · Double-tap: cancel`
      tap = { type: 'voice_stop' }
      break
    }
    case 'processing':
      text = `Thinking…\n${v.transcript ? `“${v.transcript}”` : `Sending your words to ${m.aiLabel}`}\nDouble-tap: cancel`
      break
    case 'result':
      text = `${v.transcript ? `You: “${v.transcript}”\n` : ''}${v.message ?? ''}\nTap: continue`
      tap = { type: 'back' }
      double = { type: 'back' }
      break
    case 'unsupported':
      text = `Voice is not available here.\n${v.message ?? 'Use text chat in the phone app (Companion tab).'}\nTap: back`
      tap = { type: 'back' }
      double = { type: 'back' }
      break
    case 'error':
      text = `Voice error.\n${v.message ?? 'Please try again.'}\nTap: back`
      tap = { type: 'back' }
      double = { type: 'back' }
      break
    default:
      text = 'Tap to start listening (max 15 s)\nDouble-tap: back'
      tap = { type: 'voice_start' }
      double = { type: 'back' }
  }
  return {
    page: {
      screen: `voice-${v.state}`,
      images: [{ ...PORTRAIT, src: portraitSrc(m, v.state === 'listening' ? 'surprised' : v.state === 'processing' ? 'thinking' : m.emotion) }],
      texts: [{ id: 2, name: 'voice', x: RIGHT_X, y: 4, w: RIGHT_W, h: 280, content: fitText(text, RIGHT_W - 8, 10), padding: 4, capture: true }],
      lists: [],
    },
    items: [],
    tap,
    double,
  }
}

function confirm(m: GlassesModel): BuiltScreen {
  const p = m.proposal
  if (!p) return home({ ...m, screen: { name: 'home' } })
  const head = p.status === 'executing' ? 'WORKING…' : p.status === 'done' ? 'DONE · VERIFIED' : p.status === 'failed' ? 'FAILED — NOTHING CHANGED' : `CONFIRM: ${p.title.toUpperCase()}`
  const text = [head, ...p.lines, `Target: ${p.target}`].join('\n')
  const pending = p.status === 'pending'
  return {
    page: {
      screen: `confirm-${p.status}`,
      images: [],
      texts: [{ id: 1, name: 'proposal', x: 0, y: 0, w: 576, h: 196, content: fitText(text, 576 - 18, 6), padding: 6, border: 2, borderColor: 10, radius: 6 }],
      lists: [{ id: 2, name: 'confirm', x: 0, y: 200, w: 576, h: 88, items: pending ? ['Confirm', 'Cancel'] : ['Continue'], capture: true }],
    },
    items: pending ? [{ type: 'confirm', proposalId: p.id }, { type: 'cancel', proposalId: p.id }] : [{ type: 'back' }],
    tap: { type: 'noop' },
    double: pending ? { type: 'cancel', proposalId: p.id } : { type: 'back' },
  }
}

function calendar(m: GlassesModel): BuiltScreen {
  const cal = m.calendar
  const lines: string[] = [`CALENDAR · ${cal.label}${cal.stale ? ' · stale' : ''}`]
  if (!cal.connected) lines.push('Not connected. Connect it in the phone app:', 'Settings → Google Calendar.')
  else {
    const upcoming = cal.events.filter((e) => e.status !== 'cancelled' && !e.allDay && e.end > m.now).sort((a, b) => a.start - b.start).slice(0, 3)
    if (!upcoming.length) lines.push('No more events today.')
    for (const e of upcoming) lines.push(`${formatTime(e.start, m.tz)}–${formatTime(e.end, m.tz)} ${e.title}`)
    const s = cal.freeSlots[0]
    if (s) lines.push(`Free: ${formatTime(s.start, m.tz)}–${formatTime(s.end, m.tz)}`)
  }
  const top = prioritizedQuests(m.save, m.now)[0]
  const names = cal.connected ? [top ? 'Find time for next quest' : 'Find 30 min', 'Refresh', 'Back'] : ['Back']
  const items: Intent[] = cal.connected ? [{ type: 'find_slot', questId: top?.id ?? null }, { type: 'refresh_calendar' }, { type: 'back' }] : [{ type: 'back' }]
  return {
    page: {
      screen: 'calendar',
      images: [],
      texts: [{ id: 1, name: 'agenda', x: 0, y: 0, w: 576, h: 160, content: fitText(lines.join('\n'), 576 - 12, 5), padding: 6 }],
      lists: [{ id: 2, name: 'calactions', x: 0, y: 164, w: 576, h: 124, items: names, capture: true }],
    },
    items,
    tap: { type: 'noop' },
    double: { type: 'back' },
  }
}

function inbox(m: GlassesModel): BuiltScreen {
  const rank = { reply: 0, later: 1, fyi: 2 } as const
  const tri = (x: InboxItem) => m.triage[`${x.provider}:${x.id}`] ?? (x.important && (x.canReply || x.provider === 'github') ? 'reply' : 'later')
  const items = [...m.inbox.items].sort((a, b) => rank[tri(a)] - rank[tri(b)] || b.at - a.at).slice(0, 8)
  const labels = m.inbox.labels.join(' · ')
  const head = `INBOX · ${labels || 'not connected'}${m.demo && !/demo/i.test(labels) ? ' · DEMO' : ''}`
  const needN = items.filter((x) => tri(x) === 'reply').length
  const body = !m.inbox.connected ? 'Connect Gmail, Slack or Telegram in the phone app: Camp → Mail & chat.' : items.length ? `${needN ? `${needN} need you (!) · ` : ''}${items.length} new · tap one to read` : 'All caught up. Nothing new.'
  const names = items.map((x) => label(x.provider === 'github' ? `${tri(x) === 'reply' ? '! ' : ''}${x.where} · ${x.title}` : `${tri(x) === 'reply' ? '! ' : ''}${x.provider === 'slack' ? '# ' : ''}${x.from} · ${x.provider === 'gmail' ? x.title : x.preview || x.where} · ${formatRelative(x.at, m.now)}`))
  const intents: Intent[] = items.map((x) => ({ type: 'open_message', provider: x.provider, messageId: x.id }))
  for (const c of m.captures.slice(0, 3)) {
    names.unshift(label(`+ Quest: ${c.text}`))
    intents.unshift({ type: 'add_capture', provider: c.provider, id: c.id })
  }
  names.push(m.inbox.connected ? 'Refresh' : 'Back')
  intents.push(m.inbox.connected ? { type: 'refresh_inbox' } : { type: 'back' })
  return {
    page: {
      screen: 'inbox',
      images: [],
      texts: [{ id: 1, name: 'inboxhead', x: 0, y: 0, w: 576, h: 68, content: fitText(`${head}\n${body}`, 576 - 12, 2), padding: 6 }],
      lists: [{ id: 2, name: 'inboxlist', x: 0, y: 72, w: 576, h: 216, items: names, capture: true }],
    },
    items: intents,
    tap: { type: 'noop' },
    double: { type: 'back' },
  }
}

function message(m: GlassesModel, provider: MessageProviderId, id: string): BuiltScreen {
  const x = m.inbox.items.find((i) => i.provider === provider && i.id === id)
  if (!x) return inbox(m)
  const app = MESSAGE_PROVIDER_LABELS[provider]
  const text =
    provider === 'gmail'
      ? `${app} · ${x.from} · ${formatRelative(x.at, m.now)}\n“${x.title}”\n(Questling shows sender and subject only.)`
      : provider === 'github'
        ? `${app} · ${x.where} · ${formatRelative(x.at, m.now)}\n${x.preview}\n“${x.title}”`
        : `${app} · ${x.from}${x.where && x.where !== app ? ` in ${x.where}` : ''} · ${formatRelative(x.at, m.now)}\n${x.preview}`
  const note = m.messageNotes[`${provider}:${id}`]
  const names: string[] = []
  const intents: Intent[] = []
  if (x.canReply) {
    names.push('Quick reply', 'Reply by voice')
    intents.push({ type: 'nav', screen: { name: 'quickreply', provider, messageId: id } }, { type: 'reply_voice', provider, messageId: id })
  }
  if (m.aiReady && provider !== 'gmail') {
    names.push('Summarize', 'Translate to English')
    intents.push({ type: 'message_help', provider, messageId: id, kind: 'summary' }, { type: 'message_help', provider, messageId: id, kind: 'translation' })
  }
  if (provider === 'github') {
    names.push('Mark as read')
    intents.push({ type: 'mark_read', provider, messageId: id })
  }
  names.push('Add as quest')
  intents.push({ type: 'message_quest', provider, messageId: id })
  names.push(x.canReply || provider === 'github' ? 'Back' : 'Back (read-only access)')
  intents.push({ type: 'back' })
  return {
    page: {
      screen: 'message',
      images: [],
      texts: [{ id: 1, name: 'msg', x: 0, y: 0, w: 576, h: 196, content: fitText(note ? `${text}\n${note.kind === 'summary' ? 'AI summary' : 'AI translation'}: ${note.text}` : text, 576 - 12, 6), padding: 6 }],
      lists: [{ id: 2, name: 'msgactions', x: 0, y: 200, w: 576, h: 88, items: names, capture: true }],
    },
    items: intents,
    tap: { type: 'noop' },
    double: { type: 'back' },
  }
}

function setup(m: GlassesModel): BuiltScreen {
  const text = 'QUESTLING\nA little companion. A bigger adventure.\n\nFinish setup on your phone:\nopen Questling in the Even app to pick\nyour avatar and companion.'
  return {
    page: {
      screen: 'setup',
      images: [{ ...PORTRAIT, src: `${m.assetBase}glasses/companions/optimist/happy.png` }],
      texts: [{ id: 2, name: 'setup', x: RIGHT_X, y: 4, w: RIGHT_W, h: 280, content: fitText(text, RIGHT_W - 8, 9), padding: 4, capture: true }],
      lists: [],
    },
    items: [],
    tap: { type: 'noop' },
    double: { type: 'exit' },
  }
}

export function resolveInput(b: BuiltScreen, input: { kind: string; index?: number }): Intent {
  switch (input.kind) {
    case 'select':
      return b.items[input.index ?? 0] ?? { type: 'noop' }
    case 'tap':
      return b.tap
    case 'double':
      return b.double
    case 'up':
      return b.up ?? { type: 'noop' }
    case 'down':
      return b.down ?? { type: 'noop' }
    default:
      return { type: 'noop' }
  }
}

export { glassSafe }
