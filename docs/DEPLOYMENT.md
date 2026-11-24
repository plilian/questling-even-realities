# Deployment & configuration

Questling has two parts: the **plugin** (static WebView app, packaged as `.ehpk`) and a **minimal stateless server** (AI proxy — Gemini by default — plus the Calendar, task-list and mail & chat links). Quests, companions and reminders work without the server.

## 1. Local development

```bash
npm i -g npm@11      # npm 10.9 crashes resolving this lockfile
npm ci
cp .env.example .env
npm run dev          # http://localhost:5173 (client + API on one origin)
```

`.env` is git-ignored. Values are read only by the server; nothing secret is ever bundled into the client (enforced by `npm run lint` → `scripts/policy-lint.mjs`).

## 2. Gemini

1. Create a key at https://aistudio.google.com/apikey (check current free/paid terms — on free tiers Google may use prompts to improve products).
2. In `.env`: `GEMINI_API_KEY=…` and optionally `GEMINI_MODEL=gemini-3.8-flash` (default; verified stable on 2026-11-24).
3. Restart `npm run dev`. *Camp → AI companion brain* should show **Gemini ready**; the status dot in the header turns green.
4. Verify: Companion tab → “Break down launching my portfolio” → a *Create 3–5 quests* confirmation appears.

Cost controls: `AI_RATE_PER_MINUTE` (per access token), `AI_DAILY_BUDGET` (global, in-memory, resets on restart), request/response schema validation, 15 s voice cap.

## 2b. Optional extra AI providers

Gemini stays the default. Each extra provider switches on only when its variables are set; the phone only ever sees provider ids and model names. Pick models that support structured (JSON-schema) output and check each vendor’s current model list and terms.

| Provider | `.env` | Notes |
|---|---|---|
| OpenAI | `OPENAI_API_KEY`, `OPENAI_MODEL` (optional `OPENAI_TRANSCRIBE_MODEL`, default `gpt-4o-transcribe`) | Chat Completions with strict `json_schema`; voice via the transcription endpoint |
| Claude (Anthropic) | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Messages API with one forced tool call for structure; text only |
| OpenRouter | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (e.g. `vendor/model`) | OpenAI-compatible; `provider.require_parameters` routes only to endpoints that honour `response_format`; falls back once to JSON mode; text only |
| Ollama | `OLLAMA_MODEL`, optional `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`) | Native `/api/chat` with a JSON-schema `format`; runs next to the server, no key; text only |

`AI_DEFAULT_PROVIDER` chooses who answers when the user leaves the picker on *Automatic*. In the app: *Camp → AI companion brain* lists only the configured providers; the choice is stored on the device (no secret). Text-only providers send voice to a voice-capable provider (Gemini or OpenAI) and the chat bubble says which one answered. All providers share the same rate limit and daily budget.

Verify each one the same way as §2 step 4, after selecting it in the picker.

## 3. Google Calendar

Google forbids OAuth inside embedded WebViews and the Even SDK has no “open system browser” API, so Questling links Calendar through **your phone/desktop browser**:

1. Google Cloud Console → create/select a project → **APIs & Services → Library → Google Calendar API → Enable**.
2. **OAuth consent screen**: External, app name “Questling”, add scope `https://www.googleapis.com/auth/calendar.events.owned`, add your Google account under **Test users** (testing mode needs no verification for test users).
3. **Credentials → Create OAuth client ID → Web application**. Authorized redirect URI must match exactly:
   - local: `http://localhost:5173/api/auth/google/callback`
   - deployed: `https://<your-domain>/api/auth/google/callback`
4. `.env`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, and `APP_BASE_URL` (the public base the browser will open, e.g. `http://localhost:5173`).
5. In Questling: *Camp → Google Calendar → Connect*. Open the shown link in a browser **that can reach the server** (for local testing: the same computer), enter the code, approve. The app links itself within seconds.
6. Live test (use a test calendar): *Home → Find time* or ask “Find 30 minutes for my slides” → confirm → the sheet shows **Done — verified** with the event read back from Google. Cancel must write nothing.

