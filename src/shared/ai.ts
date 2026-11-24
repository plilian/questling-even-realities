import { z } from 'zod'
import { AI_PROVIDER_IDS, CATEGORIES, COMPANION_IDS, DIFFICULTIES, EMOTIONS, INTENSITIES, PROFANITY_LEVELS, ROAST_LEVELS, SKILLS } from './schema'

/**
 * Gemini request/response contract. The model only ever sees opaque refs (Q1, E1),
 * never internal IDs, tokens, or the save. Model output is untrusted and is
 * validated here, then turned into proposals by trusted client code.
 */

const localDT = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
const qref = z.string().regex(/^Q\d{1,2}$/)
const eref = z.string().regex(/^E\d{1,2}$/)
const mref = z.string().regex(/^M\d{1,2}$/)
const shortText = (n: number) => z.string().trim().min(1).max(n)

export const AI_ACTION_TYPES = [
  'create_local_quest',
  'propose_quest_update',
  'start_quest',
  'complete_local_quest',
  'postpone_quest',
  'find_free_slot',
  'propose_calendar_event',
  'propose_calendar_update',
  'view_calendar',
  'mute_companion',
  'set_reminder_preferences',
  'daily_review',
  'propose_message_reply',
] as const
export type AiActionType = (typeof AI_ACTION_TYPES)[number]

export const AiActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('create_local_quest'),
    title: shortText(80),
    category: z.enum(CATEGORIES).exclude(['boss']),
    difficulty: z.enum(DIFFICULTIES).exclude(['major']),
    estimatedMinutes: z.number().int().min(1).max(600),
    deadlineLocal: localDT.nullable().optional(),
    skill: z.enum(SKILLS).nullable().optional(),
  }),
  z.object({
    type: z.literal('propose_quest_update'),
    questRef: qref,
    title: shortText(80).nullable().optional(),
    deadlineLocal: localDT.nullable().optional(),
    estimatedMinutes: z.number().int().min(1).max(600).nullable().optional(),
  }),
  z.object({ type: z.literal('start_quest'), questRef: qref }),
  z.object({ type: z.literal('complete_local_quest'), questRef: qref }),
  z.object({ type: z.literal('postpone_quest'), questRef: qref, deadlineLocal: localDT.nullable().optional() }),
  z.object({ type: z.literal('find_free_slot'), durationMinutes: z.number().int().min(5).max(240), questRef: qref.nullable().optional() }),
  z.object({
    type: z.literal('propose_calendar_event'),
    title: shortText(100),
    startLocal: localDT,
    durationMinutes: z.number().int().min(5).max(480),
    questRef: qref.nullable().optional(),
  }),
  z.object({
    type: z.literal('propose_calendar_update'),
    eventRef: eref,
    startLocal: localDT,
    durationMinutes: z.number().int().min(5).max(480).nullable().optional(),
  }),
  z.object({ type: z.literal('view_calendar') }),
  z.object({ type: z.literal('mute_companion'), duration: z.enum(['15m', '1h', 'tomorrow', 'indefinite']) }),
  z.object({
    type: z.literal('set_reminder_preferences'),
    meetingReminderMinutes: z.number().int().min(1).max(120).nullable().optional(),
    maxNudgesPerDay: z.number().int().min(0).max(12).nullable().optional(),
  }),
  z.object({ type: z.literal('daily_review') }),
  /** a reply the USER would send (their voice, not the companion's); always shown verbatim for confirmation */
  z.object({ type: z.literal('propose_message_reply'), messageRef: mref, body: shortText(600) }),
])
export type AiAction = z.infer<typeof AiActionSchema>

export const AI_INTENTS = ['chat', 'briefing', 'quest_create', 'goal_breakdown', 'schedule', 'calendar_query', 'quest_update', 'mute', 'memory', 'review', 'catch_up', 'meeting_prep', 'message_help', 'triage', 'unclear'] as const
export const TRIAGE_LABELS = ['reply', 'later', 'fyi'] as const
export type TriageLabel = (typeof TRIAGE_LABELS)[number]

