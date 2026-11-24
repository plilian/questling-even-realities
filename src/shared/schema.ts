import { z } from 'zod'

/** Shared runtime schemas (client + server). All persisted/untrusted data passes through these. */

export const SKILLS = ['STR', 'INT', 'DIS', 'SOC'] as const
export type Skill = (typeof SKILLS)[number]
export const SKILL_LABELS: Record<Skill, string> = {
  STR: 'Strength',
  INT: 'Intellect',
  DIS: 'Discipline',
  SOC: 'Social',
}
export const SKILL_HINTS: Record<Skill, string> = {
  STR: 'movement',
  INT: 'learning & research',
  DIS: 'planning & commitments',
  SOC: 'communication',
}

export const CATEGORIES = ['daily', 'personal', 'work', 'boss'] as const
export type Category = (typeof CATEGORIES)[number]
export const DIFFICULTIES = ['easy', 'normal', 'hard', 'major', 'recovery'] as const
export type Difficulty = (typeof DIFFICULTIES)[number]
export const STATUSES = ['pending', 'in_progress', 'completed', 'postponed', 'archived'] as const
export type QuestStatus = (typeof STATUSES)[number]
export const SOURCES = ['manual', 'ai', 'calendar', 'notion', 'todoist', 'google_tasks', 'demo'] as const
export type QuestSource = (typeof SOURCES)[number]
export const COMPLETION_METHODS = ['self_reported', 'confirmed', 'external_verified'] as const
export type CompletionMethod = (typeof COMPLETION_METHODS)[number]

export const COMPANION_IDS = ['grumpy', 'commander', 'optimist', 'sage', 'savage'] as const
export type CompanionId = (typeof COMPANION_IDS)[number]
export const AVATARS = ['adventurer', 'knight', 'mage'] as const
export type AvatarId = (typeof AVATARS)[number]

export const EMOTIONS = [
  'idle',
  'happy',
  'annoyed',
  'thinking',
  'surprised',
  'celebrating',
  'concerned',
  'sleepy',
] as const
export type Emotion = (typeof EMOTIONS)[number]

export const INTENSITIES = ['gentle', 'balanced', 'intense'] as const
export type CompanionIntensity = (typeof INTENSITIES)[number]
export const ROAST_LEVELS = ['light', 'medium', 'savage'] as const
export type RoastIntensity = (typeof ROAST_LEVELS)[number]
export const PROFANITY_LEVELS = ['none', 'mild', 'strong', 'uncensored'] as const
export type ProfanityLevel = (typeof PROFANITY_LEVELS)[number]

const id = z.string().regex(/^[a-z]{1,4}_[A-Za-z0-9_-]{4,64}$/)
const ts = z.number().int().nonnegative().max(8.64e15)
const tz = z.string().min(1).max(64)

export const QuestSchema = z.object({
  id,
  title: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  category: z.enum(CATEGORIES),
  difficulty: z.enum(DIFFICULTIES),
  estimatedMinutes: z.number().int().min(1).max(600),
  status: z.enum(STATUSES),
  deadline: z.object({ at: ts, tz }).optional(),
  source: z.enum(SOURCES),
  externalRef: z
    .object({ provider: z.enum(['google_calendar', 'notion', 'todoist', 'google_tasks']), resourceId: z.string().min(1).max(256) })
    .optional(),
  skill: z.enum(SKILLS).nullable(),
  reward: z.object({ xp: z.number().int().min(0).max(100), skillPoints: z.number().int().min(0).max(4) }),
  createdAt: ts,
  updatedAt: ts,
  startedAt: ts.optional(),
  completedAt: ts.optional(),
  completionMethod: z.enum(COMPLETION_METHODS).optional(),
  parentBossId: id.optional(),
  milestoneId: id.optional(),
  postponeCount: z.number().int().min(0).max(1000).default(0),
  repeatOf: id.optional(),
})
export type Quest = z.infer<typeof QuestSchema>

export const RewardEntrySchema = z.object({
  questId: id,
  xp: z.number().int().min(0).max(100),
  skill: z.enum(SKILLS).nullable(),
  skillPoints: z.number().int().min(0).max(4),
  at: ts,
})
export type RewardEntry = z.infer<typeof RewardEntrySchema>

export const MemoryEntrySchema = z.object({
  id,
  kind: z.enum(['goal', 'preference', 'fact']),
  text: z.string().trim().min(1).max(160),
  createdAt: ts,
  source: z.enum(['user', 'ai_approved']),
})
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>

export const TurnSchema = z.object({
  role: z.enum(['user', 'companion']),
  text: z.string().max(600),
  at: ts,
  // explicit text is never persisted; companion turns store their language tier
  tier: z.enum(['clean', 'mild']).default('clean'),
})
export type Turn = z.infer<typeof TurnSchema>

export const MemorySchema = z.object({
  enabled: z.boolean().default(true),
  entries: z.array(MemoryEntrySchema).max(20).default([]),
  recentTurns: z.array(TurnSchema).max(12).default([]),
  generation: z.number().int().min(0).default(0),
})
export type LocalMemory = z.infer<typeof MemorySchema>

