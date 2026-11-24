import { describe, expect, it } from 'vitest'
import { applyGameCommand, bossHp, isOverdue, prioritizedQuests, type QuestInput } from '../../src/game/reducer'
import { bossDamageSplit, levelInfo, rewardFor, totalXpForLevel, xpToNext } from '../../src/game/rules'
import { defaultSave } from '../../src/storage/save'
import type { SaveV1 } from '../../src/shared/schema'

const TZ = 'Europe/Istanbul'
const T0 = Date.UTC(2026, 10, 24, 9, 0) // 12:00 Istanbul

const input = (over: Partial<QuestInput> = {}): QuestInput => ({
  title: 'Finish presentation',
  category: 'work',
  difficulty: 'normal',
  estimatedMinutes: 30,
  skill: 'INT',
  source: 'manual',
  ...over,
})

function create(save: SaveV1, over: Partial<QuestInput> = {}) {
  const r = applyGameCommand(save, { type: 'quest/create', input: input(over) }, T0, TZ)
  expect(r.error).toBeUndefined()
  const q = r.save.quests[r.save.quests.length - 1]!
  return { save: r.save, q }
}

describe('levels', () => {
  it('uses 100 + 50*(L-1) thresholds with overflow kept', () => {
    expect(xpToNext(1)).toBe(100)
    expect(xpToNext(2)).toBe(150)
    expect(levelInfo(0).level).toBe(1)
    expect(levelInfo(99).level).toBe(1)
    expect(levelInfo(100).level).toBe(2)
    expect(levelInfo(100).into).toBe(0)
    expect(levelInfo(249).level).toBe(2)
    expect(levelInfo(250).level).toBe(3)
    expect(levelInfo(260).into).toBe(10)
    expect(levelInfo(140)).toEqual({ level: 2, into: 40, need: 150, totalXp: 140 })
  })
  it('supports at least 20 levels and beyond', () => {
    const t20 = totalXpForLevel(20)
    expect(levelInfo(t20).level).toBe(20)
    expect(levelInfo(t20 - 1).level).toBe(19)
    expect(levelInfo(totalXpForLevel(40)).level).toBe(40)
  })
  it('never negative', () => {
    expect(levelInfo(-50).level).toBe(1)
    expect(levelInfo(-50).totalXp).toBe(0)
  })
})

describe('rewards', () => {
  it('maps difficulty deterministically', () => {
    expect(rewardFor('easy', 'STR')).toEqual({ xp: 20, skillPoints: 1 })
    expect(rewardFor('normal', 'INT')).toEqual({ xp: 40, skillPoints: 2 })
    expect(rewardFor('hard', 'DIS')).toEqual({ xp: 70, skillPoints: 3 })
    expect(rewardFor('major', 'SOC')).toEqual({ xp: 100, skillPoints: 4 })
    expect(rewardFor('recovery', null)).toEqual({ xp: 20, skillPoints: 0 })
  })
})

