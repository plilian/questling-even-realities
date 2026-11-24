import { trainingStep, type TrainingStepId } from './training'
import {
  QuestSchema,
  type BossCampaign,
  type Category,
  type CompletionMethod,
  type Difficulty,
  type Quest,
  type QuestSource,
  type SaveV1,
  type Skill,
} from '../shared/schema'
import { newId } from '../shared/ids'
import { dayKey } from '../shared/time'
import { ACHIEVEMENTS, COSMETICS, bossDamageSplit, levelInfo, rewardFor } from './rules'

/** Pure, deterministic game domain. No I/O, no clock access: `now`/`tz` are injected. */

export interface QuestInput {
  title: string
  description?: string
  category: Category
  difficulty: Difficulty
  estimatedMinutes: number
  deadline?: { at: number; tz: string }
  skill: Skill | null
  source: QuestSource
  externalRef?: Quest['externalRef']
  parentBossId?: string
  milestoneId?: string
}

export type GameCommand =
  | { type: 'quest/create'; input: QuestInput; id?: string }
  | { type: 'quest/edit'; id: string; patch: Partial<Pick<Quest, 'title' | 'description' | 'category' | 'estimatedMinutes' | 'deadline' | 'skill' | 'difficulty'>> }
  | { type: 'quest/start'; id: string }
  | { type: 'quest/complete'; id: string; method: CompletionMethod }
  | { type: 'quest/postpone'; id: string; deadline?: { at: number; tz: string } | null }
  | { type: 'quest/archive'; id: string }
  | { type: 'quest/repeat'; id: string }
  | { type: 'boss/create'; goal: string; skin: BossCampaign['skin']; milestones: Array<Omit<QuestInput, 'source' | 'parentBossId' | 'milestoneId'>> }
  | { type: 'boss/abandon' }
  | { type: 'training/complete'; step: TrainingStepId }
  | { type: 'training/hide'; hidden: boolean }

export type DomainEvent =
  | { type: 'QUEST_CREATED'; questId: string }
  | { type: 'QUEST_STARTED'; questId: string }
  | { type: 'QUEST_COMPLETED'; questId: string; title: string; xp: number; skill: Skill | null; skillPoints: number }
  | { type: 'LEVEL_UP'; from: number; to: number }
  | { type: 'TRAINING_COMPLETED'; step: TrainingStepId; title: string; xp: number }
  | { type: 'QUEST_POSTPONED'; questId: string; title: string; postponeCount: number }
  | { type: 'QUEST_ARCHIVED'; questId: string }
  | { type: 'QUEST_EDITED'; questId: string }
  | { type: 'ITEM_UNLOCKED'; itemId: string; name: string }
  | { type: 'ACHIEVEMENT_UNLOCKED'; achievementId: string; name: string }
  | { type: 'BOSS_CREATED'; bossId: string }
  | { type: 'BOSS_DAMAGED'; bossId: string; damage: number; hp: number }
  | { type: 'BOSS_DEFEATED'; bossId: string; goal: string }

export interface GameResult {
  save: SaveV1
  events: DomainEvent[]
  error?: string
  /** true when the command was an idempotent replay (e.g. second completion tap) */
  duplicate?: boolean
}

const MAX_ACTIVE_QUESTS = 120

function fail(save: SaveV1, error: string): GameResult {
  return { save, events: [], error }
}

function findQuest(save: SaveV1, id: string): Quest | undefined {
  return save.quests.find((q) => q.id === id)
}

function replaceQuest(save: SaveV1, q: Quest): SaveV1 {
  return { ...save, quests: save.quests.map((x) => (x.id === q.id ? q : x)) }
}

