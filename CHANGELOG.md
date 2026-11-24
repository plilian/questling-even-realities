# Changelog

## 1.0.0 — Heads Up build week (Nov 23–29, 2026)

**Glasses (Even Hub SDK, official simulator)**
- Glanceable home: next meeting · next quest · who needs you · progress.
- Proactive heads-ups with cooldowns, quiet hours, mute and a daily cap; meeting reminders with *Prep me* and *Running late*.
- *Plan my day*, *Catch me up*, end-of-day recap, focus sessions with a countdown.
- Triaged inbox (Gmail, Slack, Telegram, GitHub), tap-only quick replies and AI-written suggestions, every reply confirmed word for word and verified after sending.
- Quest journal, quest detail, completion celebration, character sheet, push-to-talk voice.

**Phone (WebView)**
- Four tabs — Today, Quest Journal, Character, Camp — and a conversation sheet with the companion.
- Training: seven real steps under the XP bar that teach the assistant by doing it.
- Five companions with 8 expressions and reaction animations, each with its own voice and way of solving the same problem.
- 18+ Language Mode for the Savage: off by default, adult attestation, *Strong* and *Full 18+* tiers, instant clean switch-off.

**Integrations (stateless server, tokens in memory only)**
- Google Calendar read/write (focus blocks, reschedule) with exact confirmation and read-back verification.
- Gmail (metadata + send), Slack (mentions + thread replies), Telegram (your own bot, Business mode, `/quest` capture), GitHub notifications (mark as read).
- Todoist, Notion and Google Tasks: import open tasks as quests, tick them off at the source after confirmation.
- AI: Gemini by default; optional OpenAI, Claude (Anthropic), OpenRouter or Ollama. Every action is a validated proposal you confirm.

**Quality**
- 155 unit/integration tests, 31 browser end-to-end checks, a 22-step scripted run in the official simulator with 0 errors.
- Glasses list rows are clipped by UTF-8 bytes to the SDK's 63-byte limit (found in the simulator).
