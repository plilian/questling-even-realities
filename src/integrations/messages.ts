import { z } from 'zod'
import { ApiError, type ApiClient } from '../ai/api'
import { CaptureSchema, InboxItemSchema, MESSAGE_PROVIDER_LABELS, type Capture, type InboxItem, type MessageProviderId } from '../shared/messages'
import { DigestChannelSchema, type DigestChannel } from '../shared/notes'
import type { TaskLinkState } from './tasks'

export type InboxLinkState = TaskLinkState

export interface InboxResult {
  items: InboxItem[]
  label: string
  canReply: boolean
  fetchedAt: number
  /** Telegram “/quest …” notes sent to the user's own bot */
  captures?: Capture[]
}

export interface InboxService {
  readonly provider: MessageProviderId
  readonly mode: 'live' | 'demo'
  status(): InboxLinkState
  connected(): boolean
  beginLink(): Promise<InboxLinkState>
  cancelLink(): void
  list(ack?: string[]): Promise<InboxResult>
  reply(input: { proposalId: string; messageId: string; body: string }): Promise<{ to: string; reconciled: boolean }>
  /** GitHub: mark a notification read (verified by the server) */
  markRead?(input: { proposalId: string; messageId: string }): Promise<{ reconciled: boolean }>
  /** Telegram: recent posts of the channels and groups your bot can read */
  digest?(): Promise<DigestChannel[]>
  disconnect(): Promise<{ revoked: boolean }>
  onChange: (() => void) | null
}

const ListResp = z.object({ items: z.array(InboxItemSchema), label: z.string(), canReply: z.boolean(), fetchedAt: z.number(), captures: z.array(CaptureSchema).max(20).optional() })
const DigestResp = z.object({ channels: z.array(DigestChannelSchema).max(20), fetchedAt: z.number() })
const ReplyResp = z.object({ verified: z.literal(true), reconciled: z.boolean(), sent: z.object({ id: z.string(), to: z.string(), at: z.number() }) })

/** Gmail / Slack through the Questling proxy. The session handle lives in memory only. */
export class LiveInbox implements InboxService {
  readonly mode = 'live' as const
  private handle: string | null = null
  private st: InboxLinkState = { state: 'disconnected' }
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  onChange: (() => void) | null = null

  constructor(
    readonly provider: MessageProviderId,
    private api: ApiClient,
  ) {}

  status(): InboxLinkState {
    if (this.st.state === 'connected' && this.st.expiresAt < Date.now()) {
      this.handle = null
      this.st = { state: 'expired' }
    }
    return this.st
  }
  connected() {
    return this.status().state === 'connected'
  }
  private set(s: InboxLinkState) {
    this.st = s
    this.onChange?.()
  }