export function makeQuest(input: QuestInput, now: number, id = newId('q')): Quest | string {
  const candidate = {
    id,
    title: input.title?.trim(),
    description: input.description?.trim() || undefined,
    category: input.category,
    difficulty: input.difficulty,
    estimatedMinutes: Math.round(input.estimatedMinutes),
    status: 'pending' as const,
    deadline: input.deadline,
    source: input.source,
    externalRef: input.externalRef,
    skill: input.skill,
    reward: rewardFor(input.difficulty, input.skill),
    createdAt: now,
    updatedAt: now,
    parentBossId: input.parentBossId,
    milestoneId: input.milestoneId,
    postponeCount: 0,
  }
  const parsed = QuestSchema.safeParse(candidate)
  if (!parsed.success) return `invalid_quest: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`
  return parsed.data
}

function activeCount(save: SaveV1): number {
  return save.quests.filter((q) => q.status !== 'completed' && q.status !== 'archived').length
}

/** Keep the quest list bounded: drop the oldest archived/completed quests beyond capacity. The ledger is never pruned. */
function pruneQuests(save: SaveV1): SaveV1 {
  const CAP = 300
  if (save.quests.length <= CAP) return save
  const closed = save.quests
    .filter((q) => q.status === 'archived' || q.status === 'completed')
    .sort((a, b) => (a.completedAt ?? a.updatedAt) - (b.completedAt ?? b.updatedAt))
  const drop = new Set(closed.slice(0, save.quests.length - CAP).map((q) => q.id))
  return { ...save, quests: save.quests.filter((q) => !drop.has(q.id)) }
}