export const AiResponseSchema = z.object({
  transcript: z.string().max(600).nullable().optional(),
  dialogue: shortText(280),
  cleanDialogue: z.string().max(280).nullable().optional(),
  emotion: z.enum(EMOTIONS),
  intent: z.enum(AI_INTENTS),
  /** actions are validated one by one; invalid items are dropped, not executed */
  actions: z.array(z.unknown()).max(6).default([]),
  memoryCandidates: z.array(z.object({ kind: z.enum(['goal', 'preference', 'fact']), text: shortText(160) })).max(3).default([]),
  needsClarification: z.boolean().default(false),
  /** up to three short replies the USER could send to the message in focus (validated clean on the device) */
  replySuggestions: z.array(shortText(140)).max(3).catch([]).default([]),
  /** inbox triage by M-ref */
  triage: z.array(z.object({ messageRef: mref, label: z.enum(TRIAGE_LABELS) })).max(8).catch([]).default([]),
})
export type AiResponseRaw = z.infer<typeof AiResponseSchema>
export interface AiResponse extends Omit<AiResponseRaw, 'actions' | 'replySuggestions' | 'triage'> {
  actions: AiAction[]
  droppedActions: number
  replySuggestions?: string[]
  triage?: Array<{ messageRef: string; label: TriageLabel }>
}

export function parseAiResponse(raw: unknown): AiResponse | null {
  const r = AiResponseSchema.safeParse(raw)
  if (!r.success) return null
  const actions: AiAction[] = []
  let dropped = 0
  for (const a of r.data.actions.slice(0, 6)) {
    const p = AiActionSchema.safeParse(a)
    if (p.success) actions.push(p.data)
    else dropped++
  }
  return { ...r.data, actions, droppedActions: dropped }
}

export const AiContextSchema = z.object({
  nowLocal: localDT,
  weekday: z.string().max(12),
  tz: z.string().max(64),
  userName: z.string().max(32).optional(),
  goal: z.string().max(160).optional(),
  level: z.number().int().min(1).max(10_000),
  quests: z
    .array(
      z.object({
        ref: qref,
        title: z.string().max(80),
        status: z.enum(['pending', 'in_progress', 'postponed']),
        category: z.enum(CATEGORIES),
        difficulty: z.enum(DIFFICULTIES),
        estimatedMinutes: z.number().int(),
        deadlineLocal: localDT.optional(),
        overdue: z.boolean(),
        postponeCount: z.number().int(),
      }),
    )
    .max(15),
  completedToday: z.array(z.string().max(80)).max(10),
  calendar: z
    .object({
      events: z.array(z.object({ ref: eref, title: z.string().max(100), startLocal: localDT, endLocal: localDT })).max(10),
      freeSlots: z.array(z.object({ startLocal: localDT, endLocal: localDT })).max(6),
      fetchedMinutesAgo: z.number().int().min(0),
    })
    .nullable(),
  memory: z.array(z.string().max(160)).max(20),
  recentTurns: z.array(z.object({ role: z.enum(['user', 'companion']), text: z.string().max(600) })).max(12),
  /** unread mail / Slack mentions — untrusted third-party text, minimized (Gmail: sender + subject only) */
  messages: z
    .array(z.object({ ref: mref, app: z.enum(['Gmail', 'Slack', 'Telegram', 'GitHub']), from: z.string().max(80), where: z.string().max(60), title: z.string().max(160), preview: z.string().max(220), receivedLocal: localDT, canReply: z.boolean() }))
    .max(6)
    .default([]),
  /** the message the user is replying to right now (glasses “Reply by voice”, phone reply sheet) */
  replyingTo: mref.nullable().default(null),
})
export type AiContext = z.infer<typeof AiContextSchema>

export const LanguageSettingsSchema = z.object({
  adultEnabled: z.boolean(),
  profanityLevel: z.enum(PROFANITY_LEVELS),
  roastIntensity: z.enum(ROAST_LEVELS),
  intensity: z.enum(INTENSITIES),
  revision: z.number().int().min(0),
})

/** Server-side AI providers. Gemini is the default; the others are optional and configured on the server only. */
export { AI_PROVIDER_IDS }
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number]
export const AI_PROVIDER_LABELS: Record<AiProviderId, string> = {
  gemini: 'Gemini',
  openai: 'OpenAI',
  anthropic: 'Claude',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
}
export const AI_PROVIDER_VENDORS: Record<AiProviderId, string> = {
  gemini: 'Google',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter (model router)',
  ollama: 'Self-hosted on your server',
}

