import type { Difficulty, Skill } from '../shared/schema'

/** Deterministic reward table. AI may propose difficulty; the engine maps it. */
export const REWARDS: Record<Difficulty, { xp: number; skillPoints: number }> = {
  easy: { xp: 20, skillPoints: 1 },
  normal: { xp: 40, skillPoints: 2 },
  hard: { xp: 70, skillPoints: 3 },
  major: { xp: 100, skillPoints: 4 },
  recovery: { xp: 20, skillPoints: 1 },
}

export function rewardFor(difficulty: Difficulty, skill: Skill | null): { xp: number; skillPoints: number } {
  const r = REWARDS[difficulty]
  if (!r) return { xp: 0, skillPoints: 0 }
  return { xp: r.xp, skillPoints: skill ? r.skillPoints : 0 }
}

/** XP required to go from level L to L+1. */
export function xpToNext(level: number): number {
  return 100 + 50 * (level - 1)
}

export interface LevelInfo {
  level: number
  /** XP accumulated inside the current level */
  into: number
  /** XP needed to complete the current level */
  need: number
  totalXp: number
}

/** Level derived from cumulative XP by subtracting thresholds sequentially (no overflow lost). */
export function levelInfo(totalXp: number): LevelInfo {
  let xp = Math.max(0, Math.floor(totalXp))
  let level = 1
  while (xp >= xpToNext(level) && level < 10_000) {
    xp -= xpToNext(level)
    level += 1
  }
  return { level, into: xp, need: xpToNext(level), totalXp: Math.max(0, Math.floor(totalXp)) }
}

/** Total XP required to reach `level` from zero. */
export function totalXpForLevel(level: number): number {
  let t = 0
  for (let l = 1; l < level; l++) t += xpToNext(l)
  return t
}

export const BOSS_MAX_HP = 1000

/** Damage per milestone: floor(1000/n), remainder on the final milestone (fixed order). */
export function bossDamageSplit(n: number): number[] {
  if (n < 1) return []
  const base = Math.floor(BOSS_MAX_HP / n)
  const arr = Array.from({ length: n }, () => base)
  arr[n - 1] = base + (BOSS_MAX_HP - base * n)
  return arr
}

export const COSMETICS = [
  { id: 'wooden_sword', name: 'Wooden Sword', unlock: 'Complete your first quest' },
  { id: 'iron_sword', name: 'Iron Sword', unlock: 'Reach level 3' },
  { id: 'travelers_cloak', name: "Traveler's Cloak", unlock: 'Complete 5 quests' },
  { id: 'silver_ring', name: 'Silver Ring', unlock: 'Complete 10 quests' },
  { id: 'sages_staff', name: "Sage's Staff", unlock: 'Reach INT 10' },
  { id: 'guardian_shield', name: 'Guardian Shield', unlock: 'Reach DIS 10' },
  { id: 'golden_crown', name: 'Golden Crown', unlock: 'Reach level 10' },
  { id: 'adventurers_badge', name: "Adventurer's Badge", unlock: 'Defeat your first boss' },
] as const
export type CosmeticId = (typeof COSMETICS)[number]['id']

export const ACHIEVEMENTS = [
  { id: 'first_quest', name: 'First Quest', desc: 'Complete a quest' },
  { id: 'first_level_up', name: 'First Level Up', desc: 'Reach level 2' },
  { id: 'five_quests', name: 'Five Quests', desc: 'Complete 5 quests' },
  { id: 'first_boss', name: 'First Boss', desc: 'Defeat a boss campaign' },
  { id: 'goal_achieved', name: 'Goal Achieved', desc: 'Complete a major milestone quest' },
  { id: 'consistent', name: 'Consistent Adventurer', desc: 'Complete quests on 3 different days' },
  { id: 'knowledge_seeker', name: 'Knowledge Seeker', desc: 'Reach INT 10' },
  { id: 'balanced_hero', name: 'Balanced Hero', desc: 'All four skills at 5 or more' },
] as const
export type AchievementId = (typeof ACHIEVEMENTS)[number]['id']