export function applyGameCommand(save: SaveV1, cmd: GameCommand, now: number, tz: string): GameResult {
  switch (cmd.type) {
    case 'quest/create': {
      if (activeCount(save) >= MAX_ACTIVE_QUESTS) return fail(save, 'too_many_active_quests')
      if (cmd.input.externalRef) {
        const dup = save.quests.find(
          (q) => q.externalRef?.provider === cmd.input.externalRef!.provider && q.externalRef.resourceId === cmd.input.externalRef!.resourceId,
        )
        if (dup) return { save, events: [], duplicate: true }
      }
      if (cmd.id && findQuest(save, cmd.id)) return { save, events: [], duplicate: true }
      const q = makeQuest(cmd.input, now, cmd.id)
      if (typeof q === 'string') return fail(save, q)
      return { save: pruneQuests({ ...save, quests: [...save.quests, q] }), events: [{ type: 'QUEST_CREATED', questId: q.id }] }
    }
    case 'quest/edit': {
      const q = findQuest(save, cmd.id)
      if (!q) return fail(save, 'quest_not_found')
      if (q.status === 'completed') return fail(save, 'completed_quest_immutable')
      const next = { ...q, ...cmd.patch, updatedAt: now }
      next.reward = rewardFor(next.difficulty, next.skill)
      const parsed = QuestSchema.safeParse(next)
      if (!parsed.success) return fail(save, 'invalid_quest')
      return { save: replaceQuest(save, parsed.data), events: [{ type: 'QUEST_EDITED', questId: q.id }] }
    }
    case 'quest/start': {
      const q = findQuest(save, cmd.id)
      if (!q) return fail(save, 'quest_not_found')
      if (q.status === 'in_progress') return { save, events: [], duplicate: true }
      if (q.status !== 'pending' && q.status !== 'postponed') return fail(save, `cannot_start_${q.status}`)
      const next: Quest = { ...q, status: 'in_progress', startedAt: now, updatedAt: now }
      return { save: replaceQuest(save, next), events: [{ type: 'QUEST_STARTED', questId: q.id }] }
    }
    case 'training/complete': {
      const step = trainingStep(cmd.step)
      if (!step) return fail(save, 'unknown_training_step')
      if (save.training.done.some((t) => t.step === step.id)) return { save, events: [], duplicate: true }
      const before = levelInfo(save.player.totalXp).level
      const player = { ...save.player, totalXp: save.player.totalXp + step.xp }
      const next: SaveV1 = { ...save, player, training: { ...save.training, done: [...save.training.done, { step: step.id, xp: step.xp, at: now }] } }
      const events: DomainEvent[] = [{ type: 'TRAINING_COMPLETED', step: step.id, title: step.title, xp: step.xp }]
      const after = levelInfo(player.totalXp).level
      if (after > before) events.push({ type: 'LEVEL_UP', from: before, to: after })
      return { save: next, events }
    }
    case 'training/hide':
      return { save: { ...save, training: { ...save.training, hidden: cmd.hidden } }, events: [] }
    case 'quest/complete': {
      const q = findQuest(save, cmd.id)
      if (!q) return fail(save, 'quest_not_found')
      // Ledger is the single source of truth for rewards: one entry per quest ID, ever.
      if (save.rewardLedger.some((r) => r.questId === q.id) || q.status === 'completed') {
        return { save, events: [], duplicate: true }
      }
      if (q.status === 'archived') return fail(save, 'cannot_complete_archived')
      const before = levelInfo(save.player.totalXp).level
      const reward = rewardFor(q.difficulty, q.skill)
      const skills = { ...save.player.skills }
      if (q.skill) skills[q.skill] += reward.skillPoints
      const player = { ...save.player, totalXp: save.player.totalXp + reward.xp, skills }
      const completed: Quest = { ...q, status: 'completed', completedAt: now, completionMethod: cmd.method, updatedAt: now, reward }
      const day = dayKey(now, tz)
      let next: SaveV1 = {
        ...replaceQuest(save, completed),
        player,
        rewardLedger: [...save.rewardLedger, { questId: q.id, xp: reward.xp, skill: q.skill, skillPoints: reward.skillPoints, at: now }],
        activeDays: save.activeDays.includes(day) ? save.activeDays : [...save.activeDays, day].slice(-400),
      }
      const events: DomainEvent[] = [
        { type: 'QUEST_COMPLETED', questId: q.id, title: q.title, xp: reward.xp, skill: q.skill, skillPoints: reward.skillPoints },
      ]
      const after = levelInfo(player.totalXp).level
      if (after > before) events.push({ type: 'LEVEL_UP', from: before, to: after })
      // Boss damage (P1): milestone-linked quests damage the active boss exactly once.
      if (next.boss && q.parentBossId === next.boss.id && q.milestoneId) {
        const r = damageBoss(next, q.milestoneId, now)
        next = r.save
        events.push(...r.events)
      }
      const unlocks = evaluateUnlocks(next, q)
      next = unlocks.save
      events.push(...unlocks.events)
      return { save: pruneQuests(next), events }
    }
    case 'quest/postpone': {
      const q = findQuest(save, cmd.id)
      if (!q) return fail(save, 'quest_not_found')
      if (q.status === 'completed' || q.status === 'archived') return fail(save, `cannot_postpone_${q.status}`)
      const deadline = cmd.deadline === null ? undefined : (cmd.deadline ?? q.deadline)
      const next: Quest = { ...q, status: 'postponed', deadline, postponeCount: q.postponeCount + 1, updatedAt: now }
      return {
        save: replaceQuest(save, next),
        events: [{ type: 'QUEST_POSTPONED', questId: q.id, title: q.title, postponeCount: next.postponeCount }],
      }
    }
    case 'quest/archive': {
      const q = findQuest(save, cmd.id)
      if (!q) return fail(save, 'quest_not_found')
      if (q.status === 'archived') return { save, events: [], duplicate: true }
      // Archive never revokes earned XP: ledger untouched.
      const next: Quest = { ...q, status: 'archived', updatedAt: now }
      return { save: replaceQuest(save, next), events: [{ type: 'QUEST_ARCHIVED', questId: q.id }] }
    }
    case 'quest/repeat': {
      const q = findQuest(save, cmd.id)
      if (!q) return fail(save, 'quest_not_found')
      if (q.status !== 'completed' && q.status !== 'archived') return fail(save, 'repeat_requires_closed_quest')
      if (activeCount(save) >= MAX_ACTIVE_QUESTS) return fail(save, 'too_many_active_quests')
      const occ = makeQuest(
        {
          title: q.title,
          description: q.description,
          category: q.category === 'boss' ? 'personal' : q.category,
          difficulty: q.difficulty,
          estimatedMinutes: q.estimatedMinutes,
          skill: q.skill,
          source: q.source === 'demo' ? 'demo' : 'manual',
        },
        now,
      )
      if (typeof occ === 'string') return fail(save, occ)
      const withRef = { ...occ, repeatOf: q.id }
      return { save: { ...save, quests: [...save.quests, withRef] }, events: [{ type: 'QUEST_CREATED', questId: withRef.id }] }
    }
    case 'boss/create': {
      if (save.boss && !save.boss.defeatedAt) return fail(save, 'boss_already_active')
      const n = cmd.milestones.length
      if (n < 3 || n > 5) return fail(save, 'boss_needs_3_to_5_milestones')
      const goal = cmd.goal.trim().slice(0, 120)
      if (!goal) return fail(save, 'boss_goal_required')
      const bossId = newId('bos')
      const dmg = bossDamageSplit(n)
      const quests: Quest[] = []
      const milestones: BossCampaign['milestones'] = []
      for (let i = 0; i < n; i++) {
        const m = cmd.milestones[i]!
        const msId = newId('ms')
        const q = makeQuest({ ...m, category: 'boss', source: 'manual', parentBossId: bossId, milestoneId: msId }, now)
        if (typeof q === 'string') return fail(save, q)
        quests.push(q)
        milestones.push({ id: msId, title: q.title, questId: q.id, damage: dmg[i]! })
      }
      const boss: BossCampaign = { id: bossId, skin: cmd.skin, goal, milestones, maxHp: 1000, damagedMilestones: [], createdAt: now }
      return {
        save: { ...save, boss, quests: [...save.quests, ...quests] },
        events: [{ type: 'BOSS_CREATED', bossId }, ...quests.map((q) => ({ type: 'QUEST_CREATED' as const, questId: q.id }))],
      }
    }
    case 'boss/abandon': {
      if (!save.boss || save.boss.defeatedAt) return fail(save, 'no_active_boss')
      const bossId = save.boss.id
      // Linked, unfinished milestone quests become ordinary personal quests; earned XP is kept.
      const quests = save.quests.map((q) =>
        q.parentBossId === bossId && q.status !== 'completed'
          ? { ...q, category: 'personal' as const, parentBossId: undefined, milestoneId: undefined, updatedAt: now }
          : q,
      )
      return { save: { ...save, boss: undefined, quests }, events: [] }
    }
  }
}

