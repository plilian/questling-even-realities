import { useEffect, useState } from 'react'
import { app, useApp } from '../useApp'
import { formatDateTime, formatRelative } from '../../shared/time'
import { MESSAGE_PROVIDER_BLURBS, MESSAGE_PROVIDER_IDS, MESSAGE_PROVIDER_LABELS, QUICK_REPLIES, REPLY_MAX, type InboxItem } from '../../shared/messages'
import type { InboxView } from '../../app/controller'
import { COMPANIONS } from '../../companion/roster'
import { Sheet } from '../components/common'

function MessageLine({ m, now, onOpen, needs }: { m: InboxItem; now: number; onOpen: () => void; needs?: boolean }) {
  return (
    <li>
      <button type="button" className="msgline" onClick={onOpen} aria-label={`${m.from}: ${m.provider === 'gmail' ? m.title : m.preview} — open`}>
        <span className={`app-badge ${m.provider}`} aria-hidden="true">
          {m.provider === 'gmail' ? '✉' : m.provider === 'slack' ? '#' : m.provider === 'github' ? <svg viewBox="0 0 16 16" width="15" height="15"><path d="M5 3.5a1.5 1.5 0 1 1-2 1.4v6.2a1.5 1.5 0 1 1-1 0V4.9A1.5 1.5 0 0 1 5 3.5Zm7 0a1.5 1.5 0 0 1-.5 2.9V8a3 3 0 0 1-3 3H6.4l1.3 1.3-.7.7L4.5 10.5 7 8l.7.7L6.4 10h2.1a2 2 0 0 0 2-2V6.4A1.5 1.5 0 0 1 12 3.5Z" fill="currentColor" /></svg> : <svg viewBox="0 0 16 16" width="15" height="15"><path d="M1.5 7.6 14 2.2l-2.3 11.4-4-3.1-2 2 .3-3.3 5-4.6-6.3 3.9z" fill="currentColor" /></svg>}
        </span>
        <span className="ml-txt">
          <span className="ml-top">
            <b>{m.provider === 'github' ? m.where : m.from}</b>
            <span className="tiny muted">
              {needs && <span className="needs-t">needs you · </span>}
              {m.provider === 'github' ? m.preview.split(' · ')[0] : m.where} · {formatRelative(m.at, now)}
            </span>
          </span>
          <span className="ml-body">{m.provider === 'gmail' || m.provider === 'github' ? m.title : m.preview || m.title}</span>
        </span>
        {m.important && <span className="ml-dot" aria-label="Important" />}
      </button>
    </li>
  )
}