export const AiRequestSchema = z.object({
  mode: z.enum(['chat', 'voice']),
  /** optional provider choice; the server falls back to its default when omitted */
  provider: z.enum(AI_PROVIDER_IDS).optional(),
  companionId: z.enum(COMPANION_IDS),
  language: LanguageSettingsSchema,
  context: AiContextSchema,
  message: z.string().max(500).optional(),
  audio: z
    .object({
      mimeType: z.literal('audio/wav'),
      base64: z.string().max(700_000),
      durationMs: z.number().int().min(200).max(15_500),
    })
    .optional(),
})
export type AiRequest = z.infer<typeof AiRequestSchema>

/** JSON Schema handed to Gemini (subset supported by structured output). Flat action shape for model reliability. */
export const GEMINI_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    transcript: { type: ['string', 'null'], description: 'Voice mode only: verbatim transcript of the user audio. Null in text mode.' },
    dialogue: { type: 'string', description: 'What the companion says. One or two short sentences, max ~180 characters, in character.' },
    cleanDialogue: {
      type: ['string', 'null'],
      description: 'If dialogue contains any profanity, an equivalent line with zero profanity; otherwise null.',
    },
    emotion: { type: 'string', enum: [...EMOTIONS] },
    intent: { type: 'string', enum: [...AI_INTENTS] },
    needsClarification: { type: 'boolean', description: 'True if a time/date or target is ambiguous and must be asked before any write.' },
    actions: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...AI_ACTION_TYPES] },
          title: { type: ['string', 'null'] },
          category: { type: ['string', 'null'], enum: ['daily', 'personal', 'work', null] },
          difficulty: { type: ['string', 'null'], enum: ['easy', 'normal', 'hard', 'recovery', null] },
          estimatedMinutes: { type: ['integer', 'null'] },
          deadlineLocal: { type: ['string', 'null'], description: 'YYYY-MM-DDTHH:mm in the user timezone' },
          skill: { type: ['string', 'null'], enum: [...SKILLS, null] },
          questRef: { type: ['string', 'null'], description: 'Q-ref from context, e.g. Q2' },
          eventRef: { type: ['string', 'null'], description: 'E-ref from context, e.g. E1' },
          startLocal: { type: ['string', 'null'], description: 'YYYY-MM-DDTHH:mm in the user timezone' },
          durationMinutes: { type: ['integer', 'null'] },
          duration: { type: ['string', 'null'], enum: ['15m', '1h', 'tomorrow', 'indefinite', null] },
          meetingReminderMinutes: { type: ['integer', 'null'] },
          maxNudgesPerDay: { type: ['integer', 'null'] },
          messageRef: { type: ['string', 'null'], description: 'M-ref from context, e.g. M1 (propose_message_reply only)' },
          body: { type: ['string', 'null'], description: 'propose_message_reply: the reply text the USER would send, first person, plain and polite, max 600 chars' },
        },
        required: ['type'],
      },
    },
    replySuggestions: {
      type: 'array',
      maxItems: 3,
      description: 'Only when asked for reply suggestions: up to 3 short, distinct replies the USER could send to the message in focus (first person, plain, clean, no persona). Otherwise empty.',
      items: { type: 'string' },
    },
    triage: {
      type: 'array',
      maxItems: 8,
      description: 'Only when asked to triage: one entry per M-ref — reply (needs the user), later (can wait), fyi (no action). Otherwise empty.',
      items: { type: 'object', properties: { messageRef: { type: 'string' }, label: { type: 'string', enum: ['reply', 'later', 'fyi'] } }, required: ['messageRef', 'label'] },
    },
    memoryCandidates: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: { kind: { type: 'string', enum: ['goal', 'preference', 'fact'] }, text: { type: 'string' } },
        required: ['kind', 'text'],
      },
    },
  },
  required: ['dialogue', 'emotion', 'intent', 'actions', 'memoryCandidates', 'needsClarification'],
} as const

/** Normalize the model's flat action objects (nulls → undefined) before strict validation. */
export function normalizeModelActions(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.actions)) return raw
  const actions = obj.actions.map((a) => {
    if (!a || typeof a !== 'object') return a
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(a as Record<string, unknown>)) if (v !== null && v !== undefined) out[k] = v
    return out
  })
  return { ...obj, actions }
}