export function bossHp(boss: BossCampaign): number {
  const dealt = boss.milestones.filter((m) => boss.damagedMilestones.includes(m.id)).reduce((s, m) => s + m.damage, 0)
  return Math.max(0, boss.maxHp - dealt)
}

function damageBoss(save: SaveV1, milestoneId: string, now: number): { save: SaveV1; events: DomainEvent[] } {
  const boss = save.boss!
  if (boss.defeatedAt || boss.damagedMilestones.includes(milestoneId)) return { save, events: [] }
  const ms = boss.milestones.find((m) => m.id === milestoneId)
  if (!ms) return { save, events: [] }
  const nextBoss: BossCampaign = { ...boss, damagedMilestones: [...boss.damagedMilestones, milestoneId] }
  const hp = bossHp(nextBoss)
  const events: DomainEvent[] = [{ type: 'BOSS_DAMAGED', bossId: boss.id, damage: ms.damage, hp }]
  const allDone = nextBoss.milestones.every((m) => nextBoss.damagedMilestones.includes(m.id))
  let next: SaveV1 = { ...save, boss: nextBoss }
  if (allDone && hp === 0) {
    nextBoss.defeatedAt = now
    next = {
      ...next,
      boss: nextBoss,
      bossHistory: [...save.bossHistory, { id: boss.id, goal: boss.goal, defeatedAt: now }].slice(-50),
    }
    events.push({ type: 'BOSS_DEFEATED', bossId: boss.id, goal: boss.goal })
  }
  return { save: next, events }
}