function MessageProviderCard({ v }: { v: InboxView }) {
  const s = useApp()
  const st = v.status
  const live = st.state === 'connected' || st.state === 'demo'
  return (
    <div className="panel integ">
      <div className="integ-head">
        <div>
          <b>{v.name}</b>
          <span className="small muted">{MESSAGE_PROVIDER_BLURBS[v.provider]}</span>
        </div>
        <span className={`pill ${st.state === 'connected' ? 'on' : st.state === 'demo' ? 'demo' : ''}`}>
          <i /> {st.state === 'demo' ? 'demo' : st.state.replace('_', ' ')}
        </span>
      </div>
      {!live && st.state !== 'linking' && (
        <>
          {st.state === 'expired' && <p className="small" style={{ color: 'var(--warn)' }}>Access ended (sessions are short by design). Reconnect to continue.</p>}
          {st.state === 'permission_missing' && <p className="small" style={{ color: 'var(--warn)' }}>Permission was not granted, so nothing was connected.</p>}
          {st.state === 'unavailable' && <p className="small" style={{ color: 'var(--warn)' }}>Couldn’t reach the Questling server ({st.reason.replace(/_/g, ' ')}).</p>}
          <button type="button" className="btn block" disabled={!v.configured} onClick={() => void app.connectInbox(v.provider)}>
            Connect {v.name}
          </button>
          {!v.configured && <p className="tiny muted">{s.server.reachable ? 'Not set up on this server yet (setup: docs/DEPLOYMENT.md).' : 'Server offline.'}</p>}
        </>
      )}
      {st.state === 'linking' && (
        <>
          <p className="small">Sign in happens in a real browser, not inside the glasses app. Open this page on your phone or computer and enter the code:</p>
          <div className="receipt" style={{ textAlign: 'center' }}>
            <div className="line" style={{ wordBreak: 'break-all', fontSize: 15 }}>
              {st.linkUrl}
            </div>
            <div style={{ font: '700 30px/1.2 ui-monospace, monospace', letterSpacing: '0.16em', margin: '6px 0' }}>{st.userCode}</div>
            <div className="target">Code expires {formatRelative(st.expiresAt, Date.now())}. Questling links itself when you finish.</div>
          </div>
          <div className="grid2">
            <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(`${st.linkUrl}?code=${st.userCode}`).then(() => app.toast('Link copied'))}>
              Copy link
            </button>
            <button type="button" className="btn" onClick={() => app.cancelInboxLink(v.provider)}>
              Cancel
            </button>
          </div>
        </>
      )}
      {live && (
        <>
          <p className="tiny muted" style={{ margin: '0 0 8px' }}>
            {v.label}
            {st.state === 'connected' ? ` · access ends ${formatDateTime(st.expiresAt, s.tz)}` : ' · synthetic messages, nothing is sent'}
            {!v.canReply && st.state === 'connected' ? ' · read-only' : ''}
          </p>
          {v.error && <p className="small" style={{ color: 'var(--warn)' }}>Couldn’t load messages ({v.error.replace(/_/g, ' ')}).</p>}
          {v.items.length ? (
            <ul className="msglist">
              {v.items.slice(0, 6).map((m) => (
                <MessageLine key={m.id} m={m} now={s.now} onOpen={() => app.openMessage(m.provider, m.id)} />
              ))}
            </ul>
          ) : (
            !v.busy && v.fetchedAt && !v.error && <p className="small muted">All caught up.</p>
          )}
          <div className="grid2" style={{ marginTop: 10 }}>
            <button type="button" className="btn" disabled={v.busy} onClick={() => void app.refreshInbox(v.provider, true)}>
              {v.busy ? 'Loading…' : 'Refresh'}
            </button>
            <button type="button" className="btn danger" onClick={() => void app.disconnectInbox(v.provider)}>
              Disconnect
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** Camp → Mail & chat */
export function MessageIntegrations() {
  const s = useApp()
  return (
    <>
      <div className="section">
        <h3>Mail & chat</h3>
        <span className="tiny muted">optional</span>
      </div>
      <p className="small muted" style={{ margin: '0 2px 10px' }}>
        Your companion gives you a heads-up when something important arrives, and helps you answer — on the glasses with a tap or your voice. Gmail shares only who wrote and the subject — never the message itself. Telegram uses your own bot. Nothing is sent until you confirm the exact words.
      </p>
      {MESSAGE_PROVIDER_IDS.map((p) => (
        <MessageProviderCard key={p} v={s.inbox[p]} />
      ))}
    </>
  )
}

/** Today → newest messages from connected accounts. */
export function InboxGlance() {
  const s = useApp()
  const rank = { reply: 0, later: 1, fyi: 2 } as const
  const tri = (m: InboxItem) => s.triage[`${m.provider}:${m.id}`] ?? 'later'
  const items = MESSAGE_PROVIDER_IDS.flatMap((p) => s.inbox[p].items).sort((a, b) => rank[tri(a)] - rank[tri(b)] || b.at - a.at)
  const connected = MESSAGE_PROVIDER_IDS.some((p) => s.inbox[p].status.state === 'connected' || s.inbox[p].status.state === 'demo')
  if (!connected) return null
  return (
    <>
      <div className="section">
        <h3>Messages</h3>
        <span className="tiny faint">{items.length ? `${items.length} new` : 'all caught up'}</span>
      </div>
      {items.length > 0 && (
        <ul className="msglist panel" style={{ padding: '4px 14px' }}>
          {items.slice(0, 3).map((m) => (
            <MessageLine key={`${m.provider}:${m.id}`} m={m} now={s.now} needs={tri(m) === 'reply'} onOpen={() => app.openMessage(m.provider, m.id)} />
          ))}
        </ul>
      )}
    </>
  )
}

/** Read a message and reply — typed, or drafted by the companion; always confirmed verbatim. */
export function ReplySheet() {
  const s = useApp()
  const t = s.replyTarget
  const m = t ? s.inbox[t.provider].items.find((x) => x.id === t.id) : undefined
  const [text, setText] = useState('')
  const tp = t?.provider
  const tid = t?.id
  useEffect(() => {
    setText('')
    if (tp && tid) void app.suggestReplies(tp, tid)
  }, [tp, tid])
  if (!t || !m) return null
  const c = COMPANIONS[s.save.companion.id]
  const pending = s.proposal?.status === 'pending' || s.proposal?.status === 'executing'
  if (pending) return null
  const suggested = s.replySuggestions[`${t.provider}:${t.id}`] ?? []
  const note = s.messageNotes[`${t.provider}:${t.id}`]
  return (
    <Sheet label={`Message from ${m.from}`} onClose={() => app.closeMessage()}>
      <div className="eyebrow">
        {MESSAGE_PROVIDER_LABELS[m.provider]}
        {m.where && m.where !== MESSAGE_PROVIDER_LABELS[m.provider] ? ` · ${m.where}` : ''} · {formatRelative(m.at, s.now)}
        {s.mode === 'demo' ? ' · demo' : ''}
      </div>
      <h2 style={{ marginTop: 6 }}>{m.provider === 'github' ? m.where : m.from}</h2>
      <div className="receipt">
        <div className="line">{m.provider === 'gmail' || m.provider === 'github' ? `“${m.title}”` : m.preview}</div>
        {m.provider === 'github' && <div className="target">{m.preview} — open it on GitHub to review.</div>}
        {m.provider === 'gmail' && <div className="target">Questling sees the sender and subject only — open Gmail for the full message.</div>}
        {note && (
          <div className="target" style={{ color: '#3a2f22' }}>
            <b>{note.kind === 'summary' ? 'Summary' : 'Translation'} ({s.chat.label}):</b> {app.finalize(note.line, s.save.companion.id).text}
          </div>
        )}
      </div>
      {s.aiReady && m.provider !== 'gmail' && (
        <div className="quick" style={{ marginTop: 10 }}>
          <button type="button" className="chipbtn" disabled={!!s.assisting} onClick={() => void app.messageHelp(m.provider, m.id, 'summary')}>
            {s.assisting === 'summary' ? 'Summarizing…' : 'Summarize'}
          </button>
          <button type="button" className="chipbtn" disabled={!!s.assisting} onClick={() => void app.messageHelp(m.provider, m.id, 'translation')}>
            {s.assisting === 'translation' ? 'Translating…' : 'Translate to English'}
          </button>
        </div>
      )}
      {m.canReply ? (
        <>
          {(suggested.length > 0 || s.assisting === `suggest:${t.provider}:${t.id}`) && (
            <div className="quick" role="group" aria-label={`Suggested by ${c.name}`} style={{ marginTop: 12 }}>
              <span className="label" style={{ width: '100%' }}>Suggested by {c.name}{s.assisting === `suggest:${t.provider}:${t.id}` ? ' · writing…' : ''}</span>
              {suggested.map((q) => (
                <button key={q} type="button" className="chipbtn ai" onClick={() => setText(q)}>
                  {q}
                </button>
              ))}
            </div>
          )}
          <div className="quick" role="group" aria-label="Quick replies" style={{ marginTop: 12 }}>
            {QUICK_REPLIES.map((q) => (
              <button key={q} type="button" className="chipbtn" onClick={() => setText(q)}>
                {q}
              </button>
            ))}
          </div>
          <label className="field" style={{ marginTop: 10 }}>
            <span className="label">Your reply</span>
            <textarea value={text} maxLength={REPLY_MAX} placeholder={m.provider === 'gmail' ? 'Thanks — I’ll send the numbers by 2:30.' : 'On it, before 3.'} onChange={(e) => setText(e.target.value)} />
          </label>
          <div className="grid2">
            <button type="button" className="btn" disabled={s.chat.sending} onClick={() => void app.draftReply(m.provider, m.id, text)}>
              {s.chat.sending ? `${c.name} is drafting…` : text.trim() ? `Polish with ${c.name}` : `Draft with ${c.name}`}
            </button>
            <button type="button" className="btn primary" disabled={!text.trim()} onClick={() => app.proposeReply(m.provider, m.id, text)}>
              Review & send
            </button>
          </div>
          <p className="tiny faint" style={{ marginBottom: 0 }}>
            {m.provider === 'telegram' && m.where !== 'Telegram' ? 'Replies are sent by your Telegram bot' : `Replies go out as you, from your own ${MESSAGE_PROVIDER_LABELS[m.provider]}`}, only after you confirm the exact text. They are always kept clean, whatever mode {c.name} is in.
          </p>
        </>
      ) : m.provider === 'github' ? (
        <div className="grid2" style={{ marginTop: 14 }}>
          <button type="button" className="btn primary" onClick={() => app.messageToQuest(m.provider, m.id)}>
            Add as quest
          </button>
          <button type="button" className="btn" onClick={() => app.markRead(m.provider, m.id)}>
            Mark as read
          </button>
        </div>
      ) : (
        <p className="small muted">Read-only access: reconnect and allow sending to reply from here.</p>
      )}
      {m.provider !== 'github' && (
        <button type="button" className="tr-hide" style={{ marginTop: 10 }} onClick={() => app.messageToQuest(m.provider, m.id)}>
          Add as a quest instead
        </button>
      )}
    </Sheet>
  )
}
