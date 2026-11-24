import type { Quest } from '../../shared/schema'
import { QUEST_ICON_FILES } from './manifest'

/**
 * Picks an item icon for a quest from its title (UI concept: every journal entry has its own
 * object — laptop, dumbbell, bowl…). Icons come from the 6×4 icon sheet, imported by
 * scripts/import_ui_assets.py into public/assets/quest/<id>.png and listed in ./manifest.ts.
 * Until that sheet is imported, the category icon is used.
 */
export const QUEST_ICON_RULES: Array<[string, RegExp]> = [
  ['envelope', /\b(e-?mail|mail|invoice|letter|send|reply|inbox|newsletter)\b/i],
  ['calendar', /\b(meeting|prep|appointment|schedule|standup|interview|sync)\b/i],
  ['dumbbell', /\b(workout|gym|exercise|lift|train(ing)?|push-?ups?|strength)\b/i],
  ['shoe', /\b(run|running|walk|jog|steps|hike|5k|10k)\b/i],
  ['meal', /\b(cook|meal|lunch|dinner|breakfast|eat|recipe|bake)\b/i],
  ['basket', /\b(grocer(y|ies)|shop(ping)?|buy|market|errand)\b/i],
  ['broom', /\b(clean|tidy|laundry|vacuum|dishes|declutter|wash)\b/i],
  ['watering_can', /\b(water|garden|plants?|mow)\b/i],
  ['coins', /\b(pay|bill|budget|bank|tax(es)?|rent|savings|finance)\b/i],
  ['medicine', /\b(pills?|medic(ine|ation)|doctor|dentist|pharmacy|vitamins?|therapy)\b/i],
  ['phone', /\b(call|phone|text|ring|message)\b/i],
  ['palette', /\b(paint|draw|design|sketch|illustrat\w*|art)\b/i],
  ['lute', /\b(music|guitar|piano|sing|practice|song)\b/i],
  ['bed', /\b(sleep|nap|rest|bed(time)?)\b/i],
  ['gift', /\b(gift|birthday|present|anniversary)\b/i],
  ['herb', /\b(meditat\w*|breathe|stretch|yoga|walk outside|mindful\w*)\b/i],
  ['quill', /\b(write|essay|blog|draft|journal|notes?|thesis|chapter \d+ draft)\b/i],
  ['book', /\b(read\w*|chapter|stud\w*|learn\w*|course|lesson|review notes)\b/i],
  ['books', /\b(plan|research|week|organi[sz]e notes|outline)\b/i],
  ['backpack', /\b(organi[sz]e|pack|trip|travel|space|desk)\b/i],
  ['house', /\b(home|house|repair|fix|landlord|move)\b/i],
  ['laptop', /\b(report|update|slides|presentation|code|deploy|pull request|pr|bug|spreadsheet|project|review|website|portfolio)\b/i],
  ['checklist', /\b(todo|to-do|checklist|list|admin|forms?)\b/i],
  ['hourglass', /\b(focus|deadline|timer|pomodoro)\b/i],
]

const CATEGORY_FALLBACK: Record<Quest['category'], string> = { daily: 'icons/cat_daily', personal: 'icons/cat_personal', work: 'icons/cat_work', boss: 'icons/cat_boss' }

/** The item icon a quest title asks for, or null when nothing matches. */
export function pickQuestIcon(title: string, available: readonly string[] = QUEST_ICON_RULES.map(([id]) => id)): string | null {
  for (const [id, re] of QUEST_ICON_RULES) if (re.test(title) && available.includes(id)) return id
  return null
}

/** Asset path (without extension) for a quest's icon. */
export function questIconPath(q: Pick<Quest, 'title' | 'category'>): string {
  const id = QUEST_ICON_FILES.length ? pickQuestIcon(q.title, QUEST_ICON_FILES) : null
  return id ? `quest/${id}` : CATEGORY_FALLBACK[q.category]
}
