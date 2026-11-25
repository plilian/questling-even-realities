import { z } from 'zod'

/**
 * "Ask my notes" (Notion pages shared with Questling) and the Telegram channel digest.
 * Both hand third-party text to the app and, on request, to the AI — minimized and bounded.
 */

/** One Notion page that matched a question: title plus a short excerpt (never the whole page). */
export const NoteHitSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().max(120),
  text: z.string().max(1500),
  editedAt: z.number().int().nullable(),
})
export type NoteHit = z.infer<typeof NoteHitSchema>

export const NOTES_QUESTION_MAX = 200

/** Recent posts of one Telegram channel or group the user's bot can read. */
export const DigestChannelSchema = z.object({
  id: z.string().min(1).max(32),
  title: z.string().max(80),
  kind: z.enum(['channel', 'group']),
  posts: z.array(z.object({ text: z.string().max(300), at: z.number().int() })).max(10),
})
export type DigestChannel = z.infer<typeof DigestChannelSchema>

const STOP = new Set(
  'the and for with that this what when where which who whom whose why how are was were been being have has had did does doing about into from your you our ours mine my me we they them their there here then than but not any all can could would should will shall may might must just also only very more most some such each other again once over under after before between during until while of to in on at by is it be do an a or if as so no yes up out off too own same both few nor i its it\'s notes note page pages tell show give find please did know'.split(' '),
)

/** Content words of a question, lowercased, de-duplicated, longest first (max 5). */
export function keywords(q: string): string[] {
  const words = (q.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []).map((w) => w.replace(/'s$/, ''))
  const out: string[] = []
  for (const w of words) if (w.length >= 3 && !STOP.has(w) && !out.includes(w)) out.push(w)
  return out.sort((a, b) => b.length - a.length).slice(0, 5)
}

/** How well a text matches the keywords (title hits count three times). */
export function matchScore(title: string, text: string, kws: string[]): number {
  const t = title.toLowerCase()
  const b = text.toLowerCase()
  let s = 0
  for (const k of kws) {
    if (t.includes(k)) s += 3
    if (b.includes(k)) s += 1
  }
  return s
}

/** The lines of a text that mention the keywords (with the line after), up to `max` characters. */
export function excerpt(lines: string[], kws: string[], max = 1200): string {
  const pick = new Set<number>()
  lines.forEach((l, i) => {
    const low = l.toLowerCase()
    if (kws.some((k) => low.includes(k))) {
      pick.add(i)
      if (i + 1 < lines.length) pick.add(i + 1)
    }
  })
  const chosen = (pick.size ? [...pick].sort((a, b) => a - b).map((i) => lines[i]!) : lines).filter((l) => l.trim())
  let out = ''
  for (const l of chosen) {
    if (out.length + l.length + 1 > max) break
    out += (out ? '\n' : '') + l
  }
  return out || (chosen[0] ?? '').slice(0, max)
}
