import { useState } from 'react'
import { app, useApp } from '../useApp'
import { formatDateTime, formatRelative } from '../../shared/time'
import { Row, Toggle, asset } from '../components/common'
import { COMPANIONS } from '../../companion/roster'
import { openTalk } from '../talk'
import { AdultDialog, GlassesPreview } from '../components/overlays'
import type { PreviewDevice } from '../../device/preview'
import { AI_PROVIDER_LABELS, AI_PROVIDER_VENDORS } from '../../shared/ai'
import { TaskIntegrations } from './TaskLists'
import { MessageIntegrations } from './Messages'

function ProviderChoice({ on, title, sub, onPick }: { on: boolean; title: string; sub: string; onPick: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={on} className={`r choice ${on ? 'on' : ''}`} onClick={onPick}>
      <div className="txt">
        <b>{title}</b>
        <span>{sub}</span>
      </div>
      <span className={`radio-mark ${on ? 'on' : ''}`} aria-hidden="true" />
    </button>
  )
}

export function Settings({ preview }: { preview: PreviewDevice | null }) {
  const s = useApp()
  const prefs = s.save.preferences
  const [adultOpen, setAdultOpen] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [code, setCode] = useState('')
  const cal = s.calendar.status
  return (
    <>
      <div className="section">
        <h3>Your companion</h3>
      </div>
      <div className="rows">
        <button type="button" className="r companion-row" onClick={openTalk} aria-label={`Open ${COMPANIONS[s.save.companion.id].name}: personality, nudges and 18+ mode`}>
          <img className="pixel" src={asset(`companions/${s.save.companion.id}/idle.png`)} alt="" />
          <div className="txt">
            <b>
              {COMPANIONS[s.save.companion.id].name} <span className="tiny muted">{COMPANIONS[s.save.companion.id].title}</span>
            </b>
            <span>Switch companion, nudge style, roast intensity, mute and 18+ mode.</span>
          </div>
          <span className="chev" aria-hidden="true">›</span>
        </button>
      </div>

      {s.mode === 'demo' && <DemoControls />}

      <div className="section">
        <h3>Google Calendar</h3>
        <span className={`pill ${cal.state === 'connected' ? 'on' : cal.state === 'demo' ? 'demo' : ''}`}>
          <i /> {cal.state.replace('_', ' ')}
        </span>
      </div>
      <div className="panel">
        {cal.state === 'demo' && <p className="small" style={{ margin: 0 }}>Demo mode uses a synthetic calendar. Nothing is sent to Google. Switch to real mode below to connect your calendar.</p>}
        {(cal.state === 'disconnected' || cal.state === 'expired' || cal.state === 'permission_missing' || cal.state === 'unavailable' || cal.state === 'not_configured') && (
          <>
            {cal.state === 'expired' && <p className="small" style={{ color: 'var(--warn)' }}>Access expired (it lasts about an hour, by design). Reconnect to continue.</p>}
            {cal.state === 'permission_missing' && <p className="small" style={{ color: 'var(--warn)' }}>Calendar permission was not granted, so nothing was connected.</p>}
            {cal.state === 'not_configured' && <p className="small" style={{ color: 'var(--warn)' }}>The Questling server has no Google OAuth client configured (setup: docs/DEPLOYMENT.md).</p>}
            {cal.state === 'unavailable' && <p className="small" style={{ color: 'var(--warn)' }}>Couldn’t reach the Questling server ({cal.reason.replace(/_/g, ' ')}).</p>}
            <p className="small">Questling asks for one permission: <b>events on calendars you own</b> — read titles and times, create focus blocks, and move your own events. It never deletes events or invites anyone, and every change needs your confirmation.</p>
            <button type="button" className="btn primary block" disabled={!s.server.reachable || !s.server.calendar.configured} onClick={() => void app.connectCalendar()}>
              Connect Google Calendar
            </button>
            {!s.server.reachable && <p className="tiny muted">Server offline — Calendar unavailable. Quests still work.</p>}
          </>
        )}
        {cal.state === 'linking' && (
          <>
            <p className="small">Google sign-in must happen in a real browser (not inside the glasses app). On your phone or computer, open:</p>
            <div className="receipt" style={{ textAlign: 'center' }}>
              <div className="line" style={{ wordBreak: 'break-all', fontSize: 15 }}>
                {cal.linkUrl}
              </div>
              <div style={{ font: '700 34px/1.2 ui-monospace, monospace', letterSpacing: '0.16em', margin: '6px 0' }}>{cal.userCode}</div>
              <div className="target">Code expires {formatRelative(cal.expiresAt, Date.now())}. Questling links itself when you finish.</div>
            </div>
            <div className="grid2">
              <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(`${cal.linkUrl}?code=${cal.userCode}`).then(() => app.toast('Link copied'))}>
                Copy link
              </button>
              <button type="button" className="btn" onClick={() => app.cancelCalendarLink()}>
                Cancel
              </button>
            </div>
          </>
        )}
        {cal.state === 'connected' && (
          <>
            <p className="small" style={{ marginTop: 0 }}>
              Connected to {s.calendar.label}. Access ends {formatDateTime(cal.expiresAt, s.tz)} (then reconnect). Last refresh {s.calendar.fetchedAt ? formatRelative(s.calendar.fetchedAt, s.now) : 'never'}.
            </p>
            <div className="tiny muted" style={{ marginBottom: 10 }}>
              Granted: calendar.events.owned
            </div>
            <div className="grid2">
              <button type="button" className="btn" onClick={() => void app.refreshCalendar(true)}>
                Refresh
              </button>
              <button type="button" className="btn danger" onClick={() => void app.disconnectCalendar()}>
                Disconnect
              </button>
            </div>
          </>
        )}
      </div>

      <MessageIntegrations />

      <TaskIntegrations />

      <div className="section">
        <h3>AI companion brain</h3>
        <span className={`pill ${s.server.ai.configured && s.server.reachable ? 'on' : 'warn'}`}>
          <i /> {s.server.reachable ? (s.server.ai.configured ? `${s.chat.label} ready` : 'Not configured') : 'Offline'}
        </span>
      </div>
      <div className="panel small">
        <p style={{ marginTop: 0 }}>
          Conversations, voice and planning go through Questling’s stateless proxy to the model you pick below. Only a minimized context is sent (quest titles, times, approved memory) — never your whole save or any account credentials. API keys stay on the server. Without AI, local commands and all quests keep working.
        </p>
        {s.server.ai.providers.length > 0 && (
          <div className="rows choices" role="radiogroup" aria-label="AI provider">
            <ProviderChoice
              on={prefs.aiProvider === 'auto'}
              title="Automatic"
              sub={`Server default · ${s.server.ai.default ? AI_PROVIDER_LABELS[s.server.ai.default] : '—'}`}
              onPick={() => void app.setAiProvider('auto')}
            />
            {s.server.ai.providers.map((p) => (
              <ProviderChoice
                key={p.id}
                on={prefs.aiProvider === p.id}
                title={AI_PROVIDER_LABELS[p.id]}
                sub={`${AI_PROVIDER_VENDORS[p.id]} · ${p.model} · ${p.voice === 'native' ? 'voice ✓' : p.voice === 'routed' ? 'voice via another provider' : 'text only'}`}
                onPick={() => void app.setAiProvider(p.id)}
              />
            ))}
          </div>
        )}
        {prefs.aiProvider !== 'auto' && s.server.reachable && !s.server.ai.providers.some((p) => p.id === prefs.aiProvider) && (
          <p className="muted tiny">Your choice ({AI_PROVIDER_LABELS[prefs.aiProvider]}) isn’t offered by this server, so the default answers instead.</p>
        )}
        {s.server.access.codeRequired && (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              app.setAccessCode(code)
            }}
          >
            <input type="password" placeholder="Access code (from the operator)" aria-label="Access code" value={code} onChange={(e) => setCode(e.target.value)} />
            <button type="submit" className="btn sm">
              Use
            </button>
          </form>
        )}
        <button type="button" className="btn sm quiet" style={{ paddingLeft: 0 }} onClick={() => void app.refreshServer()}>
          Check connection
        </button>
      </div>

      <div className="section">
        <h3>Reminders</h3>
      </div>
      <div className="rows">
        <Row title="Quiet hours" sub={`${prefs.quietHours.start}–${prefs.quietHours.end} · no check-ins, not even meetings`}>
          <Toggle label="Quiet hours" on={prefs.quietHours.enabled} onChange={(v) => void app.updatePreferences({ quietHours: { ...prefs.quietHours, enabled: v } })} />
        </Row>
        <div className="block">
        <div className="grid2">
          <div className="field">
            <label htmlFor="st-qs">Quiet from</label>
            <input id="st-qs" type="time" value={prefs.quietHours.start} onChange={(e) => e.target.value && void app.updatePreferences({ quietHours: { ...prefs.quietHours, start: e.target.value } })} />
          </div>
          <div className="field">
            <label htmlFor="st-qe">Quiet until</label>
            <input id="st-qe" type="time" value={prefs.quietHours.end} onChange={(e) => e.target.value && void app.updatePreferences({ quietHours: { ...prefs.quietHours, end: e.target.value } })} />
          </div>
        </div>
        <div className="grid2">
          <div className="field">
            <label htmlFor="st-mr">Meeting reminder (min)</label>
            <input id="st-mr" type="number" min={1} max={120} value={prefs.meetingReminderMinutes} onChange={(e) => void app.updatePreferences({ meetingReminderMinutes: Math.min(120, Math.max(1, Number(e.target.value) || 15)) })} />
          </div>
          <div className="field">
            <label htmlFor="st-nc">Max nudges / day</label>
            <input id="st-nc" type="number" min={0} max={12} value={prefs.maxNudgesPerDay} onChange={(e) => void app.updatePreferences({ maxNudgesPerDay: Math.min(12, Math.max(0, Number(e.target.value) || 0)) })} />
          </div>
        </div>
        <div className="grid2">
          <div className="field">
            <label htmlFor="st-as">Active from</label>
            <input id="st-as" type="time" value={prefs.activeHours.start} onChange={(e) => e.target.value && void app.updatePreferences({ activeHours: { ...prefs.activeHours, start: e.target.value } })} />
          </div>
          <div className="field">
            <label htmlFor="st-ae">Active until</label>
            <input id="st-ae" type="time" value={prefs.activeHours.end} onChange={(e) => e.target.value && void app.updatePreferences({ activeHours: { ...prefs.activeHours, end: e.target.value } })} />
          </div>
        </div>
        <p className="tiny faint" style={{ margin: 0 }}>
          Check-ins only happen while Questling is open on your phone or glasses — no background or closed-app notifications. At least 20 minutes between nudges.
        </p>
        </div>
      </div>

      <div className="section">
        <h3>Comfort</h3>
      </div>
      <div className="rows">
        <Row title="Reduced motion" sub="No reaction animations on phone or glasses">
          <Toggle label="Reduced motion" on={prefs.reducedMotion} onChange={(v) => void app.updatePreferences({ reducedMotion: v })} />
        </Row>
        <Row title="18+ Language Mode" sub={s.policy.adultEnabled ? 'On — switching off is instant' : 'Off (default) · adults only'}>
          <Toggle label="18+ Language Mode" adult on={s.policy.adultEnabled} onChange={() => (s.policy.adultEnabled ? void app.disableAdultMode() : setAdultOpen(true))} />
        </Row>
      </div>
      {adultOpen && <AdultDialog onClose={() => setAdultOpen(false)} />}

      <div className="section">
        <h3>On your glasses</h3>
        <span className="tiny faint">{s.device.label}</span>
      </div>
      <GlassesPreview device={preview} />

      <div className="section">
        <h3>Privacy & data</h3>
      </div>
      <div className="panel small">
        <ul style={{ margin: '0 0 14px', paddingLeft: 18, lineHeight: 1.6 }}>
          <li>No account, no database. Quests, progress, settings and memory are stored only on this device ({s.device.kind === 'even' ? 'Even app storage' : 'browser storage'}).</li>
          <li>Calendar access is held in server memory for about an hour and never saved on this device.</li>
          <li>The AI provider you use receives only what each request needs. Voice audio is not stored by Questling.</li>
          <li>18+ consent stays local and is never exported or imported.</li>
          <li>Save status: {s.persist === 'saved' ? 'saved' : s.persist === 'saving' ? 'saving…' : 'NOT saved — retrying'}.</li>
        </ul>
        <div className="row wrap" style={{ gap: 8 }}>
          <button type="button" className="btn sm" onClick={() => void app.setMode(s.mode === 'demo' ? 'real' : 'demo')}>
            {s.mode === 'demo' ? 'Leave demo mode' : 'Open demo mode'}
          </button>
          <button type="button" className="btn sm danger" onClick={() => setConfirmReset(true)}>
            Delete all local data
          </button>
        </div>
        {confirmReset && (
          <div className="receipt" style={{ marginTop: 14 }}>
            <p style={{ marginTop: 0 }}>
              Delete {s.mode === 'demo' ? 'the demo save' : 'your quests, XP, settings, memory'} and 18+ settings from this device? Calendar will be disconnected. This cannot be undone. (Events already in Google Calendar are not deleted.)
            </p>
            <div className="grid2">
              <button type="button" className="btn line" style={{ color: 'var(--ink)' }} onClick={() => setConfirmReset(false)}>
                Keep my data
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={async () => {
                  setConfirmReset(false)
                  await app.resetAll()
                }}
              >
                Delete
              </button>
            </div>
          </div>
        )}
      </div>
      <span className="ornament" />
      <p className="tiny faint" style={{ textAlign: 'center', margin: 0 }}>
        Questling 1.0 · <i className="serif">A little companion. A bigger adventure.</i>
        <br />
        Original pixel art · MIT · No account, no tracking
      </p>
    </>
  )
}