Access is `access_type=online` (~1 h, no refresh token, held only in server memory). Disconnect revokes the token.

## 3b. Task lists — Todoist, Notion, Google Tasks (optional)

All three use the same `/link` page and link code as Calendar. Tokens stay in server memory (≤ 12 h), no refresh tokens are requested, and the only change Questling can make is *mark a task done* after the user confirms.

**Google Tasks** — reuses the Google OAuth client from §3:
1. Same Cloud project → **Library → Google Tasks API → Enable**; on the consent screen add scope `https://www.googleapis.com/auth/tasks`.
2. No new redirect URI: it shares `/api/auth/google/callback`. Set `GOOGLE_TASKS_ENABLED=false` to hide it.

**Todoist**:
1. Todoist → Settings → Integrations → Developer → *Build integrations* (App Management Console) → create an app.
2. OAuth redirect URL: `<APP_BASE_URL>/api/auth/todoist/callback`.
3. `.env`: `TODOIST_CLIENT_ID`, `TODOIST_CLIENT_SECRET`. Scope requested: `data:read_write` (needed to close a task).

**Notion**:
1. notion.so/profile/integrations (Developer portal) → create a **public** connection (OAuth).
2. Redirect URI: `<APP_BASE_URL>/api/auth/notion/callback`.
3. `.env`: `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`. API version sent: `2025-09-03` (override with `NOTION_VERSION`).
4. During consent, share **one task database** that has a title and either a *Done* checkbox or a *Status* property with a “Complete” group.

Live test for each: *Camp → Task lists → Connect* → open the link in a browser, enter the code, approve → tasks appear → *Add* one → finish the quest → the app asks *Tick it off at the source?* → Confirm → the sheet shows **Done — verified**. Cancel must change nothing. Disconnect revokes the token.

## 3c. Mail & chat — Gmail and Slack (optional)

Same `/link` page and link code as Calendar; tokens stay in server memory (≤ 12 h), no refresh tokens. The companion gives a heads-up when something **important** arrives (Gmail’s *Important* label, or a Slack message that @mentions you) and helps you answer. Every reply is shown word for word and sent only after you confirm; the server reads the sent message back before it reports **Done — verified**. Outgoing replies are always clean, whatever the 18+ setting.

**Gmail** — reuses the Google OAuth client from §3:
1. Same Cloud project → **Library → Gmail API → Enable**.
2. Consent screen → add scopes `https://www.googleapis.com/auth/gmail.metadata` and `https://www.googleapis.com/auth/gmail.send`. Keep the app in **Testing** with your account as a test user: `gmail.metadata` is a *restricted* scope, so a public release would need Google verification and a security assessment.
3. No new redirect URI (shares `/api/auth/google/callback`). Set `GMAIL_ENABLED=false` to hide it.
4. What Questling sees: sender name, subject and date of unread inbox mail. Never the body, attachments or other recipients. If you untick *send* on the consent screen it still links, read-only.

**Slack** — install as an internal app in your own workspace:
1. https://api.slack.com/apps → *Create New App* → *From scratch* → pick your workspace.
2. **OAuth & Permissions → User Token Scopes**: `search:read`, `chat:write`, `users:read` (no bot scopes needed). Redirect URL: `<APP_BASE_URL>/api/auth/slack/callback` (Slack requires HTTPS for non-localhost URLs).
3. **Basic Information** → copy *Client ID* and *Client Secret* into `.env` as `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`.
4. What Questling sees: messages from the last 3 days that @mention you (author, channel, first ~220 characters). It does not read DMs or whole channels. Replies go into the message’s thread as you.

Live test for each: *Camp → Mail & chat → Connect* → open the link, enter the code, approve → the list fills → on *Today* tap a message → write or *Draft with* your companion → *Review & send* → Confirm → **Sent and verified**. Send yourself a test first. Cancel must send nothing. Disconnect revokes the token. On the glasses: *Home → Inbox (n)* → a message → *Reply by voice* (needs a voice-capable AI provider).