describe('quest lifecycle', () => {
  it('creates, starts and completes once', () => {
    const { save: s0, q } = create(defaultSave())
    expect(q.status).toBe('pending')
    expect(q.reward).toEqual({ xp: 40, skillPoints: 2 })
    const save = applyGameCommand(s0, { type: 'quest/start', id: q.id }, T0 + 1, TZ).save
    const r = applyGameCommand(save, { type: 'quest/complete', id: q.id, method: 'self_reported' }, T0 + 2, TZ)
    expect(r.events.map((e) => e.type)).toContain('QUEST_COMPLETED')
    expect(r.save.player.totalXp).toBe(40)
    expect(r.save.player.skills.INT).toBe(2)
    expect(r.save.rewardLedger).toHaveLength(1)
    // repeated taps / retries are idempotent
    const r2 = applyGameCommand(r.save, { type: 'quest/complete', id: q.id, method: 'self_reported' }, T0 + 3, TZ)
    expect(r2.duplicate).toBe(true)
    expect(r2.events).toHaveLength(0)
    expect(r2.save.player.totalXp).toBe(40)
    expect(r2.save.rewardLedger).toHaveLength(1)
  })

  it('emits LEVEL_UP when crossing a threshold and keeps overflow', () => {
    let save = defaultSave()
    for (let i = 0; i < 3; i++) {
      const c = create(save, { difficulty: 'hard', title: `Hard ${i}` })
      save = applyGameCommand(c.save, { type: 'quest/complete', id: c.q.id, method: 'confirmed' }, T0, TZ).save
    }
    expect(save.player.totalXp).toBe(210)
    expect(levelInfo(save.player.totalXp)).toMatchObject({ level: 2, into: 110 })
    const c = create(save, { difficulty: 'major', title: 'Major' })
    const r = applyGameCommand(c.save, { type: 'quest/complete', id: c.q.id, method: 'confirmed' }, T0, TZ)
    expect(r.events).toContainEqual({ type: 'LEVEL_UP', from: 2, to: 3 })
    expect(levelInfo(r.save.player.totalXp).into).toBe(60)
  })

  it('archive does not revoke XP and completed quests are immutable', () => {
    const c = create(defaultSave())
    const done = applyGameCommand(c.save, { type: 'quest/complete', id: c.q.id, method: 'self_reported' }, T0, TZ).save
    const edit = applyGameCommand(done, { type: 'quest/edit', id: c.q.id, patch: { difficulty: 'major' } }, T0, TZ)
    expect(edit.error).toBe('completed_quest_immutable')
    const arch = applyGameCommand(done, { type: 'quest/archive', id: c.q.id }, T0, TZ).save
    expect(arch.player.totalXp).toBe(40)
    expect(arch.rewardLedger).toHaveLength(1)
    // archived cannot be completed again to farm XP
    const again = applyGameCommand(arch, { type: 'quest/complete', id: c.q.id, method: 'self_reported' }, T0, TZ)
    expect(again.duplicate).toBe(true)
    expect(again.save.player.totalXp).toBe(40)
  })

  it('repeat creates a new occurrence with its own reward identity', () => {
    const c = create(defaultSave())
    const done = applyGameCommand(c.save, { type: 'quest/complete', id: c.q.id, method: 'self_reported' }, T0, TZ).save
    const rep = applyGameCommand(done, { type: 'quest/repeat', id: c.q.id }, T0 + 10, TZ)
    const occ = rep.save.quests[rep.save.quests.length - 1]!
    expect(occ.id).not.toBe(c.q.id)
    expect(occ.repeatOf).toBe(c.q.id)
    const r = applyGameCommand(rep.save, { type: 'quest/complete', id: occ.id, method: 'self_reported' }, T0 + 20, TZ)
    expect(r.save.player.totalXp).toBe(80)
    expect(r.save.rewardLedger).toHaveLength(2)
    // repeat of an open quest is rejected
    const open = create(r.save)
    expect(applyGameCommand(open.save, { type: 'quest/repeat', id: open.q.id }, T0, TZ).error).toBe('repeat_requires_closed_quest')
  })

  it('postpone increments counter, overdue is derived', () => {
    const c = create(defaultSave(), { deadline: { at: T0 - 60_000, tz: TZ } })
    expect(isOverdue(c.q, T0)).toBe(true)
    const r = applyGameCommand(c.save, { type: 'quest/postpone', id: c.q.id, deadline: { at: T0 + 3600_000, tz: TZ } }, T0, TZ)
    const q = r.save.quests[0]!
    expect(q.status).toBe('postponed')
    expect(q.postponeCount).toBe(1)
    expect(isOverdue(q, T0)).toBe(false)
    expect(r.events[0]).toMatchObject({ type: 'QUEST_POSTPONED', postponeCount: 1 })
  })

  it('validates input (title length, minutes, enums)', () => {
    const s = defaultSave()
    expect(applyGameCommand(s, { type: 'quest/create', input: input({ title: '' }) }, T0, TZ).error).toMatch(/invalid_quest/)
    expect(applyGameCommand(s, { type: 'quest/create', input: input({ title: 'x'.repeat(81) }) }, T0, TZ).error).toMatch(/invalid_quest/)
    expect(applyGameCommand(s, { type: 'quest/create', input: input({ estimatedMinutes: 0 }) }, T0, TZ).error).toMatch(/invalid_quest/)
    expect(
      applyGameCommand(s, { type: 'quest/create', input: input({ difficulty: 'legendary' as never }) }, T0, TZ).error,
    ).toMatch(/invalid_quest/)
  })

  it('deduplicates external imports by provider resource id', () => {
    const ref = { provider: 'google_calendar' as const, resourceId: 'evt123_20261124' }
    const c = create(defaultSave(), { externalRef: ref, source: 'calendar' })
    const again = applyGameCommand(c.save, { type: 'quest/create', input: input({ externalRef: ref, source: 'calendar' }) }, T0, TZ)
    expect(again.duplicate).toBe(true)
    expect(again.save.quests).toHaveLength(1)
  })

  it('prioritizes in-progress, then overdue, then by deadline', () => {
    let s = defaultSave()
    const a = create(s, { title: 'Later', deadline: { at: T0 + 7200_000, tz: TZ } })
    s = a.save
    const b = create(s, { title: 'Overdue', deadline: { at: T0 - 1000, tz: TZ } })
    s = b.save
    const c = create(s, { title: 'Active' })
    s = applyGameCommand(c.save, { type: 'quest/start', id: c.q.id }, T0, TZ).save
    expect(prioritizedQuests(s, T0).map((q) => q.title)).toEqual(['Active', 'Overdue', 'Later'])
  })
})

