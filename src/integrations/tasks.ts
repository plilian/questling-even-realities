import { z } from 'zod'
import { ApiError, type ApiClient } from '../ai/api'
import { ExternalTaskSchema, TASK_PROVIDER_LABELS, TaskSourceSchema, type ExternalTask, type TaskProviderId, type TaskSource } from '../shared/tasks'
import { NOTES_QUESTION_MAX, NoteHitSchema, excerpt, keywords, matchScore, type NoteHit } from '../shared/notes'

export type TaskLinkState =
  | { state: 'disconnected' }
  | { state: 'not_configured' }
  | { state: 'linking'; userCode: string; linkUrl: string; expiresAt: number }
  | { state: 'connected'; expiresAt: number; label: string }
  | { state: 'expired' }
  | { state: 'permission_missing' }
  | { state: 'unavailable'; reason: string }
  | { state: 'demo' }

export interface TaskListResult {
  tasks: ExternalTask[]
  sources: TaskSource[]
  selected: string | null
  label: string
  fetchedAt: number
}

export interface CompleteResult {
  task: ExternalTask
  reconciled: boolean
  note: string | null
}

export interface TaskService {
  readonly provider: TaskProviderId
  readonly mode: 'live' | 'demo'
  status(): TaskLinkState
  connected(): boolean
  beginLink(): Promise<TaskLinkState>
  cancelLink(): void
  list(sourceId?: string | null): Promise<TaskListResult>
  complete(input: { proposalId: string; taskId: string }): Promise<CompleteResult>
  /** Notion: pages shared with Questling that answer a question (title + short excerpt) */
  searchNotes?(q: string): Promise<NoteHit[]>
  disconnect(): Promise<{ revoked: boolean }>
  onChange: (() => void) | null
}

const ListResp = z.object({ tasks: z.array(ExternalTaskSchema), sources: z.array(TaskSourceSchema).default([]), selected: z.string().nullable().default(null), label: z.string(), fetchedAt: z.number() })
const CompleteResp = z.object({ task: ExternalTaskSchema, verified: z.literal(true), reconciled: z.boolean(), note: z.string().nullable().default(null) })

/**
 * Live task provider through the Questling proxy. Like Calendar, the session handle lives in
 * memory only (never in storage, the save or an export) — a reload means linking again.
 */
export class LiveTasks implements TaskService {
  readonly mode = 'live' as const
  private handle: string | null = null
  private st: TaskLinkState = { state: 'disconnected' }
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  onChange: (() => void) | null = null

  constructor(
    readonly provider: TaskProviderId,
    private api: ApiClient,
  ) {}

  status(): TaskLinkState {
    if (this.st.state === 'connected' && this.st.expiresAt < Date.now()) {
      this.handle = null
      this.st = { state: 'expired' }
    }
    return this.st
  }
  connected() {
    return this.status().state === 'connected'
  }

  private set(s: TaskLinkState) {
    this.st = s
    this.onChange?.()
  }

  async beginLink(): Promise<TaskLinkState> {
    this.cancelLink()
    try {
      const r = await this.api.call<{ linkId: string; pollSecret: string; userCode: string; linkUrl: string; expiresAt: number }>('/api/tasks/link/start', { body: { provider: this.provider } })
      this.set({ state: 'linking', userCode: r.userCode, linkUrl: r.linkUrl, expiresAt: r.expiresAt })
      this.poll(r.linkId, r.pollSecret, r.expiresAt)
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'unavailable'
      this.set(code === 'integration_not_configured' ? { state: 'not_configured' } : { state: 'unavailable', reason: code })
    }
    return this.st
  }

  cancelLink() {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
    if (this.st.state === 'linking') this.set({ state: 'disconnected' })
  }

  private poll(linkId: string, pollSecret: string, expiresAt: number) {
    const tick = async () => {
      if (Date.now() > expiresAt) return this.set({ state: 'disconnected' })
      try {
        const r = await this.api.call<{ status: string; sessionHandle?: string; expiresAt?: number; label?: string }>('/api/tasks/link/poll', { body: { linkId, pollSecret }, timeoutMs: 8000 })
        if (r.status === 'connected' && r.sessionHandle) {
          this.handle = r.sessionHandle
          return this.set({ state: 'connected', expiresAt: r.expiresAt!, label: r.label ?? TASK_PROVIDER_LABELS[this.provider] })
        }
        if (r.status === 'denied') return this.set({ state: 'permission_missing' })
        if (r.status === 'expired') return this.set({ state: 'disconnected' })
      } catch {
        /* transient — keep polling until expiry */
      }
      this.pollTimer = setTimeout(tick, 2500)
    }
    this.pollTimer = setTimeout(tick, 2000)
  }

  private headers() {
    if (!this.handle) throw new ApiError(401, 'tasks_not_connected')
    return { 'x-lq-tasks': this.handle }
  }

  private handleError(e: unknown): never {
    if (e instanceof ApiError) {
      if (e.code === 'tasks_session_expired' || e.code === 'tasks_not_connected') {
        this.handle = null
        this.set({ state: 'expired' })
      } else if (e.code === 'tasks_permission_missing') this.set({ state: 'permission_missing' })
    }
    throw e
  }

  async list(sourceId?: string | null): Promise<TaskListResult> {
    try {
      const q = sourceId ? `?source=${encodeURIComponent(sourceId)}` : ''
      const p = ListResp.safeParse(await this.api.call<unknown>(`/api/tasks${q}`, { headers: this.headers(), timeoutMs: 20_000 }))
      if (!p.success) throw new ApiError(502, 'malformed_response')
      return p.data
    } catch (e) {
      return this.handleError(e)
    }
  }

