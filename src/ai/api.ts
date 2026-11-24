import type { AiProviderId } from '../shared/ai'

/** Thin client for the Questling stateless API. Access token is held in memory only. */

const BASE = (import.meta.env?.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? ''

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code)
  }
}

export interface ProviderInfo {
  id: AiProviderId
  model: string
  /** native: understands voice itself; routed: voice is answered by another configured provider; none: no voice */
  voice: 'native' | 'routed' | 'none'
}

export interface ServerStatus {
  reachable: boolean
  ai: { configured: boolean; model: string | null; default: AiProviderId | null; providers: ProviderInfo[] }
  calendar: { configured: boolean }
  tasks: { todoist: boolean; notion: boolean; google_tasks: boolean }
  messages: { gmail: boolean; slack: boolean; telegram: boolean; github: boolean }
  access: { codeRequired: boolean }
}

export const OFFLINE_STATUS: ServerStatus = {
  reachable: false,
  ai: { configured: false, model: null, default: null, providers: [] },
  calendar: { configured: false },
  tasks: { todoist: false, notion: false, google_tasks: false },
  messages: { gmail: false, slack: false, telegram: false, github: false },
  access: { codeRequired: false },
}

export class ApiClient {
  private token: { value: string; expiresAt: number } | null = null
  accessCode: string | null = null

  constructor(private base = BASE) {}

  async status(): Promise<ServerStatus> {
    try {
      const r = await fetch(`${this.base}/api/status`, { signal: AbortSignal.timeout(5000) })
      if (!r.ok) throw new Error()
      const b = await r.json()
      // tolerate an older server that predates multi-provider / task fields
      const ai = { ...OFFLINE_STATUS.ai, ...b.ai }
      if (ai.configured && !ai.providers.length && ai.model) ai.providers = [{ id: 'gemini', model: ai.model, voice: 'native' }]
      if (ai.configured && !ai.default) ai.default = ai.providers[0]?.id ?? 'gemini'
      return { reachable: true, ai, calendar: b.calendar ?? OFFLINE_STATUS.calendar, tasks: { ...OFFLINE_STATUS.tasks, ...b.tasks }, messages: { ...OFFLINE_STATUS.messages, ...b.messages }, access: b.access ?? OFFLINE_STATUS.access }
    } catch {
      return OFFLINE_STATUS
    }
  }

  hasSession() {
    return !!this.token && this.token.expiresAt > Date.now() + 30_000
  }

  async ensureSession(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value
    const r = await fetch(`${this.base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(this.accessCode ? { accessCode: this.accessCode } : {}),
      signal: AbortSignal.timeout(8000),
    }).catch(() => null)
    if (!r) throw new ApiError(0, 'offline')
    const b = await r.json().catch(() => ({}))
    if (!r.ok) throw new ApiError(r.status, b.error ?? 'session_failed')
    this.token = { value: b.token, expiresAt: b.expiresAt }
    return b.token
  }

  clearSession() {
    this.token = null
  }

  async call<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const token = await this.ensureSession()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 20_000)
    init.signal?.addEventListener('abort', () => ctrl.abort())
    let r: Response
    try {
      r = await fetch(`${this.base}${path}`, {
        method: init.method ?? (init.body ? 'POST' : 'GET'),
        headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: ctrl.signal,
      })
    } catch {
      throw new ApiError(0, ctrl.signal.aborted ? 'timeout' : 'offline')
    } finally {
      clearTimeout(timer)
    }
    const b = await r.json().catch(() => ({ ok: false, error: 'malformed_response' }))
    if (r.status === 401 && b.error === 'access_token_required') this.token = null
    if (!r.ok || !b.ok) throw new ApiError(r.status, b.error ?? 'request_failed')
    return b as T
  }
}

export const api = new ApiClient()