export const ReminderRecordSchema = z.object({
  status: z.enum(['delivered', 'dismissed', 'snoozed', 'acted', 'expired']),
  at: ts,
  snoozedUntil: ts.optional(),
})
export const ReminderStateSchema = z.object({
  records: z.record(z.string().max(160), ReminderRecordSchema).default({}),
  lastUnsolicitedAt: ts.nullable().default(null),
  nudgeDay: z.string().max(10).default(''),
  nudgesToday: z.number().int().min(0).default(0),
  mutedUntil: ts.nullable().default(null),
  lastActiveAt: ts.nullable().default(null),
  lastBriefingDay: z.string().max(10).default(''),
  lastReviewDay: z.string().max(10).default(''),
})
export type ReminderState = z.infer<typeof ReminderStateSchema>

/** Server-side AI providers (Gemini default; others optional, server-configured). Defined here to avoid an import cycle. */
export const AI_PROVIDER_IDS = ['gemini', 'openai', 'anthropic', 'openrouter', 'ollama'] as const

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
export const PreferencesSchema = z.object({
  onboarded: z.boolean().default(false),
  goal: z.string().max(160).default(''),
  activeHours: z.object({ start: hhmm, end: hhmm }).default({ start: '08:00', end: '22:00' }),
  quietHours: z.object({ enabled: z.boolean(), start: hhmm, end: hhmm }).default({ enabled: true, start: '22:00', end: '08:00' }),
  meetingReminderMinutes: z.number().int().min(1).max(120).default(15),
  maxNudgesPerDay: z.number().int().min(0).max(12).default(4),
  cooldownMinutes: z.number().int().min(5).max(240).default(20),
  reducedMotion: z.boolean().default(false),
  proactiveEnabled: z.boolean().default(true),
  timezone: tz.optional(),
  /** which configured server provider to ask; 'auto' = the server default */
  aiProvider: z.enum(['auto', ...AI_PROVIDER_IDS]).default('auto'),
})
export type Preferences = z.infer<typeof PreferencesSchema>

export const IntegrationMetadataSchema = z.object({
  provider: z.enum(['google_calendar', 'notion']),
  calendarId: z.string().max(256).optional(),
  lastFetchAt: ts.nullable().default(null),
  label: z.string().max(80).optional(),
})
export type IntegrationMetadata = z.infer<typeof IntegrationMetadataSchema>

export const BossSchema = z.object({
  id,
  skin: z.enum(['procrastinator', 'deadline_beast', 'mountain']),
  goal: z.string().trim().min(1).max(120),
  milestones: z
    .array(z.object({ id, title: z.string().trim().min(1).max(80), questId: id, damage: z.number().int().min(0).max(1000) }))
    .min(3)
    .max(5),
  maxHp: z.literal(1000),
  damagedMilestones: z.array(id).default([]),
  createdAt: ts,
  defeatedAt: ts.optional(),
})
export type BossCampaign = z.infer<typeof BossSchema>

export const SaveV1Schema = z.object({
  version: z.literal(1),
  revision: z.number().int().min(0).default(0),
  player: z.object({
    id,
    name: z.string().max(32).default(''),
    avatar: z.enum(AVATARS),
    totalXp: z.number().int().min(0),
    skills: z.object({ STR: z.number().int().min(0), INT: z.number().int().min(0), DIS: z.number().int().min(0), SOC: z.number().int().min(0) }),
  }),
  quests: z.array(QuestSchema).max(400),
  rewardLedger: z.array(RewardEntrySchema).max(20000),
  companion: z.object({
    id: z.enum(COMPANION_IDS),
    intensity: z.enum(INTENSITIES).default('balanced'),
    roastIntensity: z.enum(ROAST_LEVELS).default('medium'),
  }),
  memory: MemorySchema.prefault({}),
  reminders: ReminderStateSchema.prefault({}),
  preferences: PreferencesSchema.prefault({}),
  integrationMetadata: z.array(IntegrationMetadataSchema).max(4).default([]),
  boss: BossSchema.optional(),
  bossHistory: z.array(z.object({ id, goal: z.string().max(120), defeatedAt: ts })).max(50).default([]),
  cosmetics: z.object({ unlocked: z.array(z.string().max(40)).max(8), equipped: z.string().max(40).nullable() }).default({ unlocked: [], equipped: null }),
  achievements: z.array(z.string().max(40)).max(8).default([]),
  activeDays: z.array(z.string().max(10)).max(400).default([]),
  /** Training (tutorial) progress: each step's XP is granted once */
  training: z
    .object({ done: z.array(z.object({ step: z.string().max(24), xp: z.number().int().min(0).max(50), at: ts })).max(20).default([]), hidden: z.boolean().default(false) })
    .prefault({}),
})
export type SaveV1 = z.infer<typeof SaveV1Schema>

/** Adult language settings live OUTSIDE the save: never imported or exported. */
export const AdultSettingsSchema = z.object({
  adultLanguageEnabled: z.boolean().default(false),
  attestedAt: ts.nullable().default(null),
  profanityLevel: z.enum(PROFANITY_LEVELS).default('none'),
  policyRevision: z.number().int().min(0).default(0),
  minorLock: z.boolean().default(false),
})
export type AdultSettings = z.infer<typeof AdultSettingsSchema>
