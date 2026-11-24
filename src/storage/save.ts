import {
  AdultSettingsSchema,
  MemorySchema,
  PreferencesSchema,
  QuestSchema,
  ReminderStateSchema,
  RewardEntrySchema,
  SaveV1Schema,
  type AdultSettings,
  type AvatarId,
  type CompanionId,
  type SaveV1,
} from '../shared/schema'
import { newId } from '../shared/ids'
import { ChunkedDoc, type KV } from './kv'

export const SAVE_KEY = 'questling.save.v1'
export const DEMO_SAVE_KEY = 'questling.demo.save.v1'
export const ADULT_KEY = 'questling.adult.v1'
export const CORRUPT_KEY = 'questling.save.corrupt'

export function defaultSave(opts: { avatar?: AvatarId; companion?: CompanionId; name?: string } = {}): SaveV1 {
  return SaveV1Schema.parse({
    version: 1,
    revision: 0,
    player: {
      id: newId('p'),
      name: opts.name ?? '',
      avatar: opts.avatar ?? 'adventurer',
      totalXp: 0,
      skills: { STR: 0, INT: 0, DIS: 0, SOC: 0 },
    },
    quests: [],
    rewardLedger: [],
    companion: { id: opts.companion ?? 'grumpy', intensity: 'balanced', roastIntensity: 'medium' },
    memory: MemorySchema.parse({}),
    reminders: ReminderStateSchema.parse({}),
    preferences: PreferencesSchema.parse({}),
    integrationMetadata: [],
  })
}

export type LoadOutcome = 'new' | 'loaded' | 'migrated' | 'recovered' | 'reset_corrupt'

/** Ledger is authoritative for rewards: recompute XP/skills from it so they can never disagree. */
export function reconcileFromLedger(save: SaveV1): SaveV1 {
  const seen = new Set<string>()
  const ledger = save.rewardLedger.filter((r) => (seen.has(r.questId) ? false : (seen.add(r.questId), true)))
  const trained = new Set<string>()
  const training = (save.training?.done ?? []).filter((t) => (trained.has(t.step) ? false : (trained.add(t.step), true)))
  const totalXp = ledger.reduce((s, r) => s + r.xp, 0) + training.reduce((s, t) => s + t.xp, 0)
  const skills = { STR: 0, INT: 0, DIS: 0, SOC: 0 }
  for (const r of ledger) if (r.skill) skills[r.skill] += r.skillPoints
  // Any quest present in the ledger must be completed (reward-bearing state is immutable).
  const quests = save.quests.map((q) =>
    seen.has(q.id) && q.status !== 'completed' && q.status !== 'archived' ? { ...q, status: 'completed' as const, completedAt: q.completedAt ?? q.updatedAt } : q,
  )
  return { ...save, rewardLedger: ledger, quests, player: { ...save.player, totalXp, skills }, ...(save.training ? { training: { ...save.training, done: training } } : {}) }
}

/** Migrate any known older shape to SaveV1; unknown versions are rejected. */
export function migrate(raw: unknown): { save: SaveV1; outcome: LoadOutcome } | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  // v0 = pre-release prototype shape: { xp, quests, companionId } (documented for completeness)
  if (obj.version === 0 || (obj.version === undefined && 'xp' in obj)) {
    const base = defaultSave({ companion: (obj.companionId as CompanionId) ?? 'grumpy' })
    const quests = Array.isArray(obj.quests) ? obj.quests.map((q) => QuestSchema.safeParse(q)).filter((r) => r.success).map((r) => r.data) : []
    return { save: { ...base, quests }, outcome: 'migrated' }
  }
  if (obj.version !== 1) return null
  const parsed = SaveV1Schema.safeParse(obj)
  if (parsed.success) return { save: reconcileFromLedger(parsed.data), outcome: 'loaded' }
  // Partial salvage: keep every valid record, default the rest.
  const base = defaultSave()
  const salvage = <T>(arr: unknown, schema: { safeParse: (x: unknown) => { success: boolean; data?: T } }): T[] =>
    Array.isArray(arr) ? (arr.map((x) => schema.safeParse(x)).filter((r) => r.success).map((r) => r.data) as T[]) : []
  const player = SaveV1Schema.shape.player.safeParse(obj.player)
  const companion = SaveV1Schema.shape.companion.safeParse(obj.companion)
  const prefs = PreferencesSchema.safeParse(obj.preferences)
  const memory = MemorySchema.safeParse(obj.memory)
  const candidate: SaveV1 = {
    ...base,
    player: player.success ? player.data : base.player,
    companion: companion.success ? companion.data : base.companion,
    preferences: prefs.success ? prefs.data : base.preferences,
    memory: memory.success ? memory.data : base.memory,
    quests: salvage(obj.quests, QuestSchema).slice(0, 400),
    rewardLedger: salvage(obj.rewardLedger, RewardEntrySchema),
  }
  const check = SaveV1Schema.safeParse(candidate)
  if (!check.success) return null
  return { save: reconcileFromLedger(check.data), outcome: 'recovered' }
}

export class SaveRepository {
  private doc: ChunkedDoc
  constructor(
    private kv: KV,
    readonly key: string = SAVE_KEY,
  ) {
    this.doc = new ChunkedDoc(kv, key)
  }

  async load(): Promise<{ save: SaveV1 | null; outcome: LoadOutcome }> {
    const text = await this.doc.read()
    if (text === null) return { save: null, outcome: 'new' }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      await this.kv.set(CORRUPT_KEY, text.slice(0, 200_000))
      return { save: null, outcome: 'reset_corrupt' }
    }
    const m = migrate(raw)
    if (!m) {
      await this.kv.set(CORRUPT_KEY, text.slice(0, 200_000))
      return { save: null, outcome: 'reset_corrupt' }
    }
    return m
  }

  async write(save: SaveV1): Promise<boolean> {
    const valid = SaveV1Schema.safeParse(save)
    if (!valid.success) return false
    return this.doc.write(JSON.stringify(valid.data))
  }

  async clear(): Promise<void> {
    await this.doc.clear()
  }
}

export class AdultSettingsRepository {
  constructor(private kv: KV) {}
  async load(): Promise<AdultSettings> {
    const raw = await this.kv.get(ADULT_KEY)
    if (!raw) return AdultSettingsSchema.parse({})
    try {
      const parsed = AdultSettingsSchema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : AdultSettingsSchema.parse({})
    } catch {
      return AdultSettingsSchema.parse({})
    }
  }
  async write(s: AdultSettings): Promise<boolean> {
    return this.kv.set(ADULT_KEY, JSON.stringify(AdultSettingsSchema.parse(s)))
  }
  async clear(): Promise<void> {
    await this.kv.remove(ADULT_KEY)
  }
}
