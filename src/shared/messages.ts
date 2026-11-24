import { z } from 'zod'

/** Mail & chat: Gmail, Slack and Telegram. Read a minimized inbox; reply only after confirmation. */
export const MESSAGE_PROVIDER_IDS = ['gmail', 'slack', 'telegram', 'github'] as const
export type MessageProviderId = (typeof MESSAGE_PROVIDER_IDS)[number]

export const MESSAGE_PROVIDER_LABELS = { gmail: 'Gmail', slack: 'Slack', telegram: 'Telegram', github: 'GitHub' } as const satisfies Record<MessageProviderId, string>
export const MESSAGE_PROVIDER_BLURBS: Record<MessageProviderId, string> = {
  gmail: 'Unread inbox at a glance — sender and subject only — and short replies you approve.',
  slack: 'Heads-ups when someone mentions you, and thread replies you approve.',
  github: 'Review requests, mentions and assignments as heads-ups. Add one as a quest, or mark it read after you confirm.',
  telegram: 'Your own Telegram bot: messages to it and mentions in its groups — and, once you connect it under Telegram Business, your private chats. Replies you approve.',
}

/**
 * Minimized message. Gmail: sender name + subject (no body, no addresses). Slack: who, where and the
 * mention text (already visible to the user in Slack). Everything here is untrusted third-party text.
 */
export const InboxItemSchema = z.object({
  id: z.string().min(1).max(256),
  provider: z.enum(MESSAGE_PROVIDER_IDS),
  from: z.string().max(80),
  title: z.string().max(160),
  preview: z.string().max(220),
  where: z.string().max(60),
  at: z.number().int(),
  important: z.boolean(),
  canReply: z.boolean(),
})
export type InboxItem = z.infer<typeof InboxItemSchema>

export const REPLY_MAX = 1000

/** Tap-only replies for the glasses (no voice, no AI needed). Each still goes through the exact confirmation. */
export const QUICK_REPLIES = ['On it — I’ll get back to you shortly.', 'Thanks, got it!', 'Yes, that works for me.', 'Can we talk later today?'] as const

/** A note the user sent to their own Telegram bot with /quest (or /todo): offered as a quest, confirm-first. */
export const CaptureSchema = z.object({ id: z.string().min(1).max(64), text: z.string().min(1).max(200), from: z.string().max(80), at: z.number().int() })
export type Capture = z.infer<typeof CaptureSchema>
