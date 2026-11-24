import type { AdultSettings, CompanionId, ProfanityLevel, RoastIntensity } from '../shared/schema'

/**
 * Language/consent policy (18+ Language Mode).
 * Trusted local state only. AI output, imports, deep links and tools can never raise the tier.
 */
export type Tier = 'clean' | 'mild' | 'strong' | 'uncensored'
const TIER_RANK: Record<Tier, number> = { clean: 0, mild: 1, strong: 2, uncensored: 3 }

export interface LanguagePolicy {
  adultEnabled: boolean
  profanityLevel: ProfanityLevel
  roastIntensity: RoastIntensity
  revision: number
}

export function policyFrom(adult: AdultSettings, roast: RoastIntensity): LanguagePolicy {
  const adultEnabled = adult.adultLanguageEnabled && !adult.minorLock && adult.attestedAt !== null
  let level = adult.profanityLevel
  if (!adultEnabled && (level === 'strong' || level === 'uncensored')) level = 'none'
  // Roast intensity is kept; without adult mode the dialogue layer only uses playful clean wording.
  return { adultEnabled, profanityLevel: level, roastIntensity: roast, revision: adult.policyRevision }
}

/** Highest tier a companion may speak at under the policy. Only The Savage uses explicit tiers. */
export function allowedTier(policy: LanguagePolicy, companion: CompanionId): Tier {
  if (companion !== 'savage') return 'clean'
  switch (policy.profanityLevel) {
    case 'none':
      return 'clean'
    case 'mild':
      return 'mild'
    case 'strong':
      return policy.adultEnabled ? 'strong' : 'clean'
    case 'uncensored':
      return policy.adultEnabled ? 'uncensored' : 'clean'
  }
}

export function tierAllowed(tier: Tier, policy: LanguagePolicy, companion: CompanionId): boolean {
  return TIER_RANK[tier] <= TIER_RANK[allowedTier(policy, companion)]
}

// Heuristic detector — NOT a complete safety classifier. Used to keep clean mode clean
// (defence in depth on top of provider safety settings and prompt policy).
const STRONG = [
  /\bf+u+c+k+\w*/i,
  /\bmotherf\w*/i,
  /\bsh[i1]t+\w*/i,
  /\bbullsh[i1]t/i,
  /\bb[i1]tch\w*/i,
  /\bbastard\w*/i,
  /\basshole\w*/i,
  /\bdumbass\w*/i,
  /\bass(es|hat)?\b/i,
  /\bdamn\w*/i,
  /\bgoddamn\w*/i,
  /\bcrap\w*/i,
  /\bpiss\w*/i,
  /\bdick\w*/i,
  /\bwtf\b/i,
  /\bstfu\b/i,
  /\bhell\b/i,
  /f\*+k|s\*+t|f\W?\*/i,
]
// Never allowed in any mode (self-harm encouragement, threats). Provider safety handles hate/harassment.
const NEVER = [/\bkill\s+(your|ur)self\b/i, /\bkys\b/i, /\bi('ll| will)\s+(kill|hurt)\s+you\b/i, /\bgo\s+die\b/i, /\bhurt\s+yourself\b/i]

export function containsProfanity(text: string): boolean {
  return STRONG.some((r) => r.test(text))
}
export function containsForbidden(text: string): boolean {
  return NEVER.some((r) => r.test(text))
}

/** Classify a piece of text conservatively. */
export function classifyText(text: string): Tier {
  return containsProfanity(text) ? 'strong' : 'clean'
}

/** A rendered companion line carrying the metadata needed for final-render validation. */
export interface Line {
  text: string
  tier: Tier
  /** vetted clean variant to substitute when the tier is no longer allowed */
  cleanText: string
  /** policy revision in effect when the line was produced */
  revision: number
  origin: 'local' | 'ai' | 'fallback'
}

export const VETTED_CLEAN_FALLBACK = 'Let’s keep going — what’s the next useful step?'

/**
 * Final-render gate. Validates at display time (not only request time), so lines
 * produced before the user disabled 18+ mode are replaced immediately.
 */
export function finalizeLine(line: Line, policy: LanguagePolicy, companion: CompanionId): Line {
  const safeClean = line.cleanText && !containsProfanity(line.cleanText) && !containsForbidden(line.cleanText) ? line.cleanText : VETTED_CLEAN_FALLBACK
  if (containsForbidden(line.text)) return { ...line, text: safeClean, tier: 'clean', origin: 'fallback' }
  const effectiveTier = line.tier === 'clean' && containsProfanity(line.text) ? 'strong' : line.tier
  const explicit = effectiveTier === 'strong' || effectiveTier === 'uncensored'
  if (explicit) {
    const stale = line.revision !== policy.revision
    if (stale || !tierAllowed(effectiveTier, policy, companion)) {
      return { ...line, text: safeClean, tier: 'clean', origin: 'fallback' }
    }
  }
  if (effectiveTier === 'mild' && !tierAllowed('mild', policy, companion)) {
    return { ...line, text: safeClean, tier: 'clean', origin: 'fallback' }
  }
  return line
}

/** Text that may be persisted in history: explicit text is never stored. */
export function persistableText(line: Line): { text: string; tier: 'clean' | 'mild' } {
  if (line.tier === 'strong' || line.tier === 'uncensored' || containsProfanity(line.text)) {
    return { text: line.cleanText && !containsProfanity(line.cleanText) ? line.cleanText : VETTED_CLEAN_FALLBACK, tier: 'clean' }
  }
  return { text: line.text, tier: line.tier === 'mild' ? 'mild' : 'clean' }
}
