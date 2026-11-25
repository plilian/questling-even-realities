import { useState } from 'react'
import { app, useApp } from '../useApp'
import { COMPANIONS } from '../../companion/roster'
import { MESSAGE_PROVIDER_IDS, MESSAGE_PROVIDER_LABELS } from '../../shared/messages'
import { TRAINING_STEPS, TRAINING_TOTAL_XP, type TrainingStepId } from '../../game/training'
import { formatRelative } from '../../shared/time'
import { Sheet, useTicker } from '../components/common'
import { openTalk } from '../talk'

/**
 * Training.
 * One clear next step at a time, a “Show me” that actually does it, XP when it's done for real.
 */
export function TrainingCard({ onCamp, compact = false }: { onCamp?: () => void; compact?: boolean }) {
  // compact = the Character sheet copy: always visible, always lists every step
  const s = useApp()
  const [all, setAll] = useState(false)
  const done = new Set(s.save.training.done.map((t) => t.step))
  const earned = s.save.training.done.reduce((sum, t) => sum + t.xp, 0)
  const next = TRAINING_STEPS.find((t) => !done.has(t.id))
  const inboxReady = MESSAGE_PROVIDER_IDS.some((p) => s.inbox[p].items.some((m) => m.canReply))
  if (s.save.training.hidden && !compact) return null

  const show = (id: TrainingStepId) => {
    switch (id) {
      case 'meet':
        app.markTraining('meet')
        return openTalk()
      case 'plan':
        return void app.planDay()
      case 'catchup':
        return void app.catchUp()
      case 'reply': {
        const m = MESSAGE_PROVIDER_IDS.flatMap((p) => s.inbox[p].items).find((x) => x.canReply)
        if (m) return app.openMessage(m.provider, m.id)
        return onCamp?.()
      }
      case 'focus':
        return void app.startFocus(null)
      case 'complete':
        return document.querySelector('.waxseal, .seal')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      case 'glasses':
        // in the demo the phone simulates the glasses tap; for real it must happen on the G2
        if (s.mode === 'demo') return void app.handleIntent({ type: 'plan_day' })
        return app.toast('On your G2: open the home menu and tap “Plan my day”.', 'info')
    }
  }
  const showLabel = (id: TrainingStepId) => (id === 'reply' && !inboxReady ? 'Connect an inbox' : id === 'complete' ? 'Find a quest' : id === 'glasses' ? (s.mode === 'demo' ? 'Try it (simulated tap)' : 'Show me') : 'Show me')

  return (
    <section className={`training ${compact ? 'compact' : ''}`} aria-label="Training">
      <div className="tr-head">
        <div>
          <div className="tr-kicker">Training · {done.size}/{TRAINING_STEPS.length}</div>
          <b>{next ? next.title : 'Training complete'}</b>
        </div>
        <span className="tr-xp">
          {earned}/{TRAINING_TOTAL_XP} XP
        </span>
      </div>
      <div className="tr-pips" aria-hidden="true">
        {TRAINING_STEPS.map((t) => (
          <i key={t.id} className={done.has(t.id) ? 'on' : next?.id === t.id ? 'next' : ''} />
        ))}
      </div>
      {next ? (
        <>
          <p className="tr-how">{next.id === 'glasses' && s.mode !== 'demo' ? 'On your G2: home menu → “Plan my day” → tap.' : next.how}</p>
          <div className="tr-acts">
            <button type="button" className="btn primary sm" onClick={() => show(next.id)}>
              {showLabel(next.id)} · +{next.xp} XP
            </button>
            {!compact && (
              <button type="button" className="btn sm line" onClick={() => setAll(!all)} aria-expanded={all}>
                {all ? 'Hide steps' : 'All steps'}
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="tr-how">You know the essentials. Your companion will keep nudging at the right moments — and celebrating.</p>
      )}
      {(all || !next || compact) && (
        <ol className="tr-list">
          {TRAINING_STEPS.map((t) => (
            <li key={t.id} className={done.has(t.id) ? 'done' : ''}>
              <span className="tr-check" aria-hidden="true">{done.has(t.id) ? '✓' : ''}</span>
              <span>
                <b>{t.title}</b> <span className="tiny muted">+{t.xp} XP</span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {!compact ? (
        <button type="button" className="tr-hide" onClick={() => void app.hideTraining(true)}>
          {next ? 'Hide from Today' : 'Hide'}
        </button>
      ) : (
        s.save.training.hidden &&
        next && (
          <button type="button" className="tr-hide" onClick={() => void app.hideTraining(false)}>
            Show on Today
          </button>
        )
      )}
    </section>
  )
}

/** A running focus session on Today: time left, done, stop. */
export function FocusBanner() {
  const s = useApp()
  useTicker(15_000)
  const f = s.focus
  if (!f) return null
  const left = Math.max(0, f.endsAt - Date.now())
  const mins = Math.ceil(left / 60_000)
  return (
    <div className="focusbar" role="status">
      <div>
        <div className="tr-kicker">{f.ended ? 'Focus · time’s up' : `Focus · ${mins} min left`}</div>
        <b>{f.title}</b>
        <div className="tiny muted">Heads-ups wait until you’re done. Meetings still come through.</div>
      </div>
      <div className="focus-acts">
        <button type="button" className="btn primary sm" onClick={() => void app.completeFocus()}>
          Done
        </button>
        <button type="button" className="btn sm line" onClick={() => app.stopFocus()}>
          Stop
        </button>
      </div>
    </div>
  )
}

/** Catch me up / Recap / Meeting prep: the same answer the glasses show, as a sheet. */
export function BriefSheet() {
  const s = useApp()
  const b = s.brief
  if (!b) return null
  const pending = s.proposal?.status === 'pending' || s.proposal?.status === 'executing'
  if (pending) return null
  const text = app.finalize(b.line, s.save.companion.id).text
  const c = COMPANIONS[s.save.companion.id]
  return (
    <Sheet label={b.title} onClose={() => app.closeBrief()}>
      <div className="eyebrow">
        {b.origin === 'ai' ? `${c.name} · ${s.chat.label}` : `${c.name} · local summary`}
        {s.mode === 'demo' ? ' · demo data' : ''}
      </div>
      <h2 style={{ marginTop: 6 }}>{b.title}</h2>
      <div className="receipt">
        {text.split('\n').map((l, i) => (
          <div key={i} className="line" style={{ fontSize: 17, margin: '4px 0' }}>
            {l}
          </div>
        ))}
      </div>
      <div className="grid2" style={{ marginTop: 14 }}>
        {b.actions.slice(0, 2).map((a) => (
          <button
            key={a.label}
            type="button"
            className="btn"
            onClick={() => {
              app.closeBrief()
              if (a.intent.type === 'nav' && a.intent.screen.name === 'inbox') return document.querySelector('.msglist')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
              if (a.intent.type === 'nav' && a.intent.screen.name === 'notes') return app.openNotesAsk()
              void app.handleIntent(a.intent)
            }}
          >
            {a.label}
          </button>
        ))}
      </div>
      {b.origin === 'local' && (
        <p className="tiny faint" style={{ marginBottom: 0 }}>
          {b.kind === 'notes' ? 'The best matching lines from your Notion pages.' : b.kind === 'digest' ? 'The latest posts from the channels and groups your bot can read.' : 'Built on this device from your quests, calendar and inbox.'} With an AI provider, {c.name} writes it.
        </p>
      )}
    </Sheet>
  )
}

/** “Ask my notes”: a question about your Notion pages (typed, or one of the suggestions). */
export function NotesSheet() {
  const s = useApp()
  const [q, setQ] = useState('')
  if (!s.notesAsk) return null
  const busy = s.assisting === 'notes'
  const ask = (text: string) => {
    if (text.trim().length < 2 || busy) return
    app.closeNotesAsk()
    void app.askNotes(text, 'phone')
    setQ('')
  }
  return (
    <Sheet label="Ask my notes" onClose={() => app.closeNotesAsk()}>
      <div className="eyebrow">Notion{s.mode === 'demo' ? ' · demo notes' : ''}</div>
      <h2 style={{ marginTop: 6 }}>Ask my notes</h2>
      <p className="small muted" style={{ marginTop: 4 }}>
        Questling searches the Notion pages you shared with it and answers from them, naming the page.
      </p>
      <form
        className="notes-ask"
        onSubmit={(e) => {
          e.preventDefault()
          ask(q)
        }}
      >
        <input aria-label="Your question" placeholder="What did we decide about pricing?" value={q} maxLength={200} onChange={(e) => setQ(e.target.value)} />
        <button type="submit" className="btn primary" disabled={busy || q.trim().length < 2}>
          {busy ? 'Reading…' : 'Ask'}
        </button>
      </form>
      <div className="reply-row" style={{ marginTop: 10 }}>
        {s.notes.questions.map((x) => (
          <button key={x} type="button" className="chipbtn" onClick={() => ask(x)}>
            {x}
          </button>
        ))}
      </div>
    </Sheet>
  )
}

/** Notes sent to your own Telegram bot with “/quest …”: add as a quest (confirm-first) or dismiss. */
export function CaptureCard() {
  const s = useApp()
  if (!s.captures.length) return null
  return (
    <div className="panel captures">
      <div className="tr-kicker">From your Telegram bot</div>
      {s.captures.slice(0, 3).map((c) => (
        <div key={`${c.provider}:${c.id}`} className="cap-row">
          <span className="cap-t">
            <b>{c.text}</b>
            <span className="tiny muted">
              {c.from} · {formatRelative(c.at, s.now)}
            </span>
          </span>
          <button type="button" className="btn sm primary" onClick={() => app.addCapture(c.provider, c.id)}>
            Add quest
          </button>
          <button type="button" className="btn sm line" aria-label={`Dismiss “${c.text}”`} onClick={() => app.dismissCapture(c.provider, c.id)}>
            ✕
          </button>
        </div>
      ))}
      <p className="tiny faint" style={{ margin: '6px 0 0' }}>
        Send <b>/quest</b> and a note to your bot from any device — it lands here and on your glasses.
      </p>
    </div>
  )
}

export const providerName = (p: keyof typeof MESSAGE_PROVIDER_LABELS) => MESSAGE_PROVIDER_LABELS[p]