  async beginLink(): Promise<InboxLinkState> {
    this.cancelLink()
    try {
      const r = await this.api.call<{ linkId: string; pollSecret: string; userCode: string; linkUrl: string; expiresAt: number }>('/api/connect/start', { body: { provider: this.provider } })
      this.set({ state: 'linking', userCode: r.userCode, linkUrl: r.linkUrl, expiresAt: r.expiresAt })
      const tick = async () => {
        if (Date.now() > r.expiresAt) return this.set({ state: 'disconnected' })
        try {
          const p = await this.api.call<{ status: string; sessionHandle?: string; expiresAt?: number; label?: string }>('/api/connect/poll', { body: { linkId: r.linkId, pollSecret: r.pollSecret }, timeoutMs: 8000 })
          if (p.status === 'connected' && p.sessionHandle) {
            this.handle = p.sessionHandle
            return this.set({ state: 'connected', expiresAt: p.expiresAt!, label: p.label ?? MESSAGE_PROVIDER_LABELS[this.provider] })
          }
          if (p.status === 'denied') return this.set({ state: 'permission_missing' })
          if (p.status === 'expired') return this.set({ state: 'disconnected' })
        } catch {
          /* transient — keep polling until expiry */
        }
        this.pollTimer = setTimeout(tick, 2500)
      }
      this.pollTimer = setTimeout(tick, 2000)
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

  private headers() {
    if (!this.handle) throw new ApiError(401, 'tasks_not_connected')
    return { 'x-lq-link': this.handle }
  }
  private fail(e: unknown): never {
    if (e instanceof ApiError) {
      if (e.code === 'tasks_session_expired' || e.code === 'tasks_not_connected') {
        this.handle = null
        this.set({ state: 'expired' })
      } else if (e.code === 'tasks_permission_missing') this.set({ state: 'permission_missing' })
    }
    throw e
  }

  async list(ack: string[] = []): Promise<InboxResult> {
    try {
      const q = ack.length ? `?ack=${encodeURIComponent(ack.join(','))}` : ''
      const p = ListResp.safeParse(await this.api.call<unknown>(`/api/messages${q}`, { headers: this.headers(), timeoutMs: 20_000 }))
      if (!p.success) throw new ApiError(502, 'malformed_response')
      return p.data
    } catch (e) {
      return this.fail(e)
    }
  }

  async reply(input: { proposalId: string; messageId: string; body: string }) {
    try {
      const p = ReplyResp.safeParse(await this.api.call<unknown>('/api/messages/reply', { body: input, headers: this.headers(), timeoutMs: 25_000 }))
      if (!p.success) throw new ApiError(502, 'unverified_result')
      return { to: p.data.sent.to, reconciled: p.data.reconciled }
    } catch (e) {
      return this.fail(e)
    }
  }

  async digest(): Promise<DigestChannel[]> {
    if (this.provider !== 'telegram') throw new ApiError(400, 'digest_needs_telegram')
    try {
      const p = DigestResp.safeParse(await this.api.call<unknown>('/api/messages/digest', { headers: this.headers(), timeoutMs: 20_000 }))
      if (!p.success) throw new ApiError(502, 'malformed_response')
      return p.data.channels
    } catch (e) {
      return this.fail(e)
    }
  }

  async markRead(input: { proposalId: string; messageId: string }) {
    try {
      const p = z.object({ verified: z.literal(true), reconciled: z.boolean() }).safeParse(await this.api.call<unknown>('/api/messages/read', { body: input, headers: this.headers(), timeoutMs: 20_000 }))
      if (!p.success) throw new ApiError(502, 'unverified_result')
      return { reconciled: p.data.reconciled }
    } catch (e) {
      return this.fail(e)
    }
  }

  async disconnect(): Promise<{ revoked: boolean }> {
    this.cancelLink()
    const h = this.handle
    this.handle = null
    this.set({ state: 'disconnected' })
    if (!h) return { revoked: false }
    try {
      return await this.api.call<{ revoked: boolean }>('/api/connect/disconnect', { body: {}, headers: { 'x-lq-link': h } })
    } catch {
      return { revoked: false }
    }
  }
}

/** SYNTHETIC demo inbox, clearly labelled as demo in the UI. Nothing is sent anywhere. */
export class DemoInbox implements InboxService {
  readonly mode = 'demo' as const
  private items: InboxItem[]
  private captures: Capture[] = []
  private linked = false
  private born: number
  sent: Array<{ messageId: string; body: string }> = []
  onChange: (() => void) | null = null

  constructor(
    readonly provider: MessageProviderId,
    now: number,
  ) {
    this.born = now
    const min = 60_000
    // demo: one note sent to your own bot from another device (“/quest Call the bank about the card”)
    if (provider === 'telegram') this.captures = [{ id: '5550009:7', text: 'Call the bank about the new card', from: 'You (via @your_bot)', at: now - 25 * min }]
    this.items =
      provider === 'gmail'
        ? [
            { id: 'demo-g1', provider, from: 'Sam Lee', title: 'Budget review — numbers by 3?', preview: '', where: 'Inbox', at: now - 6 * min, important: true, canReply: true },
            { id: 'demo-g2', provider, from: 'Skyways', title: 'Check-in is open for your Friday flight', preview: '', where: 'Inbox', at: now - 55 * min, important: false, canReply: true },
            { id: 'demo-g3', provider, from: 'Maya', title: 'Lunch on Friday?', preview: '', where: 'Inbox', at: now - 140 * min, important: false, canReply: true },
          ]
        : provider === 'github'
          ? [
              { id: '9000000001', provider, from: 'GitHub', title: 'Add billing export to the dashboard (#128)', preview: 'Review requested · Pull Request', where: 'acme/web', at: now - 12 * min, important: true, canReply: false },
              { id: '9000000002', provider, from: 'GitHub', title: 'Flaky checkout test on main', preview: 'Assigned to you · Issue', where: 'acme/api', at: now - 70 * min, important: true, canReply: false },
            ]
          : provider === 'telegram'
          ? [
              { id: '5550001:41', provider, from: 'Mira Hansen', title: 'Are we still on for the 1:1 at 12:30?', preview: 'Are we still on for the 1:1 at 12:30? I can do 1 instead if that’s easier.', where: 'Telegram', at: now - 4 * min, important: true, canReply: true },
              { id: '5550002:118', provider, from: 'Jonas', title: 'Can you approve the venue quote today?', preview: 'Can you approve the venue quote today? They hold the date until 6.', where: 'Telegram', at: now - 38 * min, important: true, canReply: true },
            ]
          : [
            { id: 'CDEMO:1700000000.000100', provider, from: 'Alex', title: 'Alex in #design', preview: '@you can you look at the deck before 3? Mostly the pricing slide.', where: '#design', at: now - 9 * min, important: true, canReply: true },
            { id: 'CDEMO:1700000000.000200', provider, from: 'Priya', title: 'Priya in #launch', preview: '@you the demo video link is in the doc — thumbs up if it works for you.', where: '#launch', at: now - 95 * min, important: true, canReply: true },
          ]
  }
  /** demo channel digest: SYNTHETIC channels and a group, labelled demo in the UI */
  async digest(): Promise<DigestChannel[]> {
    if (this.provider !== 'telegram') throw new ApiError(400, 'digest_needs_telegram')
    if (!this.linked) throw new ApiError(401, 'tasks_not_connected')
    const now = this.born
    const min = 60_000
    return [
      { id: '-1005550100', title: 'Even Realities News (demo)', kind: 'channel', posts: [
        { text: 'Even Hub SDK update: faster text upgrades and a new list style.', at: now - 50 * min },
        { text: 'Hackathon submissions close Sunday 23:59 Dubai time.', at: now - 3 * 60 * min },
      ] },
      { id: '-1005550200', title: 'Launch crew (demo)', kind: 'group', posts: [
        { text: 'Jonas: venue quote is in, they hold the date until 6.', at: now - 40 * min },
        { text: 'Priya: demo video link is in the doc.', at: now - 95 * min },
        { text: 'Mira: can we move the 1:1 to 1pm?', at: now - 120 * min },
      ] },
      { id: '-1005550300', title: 'Builders Weekly (demo)', kind: 'channel', posts: [
        { text: 'Three tips for glanceable UIs: one idea per screen, verbs first, no scrolling.', at: now - 5 * 60 * min },
      ] },
    ]
  }
  status(): InboxLinkState {
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
  async list(ack: string[] = []): Promise<InboxResult> {
    if (!this.linked) throw new ApiError(401, 'tasks_not_connected')
    this.captures = this.captures.filter((c) => !ack.includes(c.id))
    return { items: [...this.items], label: `${MESSAGE_PROVIDER_LABELS[this.provider]} · demo`, canReply: true, fetchedAt: Date.now(), ...(this.provider === 'telegram' ? { captures: [...this.captures] } : {}) }
  }
  async reply(input: { proposalId: string; messageId: string; body: string }) {
    const m = this.items.find((x) => x.id === input.messageId)
    if (!m) throw new ApiError(404, 'message_not_found')
    this.sent.push({ messageId: input.messageId, body: input.body })
    return { to: this.provider === 'slack' ? 'thread' : m.from, reconciled: false }
  }
  async markRead(input: { proposalId: string; messageId: string }) {
    const before = this.items.length
    this.items = this.items.filter((x) => x.id !== input.messageId)
    return { reconciled: before === this.items.length }
  }
  async disconnect() {
    this.linked = false
    this.onChange?.()
    return { revoked: false }
  }
}
