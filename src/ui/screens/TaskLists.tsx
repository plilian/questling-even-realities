import { app, useApp } from '../useApp'
import { formatDateTime, formatRelative } from '../../shared/time'
import { TASK_PROVIDER_BLURBS, TASK_PROVIDER_IDS, type TaskProviderId } from '../../shared/tasks'
import type { TaskView } from '../../app/controller'

const DAY_FMT = new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })

function dueText(t: TaskView['tasks'][number], tz: string): string {
  if (t.due === null) return 'No date'
  return t.dueAllDay ? DAY_FMT.format(t.due) : formatDateTime(t.due, tz)
}

const SHOWN = 8

function TaskProviderCard({ v }: { v: TaskView }) {
  const s = useApp()
  const st = v.status
  const live = st.state === 'connected' || st.state === 'demo'
  const notInJournal = v.tasks.filter((t) => !t.questId)
  const pill = st.state === 'connected' ? 'on' : st.state === 'demo' ? 'demo' : ''
  return (
    <div className="panel integ">
      <div className="integ-head">
        <div>
          <b>{v.name}</b>
          <span className="small muted">{TASK_PROVIDER_BLURBS[v.provider]}</span>
        </div>
        <span className={`pill ${pill}`}>
          <i /> {st.state === 'demo' ? 'demo' : st.state.replace('_', ' ')}
        </span>
      </div>

      {!live && st.state !== 'linking' && (
        <>
          {st.state === 'expired' && <p className="small" style={{ color: 'var(--warn)' }}>Access ended (sessions are short by design). Reconnect to continue.</p>}
          {st.state === 'permission_missing' && <p className="small" style={{ color: 'var(--warn)' }}>Permission was not granted, so nothing was connected.</p>}
          {st.state === 'unavailable' && <p className="small" style={{ color: 'var(--warn)' }}>Couldn’t reach the Questling server ({st.reason.replace(/_/g, ' ')}).</p>}
          <button type="button" className="btn block" disabled={!v.configured} onClick={() => void app.connectTasks(v.provider)}>
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
            <button type="button" className="btn" onClick={() => app.cancelTaskLink(v.provider)}>
              Cancel
            </button>
          </div>
        </>
      )}

      {live && (
        <>
          <p className="tiny muted" style={{ margin: '0 0 8px' }}>
            {v.label}
            {st.state === 'connected' ? ` · access ends ${formatDateTime(st.expiresAt, s.tz)}` : ' · synthetic tasks, nothing leaves this device'}
            {v.fetchedAt ? ` · refreshed ${formatRelative(v.fetchedAt, Date.now())}` : ''}
          </p>
          {v.provider === 'notion' && v.sources.length > 1 && (
            <label className="field">
              <span className="tiny muted">Task database</span>
              <select value={v.selected ?? ''} onChange={(e) => void app.selectTaskSource('notion', e.target.value)}>
                {v.sources.map((src) => (
                  <option key={src.id} value={src.id} disabled={!src.writable}>
                    {src.name}
                    {src.writable ? '' : ' (needs a Done checkbox or Status)'}
                  </option>
                ))}
              </select>
            </label>
          )}
          {v.provider === 'notion' && !v.busy && v.fetchedAt && !v.selected && (
            <p className="small" style={{ color: 'var(--warn)' }}>No shared database looks like a task list. Share one with a title and a “Done” checkbox (or a Status property) with Questling in Notion.</p>
          )}
          {v.error && <p className="small" style={{ color: 'var(--warn)' }}>Couldn’t load tasks ({v.error.replace(/_/g, ' ')}).</p>}
          {v.tasks.length > 0 ? (
            <ul className="task-import">
              {v.tasks.slice(0, SHOWN).map((t) => (
                <li key={t.id}>
                  <div className="ti-txt">
                    <span className="ti-title">{t.title}</span>
                    <span className="tiny muted">
                      {dueText(t, s.tz)}
                      {t.recurring ? ' · repeats' : ''}
                    </span>
                  </div>
                  {t.questId ? (
                    <span className="xptag in">In journal</span>
                  ) : (
                    <button type="button" className="btn sm" aria-label={`Add “${t.title}” as a quest`} onClick={() => void app.importTasks(v.provider, [t.id])}>
                      Add
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            !v.busy && v.fetchedAt && !v.error && <p className="small muted">No open tasks. Nice.</p>
          )}
          {v.tasks.length > SHOWN && <p className="tiny muted">Showing the {SHOWN} soonest of {v.tasks.length}.</p>}
          <div className="grid2" style={{ marginTop: 10 }}>
            <button type="button" className="btn" disabled={v.busy} onClick={() => void app.refreshTasks(v.provider, { user: true })}>
              {v.busy ? 'Loading…' : 'Refresh'}
            </button>
            {notInJournal.length > 1 ? (
              <button type="button" className="btn primary" onClick={() => void app.importTasks(v.provider, notInJournal.slice(0, SHOWN).map((t) => t.id))}>
                Add {Math.min(SHOWN, notInJournal.length)} as quests
              </button>
            ) : (
              <button type="button" className="btn danger" onClick={() => void app.disconnectTasks(v.provider)}>
                Disconnect
              </button>
            )}
          </div>
          {notInJournal.length > 1 && (
            <button type="button" className="btn sm quiet" style={{ paddingLeft: 0, marginTop: 6 }} onClick={() => void app.disconnectTasks(v.provider)}>
              Disconnect {v.name}
            </button>
          )}
        </>
      )}
    </div>
  )
}

export function TaskIntegrations() {
  const s = useApp()
  const order: TaskProviderId[] = [...TASK_PROVIDER_IDS]
  return (
    <>
      <div className="section">
        <h3>Task lists</h3>
        <span className="tiny muted">optional</span>
      </div>
      <p className="small muted" style={{ margin: '0 2px 10px' }}>
        Bring tasks you already keep elsewhere into your quest journal. Questling reads only titles and due dates, and the only thing it can change is marking a task done — after you confirm.
      </p>
      {order.map((p) => (
        <TaskProviderCard key={p} v={s.tasks[p]} />
      ))}
    </>
  )
}
