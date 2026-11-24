import { randomBytes } from 'node:crypto'
import { AI_PROVIDER_IDS, type AiProviderId } from '../src/shared/ai'

/** Server configuration from environment. Secrets are read here only and never logged or returned. */
export interface ServerConfig {
  port: number
  production: boolean
  appBaseUrl: string
  allowedOrigins: string[]
  geminiApiKey: string | null
  geminiModel: string
  /** Optional extra AI providers. Each is enabled only when its key/model are set. */
  aiDefaultProvider: AiProviderId | null
  openai: { apiKey: string | null; model: string | null; baseUrl: string; transcribeModel: string }
  anthropic: { apiKey: string | null; model: string | null; baseUrl: string }
  openrouter: { apiKey: string | null; model: string | null; baseUrl: string }
  ollama: { model: string | null; baseUrl: string }
  /** Optional task integrations. OAuth client credentials live here only. */
  todoist: { clientId: string | null; clientSecret: string | null; authUrl: string; tokenUrl: string; apiBase: string }
  notion: { clientId: string | null; clientSecret: string | null; authUrl: string; apiBase: string; version: string }
  googleTasksEnabled: boolean
  googleTasksBase: string
  /** Mail & chat */
  gmailEnabled: boolean
  gmailBase: string
  slack: { clientId: string | null; clientSecret: string | null; authUrl: string; apiBase: string }
  telegram: { enabled: boolean; apiBase: string }
  github: { enabled: boolean; apiBase: string }
  googleClientId: string | null
  googleClientSecret: string | null
  googleRedirectUri: string
  accessCodes: string[]
  aiDailyBudget: number
  aiRatePerMinute: number
  /** HMAC key for short-lived access tokens; random per process unless provided */
  sessionSecret: Buffer
  google: {
    authUrl: string
    tokenUrl: string
    revokeUrl: string
    calendarBase: string
  }
}

let cached: ServerConfig | null = null

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === 'production'
  const appBaseUrl = (env.APP_BASE_URL || 'http://localhost:5173').replace(/\/$/, '')
  return {
    port: Number(env.PORT || 8787),
    production,
    appBaseUrl,
    allowedOrigins: list(env.ALLOWED_ORIGINS).length ? list(env.ALLOWED_ORIGINS) : [appBaseUrl],
    geminiApiKey: env.GEMINI_API_KEY?.trim() || null,
    geminiModel: env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash',
    aiDefaultProvider: (AI_PROVIDER_IDS as readonly string[]).includes(env.AI_DEFAULT_PROVIDER?.trim() ?? '') ? (env.AI_DEFAULT_PROVIDER!.trim() as AiProviderId) : null,
    openai: {
      apiKey: env.OPENAI_API_KEY?.trim() || null,
      model: env.OPENAI_MODEL?.trim() || null,
      baseUrl: (env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/$/, ''),
      transcribeModel: env.OPENAI_TRANSCRIBE_MODEL?.trim() || 'gpt-4o-transcribe',
    },
    anthropic: {
      apiKey: env.ANTHROPIC_API_KEY?.trim() || null,
      model: env.ANTHROPIC_MODEL?.trim() || null,
      baseUrl: (env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com').replace(/\/$/, ''),
    },
    openrouter: {
      apiKey: env.OPENROUTER_API_KEY?.trim() || null,
      model: env.OPENROUTER_MODEL?.trim() || null,
      baseUrl: (env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
    },
    ollama: {
      model: env.OLLAMA_MODEL?.trim() || null,
      baseUrl: (env.OLLAMA_BASE_URL?.trim() || 'http://127.0.0.1:11434').replace(/\/$/, ''),
    },
    todoist: {
      clientId: env.TODOIST_CLIENT_ID?.trim() || null,
      clientSecret: env.TODOIST_CLIENT_SECRET?.trim() || null,
      authUrl: env.TODOIST_AUTH_URL || 'https://todoist.com/oauth/authorize',
      tokenUrl: env.TODOIST_TOKEN_URL || 'https://todoist.com/oauth/access_token',
      apiBase: (env.TODOIST_API_BASE || 'https://api.todoist.com/api/v1').replace(/\/$/, ''),
    },
    notion: {
      clientId: env.NOTION_CLIENT_ID?.trim() || null,
      clientSecret: env.NOTION_CLIENT_SECRET?.trim() || null,
      authUrl: env.NOTION_AUTH_URL || 'https://api.notion.com/v1/oauth/authorize',
      apiBase: (env.NOTION_API_BASE || 'https://api.notion.com/v1').replace(/\/$/, ''),
      version: env.NOTION_VERSION?.trim() || '2025-09-03',
    },
    googleTasksEnabled: env.GOOGLE_TASKS_ENABLED !== 'false',
    googleTasksBase: (env.GOOGLE_TASKS_BASE || 'https://tasks.googleapis.com/tasks/v1').replace(/\/$/, ''),
    gmailEnabled: env.GMAIL_ENABLED !== 'false',
    gmailBase: (env.GMAIL_API_BASE || 'https://gmail.googleapis.com/gmail/v1').replace(/\/$/, ''),
    slack: {
      clientId: env.SLACK_CLIENT_ID?.trim() || null,
      clientSecret: env.SLACK_CLIENT_SECRET?.trim() || null,
      authUrl: env.SLACK_AUTH_URL || 'https://slack.com/oauth/v2/authorize',
      apiBase: (env.SLACK_API_BASE || 'https://slack.com/api').replace(/\/$/, ''),
    },
    github: {
      enabled: env.GITHUB_ENABLED !== 'false',
      apiBase: (env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/$/, ''),
    },
    telegram: {
      enabled: env.TELEGRAM_ENABLED !== 'false',
      apiBase: (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, ''),
    },
    googleClientId: env.GOOGLE_CLIENT_ID?.trim() || null,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET?.trim() || null,
    googleRedirectUri: env.GOOGLE_REDIRECT_URI?.trim() || `${appBaseUrl}/api/auth/google/callback`,
    accessCodes: list(env.ACCESS_CODES),
    aiDailyBudget: Math.max(1, Number(env.AI_DAILY_BUDGET || 300)),
    aiRatePerMinute: Math.max(1, Number(env.AI_RATE_PER_MINUTE || 12)),
    sessionSecret: env.SESSION_SECRET ? Buffer.from(env.SESSION_SECRET) : randomBytes(32),
    google: {
      authUrl: env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
      revokeUrl: env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke',
      calendarBase: env.GOOGLE_CALENDAR_BASE || 'https://www.googleapis.com/calendar/v3',
    },
  }
}

export function config(): ServerConfig {
  if (!cached) {
    try {
      // Node 22: load .env if present (never committed)
      process.loadEnvFile?.('.env')
    } catch {
      /* no .env — fine */
    }
    cached = loadConfig()
  }
  return cached
}

export function setConfigForTests(c: ServerConfig | null) {
  cached = c
}

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned'
export const GOOGLE_TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks'
/** Gmail: message headers/labels only (no bodies) and send-only. Both are the narrowest scopes for the job. */
export const GMAIL_METADATA_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata'
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'