## 3d. Telegram (optional)

No app registration and no server secret: every user brings their **own bot**.
1. In Telegram, open **@BotFather** → `/newbot` → copy the token. Use a new bot just for Questling (a bot that already uses a webhook or another poller cannot be shared).
2. In Questling: *Camp → Mail & chat → Connect Telegram* → open the shown link in a browser, enter the code, paste the token. The token goes from that browser to your server only (POST body), is checked with `getMe`, kept in server memory ≤ 12 h and never sent to the app.
3. **Bot mode** works right away: direct messages to your bot, and group messages that @mention it or reply to it (add the bot to the group; with BotFather privacy mode on it only sees those).
4. **Your own private chats (Business mode, no Premium needed since May 2026):** BotFather → `/mybots` → your bot → *Bot Settings → Business Mode → Turn on*; then in Telegram *Settings → Telegram Business → Chatbots* → add the bot, choose which chats it may see, allow **Reply to messages**. Questling then lists new private messages and replies **as you** (Telegram allows replies within 24 h of the incoming message).
5. Live test: send yourself a message from a second account → it appears under *Today → Messages* and on the glasses *Inbox* → reply → Confirm → **Sent and verified**. Cancel must send nothing. Disconnect makes Questling forget the token; revoke it in BotFather (`/revoke`) if you want it dead.

`TELEGRAM_ENABLED=false` hides Telegram. Updates are pulled with `getUpdates` only while the app asks (no webhook, no background job).

## 3e. GitHub notifications (optional)

Nothing to register. GitHub's notifications API accepts only **classic** personal access tokens, so each user creates one: github.com → Settings → Developer settings → Personal access tokens → Tokens (classic) → *Generate new token (classic)*, short expiry, **only the `notifications` scope**. In Questling: *Camp → Mail & chat → Connect GitHub* → open the link, enter the code, paste the token. Questling lists unread review requests, mentions and assignments; *Mark as read* is confirm-first and verified by reading the thread back. `GITHUB_ENABLED=false` hides it.

## 4. Production server

```bash
npm run build
NODE_ENV=production ACCESS_CODES=<code1,code2> SESSION_SECRET=<32+ random chars> npm start   # :8787
```

- **Always behind HTTPS** (Caddy example):
  ```
  questling.example.com {
    reverse_proxy 127.0.0.1:8787
  }
  ```
- `ALLOWED_ORIGINS` — exact origins allowed by CORS (CORS is not authorization; every API call also needs an access token).
- `ACCESS_CODES` — required in production; judges/testers enter one in *Camp → AI companion brain*. Tokens are HMAC-signed, 12 h.
- State (rate limits, link codes, Calendar and task-list sessions, budget) is in memory and **cleared on restart** — by design (no database).
- Health: `GET /health`.

### Docker

```bash
docker compose up --build    # reads .env; serves on :8787
```

## 5. Packaging for the Even Hub

```bash
# local-only package (no network permission; AI/voice/Calendar/task lists show as unavailable)
npm run pack

# package that talks to your deployed server
VITE_API_BASE_URL=https://questling.example.com npm run pack
```

`scripts/pack.mjs` writes `build/app.json` with exactly the permissions the build uses (`network` whitelist with your HTTPS origin, `g2-microphone` for push-to-talk) and calls `evenhub pack … --sdk-ver 0.0.16`. Add the server origin to `ALLOWED_ORIGINS` if the WebView sends an `Origin` header.

Uploading/publishing to Even Hub (`evenhub login`, `create`, `upload`, `promote --to beta`) needs an Even Hub developer account.

## 6. Simulator (CI-friendly)

```bash
npm run dev &
xvfb-run -a npx evenhub-simulator --automation-port 9898 "http://127.0.0.1:5173/?demo=reset" &
npm run simulator:auto      # writes evidence/simulator/*.png + run.json
```

Linux needs `libwebkit2gtk-4.1-0`.
