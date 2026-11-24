/** Tiny server-rendered pages for the external-browser link flow (Calendar and task integrations). No scripts. */

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

const STYLE = `
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#101410;color:#E5DFC7;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:420px;padding:28px;margin:20px;background:#19251D;border:2px solid #2c3d31;border-radius:14px}
h1{font-size:22px;margin:0 0 4px;color:#D7B875;letter-spacing:.02em}
.motto{margin:0 0 18px;color:#9fb3a4;font-size:13px}
p{margin:0 0 14px}
ul{margin:0 0 16px;padding-left:20px}
input{width:100%;box-sizing:border-box;font:600 22px/1 ui-monospace,monospace;letter-spacing:.18em;text-transform:uppercase;padding:12px;border-radius:10px;border:2px solid #75D89A;background:#101410;color:#E5DFC7;text-align:center}
button{margin-top:14px;width:100%;padding:13px;border:0;border-radius:10px;background:#75D89A;color:#101410;font-weight:700;font-size:16px;cursor:pointer}
.small{font-size:13px;color:#9fb3a4}
.ok{color:#75D89A}.err{color:#ff9b85}`

export function linkPage(code: string, configured: boolean): string {
  const body = configured
    ? `<p>Enter the code shown in Questling to connect your account (Google Calendar, Google Tasks, Gmail, Slack, Telegram, GitHub, Todoist or Notion — the code knows which).</p>
<p class="small">What Questling can do once connected:</p>
<ul class="small"><li><b>Calendar</b>: read titles and times of events you own; create focus blocks or move your own events</li><li><b>Tasks</b> (Todoist, Notion, Google Tasks): read open tasks (title and due date only) and mark one done</li><li><b>Mail &amp; chat</b>: Gmail — sender and subject of unread mail (never the message body) and send a reply; Slack — messages that mention you and a reply in that thread; Telegram — messages to your own bot (and, if you connect it under Telegram Business, your private chats) and a reply you approve</li></ul>
<p class="small">Every change or message needs your confirmation in Questling first. It never deletes anything or invites anyone. Access is held only in server memory for a few hours; nothing is stored in a database.</p>
<form method="GET" action="/api/auth/start"><input name="code" value="${esc(code)}" placeholder="ABCD-1234" maxlength="9" autocomplete="off" required><button type="submit">Continue</button></form>`
    : `<p class="err">No integrations are configured on this server.</p>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Questling · Connect</title><style>${STYLE}</style></head><body><main><h1>Questling</h1><p class="motto">A little companion. A bigger adventure.</p>${body}</main></body></html>`
}

export function resultPage(ok: boolean, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Questling · Connect</title><style>${STYLE}</style></head><body><main><h1>Questling</h1><p class="motto">A little companion. A bigger adventure.</p><p class="${ok ? 'ok' : 'err'}">${esc(message)}</p><p class="small">You can close this tab.</p></main></body></html>`
}

/** GitHub notifications only accept a classic personal access token; ask for the narrowest one. */
export function githubPage(code: string, error?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Questling · GitHub</title><style>${STYLE}
input.tok{font:14px/1.3 ui-monospace,monospace;letter-spacing:0;text-transform:none;text-align:left}ol{margin:0 0 14px;padding-left:20px}li{margin-bottom:6px}</style></head><body><main><h1>Questling · GitHub</h1><p class="motto">A little companion. A bigger adventure.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<ol class="small"><li>On github.com open <b>Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic)</b>.</li><li>Name it “Questling”, pick a short expiration and tick <b>only</b> the <b>notifications</b> scope.</li><li>Paste the token below.</li></ol>
<p class="small">GitHub's notifications API accepts only classic tokens; with just the notifications scope Questling can list your notifications (repository, title, reason) and mark one read after you confirm — nothing else. The token stays in this server's memory for at most 12 hours.</p>
<form method="POST" action="/api/auth/github"><input type="hidden" name="code" value="${esc(code)}"><input class="tok" type="password" name="token" placeholder="ghp_…" autocomplete="off" spellcheck="false" required><button type="submit">Connect GitHub</button></form></main></body></html>`
}

/** Telegram needs no OAuth app: the user pastes their own bot token here (browser → server only, POST body). */
export function telegramPage(code: string, error?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Questling · Telegram</title><style>${STYLE}
input.tok{font:14px/1.3 ui-monospace,monospace;letter-spacing:0;text-transform:none;text-align:left}ol{margin:0 0 14px;padding-left:20px}li{margin-bottom:6px}</style></head><body><main><h1>Questling · Telegram</h1><p class="motto">A little companion. A bigger adventure.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<ol class="small"><li>In Telegram, open <b>@BotFather</b>, send <b>/newbot</b> and follow the steps. Use a new bot just for Questling.</li><li>Copy the token BotFather gives you and paste it below.</li><li><b>Optional — your own private chats:</b> in BotFather open <b>/mybots</b> → your bot → <b>Bot Settings → Business Mode → Turn on</b>. Then in Telegram go to <b>Settings → Telegram Business → Chatbots</b>, add your bot, pick the chats it may see and allow <b>Reply to messages</b>.</li></ol>
<p class="small">Without step 3, Questling sees messages sent to your bot and group messages that mention it, and replies come from the bot. With it, Questling sees the private chats you allowed and replies as you — only after you confirm each reply. The token stays in this server's memory for at most 12 hours and is never shown to the app.</p>
<form method="POST" action="/api/auth/telegram"><input type="hidden" name="code" value="${esc(code)}"><input class="tok" type="password" name="token" placeholder="123456789:AA…" autocomplete="off" spellcheck="false" required><button type="submit">Connect Telegram</button></form></main></body></html>`
}
