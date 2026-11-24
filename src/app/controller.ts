import { AdultSettingsSchema, type AdultSettings, type CompanionId, type Emotion, type MemoryEntry, type Preferences, type ProfanityLevel, type SaveV1, type Turn } from '../shared/schema'
import { addLocalDays, dayKey, formatDateTime, formatTime, localTimezone, parseLocalDateTime, startOfLocalDay, systemClock, type Clock } from '../shared/time'
import { freeSlots, type CalendarEvent } from '../shared/calendar'
import { newId } from '../shared/ids'
import { AI_PROVIDER_LABELS, AiRequestSchema, type AiAction, type AiProviderId, type AiResponse } from '../shared/ai'
import { SaveStore, type PersistStatus } from '../storage/store'
import { AdultSettingsRepository, DEMO_SAVE_KEY, SAVE_KEY, SaveRepository, defaultSave, type LoadOutcome } from '../storage/save'
import type { DomainEvent, GameCommand } from '../game/reducer'
import { isOpen, prioritizedQuests } from '../game/reducer'
import { evaluate, muteUntil, recordDelivery, recordResponse, type MuteDuration, type Trigger } from '../companion/engine'
import { celebrationFromEvents, infoNotice, noticeFromCandidate, type Notice, type NoticeAction } from '../companion/notices'
import { classifyText, finalizeLine, persistableText, policyFrom, VETTED_CLEAN_FALLBACK, type LanguagePolicy, type Line } from '../companion/policy'
import { pickLine } from '../companion/dialogue'
import { COMPANIONS } from '../companion/roster'
import type { Device, GlassesInput, Lifecycle } from '../device/types'
import { buildScreen, resolveInput, type BuiltScreen, type GlassesScreen, type Intent, type VoiceView } from '../glasses/screens'
import { api, ApiError, OFFLINE_STATUS, type ServerStatus } from '../ai/api'
import { durationMs, level, pcmToWav, toBase64 } from '../ai/wav'
import { DemoCalendar, LiveCalendar, type CalendarService, type CalendarStatus } from '../integrations/calendar'
import { DemoTasks, LiveTasks, type TaskLinkState, type TaskService } from '../integrations/tasks'
import { DemoInbox, LiveInbox, type InboxService } from '../integrations/messages'
import { isOverdue } from '../game/reducer'
import { MESSAGE_PROVIDER_IDS, MESSAGE_PROVIDER_LABELS, type InboxItem, type MessageProviderId } from '../shared/messages'
import { TASK_PROVIDER_IDS, TASK_PROVIDER_LABELS, type ExternalTask, type TaskProviderId, type TaskSource } from '../shared/tasks'
import { buildContext, type RefMap } from './context'
import { calendarBlocksProposal, calendarCreateProposal, mergeQuestProposals, messageReplyProposal, proposalFromAction, staleReason, taskCompleteProposal, type Proposal } from './proposals'
import { localReply } from './localAssistant'
import { planDay, planPrompt, type DayPlan } from './planner'
import { TRAINING_STEP_IDS, trainingStep, type TrainingStepId } from '../game/training'
import { containsForbidden, containsProfanity } from '../companion/policy'
import type { Capture } from '../shared/messages'
import type { TriageLabel } from '../shared/ai'
import { demoEvents, demoSave } from '../demo/fixtures'

export type Mode = 'real' | 'demo'
export interface ChatTurn {
  id: string
  role: 'user' | 'companion'
  line?: Line
  text?: string
  at: number
  source?: 'ai' | 'local' | 'notice'
  /** which server provider answered (ai turns only) */
  provider?: AiProviderId
  emotion?: Emotion
}
export interface Toast {
  id: string
  text: string
  tone: 'info' | 'good' | 'warn'
}

export interface Snapshot {
  ready: boolean
  mode: Mode
  device: { kind: Device['kind']; label: string; supportsMic: boolean }
  save: SaveV1
  persist: PersistStatus
  loadOutcome: LoadOutcome
  adult: AdultSettings
  policy: LanguagePolicy
  now: number
  tz: string
  notice: Notice | null
  noticeText: string | null
  emotion: Emotion
  reactionFrame: string | null
  glassesScreen: GlassesScreen
  proposal: Proposal | null
  voice: VoiceView
  chat: { turns: ChatTurn[]; sending: boolean; source: 'ai' | 'local'; provider: AiProviderId | null; label: string }
  server: ServerStatus
  calendar: { status: CalendarStatus; events: CalendarEvent[]; fetchedAt: number | null; freeSlots: Array<{ start: number; end: number }>; error: string | null; label: string }
  tasks: Record<TaskProviderId, TaskView>
  inbox: Record<MessageProviderId, InboxView>
  /** the message the reply sheet / glasses message screen is about */
  replyTarget: { provider: MessageProviderId; id: string } | null
  /** “Plan my day” (local, deterministic) and whether the phone sheet shows it */
  plan: DayPlan | null
  planOpen: boolean
  focus: FocusSession | null
  brief: Brief | null
  /** AI reply suggestions and summaries/translations per message (key = provider:id) */
  replySuggestions: Record<string, string[]>
  messageNotes: Record<string, { kind: 'summary' | 'translation'; line: Line }>
  triage: Record<string, TriageLabel>
  captures: Array<Capture & { provider: MessageProviderId }>
  /** which assistant task is running (for spinners) */
  assisting: string | null
  aiReady: boolean
  pendingMemory: Array<{ id: string; kind: MemoryEntry['kind']; text: string }>
  toasts: Toast[]
  lastNotices: Array<{ id: string; line: Line; companionId: CompanionId; at: number; kind: string }>
  demoClockOffset: number
}

export interface TaskView {
  provider: TaskProviderId
  name: string
  label: string
  configured: boolean
  status: TaskLinkState
  /** open tasks; questId is set when the task is already in the journal */
  tasks: Array<ExternalTask & { questId: string | null }>
  sources: TaskSource[]
  selected: string | null
  fetchedAt: number | null
  error: string | null
  busy: boolean
}

interface TaskData {
  tasks: ExternalTask[]
  sources: TaskSource[]
  selected: string | null
  label: string
  fetchedAt: number | null
  error: string | null
  busy: boolean
}

export interface InboxView {
  provider: MessageProviderId
  name: string
  label: string
  configured: boolean
  status: TaskLinkState
  items: InboxItem[]
  canReply: boolean
  fetchedAt: number | null
  error: string | null
  busy: boolean
}
export interface FocusSession {
  questId: string
  title: string
  startedAt: number
  endsAt: number
  minutes: number
  /** the “time's up” heads-up was shown */
  ended: boolean
}
/** A short assistant answer shown full-width on the glasses and as a sheet on the phone. */
export interface Brief {
  kind: 'catch_up' | 'recap' | 'prep'
  title: string
  line: Line
  origin: 'ai' | 'local'
  actions: Array<{ label: string; intent: Intent }>
  at: number
}
export const msgKey = (p: MessageProviderId, id: string) => `${p}:${id}`

interface InboxData {
  captures?: Capture[]
  items: InboxItem[]
  label: string
  canReply: boolean
  fetchedAt: number | null
  error: string | null
  busy: boolean
}
const emptyInboxData = (p: MessageProviderId): InboxData => ({ items: [], label: MESSAGE_PROVIDER_LABELS[p], canReply: false, fetchedAt: null, error: null, busy: false })
const INBOX_REFRESH_MS = 5 * 60_000

const emptyTaskData = (p: TaskProviderId): TaskData => ({ tasks: [], sources: [], selected: null, label: TASK_PROVIDER_LABELS[p], fetchedAt: null, error: null, busy: false })

/**
 * Engine bookkeeping is computed from a snapshot; other writes (a dismissal, a delivery) may have been
 * queued since. Apply just the snapshot→result changes onto the current reminders.
 */
export function applyReminderDiff(current: SaveV1['reminders'], before: SaveV1['reminders'], after: SaveV1['reminders']): SaveV1['reminders'] {
  const records = { ...current.records }
  for (const [k, v] of Object.entries(after.records)) if (JSON.stringify(before.records[k]) !== JSON.stringify(v)) records[k] = v
  for (const k of Object.keys(before.records)) if (!(k in after.records)) delete records[k]
  const out: SaveV1['reminders'] = { ...current, records }
  for (const key of Object.keys(after) as Array<keyof SaveV1['reminders']>) {
    if (key === 'records') continue
    if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) (out as Record<string, unknown>)[key] = after[key]
  }
  return out
}

const MODE_KEY = 'questling.mode'
const VOICE_LIMIT_MS = 15_000
const TICK_MS = 30_000
const CAL_REFRESH_MS = 5 * 60_000

export class App {
  private listeners = new Set<() => void>()
  private snap!: Snapshot
  private store!: SaveStore
  private device!: Device
  private adultRepo!: AdultSettingsRepository
  private adult: AdultSettings = AdultSettingsSchema.parse({})
  private clock: Clock = systemClock
  private demoOffset = 0
  private mode: Mode = 'real'
  private tz = localTimezone()
  private loadOutcome: LoadOutcome = 'new'
  private notice: Notice | null = null
  private stack: GlassesScreen[] = []
  private screen: GlassesScreen = { name: 'home' }
  private built: BuiltScreen | null = null
  private proposal: Proposal | null = null
  private voice: VoiceView = { state: 'idle', elapsedMs: 0, limitMs: VOICE_LIMIT_MS, level: 0 }
  private voiceChunks: Uint8Array[] = []
  private voiceTimer: ReturnType<typeof setInterval> | null = null
  private voiceStartedAt = 0
  private voiceAbort: AbortController | null = null
  private chatTurns: ChatTurn[] = []
  private sending = false
  private chatSource: 'ai' | 'local' = 'local'
  private server: ServerStatus = OFFLINE_STATUS
  private calendar!: CalendarService
  private taskServices = {} as Record<TaskProviderId, TaskService>
  private taskData = {} as Record<TaskProviderId, TaskData>
  private inboxServices = {} as Record<MessageProviderId, InboxService>
  private inboxData = {} as Record<MessageProviderId, InboxData>
  private replyTarget: { provider: MessageProviderId; id: string } | null = null
  private plan: DayPlan | null = null
  private planOpen = false
  private focus: FocusSession | null = null
  private brief: Brief | null = null
  private replySuggestions: Record<string, string[]> = {}
  private messageNotes: Record<string, { kind: 'summary' | 'translation'; line: Line }> = {}
  private triageAi: Record<string, TriageLabel> = {}
  private triageSig = ''
  private triageAt = 0
  private ackCaptures: Record<string, string[]> = {}
  private assisting: string | null = null
  private lastAssist: { line: Line; source: 'ai' | 'local' } | null = null
  /** reminder records written this session; overlaid on the save so a queued write can never cause a repeat */
  private sessionRecords: SaveV1['reminders']['records'] = {}
  /** provider:taskId pairs ticked off this session (verified) */
  private syncedTasks = new Set<string>()
  /** a quest that came from a task list was just completed by the user: offer write-back */
  private pendingTaskSync: { provider: TaskProviderId; taskId: string; title: string; questId: string } | null = null
  private liveCalendar: LiveCalendar | null = null
  private calEvents: CalendarEvent[] = []
  private calFetchedAt: number | null = null
  private calError: string | null = null
  private pendingMemory: Snapshot['pendingMemory'] = []
  private toasts: Toast[] = []
  private lastNotices: Snapshot['lastNotices'] = []
  private reactionFrame: string | null = null
  private reactionTimer: ReturnType<typeof setTimeout> | null = null
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private unsubs: Array<() => void> = []
  private aiSeq = 0
  private lastActivePersist = 0
  private lastListLogged = ''
  private lastScreenLogged = ''
  ready = false
  private openedCheckIn = false

  // ------------------------------------------------------------------ lifecycle
  async boot(device: Device, opts: { forceDemo?: boolean; resetDemo?: boolean } = {}) {
    this.device = device
    this.adultRepo = new AdultSettingsRepository(device.kv)
    const storedMode = await device.kv.get(MODE_KEY)
    this.mode = opts.forceDemo || opts.resetDemo || storedMode === 'demo' ? 'demo' : 'real'
    if (opts.resetDemo) await new SaveRepository(device.kv, DEMO_SAVE_KEY).clear()
    this.adult = await this.adultRepo.load()
    await this.loadSave()
    this.unsubs.push(device.onInput((i) => this.onGlassesInput(i)))
    this.unsubs.push(device.onLifecycle((l) => this.onLifecycle(l)))
    this.unsubs.push(device.onAudio((pcm) => this.onAudio(pcm)))
    this.ready = true
    this.screen = this.store.state.preferences.onboarded ? { name: 'home' } : { name: 'setup' }
    this.emit()
    void this.refreshServer()
    // calendar first (bounded), so the opening check-in can prioritize an imminent meeting
    await Promise.race([this.refreshCalendar(), new Promise((r) => setTimeout(r, 2500))])
    this.runEngine('app_opened')
    this.tickTimer = setInterval(() => this.tick(), TICK_MS)
  }

