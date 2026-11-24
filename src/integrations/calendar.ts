import { CalendarEventSchema, type CalendarEvent } from '../shared/calendar'
import { ApiError, type ApiClient } from '../ai/api'
import { z } from 'zod'

export type CalendarStatus =
  | { state: 'disconnected' }
  | { state: 'not_configured' }
  | { state: 'linking'; userCode: string; linkUrl: string; expiresAt: number }
  | { state: 'connected'; expiresAt: number; scope: string }
  | { state: 'expired' }
  | { state: 'permission_missing' }
  | { state: 'unavailable'; reason: string }
  | { state: 'demo' }

export interface ProviderResult {
  event: CalendarEvent
  verified: true
  reconciled: boolean
}

export interface CalendarService {
  readonly mode: 'live' | 'demo'
  status(): CalendarStatus
  listEvents(from: number, to: number): Promise<CalendarEvent[]>
  createEvent(input: { proposalId: string; title: string; start: number; end: number; timeZone: string }): Promise<ProviderResult>
  updateEvent(input: { proposalId: string; eventId: string; expectedEtag?: string; start: number; end: number; timeZone: string }): Promise<ProviderResult>
  disconnect(): Promise<{ revoked: boolean }>
}

const ListResp = z.object({ events: z.array(CalendarEventSchema), fetchedAt: z.number() })
const WriteResp = z.object({ event: CalendarEventSchema, verified: z.literal(true), reconciled: z.boolean() })

/**
 * Live Google Calendar via the Questling proxy. The session handle is held in
 * memory only (never in storage or the save) — reload means re-link.
 */
export class LiveCalendar implements CalendarService {
  readonly mode = 'live' as const
  private handle: string | null = null
  private st: CalendarStatus = { state: 'disconnected' }
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  onChange: (() => void) | null = null

  constructor(private api: ApiClient) {}

  status(): CalendarStatus {
    if (this.st.state === 'connected' && this.st.expiresAt < Date.now()) {
      this.handle = null
      this.st = { state: 'expired' }
    }
    return this.st
  }

  private set(s: CalendarStatus) {
    this.st = s
    this.onChange?.()
  }

  async beginLink(): Promise<CalendarStatus> {
    this.cancelLink()
    try {
      const r = await this.api.call<{ linkId: string; pollSecret: string; userCode: string; linkUrl: string; expiresAt: number }>('/api/calendar/link/start', { body: {} })
      this.set({ state: 'linking', userCode: r.userCode, linkUrl: r.linkUrl, expiresAt: r.expiresAt })
      this.poll(r.linkId, r.pollSecret, r.expiresAt)
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'unavailable'
      this.set(code === 'calendar_not_configured' ? { state: 'not_configured' } : { state: 'unavailable', reason: code })
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
        const r = await this.api.call<{ status: string; sessionHandle?: string; expiresAt?: number; scope?: string }>('/api/calendar/link/poll', { body: { linkId, pollSecret }, timeoutMs: 8000 })
        if (r.status === 'connected' && r.sessionHandle) {
          this.handle = r.sessionHandle
          return this.set({ state: 'connected', expiresAt: r.expiresAt!, scope: r.scope ?? '' })
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
    if (!this.handle) throw new ApiError(401, 'calendar_not_connected')
    return { 'x-lq-calendar': this.handle }
  }

  private handleError(e: unknown): never {
    if (e instanceof ApiError) {
      if (e.code === 'calendar_session_expired' || e.code === 'calendar_not_connected') {
        this.handle = null
        this.set({ state: 'expired' })
      } else if (e.code === 'calendar_permission_missing') this.set({ state: 'permission_missing' })
    }
    throw e
  }

  async listEvents(from: number, to: number): Promise<CalendarEvent[]> {
    try {
      const r = await this.api.call<unknown>(`/api/calendar/events?from=${from}&to=${to}`, { headers: this.headers() })
      const p = ListResp.safeParse(r)
      if (!p.success) throw new ApiError(502, 'malformed_response')
      return p.data.events
    } catch (e) {
      return this.handleError(e)
    }
  }

  async createEvent(input: { proposalId: string; title: string; start: number; end: number; timeZone: string }): Promise<ProviderResult> {
    try {
      const r = WriteResp.safeParse(await this.api.call<unknown>('/api/calendar/events', { body: input, headers: this.headers(), timeoutMs: 25_000 }))
      if (!r.success) throw new ApiError(502, 'unverified_result')
      return r.data
    } catch (e) {
      return this.handleError(e)
    }
  }

  async updateEvent(input: { proposalId: string; eventId: string; expectedEtag?: string; start: number; end: number; timeZone: string }): Promise<ProviderResult> {
    try {
      const r = WriteResp.safeParse(await this.api.call<unknown>('/api/calendar/events', { method: 'PATCH', body: input, headers: this.headers(), timeoutMs: 25_000 }))
      if (!r.success) throw new ApiError(502, 'unverified_result')
      return r.data
    } catch (e) {
      return this.handleError(e)
    }
  }

  async disconnect() {
    this.cancelLink()
    let revoked = false
    if (this.handle) {
      try {
        revoked = (await this.api.call<{ revoked: boolean }>('/api/calendar/disconnect', { body: {}, headers: this.headers() })).revoked
      } catch {
        revoked = false
      }
    }
    this.handle = null
    this.set({ state: 'disconnected' })
    return { revoked }
  }
}

/**
 * Synthetic calendar for demo mode. Clearly labelled "Demo calendar (synthetic)";
 * never touches a live provider. Writes are local to this in-memory fixture.
 */
export class DemoCalendar implements CalendarService {
  readonly mode = 'demo' as const
  private events: CalendarEvent[]
  private writes = new Map<string, CalendarEvent>()
  constructor(seed: CalendarEvent[]) {
    this.events = seed.map((e) => ({ ...e }))
  }
  status(): CalendarStatus {
    return { state: 'demo' }
  }
  async listEvents(from: number, to: number) {
    return this.events.filter((e) => e.end > from && e.start < to).map((e) => ({ ...e }))
  }
  async createEvent(input: { proposalId: string; title: string; start: number; end: number; timeZone: string }): Promise<ProviderResult> {
    const prior = this.writes.get(input.proposalId)
    if (prior) return { event: prior, verified: true, reconciled: true }
    await new Promise((r) => setTimeout(r, 350))
    const ev: CalendarEvent = { id: `demo_${input.proposalId.slice(5)}`, calendarId: 'demo', title: input.title, start: input.start, end: input.end, allDay: false, status: 'confirmed', transparent: false, timeZone: input.timeZone, createdByQuestling: true, etag: '"1"' }
    this.events.push(ev)
    this.writes.set(input.proposalId, ev)
    return { event: ev, verified: true, reconciled: false }
  }
  async updateEvent(input: { proposalId: string; eventId: string; expectedEtag?: string; start: number; end: number; timeZone: string }): Promise<ProviderResult> {
    const prior = this.writes.get(input.proposalId)
    if (prior) return { event: prior, verified: true, reconciled: true }
    const ev = this.events.find((e) => e.id === input.eventId)
    if (!ev) throw new ApiError(404, 'event_not_found')
    if (input.expectedEtag && ev.etag !== input.expectedEtag) throw new ApiError(409, 'event_changed_since_proposal')
    ev.start = input.start
    ev.end = input.end
    ev.etag = `"${Number((ev.etag ?? '"1"').replace(/"/g, '')) + 1}"`
    this.writes.set(input.proposalId, { ...ev })
    return { event: { ...ev }, verified: true, reconciled: false }
  }
  async disconnect() {
    return { revoked: false }
  }
}