/** Deterministic cosmetic/achievement unlocks (P1). Never changes reward formulas. */
export function evaluateUnlocks(save: SaveV1, justCompleted?: Quest): { save: SaveV1; events: DomainEvent[] } {
  const events: DomainEvent[] = []
  const completedCount = save.rewardLedger.length
  const lvl = levelInfo(save.player.totalXp).level
  const s = save.player.skills
  const bossDefeats = save.bossHistory.length
  const cosmeticRules: Record<string, boolean> = {
    wooden_sword: completedCount >= 1,
    iron_sword: lvl >= 3,
    travelers_cloak: completedCount >= 5,
    silver_ring: completedCount >= 10,
    sages_staff: s.INT >= 10,
    guardian_shield: s.DIS >= 10,
    golden_crown: lvl >= 10,
    adventurers_badge: bossDefeats >= 1,
  }
  const unlocked = [...save.cosmetics.unlocked]
  for (const c of COSMETICS) {
    if (cosmeticRules[c.id] && !unlocked.includes(c.id)) {
      unlocked.push(c.id)
      events.push({ type: 'ITEM_UNLOCKED', itemId: c.id, name: c.name })
    }
  }
  const achRules: Record<string, boolean> = {
    first_quest: completedCount >= 1,
    first_level_up: lvl >= 2,
    five_quests: completedCount >= 5,
    first_boss: bossDefeats >= 1,
    goal_achieved: save.achievements.includes('goal_achieved') || justCompleted?.difficulty === 'major',
    consistent: save.activeDays.length >= 3,
    knowledge_seeker: s.INT >= 10,
    balanced_hero: s.STR >= 5 && s.INT >= 5 && s.DIS >= 5 && s.SOC >= 5,
  }
  const achievements = [...save.achievements]
  for (const a of ACHIEVEMENTS) {
    if (achRules[a.id] && !achievements.includes(a.id)) {
      achievements.push(a.id)
      events.push({ type: 'ACHIEVEMENT_UNLOCKED', achievementId: a.id, name: a.name })
    }
  }
  if (!events.length) return { save, events }
  return { save: { ...save, cosmetics: { ...save.cosmetics, unlocked }, achievements }, events }
}

/** Overdue is derived, never stored. */
export function isOverdue(q: Quest, now: number): boolean {
  return (q.status === 'pending' || q.status === 'in_progress' || q.status === 'postponed') && !!q.deadline && q.deadline.at < now
}

export function isOpen(q: Quest): boolean {
  return q.status === 'pending' || q.status === 'in_progress' || q.status === 'postponed'
}

/** Prioritized open quests: in-progress first, then overdue, then by deadline, then oldest. */
export function prioritizedQuests(save: SaveV1, now: number): Quest[] {
  const open = save.quests.filter(isOpen)
  const rank = (q: Quest) => (q.status === 'in_progress' ? 0 : isOverdue(q, now) ? 1 : q.deadline ? 2 : 3)
  return open.sort((a, b) => {
    const r = rank(a) - rank(b)
    if (r) return r
    const da = a.deadline?.at ?? Infinity
    const db = b.deadline?.at ?? Infinity
    if (da !== db) return da - db
    return a.createdAt - b.createdAt
  })
}

/** Today's plan = completed today + open quests that are in progress, daily, or due today/overdue. */
export function todayProgress(save: SaveV1, now: number, tz: string): { done: number; total: number } {
  const today = dayKey(now, tz)
  const done = save.rewardLedger.filter((r) => dayKey(r.at, tz) === today).length
  const planned = save.quests.filter(
    (q) =>
      isOpen(q) &&
      (q.status === 'in_progress' || q.category === 'daily' || (q.deadline !== undefined && dayKey(q.deadline.at, tz) <= today)),
  ).length
  return { done, total: done + planned }
}