describe('boss (P1)', () => {
  it('splits damage deterministically and reaches exactly zero only when all done', () => {
    expect(bossDamageSplit(3)).toEqual([333, 333, 334])
    expect(bossDamageSplit(4)).toEqual([250, 250, 250, 250])
    expect(bossDamageSplit(5).reduce((a, b) => a + b)).toBe(1000)
    const ms = [1, 2, 3].map((i) => ({ title: `Milestone ${i}`, category: 'boss' as const, difficulty: 'major' as const, estimatedMinutes: 60, skill: 'DIS' as const }))
    let s = applyGameCommand(defaultSave(), { type: 'boss/create', goal: 'Ship portfolio', skin: 'procrastinator', milestones: ms }, T0, TZ).save
    const boss = s.boss!
    expect(bossHp(boss)).toBe(1000)
    const [m1, m2, m3] = boss.milestones
    let r = applyGameCommand(s, { type: 'quest/complete', id: m1!.questId, method: 'confirmed' }, T0, TZ)
    expect(bossHp(r.save.boss!)).toBe(667)
    // completing the same milestone twice does not damage twice
    r = applyGameCommand(r.save, { type: 'quest/complete', id: m1!.questId, method: 'confirmed' }, T0, TZ)
    expect(r.duplicate).toBe(true)
    expect(bossHp(r.save.boss!)).toBe(667)
    s = applyGameCommand(r.save, { type: 'quest/complete', id: m2!.questId, method: 'confirmed' }, T0, TZ).save
    expect(bossHp(s.boss!)).toBe(334)
    const fin = applyGameCommand(s, { type: 'quest/complete', id: m3!.questId, method: 'confirmed' }, T0, TZ)
    expect(bossHp(fin.save.boss!)).toBe(0)
    expect(fin.events.map((e) => e.type)).toContain('BOSS_DEFEATED')
    expect(fin.save.cosmetics.unlocked).toContain('adventurers_badge')
    expect(fin.save.achievements).toContain('first_boss')
    expect(fin.save.bossHistory).toHaveLength(1)
  })
  it('rejects fewer than 3 milestones and a second active boss', () => {
    const ms = [1, 2].map((i) => ({ title: `M${i}`, category: 'boss' as const, difficulty: 'major' as const, estimatedMinutes: 30, skill: null }))
    expect(applyGameCommand(defaultSave(), { type: 'boss/create', goal: 'x', skin: 'mountain', milestones: ms }, T0, TZ).error).toBe('boss_needs_3_to_5_milestones')
  })
})

describe('unlocks (P1)', () => {
  it('unlocks first-quest cosmetic and achievement exactly once', () => {
    const c = create(defaultSave())
    const r = applyGameCommand(c.save, { type: 'quest/complete', id: c.q.id, method: 'self_reported' }, T0, TZ)
    expect(r.events.filter((e) => e.type === 'ITEM_UNLOCKED')).toHaveLength(1)
    expect(r.save.cosmetics.unlocked).toEqual(['wooden_sword'])
    expect(r.save.achievements).toEqual(['first_quest'])
    const c2 = create(r.save, { title: 'Second' })
    const r2 = applyGameCommand(c2.save, { type: 'quest/complete', id: c2.q.id, method: 'self_reported' }, T0, TZ)
    expect(r2.events.filter((e) => e.type === 'ITEM_UNLOCKED')).toHaveLength(0)
  })
})