  async searchNotes(q: string): Promise<NoteHit[]> {
    if (this.provider !== 'notion') throw new ApiError(400, 'notes_need_notion')
    try {
      const p = z.object({ notes: z.array(NoteHitSchema).max(3) }).safeParse(await this.api.call<unknown>('/api/notes/search', { body: { q: q.slice(0, NOTES_QUESTION_MAX) }, headers: this.headers(), timeoutMs: 25_000 }))
      if (!p.success) throw new ApiError(502, 'malformed_response')
      return p.data.notes
    } catch (e) {
      return this.handleError(e)
    }
  }

  async complete(input: { proposalId: string; taskId: string }): Promise<CompleteResult> {
    try {
      const r = CompleteResp.safeParse(await this.api.call<unknown>('/api/tasks/complete', { body: input, headers: this.headers(), timeoutMs: 25_000 }))
      if (!r.success) throw new ApiError(502, 'unverified_result')
      return r.data
    } catch (e) {
      return this.handleError(e)
    }
  }

  async disconnect(): Promise<{ revoked: boolean }> {
    this.cancelLink()
    const h = this.handle
    this.handle = null
    this.set({ state: 'disconnected' })
    if (!h) return { revoked: false }
    try {
      return await this.api.call<{ revoked: boolean }>('/api/tasks/disconnect', { body: {}, headers: { 'x-lq-tasks': h } })
    } catch {
      return { revoked: false }
    }
  }
}

/**
 * Demo task sources: SYNTHETIC tasks, clearly labelled as demo in the UI.
 * Never presented as a live Todoist/Notion/Google account.
 */
export class DemoTasks implements TaskService {
  readonly mode = 'demo' as const
  private tasks: ExternalTask[]
  private linked = false
  private born: number
  onChange: (() => void) | null = null

  constructor(
    readonly provider: TaskProviderId,
    now: number,
  ) {
    this.born = now
    const day = 86400_000
    const seeds: Record<TaskProviderId, Array<[string, number | null]>> = {
      todoist: [
        ['Pay the electricity bill', now + day],
        ['Book a dentist appointment', now + 3 * day],
        ['Return the library books', null],
      ],
      notion: [
        ['Draft the hackathon write-up', now + day],
        ['Record a 90-second demo', now + 2 * day],
      ],
      google_tasks: [
        ['Renew passport photos', now + 4 * day],
        ['Call grandma', null],
      ],
    }
    this.tasks = seeds[provider].map(([title, due], i) => ({ id: `demo-${provider}-${i + 1}`, title, due, dueAllDay: due !== null, done: false, recurring: false, list: provider === 'notion' ? 'Demo tasks' : undefined }))
  }
  status(): TaskLinkState {
    return this.linked ? { state: 'demo' } : { state: 'disconnected' }
  }
  connected() {
    return this.linked
  }
  async beginLink() {
    this.linked = true
    this.onChange?.()
    return this.status()
  }
  cancelLink() {}
  /** demo notes: SYNTHETIC Notion pages, ranked the same way the server ranks real ones */
  async searchNotes(q: string): Promise<NoteHit[]> {
    if (this.provider !== 'notion') throw new ApiError(400, 'notes_need_notion')
    if (!this.linked) throw new ApiError(401, 'tasks_not_connected')
    const kws = keywords(q)
    const pages: Array<{ id: string; title: string; lines: string[]; edited: number }> = [
      { id: 'demo-note-1', title: 'Design review prep (demo)', edited: this.born - 3 * 3600_000, lines: ['# Design review with Alex', '- Pricing slide: show two plans, not four', '- Alex asked for the onboarding numbers', '[ ] Bring the new glasses mockups'] },
      { id: 'demo-note-2', title: 'Pricing decisions (demo)', edited: this.born - 26 * 3600_000, lines: ['Decided on Monday: Plus costs $5 per month, $48 per year.', 'The free tier keeps local quests and one integration.', 'Team plan later, after the pilot.'] },
      { id: 'demo-note-3', title: 'Hackathon checklist (demo)', edited: this.born - 50 * 3600_000, lines: ['[x] Public repo with setup steps', '[ ] Demo video under 3 minutes', '[ ] Submit before Sunday 23:59 Dubai time'] },
    ]
    const scored = pages.map((p) => ({ p, score: matchScore(p.title, p.lines.join('\n'), kws) }))
    const hits = kws.length ? scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score) : scored
    return hits.slice(0, 3).map((x) => ({ id: x.p.id, title: x.p.title, text: excerpt(x.p.lines, kws, 1200), editedAt: x.p.edited }))
  }
  async list(): Promise<TaskListResult> {
    if (!this.linked) throw new ApiError(401, 'tasks_not_connected')
    return { tasks: this.tasks.filter((t) => !t.done), sources: [], selected: null, label: `${TASK_PROVIDER_LABELS[this.provider]} · demo`, fetchedAt: Date.now() }
  }
  async complete(input: { proposalId: string; taskId: string }): Promise<CompleteResult> {
    const t = this.tasks.find((x) => x.id === input.taskId)
    if (!t) throw new ApiError(404, 'task_not_found')
    t.done = true
    return { task: { ...t }, reconciled: false, note: null }
  }
  async disconnect() {
    this.linked = false
    this.onChange?.()
    return { revoked: false }
  }
}
