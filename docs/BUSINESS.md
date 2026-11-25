# Business model

## Who it's for

People whose day is meetings and messages and who already wear, or would wear, smart glasses:

- **Founders, managers and consultants:** back-to-back meetings, people waiting on replies, a calendar that keeps moving.
- **Sales and customer-facing teams:** a brief before every call, quick replies between calls.
- **Developers:** review requests and mentions on GitHub, team chat on Slack or Telegram.
- **Anyone who mutes reminders:** Questling speaks up rarely, at the right moment, and in a voice they picked.

The job Questling does is "**tell me the one thing that matters and let me act on it without picking up my phone.**" That's a daily habit, which makes a subscription natural.

## How a local-first app makes money

Local-first means **your data lives on your device**. Questling doesn't keep accounts, profiles or message history on a server, and it never sells or mines data. That's a selling point, not a limitation.

What costs money, and what people will pay for, is the **service around the app**:

1. **AI work.** Every briefing, inbox triage, reply draft, notes answer, channel digest and voice transcription is a paid model call.
2. **A hosted server people don't have to build.** Connecting Gmail, Calendar, Slack and Notion needs registered OAuth apps (Gmail's read scope needs Google's verification for public use), an always-on HTTPS server and maintenance. Almost no one wants to set that up themselves.
3. **Convenience:** one-tap setup, a shared Questling Telegram bot instead of creating your own, updates and new companions.

So Questling sells the **service, not the data**. The free, open-source app stays fully usable by anyone who runs their own server with their own AI key.

## Plans (proposal)

| Plan | Price | What you get |
|---|---|---|
| **Free** | $0 | The app, all five companions, quests, RPG progress, Training and demo mode. Bring your own server and AI key (open source, MIT) |
| **Questling Plus** | **$5 / month** or **$48 / year** | Hosted server, a monthly AI allowance (briefings, triage, AI replies, Ask my notes, channel digest, voice), every integration with one-tap setup, the shared Telegram bot |
| **Teams** | per seat, per month | Plus for a company: admin controls (which integrations, data rules), SSO, team channel digests, and a **self-hosted option** so nothing leaves the company network |
| **Companions & seasons** | small one-time purchases | Extra companions, outfits and seasonal quest packs. They fit the RPG and never gate productivity |

## How billing works without accounts

- **A purchase gives a signed license key.** The app keeps it on the device and sends it with each request to the hosted server.
- **The server checks the signature and expiry statelessly.** It needs no user database.
- **Usage limits come from short-lived counters keyed by a hash of the license.** That's the same kind of in-memory rate limit Questling already uses, not a user record.
- **Payments stay with a payment provider or an app store.** Questling's server never sees card details.

**Not in this build:** payments and licensing. The hackathon build has no payments by design.

## Costs and margins

- **AI is the main variable cost.** Questling minimizes context by design: opaque references, titles instead of bodies, at most six messages or documents per request. Fast "flash-class" models keep a typical day (briefing, a few triages, several drafts, a notes answer) well inside the Plus price. Each plan has an allowance, with a softer fallback to local summaries when it runs out, and that fallback already exists.
- **The servers are stateless.** They scale horizontally with no database to run or secure.
- **Teams self-hosting** moves infrastructure cost to the customer.

## Getting users

1. **Even Hub catalogue:** Questling is built as an Even Hub app (`.ehpk`), listed where G2 owners look for apps.
2. **Telegram:** the shared bot and the channel digest make Questling useful inside communities G2 owners are already in.
3. **Teams on Slack and Google Workspace:** pilots with small teams, then per-seat Teams plans.
4. **Open source:** developers self-host, contribute integrations and recommend Plus to people who don't want to run servers.

## Why people will trust it

- **Data stays on the device.** Tokens live only in server memory and expire within hours.
- **Every write is shown word for word, confirmed and verified.**
- **Scopes are least-privilege** (Gmail metadata, only calendars you own, the GitHub `notifications` scope).
- **No ads, no data resale.** The business is the subscription.