  private async loadSave() {
    this.openedCheckIn = false
    this.store?.dispose()
    const key = this.mode === 'demo' ? DEMO_SAVE_KEY : SAVE_KEY
    const repo = new SaveRepository(this.device.kv, key)
    const loaded = await repo.load()
    this.loadOutcome = loaded.outcome
    let save = loaded.save
    if (!save) save = this.mode === 'demo' ? demoSave(this.clock.now(), this.tz) : defaultSave()
    this.store = new SaveStore(repo, save)
    if (!loaded.save) await this.store.replace(save)
    this.store.subscribe(() => this.emit())
    this.store.onEvents((events) => this.onDomainEvents(events))
    this.liveCalendar = null
    if (this.mode === 'demo') {
      this.demoOffset = 0
      this.calendar = new DemoCalendar(demoEvents(this.clock.now()))
    } else {
      this.liveCalendar = new LiveCalendar(api)
      this.liveCalendar.onChange = () => {
        if (this.liveCalendar?.status().state === 'connected') void this.refreshCalendar()
        this.emit()
      }
      this.calendar = this.liveCalendar
    }
    for (const p of TASK_PROVIDER_IDS) {
      const svc: TaskService = this.mode === 'demo' ? new DemoTasks(p, this.clock.now()) : new LiveTasks(p, api)
      svc.onChange = () => {
        if (svc.connected()) void this.refreshTasks(p)
        else if (svc.status().state !== 'linking') this.taskData[p] = { ...emptyTaskData(p), error: this.taskData[p]?.error ?? null }
        this.emit()
      }
      this.taskServices[p] = svc
      this.taskData[p] = emptyTaskData(p)
    }
    for (const p of MESSAGE_PROVIDER_IDS) {
      const svc: InboxService = this.mode === 'demo' ? new DemoInbox(p, this.clock.now()) : new LiveInbox(p, api)
      svc.onChange = () => {
        if (svc.connected()) void this.refreshInbox(p)
        else if (svc.status().state !== 'linking') this.inboxData[p] = { ...emptyInboxData(p), error: this.inboxData[p]?.error ?? null }
        this.emit()
      }
      this.inboxServices[p] = svc
      this.inboxData[p] = emptyInboxData(p)
      // demo: the synthetic inboxes start linked so the whole assistant is visible at once (nothing is sent)
      if (this.mode === 'demo') void svc.beginLink()
    }
    this.replyTarget = null
    this.sessionRecords = {}
    this.syncedTasks.clear()
    this.pendingTaskSync = null
    this.calEvents = []
    this.calFetchedAt = null
    this.notice = null
    this.proposal = null
    this.chatTurns = []
  }

  dispose() {
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.unsubs.forEach((u) => u())
    void this.cancelVoice()
    this.store?.dispose()
  }