function DemoControls() {
  return (
    <div className="panel" style={{ borderColor: 'var(--gold-soft)', marginTop: 16 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="pill demo">Demo</span>
        <b className="serif" style={{ fontSize: 18 }}>Stage controls</b>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>
        Synthetic save + calendar, isolated from your real data. Triggers follow the same engine rules (cooldowns, dedupe, one-time rewards).
      </p>
      <div className="grid2">
        <button type="button" className="btn sm" onClick={() => void app.demo('overdue')}>
          Trigger overdue
        </button>
        <button type="button" className="btn sm" onClick={() => void app.demo('meeting')}>
          Meeting in 15 min
        </button>
        <button type="button" className="btn sm" onClick={() => void app.demo('complete')}>
          Complete a quest
        </button>
        <button type="button" className="btn sm" onClick={() => void app.demo('levelup')}>
          Level up
        </button>
        <button type="button" className="btn sm" onClick={() => void app.demo('compare')}>
          Next companion (same event)
        </button>
        <button type="button" className="btn sm" onClick={() => void app.demo('advance15')}>
          Advance clock 15 min
        </button>
      </div>
      <button type="button" className="btn sm quiet block" style={{ marginTop: 8 }} onClick={() => void app.demo('reset')}>
        Reset demo
      </button>
    </div>
  )
}
