import { z } from 'zod'

/** Optional task integrations. Tasks are imported as quests; completion can be written back after confirmation. */
export const TASK_PROVIDER_IDS = ['todoist', 'notion', 'google_tasks'] as const
export type TaskProviderId = (typeof TASK_PROVIDER_IDS)[number]

export const TASK_PROVIDER_LABELS: Record<TaskProviderId, string> = {
  todoist: 'Todoist',
  notion: 'Notion',
  google_tasks: 'Google Tasks',
}

export const TASK_PROVIDER_BLURBS: Record<TaskProviderId, string> = {
  todoist: 'Import active tasks as quests; tick them off in Todoist when you finish.',
  notion: 'Use one task database you share with Questling: open rows become quests. “Ask my notes” answers questions from the pages you share.',
  google_tasks: 'Your default Google Tasks list (“My Tasks”) becomes a quest source.',
}

/** Minimized task shape: no descriptions, notes, comments, assignees or labels leave the server. */
export const ExternalTaskSchema = z.object({
  id: z.string().min(1).max(256),
  title: z.string().max(200),
  /** epoch ms of the due date/time, or null */
  due: z.number().int().nullable(),
  /** true when the provider only gave a calendar date (no time) */
  dueAllDay: z.boolean(),
  done: z.boolean(),
  recurring: z.boolean().default(false),
  list: z.string().max(80).optional(),
})
export type ExternalTask = z.infer<typeof ExternalTaskSchema>

export const TaskSourceSchema = z.object({ id: z.string().min(1).max(128), name: z.string().max(120), writable: z.boolean() })
export type TaskSource = z.infer<typeof TaskSourceSchema>

/** Parse a provider date ("YYYY-MM-DD" or RFC 3339) into epoch ms. Date-only values are read as local noon of that day in tz-agnostic UTC terms. */
export function parseDue(value: string | null | undefined): { due: number | null; dueAllDay: boolean } {
  if (!value) return { due: null, dueAllDay: false }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const t = Date.parse(`${value}T12:00:00Z`)
    return Number.isFinite(t) ? { due: t, dueAllDay: true } : { due: null, dueAllDay: false }
  }
  const t = Date.parse(value)
  return Number.isFinite(t) ? { due: t, dueAllDay: false } : { due: null, dueAllDay: false }
}