  now() {
    return this.clock.now() + this.demoOffset
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  getSnapshot = () => this.snap

  private get policy(): LanguagePolicy {
    return policyFrom(this.adult, this.store.state.companion.roastIntensity)
  }

  private emit() {
    if (!this.store) return
    const now = this.now()
    const policy = this.policy
    const save = this.store.state
    const noticeText = this.notice ? finalizeLine(this.notice.line, policy, this.notice.companionId).text : null
    const emotion: Emotion = this.notice?.emotion ?? (this.voice.state === 'listening' ? 'surprised' : this.voice.state === 'processing' ? 'thinking' : this.idleEmotion(save, now))
    const calStatus = this.calendar.status()
    this.snap = {
      ready: this.ready,
      mode: this.mode,
      device: { kind: this.device.kind, label: this.device.label, supportsMic: this.device.supportsMic },
      save,
      persist: this.store.status,
      loadOutcome: this.loadOutcome,
      adult: this.adult,
      policy,
      now,
      tz: this.tz,
      notice: this.notice,
      noticeText,
      emotion,
      reactionFrame: this.reactionFrame,
      glassesScreen: this.screen,
      proposal: this.proposal,
      voice: { ...this.voice },
      chat: { turns: this.chatTurns, sending: this.sending, source: this.chatSource, provider: this.aiProvider(), label: this.aiLabel() },
      server: this.server,
      calendar: { status: calStatus, events: this.calEvents, fetchedAt: this.calFetchedAt, freeSlots: this.slots(), error: this.calError, label: this.calendarLabel() },
      tasks: this.taskViews(save),
      inbox: this.inboxViews(),
      replyTarget: this.replyTarget,
      plan: this.plan,
      planOpen: this.planOpen,
      focus: this.focus,
      brief: this.brief,
      replySuggestions: this.replySuggestions,
      messageNotes: this.messageNotes,
      triage: this.triageMap(),
      captures: this.allCaptures(),
      assisting: this.assisting,
      aiReady: this.aiReady(),
      pendingMemory: this.pendingMemory,
      toasts: this.toasts,
      lastNotices: this.lastNotices,
      demoClockOffset: this.demoOffset,
    }
    this.renderGlasses()
    for (const l of this.listeners) l()
  }

  private idleEmotion(save: SaveV1, now: number): Emotion {
    const open = save.quests.filter(isOpen)
    if (open.some((q) => q.deadline && q.deadline.at < now)) return 'annoyed'
    if (!open.length) return 'happy'
    return 'idle'
  }

  private calendarLabel() {
    return this.mode === 'demo' ? 'Demo calendar (synthetic)' : 'Google Calendar · primary'
  }

  private calendarConnected() {
    const s = this.calendar.status().state
    return s === 'connected' || s === 'demo'
  }

  private slots() {
    if (!this.calendarConnected() || this.calFetchedAt === null) return []
    const now = this.now()
    return freeSlots(this.calEvents, { start: now + 5 * 60_000, end: addLocalDays(startOfLocalDay(now, this.tz), 1, this.tz) }, 20, this.tz, this.store.state.preferences.activeHours).slice(0, 6)
  }

  // ------------------------------------------------------------------ glasses
  private renderGlasses() {
    if (!this.device || !this.store) return
    const policy = this.policy
    const save = this.store.state
    const now = this.now()
    const c = COMPANIONS[save.companion.id]
    const idle = this.notice ? '' : pickLine(save.companion.id, prioritizedQuests(save, now).length ? 'morning' : 'empty', { count: prioritizedQuests(save, now).length, next: prioritizedQuests(save, now)[0]?.title ? `“${prioritizedQuests(save, now)[0]!.title}”` : 'a quest' }, policy, { seed: dayKey(now, this.tz) }).line
    const built = buildScreen({
      screen: this.screen,
      save,
      now,
      tz: this.tz,
      companionId: save.companion.id,
      notice: this.notice,
      noticeText: this.notice ? finalizeLine(this.notice.line, policy, this.notice.companionId).text : null,
      idleLine: idle ? finalizeLine(idle, policy, save.companion.id).text : c.sampleGreeting,
      emotion: this.snap?.emotion ?? 'idle',
      portraitFrame: this.reactionFrame,
      proposal: this.proposal ? { id: this.proposal.id, title: this.proposal.title, lines: this.proposal.status === 'pending' ? this.proposal.lines : (this.proposal.resultLines ?? this.proposal.lines), target: this.proposal.target, external: this.proposal.external, status: this.proposal.status } : null,
      voice: this.voice,
      calendar: { label: this.calendarLabel(), connected: this.calendarConnected(), events: this.calEvents, freeSlots: this.slots(), stale: this.calFetchedAt !== null && now - this.calFetchedAt > 30 * 60_000 },
      inbox: { connected: this.inboxConnected(), items: this.allInbox(), labels: MESSAGE_PROVIDER_IDS.filter((p) => this.inboxServices[p]?.connected()).map((p) => this.inboxLabel(p)) },
      plan: this.plan,
      focus: this.focus,
      brief: this.brief ? { ...this.brief, text: finalizeLine(this.brief.line, this.policy, this.store.state.companion.id).text } : null,
      replySuggestions: this.replySuggestions,
      messageNotes: Object.fromEntries(Object.entries(this.messageNotes).map(([k, v]) => [k, { kind: v.kind, text: finalizeLine(v.line, this.policy, this.store.state.companion.id).text }])),
      triage: this.triageMap(),
      captures: this.allCaptures(),
      aiReady: this.aiReady(),
      assisting: this.assisting,
      aiLabel: this.chatSource === 'ai' ? this.aiLabel() : 'local',
      demo: this.mode === 'demo',
      assetBase: './assets/',
    })
    this.built = built
    if (built.page.screen !== this.lastScreenLogged) {
      this.lastScreenLogged = built.page.screen
      console.log(`[questling/screen] ${built.page.screen}`)
    }
    // demo only (synthetic data): expose the selectable items so the simulator walkthrough can pick by label
    const cap = built.page.lists.find((l) => l.capture)
    const listSig = cap ? `${built.page.screen}|${cap.items.join('|')}` : ''
    if (this.mode === 'demo' && listSig !== this.lastListLogged) {
      this.lastListLogged = listSig
      if (cap) console.log(`[questling/list] ${JSON.stringify({ screen: built.page.screen, items: cap.items })}`)
    }
    this.device.render(built.page)
  }

  private nav(screen: GlassesScreen) {
    if (JSON.stringify(screen) === JSON.stringify(this.screen)) return
    if (screen.name === 'quickreply') void this.suggestReplies(screen.provider, screen.messageId)
    if (screen.name === 'inbox') void this.triageInbox()
    this.stack.push(this.screen)
    if (this.stack.length > 8) this.stack.shift()
    this.screen = screen
    this.emit()
  }

  private back() {
    this.screen = this.stack.pop() ?? (this.store.state.preferences.onboarded ? { name: 'home' } : { name: 'setup' })
    if (this.screen.name === 'confirm' && this.proposal?.status !== 'pending') this.screen = this.stack.pop() ?? { name: 'home' }
    if (this.screen.name === 'voice' && this.voice.state !== 'listening') this.screen = this.stack.pop() ?? { name: 'home' }
    this.emit()
  }

  private onGlassesInput(input: GlassesInput) {
    if (!this.built) return
    if (input.kind === 'long_press' && this.voice.state !== 'listening' && this.screen.name !== 'confirm') return void this.startVoice()
    if (input.kind === 'long_release' && this.voice.state === 'listening') return void this.stopVoice()
    void this.handleIntent(resolveInput(this.built, input))
  }

  async handleIntent(intent: Intent) {
    switch (intent.type) {
      case 'nav':
        return this.nav(intent.screen)
      case 'back':
        if (this.screen.name === 'companion' && this.notice) this.closeNotice(null)
        return this.back()
      case 'exit':
        return this.device.requestExit()
      case 'notice':
        return this.noticeAction(intent.action)
      case 'quest':
        return this.questCommand(intent.cmd)
      case 'confirm':
        return this.confirmProposal(intent.proposalId)
      case 'cancel':
        return this.cancelProposal(intent.proposalId)
      case 'voice_start':
        return this.startVoice()
      case 'voice_stop':
        return this.stopVoice()
      case 'voice_cancel':
        return this.cancelVoice()
      case 'find_slot':
        return this.findSlot(intent.questId)
      case 'refresh_calendar':
        return this.refreshCalendar(true)
      case 'open_message':
        return this.openMessage(intent.provider, intent.messageId)
      case 'reply_voice':
        this.replyTarget = { provider: intent.provider, id: intent.messageId }
        return void this.startVoice()
      case 'refresh_inbox':
        for (const p of MESSAGE_PROVIDER_IDS) void this.refreshInbox(p, true)
        return
      case 'plan_day':
        void this.markTraining('glasses')
        return this.planDay('glasses')
      case 'book_plan':
        return this.bookPlan()
      case 'quick_reply':
        return this.proposeReply(intent.provider, intent.messageId, intent.text)
      case 'catch_up':
        return this.catchUp('glasses')
      case 'recap_day':
        return this.recapDay('glasses')
      case 'focus_start':
        return this.startFocus(intent.questId)
      case 'focus_stop':
        return this.stopFocus()
      case 'focus_complete':
        return this.completeFocus()
      case 'message_help':
        return this.messageHelp(intent.provider, intent.messageId, intent.kind)
      case 'suggest_replies':
        return this.suggestReplies(intent.provider, intent.messageId)
      case 'add_capture':
        return this.addCapture(intent.provider, intent.id)
      case 'message_quest':
        return this.messageToQuest(intent.provider, intent.messageId)
      case 'mark_read':
        return this.markRead(intent.provider, intent.messageId)
      case 'running_late':
        return this.runningLate(intent.eventId)
      case 'prep_meeting':
        return this.meetingPrep(intent.eventId, 'glasses')
      case 'noop':
        return
    }
  }

  // ------------------------------------------------------------------ lifecycle / engine
  private onLifecycle(l: Lifecycle) {
    if (l === 'background' || l === 'exit') {
      void this.cancelVoice()
      void this.store.mutate((s) => ({ ...s, reminders: { ...s.reminders, lastActiveAt: this.now() } }))
      void this.store.flush()
      return
    }
    if (l === 'foreground') {
      void this.refreshCalendar()
      this.runEngine('resumed')
    }
  }

  private tick() {
    const now = this.now()
    if (now - this.lastActivePersist > 5 * 60_000) {
      this.lastActivePersist = now
      void this.store.mutate((s) => ({ ...s, reminders: { ...s.reminders, lastActiveAt: now } }))
    }
    if (this.proposal?.status === 'pending' && now > this.proposal.expiresAt) {
      this.proposal = { ...this.proposal, status: 'expired', resultLines: ['Proposal expired — nothing was changed.'] }
    }
    if (this.calendarConnected() && (this.calFetchedAt === null || now - this.calFetchedAt > CAL_REFRESH_MS)) void this.refreshCalendar()
    for (const p of MESSAGE_PROVIDER_IDS) {
      const d = this.inboxData[p]
      if (this.inboxServices[p]?.connected() && !d.busy && (d.fetchedAt === null || Date.now() - d.fetchedAt > INBOX_REFRESH_MS)) void this.refreshInbox(p)
    }
    this.runEngine('tick')
  }

  /** busy = recording or an exact action confirmation is on screen: never interrupt. */
  private busy() {
    return this.voice.state === 'listening' || this.voice.state === 'processing' || (this.proposal?.status === 'pending') || this.screen.name === 'setup' || !this.store.state.preferences.onboarded
  }

  runEngine(trigger: Trigger) {
    if (!this.store) return
    // nothing speaks up before the opening check-in (which waits for the calendar so a meeting wins)
    if (trigger === 'app_opened') this.openedCheckIn = true
    else if (!this.openedCheckIn) return
    if (this.focus && !this.focus.ended && this.now() >= this.focus.endsAt) return this.focusEnded()
    const now = this.now()
    const stored = this.store.state
    const save = { ...stored, reminders: { ...stored.reminders, records: { ...stored.reminders.records, ...this.sessionRecords } } }
    const out = evaluate({
      now,
      tz: this.tz,
      save,
      calendar: { connected: this.calendarConnected(), events: this.calEvents, fetchedAt: this.calFetchedAt },
      inbox: this.allInbox(),
      trigger,
      busy: this.busy(),
      focusing: !!this.focus && !this.focus.ended,
      showing: !!this.notice,
    })
    const remindersChanged = JSON.stringify(out.reminders) !== JSON.stringify(save.reminders)
    if (!out.notice) {
      if (remindersChanged) void this.store.mutate((s) => ({ ...s, reminders: applyReminderDiff(s.reminders, save.reminders, out.reminders) }))
      if (trigger === 'app_opened' && !save.reminders.lastActiveAt) void this.store.mutate((s) => ({ ...s, reminders: { ...s.reminders, lastActiveAt: now } }))
      return
    }
    const next = prioritizedQuests(save, now)[0]
    const notice = noticeFromCandidate(out.notice, save.companion.id, this.policy, { now, tz: this.tz, nextQuestTitle: next?.title, intensity: save.companion.intensity })
    if (out.notice.type === 'DAY_STARTED' && next) notice.actions = [{ id: 'plan_day', label: 'Plan my day' }, { id: 'open_quest', label: 'Open next quest', questId: next.id }, ...notice.actions.filter((a) => a.id !== 'open_quest' && a.id !== 'plan_day')]
    const delivered = { ...recordDelivery(out.reminders, out.notice!, now, this.tz), lastActiveAt: now }
    this.sessionRecords[out.notice.key] = delivered.records[out.notice.key]!
    // apply only what this evaluation changed, on top of whatever was queued meanwhile (no lost updates)
    void this.store.mutate((s) => ({ ...s, reminders: applyReminderDiff(s.reminders, save.reminders, delivered) }))
    this.showNotice(notice)
    if (out.notice.type === 'DAY_STARTED' || out.notice.type === 'USER_RETURNED') void this.enrichBriefing(notice.id)
  }

  /** The morning / welcome-back heads-up is rewritten by the AI from your actual day when a provider is configured. */
  private async enrichBriefing(noticeId: string) {
    if (!this.aiReady()) return
    const resp = await this.askAssistant({ mode: 'chat', message: 'Brief me: one or two short sentences about my day — the first thing to do, the next meeting, and who is waiting.' }, { quiet: true })
    if (!resp || this.notice?.id !== noticeId || !resp.dialogue.trim()) return
    const policy = this.policy
    const strong = classifyText(resp.dialogue) === 'strong'
    const clean = resp.cleanDialogue && classifyText(resp.cleanDialogue) === 'clean' ? resp.cleanDialogue : this.notice.line.cleanText
    const line: Line = { text: resp.dialogue, tier: strong ? (policy.profanityLevel === 'uncensored' ? 'uncensored' : 'strong') : 'clean', cleanText: strong ? clean : resp.dialogue, revision: policy.revision, origin: 'ai' }
    this.notice = { ...this.notice, line, emotion: resp.emotion }
    this.emit()
  }

  private showNotice(n: Notice) {
    this.notice = n
    this.lastNotices = [{ id: n.id, line: n.line, companionId: n.companionId, at: n.createdAt, kind: n.kind }, ...this.lastNotices].slice(0, 20)
    // Never cover an action in progress (quest detail, confirmation, voice); the notice waits on Home (★ item).
    const interruptible = ['home', 'journal', 'character', 'calendar'].includes(this.screen.name)
    if (interruptible || n.solicited) {
      if (this.screen.name !== 'companion' && this.screen.name !== 'confirm' && this.screen.name !== 'voice') this.nav({ name: 'companion' })
    }
    if (n.react) this.playReaction(n.companionId)
    this.emit()
  }

  private playReaction(cid: CompanionId) {
    if (this.store.state.preferences.reducedMotion) return
    if (this.reactionTimer) clearTimeout(this.reactionTimer)
    const frames = ['react_0', 'react_1', 'react_2']
    let i = 0
    const step = () => {
      if (this.notice?.companionId !== cid && i > 0) {
        this.reactionFrame = null
        return this.emit()
      }
      this.reactionFrame = frames[i] ?? null
      this.emit()
      i++
      if (i <= frames.length) this.reactionTimer = setTimeout(step, this.device.kind === 'even' ? 900 : 450)
    }
    step()
  }

  private closeNotice(response: 'dismiss' | 'acted' | { snoozeMs: number } | null) {
    const n = this.notice
    if (!n) return
    this.notice = null
    this.reactionFrame = null
    if (!n.solicited && response) {
      const now = this.now()
      const r = response === 'dismiss' ? { kind: 'dismiss' as const } : response === 'acted' ? { kind: 'acted' as const } : { kind: 'snooze' as const, ms: response.snoozeMs }
      this.sessionRecords[n.key] = recordResponse({ ...this.store.state.reminders, records: {} }, n, r, now).records[n.key]!
      void this.store.mutate((s) => ({ ...s, reminders: recordResponse(s.reminders, n, r, now) }))
    }
  }

  async noticeAction(a: NoticeAction) {
    const now = this.now()
    switch (a.id) {
      case 'dismiss':
        this.closeNotice('dismiss')
        return this.back()
      case 'snooze':
        this.closeNotice({ snoozeMs: a.ms })
        this.toast(`Snoozed for ${Math.round(a.ms / 60000)} min`)
        return this.back()
      case 'mute':
        this.closeNotice('dismiss')
        await this.mute(a.duration)
        return this.back()
      case 'start':
        this.closeNotice('acted')
        this.screen = this.stack.pop() ?? { name: 'home' }
        return this.questCommand({ type: 'quest/start', id: a.questId })
      case 'complete':
        this.closeNotice('acted')
        this.screen = this.stack.pop() ?? { name: 'home' }
        return this.questCommand({ type: 'quest/complete', id: a.questId, method: 'self_reported' })
      case 'postpone': {
        this.closeNotice('acted')
        this.screen = this.stack.pop() ?? { name: 'home' }
        const q = this.store.state.quests.find((x) => x.id === a.questId)
        return this.questCommand({ type: 'quest/postpone', id: a.questId, deadline: { at: Math.max(now, q?.deadline?.at ?? now) + a.minutes * 60_000, tz: this.tz } })
      }
      case 'split':
        this.closeNotice('acted')
        this.screen = this.stack.pop() ?? { name: 'home' }
        return this.splitQuest(a.questId)
      case 'open_quest':
        this.closeNotice('acted')
        this.screen = { name: 'quest', questId: a.questId }
        return this.emit()
      case 'review_event':
        this.closeNotice('acted')
        this.screen = { name: 'calendar' }
        return this.emit()
      case 'schedule_slot': {
        this.closeNotice('acted')
        const q = this.store.state.quests.find((x) => x.id === a.questId)
        return this.propose(calendarCreateProposal({ title: `Quest: ${q?.title ?? 'Focus'}`, start: a.slotStart, minutes: a.minutes, questId: a.questId }, this.proposalCtx('notice')))
      }
      case 'daily_review':
        this.closeNotice('acted')
        this.screen = this.stack.pop() ?? { name: 'home' }
        return this.recapDay('glasses')
      case 'talk':
        this.closeNotice('acted')
        return this.startVoice()
      case 'open_message':
        this.closeNotice('acted')
        return this.openMessage(a.provider, a.messageId)
      case 'plan_day':
        this.closeNotice('acted')
        this.screen = this.stack.pop() ?? { name: 'home' }
        return this.planDay('glasses')
      case 'catch_up':
        this.closeNotice('acted')
        this.screen = this.stack.pop() ?? { name: 'home' }
        return this.catchUp('glasses')
      case 'prep_meeting':
        this.closeNotice('acted')
        this.screen = this.stack.pop() ?? { name: 'home' }
        return this.meetingPrep(a.eventId, 'glasses')
      case 'running_late':
        this.closeNotice('acted')
        this.screen = this.stack.pop() ?? { name: 'home' }
        return this.runningLate(a.eventId)
      case 'focus_complete':
        this.closeNotice('acted')
        this.screen = this.stack.pop() ?? { name: 'home' }
        return this.completeFocus()
      case 'focus_extend':
        this.closeNotice('acted')
        this.screen = this.focus ? { name: 'focus' } : (this.stack.pop() ?? { name: 'home' })
        return this.extendFocus(a.minutes)
      case 'focus_stop':
        this.closeNotice('acted')
        this.screen = this.stack.pop() ?? { name: 'home' }
        return this.stopFocus()
    }
  }


  // ------------------------------------------------------------------ assistant features
  private aiReady() {
    return this.server.reachable && this.server.ai.configured
  }

  /** Training: each step's XP once, recorded in the save (never in the quest ledger). */
  async markTraining(step: TrainingStepId) {
    const save = this.store?.state
    if (!save || !save.preferences.onboarded || save.training.done.some((t) => t.step === step) || !trainingStep(step)) return
    const r = await this.store.dispatch({ type: 'training/complete', step }, this.now(), this.tz)
    if (!r.error && !r.duplicate) this.emit()
  }
  hideTraining(hidden: boolean) {
    return this.questCommand({ type: 'training/hide', hidden })
  }
  trainingSteps() {
    return TRAINING_STEP_IDS
  }

  private cleanLine(text: string, origin: 'ai' | 'local'): Line {
    return { text, tier: 'clean', cleanText: text, revision: this.policy.revision, origin }
  }

  /** Shows a brief on the glasses (full-width) and as a sheet on the phone. */
  private showBrief(b: Omit<Brief, 'at'>, from: 'phone' | 'glasses') {
    this.brief = { ...b, at: this.now() }
    if (from === 'glasses' || this.screen.name === 'home') {
      if (this.screen.name !== 'brief') return this.nav({ name: 'brief' })
    }
    this.emit()
  }
  closeBrief() {
    this.brief = null
    if (this.screen.name === 'brief') this.back()
    else this.emit()
  }

  /** Ask the AI for a short answer; null when AI is off or fails (the caller shows the local version). */
  private async aiText(message: string, task: string): Promise<{ line: Line; source: 'ai' } | null> {
    if (!this.aiReady()) return null
    this.assisting = task
    this.lastAssist = null
    this.emit()
    try {
      const resp = await this.askAssistant({ mode: 'chat', message: message.slice(0, 500) })
      const la = this.lastAssist as { line: Line; source: 'ai' | 'local' } | null
      return resp && la?.source === 'ai' ? { line: la.line, source: 'ai' } : null
    } finally {
      this.assisting = null
    }
  }

  private nextEvent() {
    const now = this.now()
    return this.calEvents.filter((e) => e.status !== 'cancelled' && !e.allDay && e.end > now && !e.title.startsWith('Quest: ')).sort((a, b) => a.start - b.start)[0]
  }

  private localCatchUp(): string {
    const now = this.now()
    const open = prioritizedQuests(this.store.state, now)
    const overdue = open.filter((q) => isOverdue(q, now))
    const waiting = this.sortedInbox().filter((m) => this.triageLabel(m) === 'reply').slice(0, 3)
    const ev = this.nextEvent()
    return [
      waiting.length ? `Waiting on you: ${waiting.map((m) => `${m.from} (${MESSAGE_PROVIDER_LABELS[m.provider]})`).join(', ')}.` : this.inboxConnected() ? 'Nobody is waiting on you.' : null,
      ev ? `Next: ${formatTime(ev.start, this.tz)} ${ev.title}${ev.start > now ? ` (in ${Math.max(1, Math.round((ev.start - now) / 60_000))} min)` : ' (now)'}.` : this.calendarConnected() ? 'No more meetings today.' : null,
      overdue.length ? `Overdue: ${overdue[0]!.title}${overdue.length > 1 ? ` +${overdue.length - 1} more` : ''}.` : open[0] ? `Next quest: ${open[0].title}.` : 'No open quests.',
    ]
      .filter(Boolean)
      .join('\n')
  }

  /** “Catch me up”: who needs you, what's next, what slipped — AI when available, local facts otherwise. */
  async catchUp(from: 'phone' | 'glasses' = 'phone') {
    void this.markTraining('catchup')
    const ai = await this.aiText('Catch me up: who needs me, what is next and what slipped — at most three short lines.', 'catch_up')
    const actions: Brief['actions'] = [{ label: 'Plan my day', intent: { type: 'plan_day' } }]
    if (this.inboxConnected()) actions.push({ label: 'Open inbox', intent: { type: 'nav', screen: { name: 'inbox' } } })
    this.showBrief({ kind: 'catch_up', title: 'Catch me up', line: ai?.line ?? this.cleanLine(this.localCatchUp(), 'local'), origin: ai ? 'ai' : 'local', actions }, from)
  }

  /** End-of-day recap; with AI it may also propose tomorrow's quests (confirm-first). */
  async recapDay(from: 'phone' | 'glasses' = 'phone') {
    const save = this.store.state
    const now = this.now()
    const today = dayKey(now, this.tz)
    const done = save.quests.filter((q) => q.status === 'completed' && q.completedAt && dayKey(q.completedAt, this.tz) === today)
    const xp = save.rewardLedger.filter((r) => dayKey(r.at, this.tz) === today).reduce((sum, r) => sum + r.xp, 0)
    const open = prioritizedQuests(save, now)
    const slipped = open.filter((q) => isOverdue(q, now))
    await this.store.mutate((x) => ({ ...x, reminders: { ...x.reminders, lastReviewDay: today } }))
    const ai = await this.aiText('Recap my day in two short lines (done, slipped). If it helps, propose up to three create_local_quest actions for tomorrow.', 'recap')
    const local = [
      done.length ? `Done today: ${done.slice(0, 3).map((q) => q.title).join(', ')}${done.length > 3 ? ` +${done.length - 3}` : ''} (+${xp} XP).` : 'Nothing finished today — tomorrow is a fresh page.',
      slipped.length ? `Slipped: ${slipped.slice(0, 2).map((q) => q.title).join(', ')}.` : 'Nothing slipped.',
      open[0] ? `Tomorrow, start with “${open[0].title}”.` : 'Your journal is clear.',
    ].join('\n')
    this.showBrief({ kind: 'recap', title: 'Recap my day', line: ai?.line ?? this.cleanLine(local, 'local'), origin: ai ? 'ai' : 'local', actions: [{ label: 'Plan tomorrow', intent: { type: 'plan_day' } }] }, from)
  }

  private personFor(title: string): InboxItem | undefined {
    const t = title.toLowerCase()
    return this.sortedInbox().find((m) => {
      const first = m.from.split(/[\s(]/)[0]?.toLowerCase() ?? ''
      return first.length >= 3 && new RegExp(`\\b${first.replace(/[^a-z0-9]/g, '')}\\b`).test(t)
    })
  }

  /** Ten minutes before a meeting: what it is, who's involved, related quests, one tip. */
  async meetingPrep(eventId: string, from: 'phone' | 'glasses' = 'phone') {
    const ev = this.calEvents.find((e) => e.id === eventId) ?? this.nextEvent()
    if (!ev) return this.toast('No upcoming meeting found', 'info')
    const now = this.now()
    const person = this.personFor(ev.title)
    const words = new Set(`${ev.title} ${person?.preview ?? ''} ${person?.title ?? ''}`.toLowerCase().match(/[a-z]{4,}/g) ?? [])
    for (const w of ['with', 'demo', 'review', 'meeting', 'call', 'sync', 'about', 'your', 'this', 'that', 'there', 'mostly', 'before']) words.delete(w)
    const related = prioritizedQuests(this.store.state, now).find((q) => (q.title.toLowerCase().match(/[a-z]{4,}/g) ?? []).some((w) => words.has(w)))
    const local = [
      `${ev.title} · ${formatTime(ev.start, this.tz)}${ev.start > now ? ` (in ${Math.max(1, Math.round((ev.start - now) / 60_000))} min)` : ''}.`,
      person ? `${person.from} (${MESSAGE_PROVIDER_LABELS[person.provider]}): “${(person.provider === 'gmail' ? person.title : person.preview || person.title).slice(0, 90)}”` : null,
      related ? `Related quest: ${related.title}.` : null,
      'Tip: open the agenda two minutes early.',
    ]
      .filter(Boolean)
      .join('\n')
    const ref = Object.entries(this.lastRefsFor()).find(([, id]) => id === ev.id)?.[0]
    const ai = await this.aiText(`Prep me for ${ref ?? 'my next meeting'}: what it is, related quests or messages, and one thing to raise — three short lines.`, 'prep')
    const actions: Brief['actions'] = []
    if (person?.canReply) actions.push({ label: 'Running late', intent: { type: 'running_late', eventId: ev.id } })
    actions.push({ label: 'Open calendar', intent: { type: 'nav', screen: { name: 'calendar' } } })
    this.showBrief({ kind: 'prep', title: `Prep · ${ev.title}`, line: ai?.line ?? this.cleanLine(local, 'local'), origin: ai ? 'ai' : 'local', actions }, from)
  }
  private lastRefsFor(): Record<string, string> {
    const { refs } = buildContext(this.store.state, this.now(), this.tz, { connected: this.calendarConnected(), events: this.calEvents, freeSlots: this.slots(), fetchedAt: this.calFetchedAt }, [], { items: [] })
    return Object.fromEntries(Object.entries(refs.events).map(([k, e]) => [k, e.id]))
  }

  /** One tap: tell someone from the meeting you're late (exact text, confirm-first). */
  runningLate(eventId: string) {
    const ev = this.calEvents.find((e) => e.id === eventId)
    if (!ev) return this.toast('That meeting is no longer on your calendar', 'info')
    const person = this.personFor(ev.title)
    if (!person || !person.canReply) return this.toast(`No chat with someone from “${ev.title}” — tell them yourself.`, 'info')
    this.replyTarget = { provider: person.provider, id: person.id }
    this.proposeReply(person.provider, person.id, `Running about 5 minutes late for “${ev.title}” — sorry!`)
  }

  /** Turn any message into a quest (exact confirmation): “Reply to Sam: …”, “Review: …”. */
  messageToQuest(p: MessageProviderId, id: string) {
    const m = this.findMessage(p, id)
    if (!m) return
    const title = (p === 'github' ? `${m.preview.startsWith('Review') ? 'Review' : 'Handle'}: ${m.title}` : `Reply to ${m.from}: ${m.provider === 'gmail' ? m.title : m.preview || m.title}`).slice(0, 80)
    const prop = proposalFromAction({ type: 'create_local_quest', title, category: 'work', difficulty: 'normal', estimatedMinutes: p === 'github' ? 30 : 10, skill: p === 'github' ? 'INT' : 'SOC' } as AiAction, {
      save: this.store.state,
      now: this.now(),
      tz: this.tz,
      refs: { quests: {}, events: {}, messages: {} },
      events: this.calEvents,
      calendarConnected: this.calendarConnected(),
      calendarLabel: this.calendarLabel(),
      source: 'user',
    })
    this.propose(prop)
  }

  /** GitHub: mark a notification read — confirm-first, verified by reading it back. */
  markRead(p: MessageProviderId, id: string) {
    const m = this.findMessage(p, id)
    if (!m || !this.inboxServices[p]?.markRead) return
    this.propose({
      id: newId('prop'),
      params: { kind: 'message_mark_read', provider: p, messageId: id, title: m.title },
      title: 'Mark this notification read?',
      lines: [`${m.where} · “${m.title}”`, `${m.preview}`, 'Only marks it read on GitHub. Nothing else changes.'],
      target: this.inboxLabel(p),
      external: true,
      source: 'user',
      createdAt: this.now(),
      expiresAt: this.now() + 5 * 60_000,
      baseRevision: this.store.state.revision,
      status: 'pending',
      warnings: [],
    })
  }

  // ------------------------------------------------------------------ focus sessions
  async startFocus(questId?: string | null, minutes?: number) {
    const now = this.now()
    const q = (questId ? this.store.state.quests.find((x) => x.id === questId) : null) ?? prioritizedQuests(this.store.state, now)[0]
    if (!q) return this.toast('Add a quest first', 'info')
    const mins = Math.max(5, Math.min(90, minutes ?? (q.estimatedMinutes > 0 ? q.estimatedMinutes : 25)))
    this.focus = { questId: q.id, title: q.title, startedAt: now, endsAt: now + mins * 60_000, minutes: mins, ended: false }
    if (q.status !== 'in_progress') await this.store.dispatch({ type: 'quest/start', id: q.id }, now, this.tz)
    void this.markTraining('focus')
    this.toast(`Focus: ${mins} min on “${q.title}”. Heads-ups wait (meetings still come through).`, 'good')
    if (this.screen.name !== 'focus') this.nav({ name: 'focus' })
    else this.emit()
  }
  extendFocus(minutes: number) {
    if (!this.focus) return
    const now = this.now()
    this.focus = { ...this.focus, endsAt: Math.max(now, this.focus.endsAt) + minutes * 60_000, minutes: this.focus.minutes + minutes, ended: false }
    this.emit()
  }
  stopFocus() {
    this.focus = null
    if (this.screen.name === 'focus') this.back()
    else this.emit()
  }
  async completeFocus() {
    const f = this.focus
    this.focus = null
    if (this.screen.name === 'focus') this.screen = this.stack.pop() ?? { name: 'home' }
    if (f) await this.questCommand({ type: 'quest/complete', id: f.questId, method: 'self_reported' })
    else this.emit()
  }
  private focusEnded() {
    const f = this.focus
    if (!f) return
    this.focus = { ...f, ended: true }
    const save = this.store.state
    const n = infoNotice(save.companion.id, 'focus_done', { quest: f.title }, this.policy, this.now())
    if (this.notice && !this.notice.solicited) this.closeNotice(null)
    this.showNotice({ ...n, solicited: true, actions: [{ id: 'focus_complete', label: '★ Done — complete it', questId: f.questId }, { id: 'focus_extend', label: '+10 minutes', minutes: 10 }, { id: 'focus_stop', label: 'Stop focus' }] })
  }

  // ------------------------------------------------------------------ message help, suggestions, triage
  /** Summarize or translate the message in focus (AI only; Slack/Telegram — Gmail has no body). */
  async messageHelp(p: MessageProviderId, id: string, kind: 'summary' | 'translation') {
    const m = this.findMessage(p, id)
    if (!m) return
    if (!this.aiReady()) return this.toast('Summaries and translations need an AI provider (Camp → AI companion brain)', 'info')
    this.replyTarget = { provider: p, id }
    const ai = await this.aiText(kind === 'summary' ? 'Summarize the message in focus (replyingTo) in two short lines.' : 'Translate the message in focus (replyingTo) into English. Only the translation.', kind)
    if (ai) this.messageNotes = { ...this.messageNotes, [msgKey(p, id)]: { kind, line: ai.line } }
    this.emit()
  }

  /** Three short replies written for this message (AI); the fixed quick replies stay underneath. */
  async suggestReplies(p: MessageProviderId, id: string) {
    const key = msgKey(p, id)
    if (!this.aiReady() || this.replySuggestions[key] || this.assisting === `suggest:${key}`) return
    const m = this.findMessage(p, id)
    if (!m?.canReply) return
    const prevTarget = this.replyTarget
    this.replyTarget = { provider: p, id }
    this.assisting = `suggest:${key}`
    this.emit()
    try {
      const resp = await this.askAssistant({ mode: 'chat', message: 'Suggest three short replies I could send to the message in focus (replyingTo).' }, { quiet: true })
      const list = (resp?.replySuggestions ?? []).map((x) => x.trim()).filter((x) => x && x.length <= 140 && !containsProfanity(x) && !containsForbidden(x))
      if (list.length) this.replySuggestions = { ...this.replySuggestions, [key]: [...new Set(list)].slice(0, 3) }
    } finally {
      this.assisting = null
      if (!prevTarget) this.replyTarget = prevTarget
      this.emit()
    }
  }

  /** Local triage: Important mail, Slack mentions and Telegram messages need you; other mail is FYI. */
  triageLabel(m: InboxItem): TriageLabel {
    const ai = this.triageAi[msgKey(m.provider, m.id)]
    if (ai) return ai
    if (m.important && (m.canReply || m.provider === 'github')) return 'reply'
    return m.provider === 'gmail' ? 'fyi' : 'later'
  }
  private triageMap(): Record<string, TriageLabel> {
    const out: Record<string, TriageLabel> = {}
    for (const m of this.allInbox()) out[msgKey(m.provider, m.id)] = this.triageLabel(m)
    return out
  }
  /** Inbox order: needs you → can wait → FYI, newest first within each. */
  sortedInbox(): InboxItem[] {
    const rank: Record<TriageLabel, number> = { reply: 0, later: 1, fyi: 2 }
    return [...this.allInbox()].sort((a, b) => rank[this.triageLabel(a)] - rank[this.triageLabel(b)] || b.at - a.at)
  }
  private async triageInbox() {
    const items = this.allInbox()
    const sig = items.map((m) => msgKey(m.provider, m.id)).sort().join('|')
    if (!this.aiReady() || !items.length || sig === this.triageSig || Date.now() - this.triageAt < 10 * 60_000) return
    this.triageSig = sig
    this.triageAt = Date.now()
    let refs: RefMap | null = null
    const resp = await this.askAssistant({ mode: 'chat', message: 'Triage my messages: label every M-ref reply, later or fyi.' }, { quiet: true, onRefs: (r) => (refs = r) })
    if (!resp?.triage?.length || !refs) return
    const map: Record<string, TriageLabel> = {}
    for (const t of resp.triage) {
      const m = (refs as RefMap).messages[t.messageRef]
      if (m) map[msgKey(m.provider, m.id)] = t.label
    }
    this.triageAi = map
    this.emit()
  }

  // ------------------------------------------------------------------ Telegram capture (“/quest …” to your own bot)
  private allCaptures(): Array<Capture & { provider: MessageProviderId }> {
    return MESSAGE_PROVIDER_IDS.flatMap((p) => (this.inboxData[p]?.captures ?? []).filter((c) => !(this.ackCaptures[p] ?? []).includes(c.id)).map((c) => ({ ...c, provider: p })))
  }
  /** Offer a captured note as a quest (exact confirmation); acknowledged to the bot buffer once added. */
  addCapture(p: MessageProviderId, id: string) {
    const c = this.inboxData[p]?.captures?.find((x) => x.id === id)
    if (!c) return
    const prop = proposalFromAction({ type: 'create_local_quest', title: c.text.slice(0, 80), category: 'personal', difficulty: 'normal', estimatedMinutes: 15 } as AiAction, {
      save: this.store.state,
      now: this.now(),
      tz: this.tz,
      refs: { quests: {}, events: {}, messages: {} },
      events: this.calEvents,
      calendarConnected: this.calendarConnected(),
      calendarLabel: this.calendarLabel(),
      source: 'user',
    })
    if (prop && typeof prop !== 'string') this.pendingCapture = { provider: p, id }
    this.propose(prop)
  }
  dismissCapture(p: MessageProviderId, id: string) {
    this.ackCaptures[p] = [...(this.ackCaptures[p] ?? []), id]
    this.emit()
    void this.refreshInbox(p)
  }
  private pendingCapture: { provider: MessageProviderId; id: string } | null = null

  // ------------------------------------------------------------------ plan my day
  /** Local, deterministic plan from quests, calendar and inbox. Shown on the phone sheet and the glasses plan screen. */
  async planDay(from: 'phone' | 'glasses' = 'phone') {
    if (this.calendarConnected() && (this.calFetchedAt === null || this.now() - this.calFetchedAt > 10 * 60_000)) await this.refreshCalendar()
    this.plan = planDay({ save: this.store.state, now: this.now(), tz: this.tz, events: this.calEvents, calendarConnected: this.calendarConnected(), inbox: this.allInbox() })
    this.planOpen = true
    void this.markTraining('plan')
    if (from === 'glasses' || this.screen.name === 'home') {
      if (this.screen.name !== 'plan') return this.nav({ name: 'plan' })
    }
    this.emit()
  }

  closePlan() {
    this.planOpen = false
    if (this.screen.name === 'plan') this.back()
    else this.emit()
  }

  /** Book the plan's focus blocks: one exact confirmation, each block created and verified. */
  bookPlan() {
    const p = this.plan
    if (!p) return
    if (!this.calendarConnected()) return this.toast('Connect Google Calendar first (Camp)', 'warn')
    this.planOpen = false
    this.propose(calendarBlocksProposal(p.blocks.map((b) => ({ title: `Quest: ${b.title}`, start: b.start, end: b.end, questId: b.questId })), this.proposalCtx('user')))
  }

  /** Ask the AI companion to refine the local plan (only offered when an AI provider is configured). */
  async refinePlan() {
    if (!this.plan) await this.planDay()
    this.planOpen = false
    this.pushUserTurn('Plan my day')
    this.emit()
    await this.askAssistant({ mode: 'chat', message: planPrompt(this.plan!, this.tz) })
  }

  /** Local, deterministic split: a 10-minute first step (works offline; labelled local). */
  private async splitQuest(questId: string) {
    const q = this.store.state.quests.find((x) => x.id === questId)
    if (!q) return
    const r = await this.store.dispatch(
      { type: 'quest/create', input: { title: `First step: ${q.title}`.slice(0, 80), category: q.category === 'boss' ? 'personal' : q.category, difficulty: 'easy', estimatedMinutes: Math.min(10, q.estimatedMinutes), skill: q.skill, source: 'manual', deadline: { at: this.now() + 3600_000, tz: this.tz } } },
      this.now(),
      this.tz,
    )
    if (!r.error) {
      const created = r.save.quests[r.save.quests.length - 1]!
      this.toast(`Added “${created.title}” (10 min)`, 'good')
      this.screen = { name: 'quest', questId: created.id }
      this.emit()
    }
  }

  async mute(d: MuteDuration) {
    const now = this.now()
    const until = muteUntil(d, now, this.tz, this.store.state.preferences.quietHours.end)
    await this.store.mutate((s) => ({ ...s, reminders: { ...s.reminders, mutedUntil: until } }))
    this.toast(d === 'indefinite' ? 'Reminders muted until you unmute' : `Reminders muted until ${formatDateTime(until!, this.tz)}`)
  }

  async unmute() {
    await this.store.mutate((s) => ({ ...s, reminders: { ...s.reminders, mutedUntil: null } }))
    this.toast('Reminders back on', 'good')
  }

  // ------------------------------------------------------------------ game
  async questCommand(cmd: GameCommand) {
    // leave the detail screen first so the celebration's "back" returns to the list, not a finished quest
    if ((cmd.type === 'quest/complete' || cmd.type === 'quest/postpone' || cmd.type === 'quest/archive') && this.screen.name === 'quest' && this.screen.questId === cmd.id) {
      this.screen = this.stack.pop() ?? { name: 'home' }
    }
    this.pendingTaskSync = null
    const r = await this.store.dispatch(cmd, this.now(), this.tz)
    if (cmd.type === 'quest/complete' && !r.error && !r.duplicate) {
      if (this.focus?.questId === cmd.id) this.focus = null
      void this.markTraining('complete')
    }
    if (r.error) this.toast(`Couldn’t do that (${r.error.replace(/_/g, ' ')})`, 'warn')
    else if (r.duplicate) this.toast('Already done — no double rewards', 'info')
    else if (!r.persisted) this.toast('Saved in memory only — retrying storage…', 'warn')
    const sync = this.pendingTaskSync as { questId: string } | null
    this.pendingTaskSync = null
    if (sync && !r.error && !r.duplicate) {
      // the user finished a quest that came from Todoist/Notion/Google Tasks: offer to tick it off there (confirm-first)
      if (this.taskSyncFor(sync.questId)) this.proposeTaskComplete(sync.questId, 'user')
      else {
        const q = this.store.state.quests.find((x) => x.id === sync.questId)
        const p = q?.externalRef?.provider as TaskProviderId | undefined
        if (p && !this.taskServices[p]?.connected()) this.toast(`Done here. ${TASK_PROVIDER_LABELS[p]} isn’t connected, so it wasn’t ticked off there.`, 'info')
      }
    }
    this.emit()
    return r
  }

  private onDomainEvents(events: DomainEvent[]) {
    const save = this.store.state
    const now = this.now()
    for (const e of events) if (e.type === 'TRAINING_COMPLETED') this.toast(`+${e.xp} XP · Training: ${e.title}`, 'good')
    for (const e of events) {
      if (e.type !== 'QUEST_COMPLETED') continue
      const q = save.quests.find((x) => x.id === e.questId)
      const ref = q?.externalRef
      if (q && ref && (TASK_PROVIDER_IDS as readonly string[]).includes(ref.provider)) this.pendingTaskSync = { provider: ref.provider as TaskProviderId, taskId: ref.resourceId, title: q.title, questId: q.id }
    }
    const next = prioritizedQuests(save, now)[0]
    const n = celebrationFromEvents(events, save.companion.id, this.policy, { now, tz: this.tz, intensity: save.companion.intensity, nextQuestId: next?.id })
    if (n) {
      if (this.notice && !this.notice.solicited) this.closeNotice(null)
      this.showNotice(n)
    }
    if (events.some((e) => e.type === 'QUEST_STARTED')) {
      const ev = events.find((e) => e.type === 'QUEST_STARTED')!
      const q = save.quests.find((x) => x.id === (ev as { questId: string }).questId)
      if (q && !this.notice) this.showNotice({ ...infoNotice(save.companion.id, 'started', { quest: q.title }, this.policy, now), actions: [{ id: 'complete', label: '★ Complete', questId: q.id }, { id: 'dismiss', label: 'Continue' }] })
    }
  }

  // ------------------------------------------------------------------ proposals
  private proposalCtx(source: Proposal['source']) {
    return { now: this.now(), tz: this.tz, revision: this.store.state.revision, events: this.calEvents, calendarLabel: this.calendarLabel(), source }
  }

  private propose(p: Proposal | string | null) {
    if (!p) return
    if (typeof p === 'string') {
      this.toast(`Can’t propose that: ${p.replace(/_/g, ' ')}`, 'warn')
      return
    }
    if (this.proposal?.status === 'pending') this.proposal = { ...this.proposal, status: 'cancelled' }
    this.proposal = p
    if (this.screen.name !== 'confirm') this.nav({ name: 'confirm', proposalId: p.id })
    else {
      this.screen = { name: 'confirm', proposalId: p.id }
      this.emit()
    }
  }

  async confirmProposal(id: string) {
    const p = this.proposal
    if (!p || p.id !== id) return
    const stale = staleReason(p, this.store.state, this.now())
    if (stale) {
      this.proposal = { ...p, status: stale === 'expired' ? 'expired' : 'failed', resultLines: [`Not executed: ${stale.replace(/_/g, ' ')}. Nothing changed.`] }
      return this.emit()
    }
    this.proposal = { ...p, status: 'executing' }
    this.emit()
    try {
      const result = await this.execute(p)
      this.proposal = { ...p, status: 'done', resultLines: result }
      const done = pickLine(this.store.state.companion.id, 'done', {}, this.policy, { seed: p.id })
      this.pushCompanionTurn(done.line, 'local', done.emotion)
    } catch (e) {
      const code = e instanceof ApiError ? e.code : (e as Error).message
      this.proposal = { ...p, status: 'failed', resultLines: [`Failed: ${code.replace(/_/g, ' ')}.`, p.external ? 'Provider did not confirm the change — nothing is assumed written.' : 'Nothing was changed.'] }
    }
    this.emit()
  }

  cancelProposal(id: string) {
    const p = this.proposal
    if (!p || p.id !== id || p.status !== 'pending') return
    this.proposal = { ...p, status: 'cancelled' }
    this.pendingCapture = null
    const c = pickLine(this.store.state.companion.id, 'cancelled', {}, this.policy, { seed: id })
    this.pushCompanionTurn(c.line, 'local', c.emotion)
    this.toast('Cancelled — nothing changed')
    this.proposal = null
    this.back()
  }

  dismissProposalResult() {
    if (this.proposal && this.proposal.status !== 'pending' && this.proposal.status !== 'executing') {
      this.proposal = null
      if (this.screen.name === 'confirm') this.back()
      else this.emit()
    }
  }

  /** Trusted executor. Returns verified result lines. */
  private async execute(p: Proposal): Promise<string[]> {
    const now = this.now()
    const prm = p.params
    switch (prm.kind) {
      case 'create_quests': {
        const ids: string[] = []
        for (const q of prm.quests) {
          const r = await this.store.dispatch({ type: 'quest/create', input: { ...q, source: p.source === 'user' ? 'manual' : 'ai' } }, now, this.tz)
          if (r.error) throw new Error(r.error)
          ids.push(r.save.quests[r.save.quests.length - 1]!.id)
        }
        if (this.pendingCapture) {
          // the note came from the user's Telegram bot: it's handled now, so the bot buffer can forget it
          const c = this.pendingCapture
          this.pendingCapture = null
          this.dismissCapture(c.provider, c.id)
        }
        return [`Added ${ids.length} quest${ids.length > 1 ? 's' : ''} to your journal.`, ...prm.quests.map((q) => `“${q.title}”`)]
      }
      case 'update_quest': {
        const r = await this.store.dispatch({ type: 'quest/edit', id: prm.questId, patch: { ...(prm.title ? { title: prm.title } : {}), ...(prm.deadline ? { deadline: prm.deadline } : {}), ...(prm.estimatedMinutes ? { estimatedMinutes: prm.estimatedMinutes } : {}) } }, now, this.tz)
        if (r.error) throw new Error(r.error)
        return ['Quest updated.']
      }
      case 'start_quest': {
        const r = await this.store.dispatch({ type: 'quest/start', id: prm.questId }, now, this.tz)
        if (r.error) throw new Error(r.error)
        return ['Quest started.']
      }
      case 'complete_quest': {
        const r = await this.store.dispatch({ type: 'quest/complete', id: prm.questId, method: 'confirmed' }, now, this.tz)
        if (r.error) throw new Error(r.error)
        return r.duplicate ? ['Already completed — no extra reward.'] : ['Quest completed.']
      }
      case 'postpone_quest': {
        const r = await this.store.dispatch({ type: 'quest/postpone', id: prm.questId, deadline: prm.deadline }, now, this.tz)
        if (r.error) throw new Error(r.error)
        return [`Postponed to ${prm.deadline ? formatDateTime(prm.deadline.at, this.tz) : 'no deadline'}.`]
      }
      case 'reminder_prefs': {
        await this.store.mutate((s) => ({ ...s, preferences: { ...s.preferences, ...(prm.meetingReminderMinutes ? { meetingReminderMinutes: prm.meetingReminderMinutes } : {}), ...(prm.maxNudgesPerDay !== undefined ? { maxNudgesPerDay: prm.maxNudgesPerDay } : {}) } }))
        return ['Reminder settings updated.']
      }
      case 'calendar_create': {
        if (!this.calendarConnected()) throw new ApiError(401, 'calendar_not_connected')
        const r = await this.calendar.createEvent({ proposalId: p.id, title: prm.title, start: prm.start, end: prm.end, timeZone: prm.timeZone })
        await this.refreshCalendar(true)
        return [
          `${r.reconciled ? 'Already on your calendar (reconciled)' : 'Created and verified'}${this.mode === 'demo' ? ' in the DEMO calendar' : ' in Google Calendar'}:`,
          `“${r.event.title}”`,
          `${formatDateTime(r.event.start, this.tz)}–${formatTime(r.event.end, this.tz)}`,
        ]
      }
      case 'calendar_create_many': {
        if (!this.calendarConnected()) throw new ApiError(401, 'calendar_not_connected')
        const ok: string[] = []
        const failed: string[] = []
        let firstError: unknown = null
        for (const [i, b] of prm.blocks.entries()) {
          try {
            // one deterministic id per block: a retry reconciles instead of duplicating
            const r = await this.calendar.createEvent({ proposalId: `${p.id}b${i}`, title: b.title, start: b.start, end: b.end, timeZone: prm.timeZone })
            ok.push(`“${r.event.title}” ${formatDateTime(r.event.start, this.tz)}–${formatTime(r.event.end, this.tz)}${r.reconciled ? ' (already there)' : ''}`)
          } catch (e) {
            firstError ??= e
            failed.push(`Not created: “${b.title}” (${e instanceof ApiError ? e.code.replace(/_/g, ' ') : 'error'})`)
          }
        }
        await this.refreshCalendar(true)
        if (!ok.length) throw firstError ?? new ApiError(502, 'calendar_write_failed')
        return [`Created and verified ${ok.length} of ${prm.blocks.length}${this.mode === 'demo' ? ' in the DEMO calendar' : ' in Google Calendar'}:`, ...ok, ...failed]
      }
      case 'message_mark_read': {
        const svc = this.inboxServices[prm.provider]
        if (!svc?.connected() || !svc.markRead) throw new ApiError(401, 'tasks_not_connected')
        const r = await svc.markRead({ proposalId: p.id, messageId: prm.messageId })
        void this.refreshInbox(prm.provider)
        if (this.screen.name === 'message') this.screen = this.stack.pop() ?? { name: 'home' }
        return [`${r.reconciled ? 'Already read (reconciled)' : 'Marked read and verified'}${this.mode === 'demo' ? ' (DEMO GitHub — nothing left this device)' : ' on GitHub'}:`, `“${prm.title}”`]
      }
      case 'message_reply': {
        const svc = this.inboxServices[prm.provider]
        if (!svc?.connected()) throw new ApiError(401, 'tasks_not_connected')
        const r = await svc.reply({ proposalId: p.id, messageId: prm.messageId, body: prm.body })
        this.replyTarget = null
        void this.markTraining('reply')
        void this.refreshInbox(prm.provider)
        const where = this.mode === 'demo' ? ` (DEMO ${MESSAGE_PROVIDER_LABELS[prm.provider]} — nothing left this device)` : ` from your ${MESSAGE_PROVIDER_LABELS[prm.provider]}`
        return [`${r.reconciled ? 'Already sent (reconciled)' : 'Sent and verified'}${where}:`, prm.provider === 'gmail' ? `To ${r.to} · Re: ${prm.about}` : prm.provider === 'telegram' ? `Reply to ${prm.to} in Telegram` : `Thread reply to ${prm.to}`, `“${prm.body.length > 120 ? `${prm.body.slice(0, 119)}…` : prm.body}”`]
      }
      case 'task_complete': {
        const svc = this.taskServices[prm.provider]
        if (!svc?.connected()) throw new ApiError(401, 'tasks_not_connected')
        const label = this.taskLabel(prm.provider)
        const r = await svc.complete({ proposalId: p.id, taskId: prm.taskId })
        this.syncedTasks.add(`${prm.provider}:${prm.taskId}`)
        void this.refreshTasks(prm.provider)
        return [`${r.reconciled ? 'Already ticked off (reconciled)' : 'Marked done and verified'} in ${label}:`, `“${r.task.title}”`, ...(r.note ? [r.note] : [])]
      }
      case 'calendar_update': {
        if (!this.calendarConnected()) throw new ApiError(401, 'calendar_not_connected')
        const r = await this.calendar.updateEvent({ proposalId: p.id, eventId: prm.eventId, expectedEtag: prm.etag, start: prm.start, end: prm.end, timeZone: prm.timeZone })
        await this.refreshCalendar(true)
        return [`Rescheduled and verified:`, `“${r.event.title}”`, `${formatDateTime(r.event.start, this.tz)}–${formatTime(r.event.end, this.tz)}`]
      }
    }
  }

  // ------------------------------------------------------------------ mail & chat (Gmail, Slack)
  private inboxLabel(p: MessageProviderId) {
    return this.mode === 'demo' ? `${MESSAGE_PROVIDER_LABELS[p]} · demo` : this.inboxData[p]?.label ?? MESSAGE_PROVIDER_LABELS[p]
  }

  private inboxViews(): Record<MessageProviderId, InboxView> {
    const out = {} as Record<MessageProviderId, InboxView>
    for (const p of MESSAGE_PROVIDER_IDS) {
      const d = this.inboxData[p] ?? emptyInboxData(p)
      const svc = this.inboxServices[p]
      out[p] = {
        provider: p,
        name: MESSAGE_PROVIDER_LABELS[p],
        label: this.inboxLabel(p),
        configured: this.mode === 'demo' || (this.server.reachable && this.server.messages[p]),
        status: svc ? svc.status() : { state: 'disconnected' },
        items: d.items,
        canReply: d.canReply,
        fetchedAt: d.fetchedAt,
        error: d.error,
        busy: d.busy,
      }
    }
    return out
  }

  /** Every connected inbox, newest first. */
  allInbox(): InboxItem[] {
    return MESSAGE_PROVIDER_IDS.flatMap((p) => (this.inboxServices[p]?.connected() ? this.inboxData[p].items : [])).sort((a, b) => b.at - a.at)
  }

  inboxConnected(): boolean {
    return MESSAGE_PROVIDER_IDS.some((p) => this.inboxServices[p]?.connected())
  }

  async connectInbox(p: MessageProviderId) {
    await this.inboxServices[p].beginLink()
    this.emit()
  }

  cancelInboxLink(p: MessageProviderId) {
    this.inboxServices[p].cancelLink()
    this.emit()
  }

  async refreshInbox(p: MessageProviderId, user = false) {
    const svc = this.inboxServices[p]
    if (!svc?.connected()) return
    this.inboxData[p] = { ...this.inboxData[p], busy: true }
    this.emit()
    try {
      const ack = this.ackCaptures[p] ?? []
      const r = await svc.list(ack)
      if (ack.length) this.ackCaptures[p] = (this.ackCaptures[p] ?? []).filter((x) => !ack.includes(x))
      this.inboxData[p] = { items: r.items, captures: (r.captures ?? []).filter((c) => !(this.ackCaptures[p] ?? []).includes(c.id)), label: r.label, canReply: r.canReply, fetchedAt: r.fetchedAt, error: null, busy: false }
      if (user) this.toast(`${MESSAGE_PROVIDER_LABELS[p]}: ${r.items.length} new`)
      this.runEngine('tick')
      void this.triageInbox()
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'messages_unavailable'
      this.inboxData[p] = { ...(svc.connected() ? this.inboxData[p] : emptyInboxData(p)), error: code, busy: false }
    }
    this.emit()
  }

  async disconnectInbox(p: MessageProviderId) {
    const r = await this.inboxServices[p].disconnect()
    this.inboxData[p] = emptyInboxData(p)
    if (this.replyTarget?.provider === p) this.replyTarget = null
    this.toast(this.mode === 'demo' ? `${MESSAGE_PROVIDER_LABELS[p]} demo disconnected` : `${MESSAGE_PROVIDER_LABELS[p]} disconnected${r.revoked ? ' and access revoked' : ''}`)
    this.emit()
  }

  findMessage(p: MessageProviderId, id: string): InboxItem | undefined {
    return this.inboxData[p]?.items.find((m) => m.id === id)
  }

  /** Open a message: the phone shows the reply sheet; the glasses show the message with “Reply by voice”. */
  openMessage(p: MessageProviderId, id: string) {
    if (!this.findMessage(p, id)) return this.toast('That message is no longer in the inbox', 'info')
    this.replyTarget = { provider: p, id }
    if (this.screen.name !== 'message') this.nav({ name: 'message', provider: p, messageId: id })
    else this.emit()
  }

  closeMessage() {
    this.replyTarget = null
    if (this.screen.name === 'message') this.back()
    else this.emit()
  }

  /** The user wrote (or dictated) a reply: show it verbatim for confirmation. */
  proposeReply(p: MessageProviderId, id: string, body: string, source: Proposal['source'] = 'user') {
    const m = this.findMessage(p, id)
    if (!m) return this.toast('That message is no longer in the inbox', 'info')
    this.propose(messageReplyProposal({ provider: p, messageId: id, to: m.from, about: m.title, where: m.where, body, canReply: m.canReply }, { now: this.now(), revision: this.store.state.revision, source, target: this.inboxLabel(p) }))
  }

  /** Ask the companion to draft a reply (the draft is still shown verbatim for confirmation). */
  async draftReply(p: MessageProviderId, id: string, hint = '') {
    const m = this.findMessage(p, id)
    if (!m) return
    this.replyTarget = { provider: p, id }
    const ask = hint.trim() ? `Reply to ${m.from} about “${m.title}”: ${hint.trim()}` : `Draft a short, polite reply to ${m.from} about “${m.title}”.`
    this.pushUserTurn(ask.slice(0, 500))
    await this.askAssistant({ mode: 'chat', message: ask.slice(0, 500) })
  }

  // ------------------------------------------------------------------ task integrations (Todoist, Notion, Google Tasks)
  private taskLabel(p: TaskProviderId) {
    return this.mode === 'demo' ? `${TASK_PROVIDER_LABELS[p]} · demo` : this.taskData[p]?.label ?? TASK_PROVIDER_LABELS[p]
  }

  private taskViews(save: SaveV1): Record<TaskProviderId, TaskView> {
    const out = {} as Record<TaskProviderId, TaskView>
    for (const p of TASK_PROVIDER_IDS) {
      const d = this.taskData[p] ?? emptyTaskData(p)
      const svc = this.taskServices[p]
      out[p] = {
        provider: p,
        name: TASK_PROVIDER_LABELS[p],
        label: this.taskLabel(p),
        configured: this.mode === 'demo' || (this.server.reachable && this.server.tasks[p]),
        status: svc ? svc.status() : { state: 'disconnected' },
        tasks: d.tasks.map((t) => ({ ...t, questId: save.quests.find((q) => q.externalRef?.provider === p && q.externalRef.resourceId === t.id)?.id ?? null })),
        sources: d.sources,
        selected: d.selected,
        fetchedAt: d.fetchedAt,
        error: d.error,
        busy: d.busy,
      }
    }
    return out
  }

  async connectTasks(p: TaskProviderId) {
    await this.taskServices[p].beginLink()
    this.emit()
  }

  cancelTaskLink(p: TaskProviderId) {
    this.taskServices[p].cancelLink()
    this.emit()
  }

  async refreshTasks(p: TaskProviderId, opts: { sourceId?: string | null; user?: boolean } = {}) {
    const svc = this.taskServices[p]
    if (!svc?.connected()) return
    this.taskData[p] = { ...this.taskData[p], busy: true }
    this.emit()
    try {
      const r = await svc.list(opts.sourceId ?? this.taskData[p].selected)
      this.taskData[p] = { tasks: r.tasks, sources: r.sources, selected: r.selected, label: r.label, fetchedAt: r.fetchedAt, error: null, busy: false }
      if (opts.user) this.toast(`${TASK_PROVIDER_LABELS[p]}: ${r.tasks.length} open task${r.tasks.length === 1 ? '' : 's'}`)
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'tasks_unavailable'
      this.taskData[p] = { ...(svc.connected() ? this.taskData[p] : emptyTaskData(p)), error: code, busy: false }
    }
    this.emit()
  }

  async selectTaskSource(p: TaskProviderId, sourceId: string) {
    await this.refreshTasks(p, { sourceId, user: true })
  }

  async disconnectTasks(p: TaskProviderId) {
    const r = await this.taskServices[p].disconnect()
    this.taskData[p] = emptyTaskData(p)
    this.toast(this.mode === 'demo' ? `${TASK_PROVIDER_LABELS[p]} demo disconnected` : `${TASK_PROVIDER_LABELS[p]} disconnected${r.revoked ? ' and access revoked' : ''}`)
    this.emit()
  }

  /** Bring tasks into the journal as quests. Deduplicated by provider + task id in the reducer. */
  async importTasks(p: TaskProviderId, ids: string[]) {
    const now = this.now()
    let added = 0
    let skipped = 0
    for (const id of ids.slice(0, 12)) {
      const t = this.taskData[p].tasks.find((x) => x.id === id)
      if (!t) continue
      let deadline: { at: number; tz: string } | undefined
      if (t.due !== null) {
        // date-only due dates mean "some time that day": aim for the evening, inside active hours
        const at = t.dueAllDay ? parseLocalDateTime(`${new Date(t.due).toISOString().slice(0, 10)}T21:00`, this.tz) : t.due
        if (at !== null) deadline = { at, tz: this.tz }
      }
      const r = await this.store.dispatch(
        {
          type: 'quest/create',
          input: { title: t.title.slice(0, 80) || 'Untitled task', category: 'personal', difficulty: 'normal', estimatedMinutes: 30, skill: 'DIS', source: p, externalRef: { provider: p, resourceId: t.id }, deadline },
        },
        now,
        this.tz,
      )
      if (r.error) {
        this.toast(`Stopped importing: ${r.error.replace(/_/g, ' ')}`, 'warn')
        break
      }
      if (r.duplicate) skipped++
      else added++
    }
    if (added) this.toast(`${added} quest${added === 1 ? '' : 's'} added from ${TASK_PROVIDER_LABELS[p]}`, 'good')
    else if (skipped) this.toast('Already in your journal', 'info')
    this.emit()
  }

  /** Can a finished quest be ticked off in the list it came from? (UI affordance) */
  taskSyncFor(questId: string): { provider: TaskProviderId; label: string } | null {
    const q = this.store.state.quests.find((x) => x.id === questId)
    const ref = q?.externalRef
    if (!q || q.status !== 'completed' || !ref || !(TASK_PROVIDER_IDS as readonly string[]).includes(ref.provider)) return null
    const p = ref.provider as TaskProviderId
    if (!this.taskServices[p]?.connected() || this.syncedTasks.has(`${p}:${ref.resourceId}`)) return null
    return { provider: p, label: this.taskLabel(p) }
  }

  proposeTaskComplete(questId: string, source: Proposal['source'] = 'user') {
    const sync = this.taskSyncFor(questId)
    const q = this.store.state.quests.find((x) => x.id === questId)
    if (!sync || !q?.externalRef) return
    this.propose(taskCompleteProposal({ provider: sync.provider, taskId: q.externalRef.resourceId, title: q.title, questId }, { now: this.now(), revision: this.store.state.revision, source, target: sync.label }))
  }

  // ------------------------------------------------------------------ calendar
  async refreshCalendar(user = false) {
    if (!this.calendarConnected()) return
    const now = this.now()
    try {
      const from = startOfLocalDay(now, this.tz)
      this.calEvents = await this.calendar.listEvents(from, from + 2 * 86400_000)
      this.calFetchedAt = now
      this.calError = null
      if (user) this.toast('Calendar refreshed')
    } catch (e) {
      this.calError = e instanceof ApiError ? e.code : 'calendar_unavailable'
      if (this.calendar.status().state === 'expired') {
        this.calEvents = []
        this.calFetchedAt = null
      }
    }
    this.emit()
  }

  async connectCalendar() {
    if (!this.liveCalendar) return
    await this.liveCalendar.beginLink()
    this.emit()
  }
  cancelCalendarLink() {
    this.liveCalendar?.cancelLink()
    this.emit()
  }
  async disconnectCalendar() {
    const r = await this.calendar.disconnect()
    this.calEvents = []
    this.calFetchedAt = null
    await this.store.mutate((s) => ({ ...s, integrationMetadata: s.integrationMetadata.filter((m) => m.provider !== 'google_calendar') }))
    this.toast(r.revoked ? 'Calendar disconnected and access revoked' : 'Calendar disconnected. To be sure, also remove access at myaccount.google.com/permissions', r.revoked ? 'good' : 'info')
    this.emit()
  }

  async findSlot(questId: string | null) {
    if (!this.calendarConnected()) {
      this.toast('Connect Google Calendar first (Settings)', 'warn')
      return
    }
    if (this.calFetchedAt === null || this.now() - this.calFetchedAt > 10 * 60_000) await this.refreshCalendar()
    const q = questId ? this.store.state.quests.find((x) => x.id === questId) : prioritizedQuests(this.store.state, this.now())[0]
    const minutes = Math.max(15, Math.min(240, q?.estimatedMinutes ?? 30))
    const now = this.now()
    const slots = freeSlots(this.calEvents, { start: now + 5 * 60_000, end: now + 36 * 3600_000 }, minutes, this.tz, this.store.state.preferences.activeHours)
    const s = slots[0]
    if (!s) {
      this.toast(`No free ${minutes}-minute slot in your active hours`, 'warn')
      return
    }
    this.propose(calendarCreateProposal({ title: `Quest: ${q?.title ?? 'Focus time'}`, start: s.start, minutes, questId: q?.id }, this.proposalCtx('user')))
  }

  // ------------------------------------------------------------------ AI chat
  async refreshServer() {
    this.server = await api.status()
    this.chatSource = this.server.reachable && this.server.ai.configured ? 'ai' : 'local'
    this.emit()
    void this.triageInbox()
  }

  /** The provider this device will ask: the saved choice when the server offers it, else the server default. */
  aiProvider(): AiProviderId | null {
    if (!this.server.reachable || !this.server.ai.configured) return null
    const pref = this.store.state.preferences.aiProvider
    if (pref !== 'auto' && this.server.ai.providers.some((p) => p.id === pref)) return pref
    return this.server.ai.default
  }

  aiLabel(): string {
    const id = this.aiProvider()
    return id ? AI_PROVIDER_LABELS[id] : 'Local'
  }

  async setAiProvider(id: Preferences['aiProvider']) {
    await this.store.mutate((s) => ({ ...s, preferences: { ...s.preferences, aiProvider: id } }))
    this.toast(id === 'auto' ? 'AI: using the server default' : `AI: ${AI_PROVIDER_LABELS[id]} will answer from now on`, 'info')
  }

  setAccessCode(code: string) {
    api.accessCode = code.trim() || null
    api.clearSession()
    void this.refreshServer()
  }

  private pushCompanionTurn(line: Line, source: ChatTurn['source'], emotion?: Emotion, provider?: AiProviderId) {
    this.chatTurns = [...this.chatTurns, { id: newId('evt'), role: 'companion' as const, line, at: this.now(), source, emotion, provider }].slice(-40)
    const save = this.store.state
    if (save.memory.enabled) {
      const p = persistableText(line)
      const turn: Turn = { role: 'companion', text: p.text.slice(0, 600), at: this.now(), tier: p.tier }
      void this.store.mutate((s) => ({ ...s, memory: { ...s.memory, recentTurns: [...s.memory.recentTurns, turn].slice(-12) } }))
    }
  }

  private pushUserTurn(text: string) {
    this.chatTurns = [...this.chatTurns, { id: newId('evt'), role: 'user' as const, text, at: this.now() }].slice(-40)
    if (this.store.state.memory.enabled) {
      const turn: Turn = { role: 'user', text: text.slice(0, 600), at: this.now(), tier: 'clean' }
      void this.store.mutate((s) => ({ ...s, memory: { ...s.memory, recentTurns: [...s.memory.recentTurns, turn].slice(-12) } }))
    }
  }

  async sendChat(message: string) {
    const text = message.trim().slice(0, 500)
    if (!text || this.sending) return
    this.pushUserTurn(text)
    await this.askAssistant({ mode: 'chat', message: text })
  }

  private sessionTurns() {
    return this.store.state.memory.enabled ? [] : this.chatTurns.slice(-6).map((t) => ({ role: t.role, text: t.text ?? (t.line ? persistableText(t.line).text : '') }))
  }

  private async askAssistant(input: { mode: 'chat'; message: string } | { mode: 'voice'; wavBase64: string; durationMs: number; signal?: AbortSignal }, opts: { quiet?: boolean; onRefs?: (r: RefMap) => void } = {}): Promise<AiResponse | null> {
    const save = this.store.state
    if (opts.quiet && !(this.server.reachable && this.server.ai.configured)) return null
    const now = this.now()
    const seq = ++this.aiSeq
    const policy = this.policy
    const memGen = save.memory.generation
    const { context, refs } = buildContext(save, now, this.tz, { connected: this.calendarConnected(), events: this.calEvents, freeSlots: this.slots(), fetchedAt: this.calFetchedAt }, this.sessionTurns(), { items: this.allInbox(), replyingTo: this.replyTarget })
    opts.onRefs?.(refs)
    if (!opts.quiet) this.sending = true
    this.emit()
    let resp: AiResponse | null = null
    let source: 'ai' | 'local' = 'local'
    let answeredBy: AiProviderId | undefined
    const canAi = this.server.reachable && this.server.ai.configured
    if (canAi) {
      const body = {
        mode: input.mode,
        ...(save.preferences.aiProvider !== 'auto' && this.aiProvider() === save.preferences.aiProvider ? { provider: save.preferences.aiProvider } : {}),
        companionId: save.companion.id,
        language: { adultEnabled: policy.adultEnabled, profanityLevel: policy.profanityLevel, roastIntensity: policy.roastIntensity, intensity: save.companion.intensity, revision: policy.revision },
        context,
        ...(input.mode === 'chat' ? { message: input.message } : { audio: { mimeType: 'audio/wav' as const, base64: input.wavBase64, durationMs: input.durationMs } }),
      }
      const valid = AiRequestSchema.safeParse(body)
      if (valid.success) {
        try {
          const r = await api.call<{ response: AiResponse; provider?: AiProviderId; routed?: boolean }>(input.mode === 'voice' ? '/api/ai/voice' : '/api/ai/chat', { body: valid.data, timeoutMs: input.mode === 'voice' ? 30_000 : 22_000, signal: input.mode === 'voice' ? input.signal : undefined })
          resp = r.response
          source = 'ai'
          answeredBy = r.provider ?? this.aiProvider() ?? undefined
        } catch (e) {
          const code = e instanceof ApiError ? e.code : 'offline'
          if (opts.quiet) {
            /* background assist: the local version stays on screen */
          } else if (code === 'ai_refused') this.toast(`${this.aiLabel()} declined that request — using a safe local reply`, 'info')
          else if (code !== 'timeout' || input.mode !== 'voice') this.toast(`AI unavailable (${code.replace(/_/g, ' ')}) — local mode`, 'warn')
        }
      }
    }
    if (seq !== this.aiSeq) {
      // conversation/memory was cleared while the request was in flight: drop the stale result
      this.sending = false
      this.emit()
      return null
    }
    if (opts.quiet) {
      this.emit()
      return resp
    }
    if (!resp) {
      if (input.mode === 'voice') {
        this.sending = false
        this.emit()
        return null // no fake transcription offline
      }
      const lr = localReply(input.message, save.companion.id, context)
      resp = { transcript: null, dialogue: lr.dialogue, cleanDialogue: null, emotion: lr.emotion, intent: lr.intent as AiResponse['intent'], actions: lr.actions, memoryCandidates: [], needsClarification: false, droppedActions: 0 }
    }
    this.sending = false
    this.chatSource = source
    // Final-render validation happens in finalizeLine(); here we tag the line with the
    // request-time revision so a response arriving after 18+ was disabled is replaced.
    const dialogue = resp.dialogue
    const tier = classifyText(dialogue) === 'strong' ? (policy.adultEnabled ? (policy.profanityLevel === 'uncensored' ? 'uncensored' : 'strong') : 'strong') : 'clean'
    const fallbackClean = resp.cleanDialogue && classifyText(resp.cleanDialogue) === 'clean' ? resp.cleanDialogue : pickLine(save.companion.id, 'confirm', {}, { ...policy, adultEnabled: false, profanityLevel: 'none' }).line.text || VETTED_CLEAN_FALLBACK
    const line: Line = { text: dialogue, tier, cleanText: tier === 'clean' ? dialogue : fallbackClean, revision: policy.revision, origin: source === 'ai' ? 'ai' : 'local' }
    if (input.mode === 'voice' && resp.transcript) this.pushUserTurn(`🎙 ${resp.transcript}`)
    this.pushCompanionTurn(line, source, resp.emotion, answeredBy)
    this.lastAssist = { line, source }
    // memory candidates require review; dropped if memory was cleared/disabled meanwhile
    if (resp.memoryCandidates.length && this.store.state.memory.enabled && this.store.state.memory.generation === memGen) {
      this.pendingMemory = [...this.pendingMemory, ...resp.memoryCandidates.map((m) => ({ id: newId('mem'), kind: m.kind, text: m.text }))].slice(-6)
    }
    await this.applyActions(resp, refs, input.mode === 'voice' ? 'voice' : 'ai')
    this.emit()
    return resp
  }

  private async applyActions(resp: AiResponse, refs: RefMap, source: Proposal['source']) {
    if (resp.needsClarification) return
    const save = this.store.state
    const ctx = { save, now: this.now(), tz: this.tz, refs, events: this.calEvents, calendarConnected: this.calendarConnected(), calendarLabel: this.calendarLabel(), source, inboxLabel: (p: MessageProviderId) => this.inboxLabel(p) }
    const writes: Proposal[] = []
    for (const a of resp.actions as AiAction[]) {
      if (a.type === 'mute_companion') {
        if (resp.intent === 'mute') await this.mute(a.duration)
        continue
      }
      if (a.type === 'view_calendar') {
        if (this.calendarConnected()) this.nav({ name: 'calendar' })
        continue
      }
      if (a.type === 'daily_review') {
        await this.dailyReview()
        continue
      }
      if (a.type === 'find_free_slot') {
        const qid = a.questRef ? refs.quests[a.questRef] ?? null : null
        await this.findSlot(qid)
        return
      }
      const p = proposalFromAction(a, ctx)
      if (typeof p === 'string') {
        if (p === 'calendar_not_connected') this.toast('Calendar isn’t connected — connect it in Settings', 'warn')
        if (p === 'reply_must_be_clean') this.toast('That reply wasn’t clean enough to send as you — try rewording it', 'warn')
        if (p === 'reply_not_allowed') this.toast('Replies aren’t allowed for that account (read-only access)', 'warn')
        continue
      }
      if (p) writes.push(p)
    }
    if (!writes.length) return
    const creates = writes.filter((w) => w.params.kind === 'create_quests')
    if (creates.length > 1) return this.propose(mergeQuestProposals(creates, this.tz))
    this.propose(writes[0]!)
  }

  async dailyReview() {
    const save = this.store.state
    const now = this.now()
    const today = dayKey(now, this.tz)
    const done = save.rewardLedger.filter((r) => dayKey(r.at, this.tz) === today)
    const xp = done.reduce((s, r) => s + r.xp, 0)
    const open = prioritizedQuests(save, now)
    const base = pickLine(save.companion.id, 'daily_review', { count: done.length }, this.policy, { seed: today })
    const extra = ` +${xp} XP today. ${open.length ? `Tomorrow, start with “${open[0]!.title}”.` : 'Journal is clear.'}`
    const line: Line = { ...base.line, text: base.line.text + extra, cleanText: base.line.cleanText + extra }
    await this.store.mutate((s) => ({ ...s, reminders: { ...s.reminders, lastReviewDay: today } }))
    this.showNotice({ ...infoNotice(save.companion.id, 'daily_review', {}, this.policy, now), line, emotion: base.emotion, kind: 'INFO' })
  }

  approveMemory(id: string) {
    const m = this.pendingMemory.find((x) => x.id === id)
    this.pendingMemory = this.pendingMemory.filter((x) => x.id !== id)
    if (m && this.store.state.memory.enabled) void this.addMemory(m.kind, m.text, 'ai_approved')
    this.emit()
  }
  rejectMemory(id: string) {
    this.pendingMemory = this.pendingMemory.filter((x) => x.id !== id)
    this.emit()
  }
  async addMemory(kind: MemoryEntry['kind'], text: string, source: MemoryEntry['source'] = 'user') {
    const t = text.trim().slice(0, 160)
    if (!t) return
    await this.store.mutate((s) => ({ ...s, memory: { ...s.memory, entries: [...s.memory.entries, { id: newId('mem'), kind, text: t, createdAt: this.now(), source }].slice(-20) } }))
  }
  async editMemory(id: string, text: string) {
    await this.store.mutate((s) => ({ ...s, memory: { ...s.memory, entries: s.memory.entries.map((e) => (e.id === id ? { ...e, text: text.trim().slice(0, 160) || e.text } : e)) } }))
  }
  async deleteMemory(id: string) {
    await this.store.mutate((s) => ({ ...s, memory: { ...s.memory, entries: s.memory.entries.filter((e) => e.id !== id) } }))
  }
  async clearConversation() {
    this.chatTurns = []
    this.aiSeq++ // invalidate in-flight context
    await this.store.mutate((s) => ({ ...s, memory: { ...s.memory, recentTurns: [], generation: s.memory.generation + 1 } }))
    this.toast('Conversation cleared')
  }
  async setMemoryEnabled(enabled: boolean) {
    await this.store.mutate((s) => ({ ...s, memory: { ...s.memory, enabled, ...(enabled ? {} : { recentTurns: [] }), generation: s.memory.generation + 1 } }))
    if (!enabled) this.pendingMemory = []
  }
  async resetMemory() {
    this.pendingMemory = []
    this.chatTurns = []
    this.aiSeq++
    await this.store.mutate((s) => ({ ...s, memory: { ...s.memory, entries: [], recentTurns: [], generation: s.memory.generation + 1 } }))
    this.toast('Memory reset (game progress kept)')
  }

  // ------------------------------------------------------------------ voice
  async startVoice() {
    if (this.voice.state === 'listening' || this.voice.state === 'processing') return
    if (this.proposal?.status === 'pending') return
    if (this.screen.name !== 'voice') this.nav({ name: 'voice' })
    if (!this.device.supportsMic) {
      this.voice = { ...this.voice, state: 'unsupported', message: 'No microphone in this environment. Use text chat on the phone.' }
      return this.emit()
    }
    if (!(this.server.reachable && this.server.ai.configured)) {
      this.voice = { ...this.voice, state: 'unsupported', message: 'Voice needs the AI server (not configured or offline). Text commands still work locally.' }
      return this.emit()
    }
    if (!this.server.ai.providers.some((p) => p.voice === 'native')) {
      this.voice = { ...this.voice, state: 'unsupported', message: 'None of the AI providers on this server accept voice. Text chat still works.' }
      return this.emit()
    }
    this.voiceChunks = []
    const ok = await this.device.startMic()
    if (!ok) {
      this.voice = { ...this.voice, state: 'error', message: 'Microphone could not start (permission or device).' }
      return this.emit()
    }
    this.voiceStartedAt = Date.now()
    this.voice = { state: 'listening', elapsedMs: 0, limitMs: VOICE_LIMIT_MS, level: 0 }
    this.voiceTimer = setInterval(() => {
      const el = Date.now() - this.voiceStartedAt
      this.voice = { ...this.voice, elapsedMs: el }
      if (el >= VOICE_LIMIT_MS) void this.stopVoice()
      else this.emit()
    }, 500)
    this.emit()
  }

  private onAudio(pcm: Uint8Array) {
    if (this.voice.state !== 'listening') return
    this.voiceChunks.push(pcm)
    const total = this.voiceChunks.reduce((s, c) => s + c.length, 0)
    if (total > 16_000 * 2 * 15.4) void this.stopVoice()
    this.voice = { ...this.voice, level: level(pcm) }
  }

  private clearVoiceTimer() {
    if (this.voiceTimer) clearInterval(this.voiceTimer)
    this.voiceTimer = null
  }

  async stopVoice() {
    if (this.voice.state !== 'listening') return
    this.clearVoiceTimer()
    await this.device.stopMic()
    const chunks = this.voiceChunks
    this.voiceChunks = []
    const dur = durationMs(chunks)
    if (dur < 400) {
      this.voice = { ...this.voice, state: 'error', message: 'No audio captured. Hold the glasses mic close and try again.' }
      return this.emit()
    }
    this.voice = { ...this.voice, state: 'processing', transcript: undefined }
    this.emit()
    const wav = pcmToWav(chunks)
    this.voiceAbort = new AbortController()
    const resp = await this.askAssistant({ mode: 'voice', wavBase64: toBase64(wav), durationMs: Math.min(15_500, Math.max(200, dur)), signal: this.voiceAbort.signal })
    this.voiceAbort = null
    if (this.voice.state !== 'processing') return // cancelled meanwhile
    if (!resp) {
      this.voice = { ...this.voice, state: 'error', message: `Could not reach ${this.aiLabel()}. Nothing was transcribed. Try text chat.` }
      return this.emit()
    }
    const last = this.chatTurns[this.chatTurns.length - 1]
    const text = last?.line ? finalizeLine(last.line, this.policy, this.store.state.companion.id).text : resp.dialogue
    this.voice = { ...this.voice, state: 'result', transcript: resp.transcript ?? undefined, message: text }
    if (this.proposal?.status === 'pending') {
      // the confirmation screen is already shown by propose(); keep the voice result out of the back stack
      this.stack = this.stack.filter((s) => s.name !== 'voice')
    }
    this.emit()
  }

  async cancelVoice() {
    this.clearVoiceTimer()
    this.voiceAbort?.abort()
    this.voiceAbort = null
    this.voiceChunks = []
    await this.device?.stopMic()
    const wasActive = this.voice.state !== 'idle'
    this.voice = { state: 'idle', elapsedMs: 0, limitMs: VOICE_LIMIT_MS, level: 0 }
    if (wasActive && this.screen.name === 'voice') this.back()
    else this.emit()
  }

  // ------------------------------------------------------------------ settings
  async completeOnboarding(input: { name: string; avatar: SaveV1['player']['avatar']; companion: CompanionId; goal: string; quietHours: SaveV1['preferences']['quietHours']; activeHours: SaveV1['preferences']['activeHours'] }) {
    await this.store.mutate((s) => ({
      ...s,
      player: { ...s.player, name: input.name.trim().slice(0, 32), avatar: input.avatar },
      companion: { ...s.companion, id: input.companion },
      preferences: { ...s.preferences, onboarded: true, goal: input.goal.trim().slice(0, 160), quietHours: input.quietHours, activeHours: input.activeHours, timezone: this.tz },
    }))
    if (input.goal.trim() && this.store.state.memory.enabled) await this.addMemory('goal', input.goal)
    this.screen = { name: 'home' }
    this.stack = []
    const intro = pickLine(input.companion, 'intro', {}, this.policy)
    this.pushCompanionTurn(intro.line, 'local', intro.emotion)
    this.emit()
  }

  async setCompanion(id: CompanionId) {
    await this.store.mutate((s) => ({ ...s, companion: { ...s.companion, id } }))
    if (this.notice) this.notice = { ...this.notice, companionId: id, line: pickLine(id, 'intro', {}, this.policy).line, emotion: 'happy' }
    this.emit()
  }
  async setCompanionStyle(patch: Partial<SaveV1['companion']>) {
    await this.store.mutate((s) => ({ ...s, companion: { ...s.companion, ...patch, id: s.companion.id } }))
  }
  async updatePreferences(patch: Partial<SaveV1['preferences']>) {
    await this.store.mutate((s) => ({ ...s, preferences: { ...s.preferences, ...patch } }))
  }
  async updatePlayer(patch: Partial<Pick<SaveV1['player'], 'name' | 'avatar'>>) {
    await this.store.mutate((s) => ({ ...s, player: { ...s.player, ...patch } }))
  }

  /** ONLY reachable from the trusted local confirmation dialog (checkbox + button). */
  async enableAdultMode(attested: boolean) {
    if (!attested || this.adult.minorLock) return false
    // opting in means the real thing — Full 18+ (the user can step down to Strong)
    const next: AdultSettings = { ...this.adult, adultLanguageEnabled: true, attestedAt: Date.now(), profanityLevel: 'uncensored', policyRevision: this.adult.policyRevision + 1 }
    this.adult = next
    await this.adultRepo.write(next)
    this.emit()
    return true
  }

  /** Immediate, no restart: revision bump invalidates queued, displayed and in-flight explicit text. */
  async disableAdultMode() {
    this.adult = { ...this.adult, adultLanguageEnabled: false, profanityLevel: this.adult.profanityLevel === 'mild' ? 'mild' : 'none', policyRevision: this.adult.policyRevision + 1 }
    this.emit() // re-render first: displayed explicit text is replaced right now
    await this.adultRepo.write(this.adult)
    this.toast('18+ Language Mode is off. All companions are clean.')
    this.emit()
  }

  async setProfanityLevel(level: ProfanityLevel) {
    if ((level === 'strong' || level === 'uncensored') && !this.policy.adultEnabled) return
    this.adult = { ...this.adult, profanityLevel: level, policyRevision: this.adult.policyRevision + 1 }
    await this.adultRepo.write(this.adult)
    this.emit()
  }

  async declareUnder18() {
    this.adult = { ...this.adult, adultLanguageEnabled: false, profanityLevel: 'none', attestedAt: null, minorLock: true, policyRevision: this.adult.policyRevision + 1 }
    await this.adultRepo.write(this.adult)
    this.emit()
  }

  async resetAll() {
    await this.cancelVoice()
    if (this.liveCalendar) await this.liveCalendar.disconnect()
    const repo = new SaveRepository(this.device.kv, this.mode === 'demo' ? DEMO_SAVE_KEY : SAVE_KEY)
    await repo.clear()
    await this.adultRepo.clear()
    this.adult = AdultSettingsSchema.parse({})
    await this.loadSave()
    this.screen = this.store.state.preferences.onboarded ? { name: 'home' } : { name: 'setup' }
    this.stack = []
    this.pendingMemory = []
    this.toast('All local Questling data deleted')
    this.emit()
  }

  async setMode(mode: Mode) {
    if (mode === this.mode) return
    await this.cancelVoice()
    await this.store.flush()
    this.mode = mode
    await this.device.kv.set(MODE_KEY, mode)
    await this.loadSave()
    this.screen = this.store.state.preferences.onboarded ? { name: 'home' } : { name: 'setup' }
    this.stack = []
    this.emit()
    if (mode === 'demo') await this.refreshCalendar()
    this.runEngine('app_opened')
  }

  // ------------------------------------------------------------------ demo controls (demo namespace only)
  async demo(action: 'overdue' | 'meeting' | 'complete' | 'levelup' | 'compare' | 'reset' | 'advance15' | 'boss') {
    if (this.mode !== 'demo') return
    const now = this.now()
    const clearReminders = (keys: (k: string) => boolean) =>
      this.store.mutate((s) => ({ ...s, reminders: { ...s.reminders, lastUnsolicitedAt: null, nudgesToday: 0, mutedUntil: null, records: Object.fromEntries(Object.entries(s.reminders.records).filter(([k]) => !keys(k))) } }))
    if (this.notice) this.closeNotice(null)
    switch (action) {
      case 'reset':
        await new SaveRepository(this.device.kv, DEMO_SAVE_KEY).clear()
        await this.loadSave()
        this.screen = { name: 'home' }
        this.stack = []
        await this.refreshCalendar()
        this.runEngine('app_opened')
        return
      case 'advance15':
        this.demoOffset += 15 * 60_000
        this.runEngine('tick')
        return this.emit()
      case 'overdue': {
        const q = this.store.state.quests.find((x) => isOpen(x) && x.deadline && x.deadline.at < now) ?? this.store.state.quests.find(isOpen)
        if (q && !(q.deadline && q.deadline.at < now)) await this.store.dispatch({ type: 'quest/edit', id: q.id, patch: { deadline: { at: now - 30 * 60_000, tz: this.tz } } }, now, this.tz)
        await clearReminders((k) => k.startsWith('overdue') || k.startsWith('briefing'))
        await this.store.mutate((s) => ({ ...s, reminders: { ...s.reminders, lastBriefingDay: dayKey(now, this.tz) } }))
        return this.runEngine('tick')
      }
      case 'meeting': {
        this.calendar = new DemoCalendar(demoEvents(now - 60_000))
        await this.refreshCalendar()
        await clearReminders((k) => k.startsWith('meeting'))
        return this.runEngine('tick')
      }
      case 'complete': {
        const q = this.store.state.quests.find((x) => isOpen(x) && /presentation/i.test(x.title)) ?? prioritizedQuests(this.store.state, now)[0]
        if (q) await this.questCommand({ type: 'quest/complete', id: q.id, method: 'self_reported' })
        return
      }
      case 'levelup': {
        const before = this.store.state.player.totalXp
        for (let i = 0; i < 3; i++) {
          const r = await this.store.dispatch({ type: 'quest/create', input: { title: `Demo milestone ${i + 1}`, category: 'work', difficulty: 'hard', estimatedMinutes: 45, skill: 'DIS', source: 'demo' } }, now, this.tz)
          const q = r.save.quests[r.save.quests.length - 1]!
          const c = await this.store.dispatch({ type: 'quest/complete', id: q.id, method: 'self_reported' }, now, this.tz)
          if (c.events.some((e) => e.type === 'LEVEL_UP')) break
        }
        if (this.store.state.player.totalXp === before) this.toast('Could not level up', 'warn')
        return
      }
      case 'compare': {
        const order: CompanionId[] = ['grumpy', 'commander', 'optimist', 'sage', 'savage']
        const nextId = order[(order.indexOf(this.store.state.companion.id) + 1) % order.length]!
        await this.store.mutate((s) => ({ ...s, companion: { ...s.companion, id: nextId } }))
        const q = this.store.state.quests.find((x) => isOpen(x) && x.deadline && x.deadline.at < now) ?? prioritizedQuests(this.store.state, now)[0]
        if (q) {
          const n = noticeFromCandidate({ key: `compare:${now}`, type: 'QUEST_OVERDUE', critical: false, priority: 50, countsAsNudge: false, quest: { id: q.id, title: q.title, estimatedMinutes: q.estimatedMinutes, postponeCount: q.postponeCount } }, nextId, this.policy, { now, tz: this.tz })
          this.showNotice({ ...n, solicited: true, react: true })
        }
        return
      }
      case 'boss':
        return
    }
  }

  // ------------------------------------------------------------------ toasts
  toast(text: string, tone: Toast['tone'] = 'info') {
    const t = { id: newId('evt'), text, tone }
    this.toasts = [...this.toasts, t].slice(-3)
    this.emit()
    setTimeout(() => {
      this.toasts = this.toasts.filter((x) => x.id !== t.id)
      this.emit()
    }, 3500)
  }

  /** Mobile UI helpers */
  openGlassesScreen(s: GlassesScreen) {
    this.nav(s)
  }
  dismissNotice() {
    this.closeNotice('dismiss')
    if (this.screen.name === 'companion') this.back()
    else this.emit()
  }
  previewLine(companion: CompanionId, ev: Parameters<typeof pickLine>[1], vars: Parameters<typeof pickLine>[2], cleanOnly = true) {
    const pol = cleanOnly ? { ...this.policy, adultEnabled: false, profanityLevel: 'none' as const } : this.policy
    return pickLine(companion, ev, vars, pol, { seed: 'preview' })
  }
  finalize(line: Line, companion: CompanionId) {
    return finalizeLine(line, this.policy, companion)
  }
  async bossCreate(goal: string, skin: 'procrastinator' | 'deadline_beast' | 'mountain', milestones: string[]) {
    const ms = milestones.map((t) => ({ title: t, category: 'boss' as const, difficulty: 'major' as const, estimatedMinutes: 60, skill: 'DIS' as const }))
    return this.questCommand({ type: 'boss/create', goal, skin, milestones: ms })
  }
}

export const app = new App()
