import { app, useApp } from '../useApp'
import { COMPANIONS } from '../../companion/roster'
import { formatTime } from '../../shared/time'
import { MESSAGE_PROVIDER_LABELS } from '../../shared/messages'
import { Sheet, asset } from '../components/common'
import { questIconPath } from '../art/questIcons'
import { openTalk } from '../talk'

/** “Plan my day”: the local plan (labelled), one-tap booking of focus blocks, replies waiting, and AI refinement when available. */
export function PlanSheet() {
  const s = useApp()
  const p = s.plan
  if (!s.planOpen || !p) return null
  const pending = s.proposal?.status === 'pending' || s.proposal?.status === 'executing'
  if (pending) return null
  const c = COMPANIONS[s.save.companion.id]
  const aiReady = s.chat.source === 'ai'
  const calReady = s.calendar.status.state === 'connected' || s.calendar.status.state === 'demo'
  return (
    <Sheet label="Plan my day" onClose={() => app.closePlan()}>
      <div className="eyebrow">
        Local plan · {p.day === 'tomorrow' ? 'tomorrow' : 'today'}
        {s.mode === 'demo' ? ' · demo data' : ''}
      </div>
      <h2 style={{ marginTop: 6 }}>{p.day === 'tomorrow' ? 'Tomorrow, sorted' : 'Your day, sorted'}</h2>
      <p className="small muted" style={{ marginTop: 2 }}>{p.summary}.</p>

      <div className="label plan-h">Focus</div>
      {p.focus.length ? (
        <ol className="plan-list">
          {p.focus.map((f, i) => {
            const b = p.blocks.find((x) => x.questId === f.questId)
            const q = s.save.quests.find((x) => x.id === f.questId)
            return (
              <li key={f.questId}>
                <span className="plan-n">{i + 1}</span>
                {q && <img className="painted" src={asset(`${questIconPath(q)}.png`)} alt="" />}
                <span className="plan-t">
                  <b>{f.title}</b>
                  <span className="tiny muted">
                    {b ? `${formatTime(b.start, s.tz)}–${formatTime(b.end, s.tz)} free` : `${f.minutes} min`} · {f.why}
                  </span>
                </span>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="small muted">No open quests. Add one from the Journal’s quill.</p>
      )}

      {p.meetings.length > 0 && (
        <>
          <div className="label plan-h">Meetings</div>
          <ul className="plan-list plain">
            {p.meetings.map((m) => (
              <li key={`${m.start}-${m.title}`}>
                <span className="plan-time">{formatTime(m.start, s.tz)}</span>
                <span className="plan-t">
                  <b>{m.title}</b>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {p.replies.length > 0 && (
        <>
          <div className="label plan-h">Waiting for your reply</div>
          <ul className="plan-list plain">
            {p.replies.map((r) => (
              <li key={`${r.provider}:${r.id}`}>
                <button type="button" className="plan-reply" onClick={() => { app.closePlan(); app.openMessage(r.provider, r.id) }}>
                  <span className="plan-t">
                    <b>{r.from}</b>
                    <span className="tiny muted">
                      {MESSAGE_PROVIDER_LABELS[r.provider]} · {r.title}
                    </span>
                  </span>
                  <span className="chev" aria-hidden="true">›</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="grid2" style={{ marginTop: 16 }}>
        {p.blocks.length > 0 && calReady ? (
          <button type="button" className="btn primary" onClick={() => app.bookPlan()}>
            Book {p.blocks.length === 1 ? '1 focus block' : `${p.blocks.length} focus blocks`}
          </button>
        ) : (
          <button type="button" className="btn" onClick={() => app.closePlan()}>
            Close
          </button>
        )}
        <button
          type="button"
          className="btn"
          disabled={!aiReady || s.chat.sending}
          onClick={() => {
            openTalk()
            void app.refinePlan()
          }}
        >
          Ask {c.name} to refine
        </button>
      </div>
      <p className="tiny faint" style={{ marginBottom: 0 }}>
        {calReady ? 'Booking shows every block for one confirmation, then checks each one on your calendar.' : 'Connect Google Calendar in Camp to book focus blocks.'}{' '}
        {aiReady ? `${c.name} sees the same quests, times and message subjects to refine it.` : 'Refining with AI needs an AI provider on your Questling server (Camp → AI companion brain).'}
      </p>
    </Sheet>
  )
}
