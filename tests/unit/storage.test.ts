import { describe, expect, it } from 'vitest'
import { MemoryKV, ChunkedDoc } from '../../src/storage/kv'
import { AdultSettingsRepository, CORRUPT_KEY, SaveRepository, defaultSave, migrate, reconcileFromLedger } from '../../src/storage/save'
import { SaveStore } from '../../src/storage/store'
import type { QuestInput } from '../../src/game/reducer'

const TZ = 'UTC'
const NOW = Date.UTC(2026, 10, 24, 10)
const qi: QuestInput = { title: 'Read chapter', category: 'personal', difficulty: 'easy', estimatedMinutes: 20, skill: 'INT', source: 'manual' }

describe('chunked storage', () => {
  it('round-trips large documents across chunks and keeps the previous copy on torn write', async () => {
    const kv = new MemoryKV()
    const doc = new ChunkedDoc(kv, 'k')
    const big = 'x'.repeat(95_000)
    expect(await doc.write(big)).toBe(true)
    expect(await doc.read()).toBe(big)
    kv.failWrites = true
    expect(await doc.write('y'.repeat(10))).toBe(false)
    kv.failWrites = false
    expect(await doc.read()).toBe(big)
    await doc.clear()
    expect(await doc.read()).toBeNull()
  })
})

describe('save repository', () => {
  it('loads a fresh state as new, persists and reloads identical state', async () => {
    const kv = new MemoryKV()
    const repo = new SaveRepository(kv)
    expect((await repo.load()).outcome).toBe('new')
    const store = new SaveStore(repo, defaultSave({ companion: 'savage', avatar: 'mage' }))
    const c = await store.dispatch({ type: 'quest/create', input: qi }, NOW, TZ)
    const id = c.save.quests[0]!.id
    await store.dispatch({ type: 'quest/complete', id, method: 'self_reported' }, NOW, TZ)
    await store.dispatch({ type: 'quest/complete', id, method: 'self_reported' }, NOW, TZ)
    const reloaded = await new SaveRepository(kv).load()
    expect(reloaded.outcome).toBe('loaded')
    expect(reloaded.save!.player.totalXp).toBe(20)
    expect(reloaded.save!.rewardLedger).toHaveLength(1)
    expect(reloaded.save!.companion.id).toBe('savage')
    expect(reloaded.save!.player.avatar).toBe('mage')
  })

  it('recovers from malformed JSON by keeping a copy and resetting', async () => {
    const kv = new MemoryKV()
    await new ChunkedDoc(kv, 'questling.save.v1').write('{not json')
    const r = await new SaveRepository(kv).load()
    expect(r.outcome).toBe('reset_corrupt')
    expect(r.save).toBeNull()
    expect(await kv.get(CORRUPT_KEY)).toBe('{not json')
  })

  it('salvages valid records from a partially corrupt save and recomputes XP from the ledger', () => {
    const base = defaultSave()
    const raw = {
      ...base,
      player: { ...base.player, totalXp: 9999 },
      quests: [{ bogus: true }],
      rewardLedger: [
        { questId: 'q_abcdefgh', xp: 40, skill: 'INT', skillPoints: 2, at: NOW },
        { questId: 'q_abcdefgh', xp: 40, skill: 'INT', skillPoints: 2, at: NOW },
        { questId: 'bad', xp: -1 },
      ],
      preferences: { quietHours: 'oops' },
    }
    const m = migrate(raw)!
    expect(m.outcome).toBe('recovered')
    expect(m.save.quests).toHaveLength(0)
    expect(m.save.rewardLedger).toHaveLength(1)
    expect(m.save.player.totalXp).toBe(40)
    expect(m.save.player.skills.INT).toBe(2)
  })

  it('fills missing fields with safe defaults (forward-compatible load)', () => {
    const base = defaultSave() as Record<string, unknown>
    const { reminders: _r, memory: _m, ...rest } = base
    void _r
    void _m
    const m = migrate({ ...rest })!
    expect(m.outcome).toBe('loaded')
    expect(m.save.memory.enabled).toBe(true)
    expect(m.save.reminders.records).toEqual({})
  })

  it('rejects unknown future versions', () => {
    expect(migrate({ version: 99 })).toBeNull()
    expect(migrate('x')).toBeNull()
  })

  it('reconcileFromLedger marks ledgered quests completed (no double reward on reload)', () => {
    const s = defaultSave()
    const q = { id: 'q_zzzzzzzz', title: 'T', category: 'work' as const, difficulty: 'easy' as const, estimatedMinutes: 5, status: 'pending' as const, source: 'manual' as const, skill: null, reward: { xp: 20, skillPoints: 0 }, createdAt: NOW, updatedAt: NOW, postponeCount: 0 }
    const r = reconcileFromLedger({ ...s, quests: [q], rewardLedger: [{ questId: q.id, xp: 20, skill: null, skillPoints: 0, at: NOW }] })
    expect(r.quests[0]!.status).toBe('completed')
  })
})

describe('store persistence failures', () => {
  it('labels unsaved state when writes fail and recovers on flush', async () => {
    const kv = new MemoryKV()
    const store = new SaveStore(new SaveRepository(kv), defaultSave())
    kv.failWrites = true
    const r = await store.dispatch({ type: 'quest/create', input: qi }, NOW, TZ)
    expect(r.persisted).toBe(false)
    expect(store.status).toBe('unsaved')
    kv.failWrites = false
    await store.flush()
    expect(store.status).toBe('saved')
    expect((await new SaveRepository(kv).load()).save!.quests).toHaveLength(1)
    store.dispose()
  })

  it('serializes concurrent completions (single writer) — one reward only', async () => {
    const store = new SaveStore(new SaveRepository(new MemoryKV()), defaultSave())
    const c = await store.dispatch({ type: 'quest/create', input: qi }, NOW, TZ)
    const id = c.save.quests[0]!.id
    const results = await Promise.all(
      Array.from({ length: 5 }, () => store.dispatch({ type: 'quest/complete', id, method: 'self_reported' }, NOW, TZ)),
    )
    expect(results.filter((r) => r.events.some((e) => e.type === 'QUEST_COMPLETED'))).toHaveLength(1)
    expect(store.state.player.totalXp).toBe(20)
    store.dispose()
  })
})

describe('adult settings', () => {
  it('defaults to disabled and ignores garbage', async () => {
    const kv = new MemoryKV()
    const repo = new AdultSettingsRepository(kv)
    expect((await repo.load()).adultLanguageEnabled).toBe(false)
    await kv.set('questling.adult.v1', '{"adultLanguageEnabled":"yes"}')
    expect((await repo.load()).adultLanguageEnabled).toBe(false)
  })
})
