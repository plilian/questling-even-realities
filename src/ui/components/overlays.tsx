import { useEffect, useRef, useState } from 'react'
import { app, useApp } from '../useApp'
import { COMPANIONS } from '../../companion/roster'
import type { CompanionId, Emotion } from '../../shared/schema'
import { asset, Sheet, timeOfDay } from './common'
import type { PreviewDevice } from '../../device/preview'
import type { NoticeAction } from '../../companion/notices'
import { openTalk } from '../talk'

/**
 * The companion standing in a living pixel landscape (time-of-day aware), with a parchment
 * speech bubble. Used on Home and Companion. Shows the current notice when there is one.
 */
export function Scene({ idleText, idleEmotion, extra, card = false, onTalk, compact = false, quiet = false }: { idleText: string; idleEmotion?: Emotion; extra?: React.ReactNode; card?: boolean; onTalk?: () => void; compact?: boolean; quiet?: boolean }) {
  const s = useApp()
  const aiLabel = s.chat.label
  const n = s.notice
  const cid: CompanionId = n?.companionId ?? s.save.companion.id
  const c = COMPANIONS[cid]
  const tod = timeOfDay(s.now, s.tz)
  const emotion = n?.emotion ?? idleEmotion ?? s.emotion
  const src = asset(`companions/${cid}/${s.reactionFrame ?? emotion}.png`)
  const text = n ? s.noticeText : idleText
  const label = n ? (n.kind === 'CELEBRATION' ? 'celebrates' : n.critical ? 'heads-up' : n.solicited ? 'says' : 'checks in') : 'says'
  return (
    <section className={`scene pixel ${card ? 'card' : ''} ${compact ? 'compact' : ''}`} style={{ backgroundImage: `url(${asset(`scenes/${tod}.webp`)})` }} aria-label={`${c.name} the ${c.title}`}>
      {onTalk ? (
        <button type="button" className={`actor pixel tappable ${n?.react && !s.save.preferences.reducedMotion ? 'react' : ''}`} onClick={onTalk} aria-label={`Talk with ${c.name}`}>
          <img src={src} alt={`${c.name}, ${emotion}`} />
          <span className="talk-hint" aria-hidden="true">
            Talk
          </span>
        </button>
      ) : (
        <div className={`actor pixel ${n?.react && !s.save.preferences.reducedMotion ? 'react' : ''}`}>
          <img src={src} alt={`${c.name}, ${emotion}`} />
        </div>
      )}
      {(!quiet || n) && (
      <div className="bubble-wrap" role="status" aria-live="polite">
        <p className="who">
          {c.name} {label}
        </p>
        <div
          className={`say ${onTalk ? 'tappable' : ''}`}
          onClick={onTalk}
          onKeyDown={onTalk ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onTalk()) : undefined}
          role={onTalk ? 'button' : undefined}
          tabIndex={onTalk ? 0 : undefined}
          aria-label={onTalk ? `${text} — tap to talk with ${c.name}` : undefined}
        >
          {text}
          <span className="src">{n ? (n.line.origin === 'ai' ? aiLabel : 'Local dialogue') : c.title}</span>
        </div>
        {n?.reward && (
          <div className="reward">
            <span className="stamp">+{n.reward.xp} XP</span>
            {n.reward.skill && <span className="stamp">{n.reward.skill} +{n.reward.skillPoints}</span>}
            {n.reward.level && <span className="stamp lv">Level {n.reward.level}</span>}
          </div>
        )}
        {n ? <NoticeActions actions={n.actions} /> : extra}
      </div>
      )}
    </section>
  )
}

function NoticeActions({ actions, compact = false }: { actions: NoticeAction[]; compact?: boolean }) {
  const [more, setMore] = useState(false)
  const main: NoticeAction[] = actions.filter((a) => a.id !== 'snooze' && a.id !== 'mute' && a.id !== 'dismiss').slice(0, compact ? 1 : 2)
  const dismiss = actions.find((a) => a.id === 'dismiss')
  const rest = actions.filter((a) => !main.some((x) => x === a) && a !== dismiss)
  return (
    <div className="reply-row">
      {(more ? [...main, ...rest] : main).map((a, i) => (
        <button
          key={`${a.id}${i}`}
          type="button"
          className={`chipbtn ${i === 0 ? 'lead' : ''}`}
          onClick={() => {
            if (a.id === 'talk') openTalk()
            void app.noticeAction(a)
          }}
        >
          {a.label}
        </button>
      ))}
      {!more && rest.length > 0 && (
        <button type="button" className="chipbtn" onClick={() => setMore(true)} aria-expanded={false}>
          Later…
        </button>
      )}
      {dismiss && (
        <button type="button" className={`chipbtn ${dismiss.label === 'Dismiss' ? 'x' : ''}`} aria-label={dismiss.label} title={dismiss.label} onClick={() => void app.noticeAction(dismiss)}>
          {dismiss.label === 'Dismiss' ? '×' : dismiss.label}
        </button>
      )}
    </div>
  )
}

/** Compact notice for tabs without a scene. */
export function NoticeInline() {
  const s = useApp()
  const n = s.notice
  if (!n) return null
  const c = COMPANIONS[n.companionId]
  return (
    <div className="banner" role="status" aria-live="polite">
      <img className="face pixel" src={asset(`companions/${n.companionId}/${s.reactionFrame ?? n.emotion}.png`)} alt={c.name} />
      <div style={{ minWidth: 0 }}>
        <div className="line">
          <b style={{ color: c.accent, fontWeight: 600 }}>{c.name}:</b> {s.noticeText}
        </div>
        <NoticeActions actions={n.actions} compact />
      </div>
    </div>
  )
}

/** Exact change confirmation, styled as a receipt. Nothing runs without Confirm. */
export function ProposalSheet() {
  const s = useApp()
  const aiLabel = s.chat.label
  const p = s.proposal
  if (!p) return null
  const pending = p.status === 'pending'
  const lines = pending || p.status === 'executing' ? p.lines : (p.resultLines ?? p.lines)
  const heading = pending ? p.title : p.status === 'executing' ? 'Working on it…' : p.status === 'done' ? 'Done — verified' : p.status === 'cancelled' ? 'Cancelled' : p.status === 'expired' ? 'Expired' : 'Not completed'
  return (
    <Sheet label={p.title} onClose={pending ? () => app.cancelProposal(p.id) : () => app.dismissProposalResult()}>
      <div className="eyebrow">{p.external ? (s.mode === 'demo' ? (/demo|synthetic/i.test(p.target) ? p.target : `${p.target} · demo`) : `Changes ${p.target}`) : 'Changes your quest journal'}</div>
      <h2 style={{ marginTop: 6 }}>{heading}</h2>
      <div className="receipt">
        {lines.map((l, i) => (
          <div key={i} className={`line ${l.startsWith('Overlaps') ? 'warn' : ''}`}>
            {l}
          </div>
        ))}
        <div className="target">
          Target · {p.target} · {p.source === 'ai' ? `proposed by ${aiLabel}` : p.source === 'voice' ? 'from your voice' : 'proposed'}
        </div>
      </div>
      {pending ? (
        <>
          <p className="muted small" style={{ margin: '0 0 14px' }}>
            Nothing changes until you confirm. Expires in 5 minutes.
          </p>
          <div className="grid2">
            <button type="button" className="btn line" onClick={() => app.cancelProposal(p.id)}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={() => void app.confirmProposal(p.id)}>
              Confirm
            </button>
          </div>
        </>
      ) : p.status === 'executing' ? (
        <p className="muted">Waiting for the provider to confirm…</p>
      ) : (
        <button type="button" className="btn block" onClick={() => app.dismissProposalResult()}>
          Close
        </button>
      )}
    </Sheet>
  )
}

/** 18+ Language Mode consent — exact consent copy; checkbox never prechecked. */
export function AdultDialog({ onClose }: { onClose: () => void }) {
  const [checked, setChecked] = useState(false)
  const s = useApp()
  if (s.adult.minorLock) {
    return (
      <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="18+ Language Mode unavailable">
        <div className="dialog">
          <h2>Locked</h2>
          <p className="muted">You told us you’re under 18, so mature language stays off. Deleting all local data resets this.</p>
          <button type="button" className="btn block" onClick={onClose}>
            OK
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="adult-title">
      <div className="dialog">
        <img className="pixel" src={asset('companions/savage/happy.png')} width={72} height={72} alt="" style={{ display: 'block', marginBottom: 6 }} />
        <h2 id="adult-title">Enable 18+ Language Mode?</h2>
        <p>This mode allows strong profanity and more intense comedic roasting. Intended for adults 18 and over. Disable at any time.</p>
        <p className="small">It starts at <b>Full 18+</b>: The Savage stops holding back — heavy swearing, crude adult jokes and innuendo about your tasks and habits. Never explicit sex, slurs or attacks on you. You can step down to <b>Strong</b> (swearing only) in the companion settings.</p>
        <label className="check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>I confirm I am 18 or older and want to enable mature language.</span>
        </label>
        <p className="muted tiny">Self-attestation only — no ID or birth date is collected. Stored on this device only; never exported or synced. The AI provider’s own safety rules still apply.</p>
        <div className="grid2">
          <button type="button" className="btn line" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!checked}
            onClick={async () => {
              if (await app.enableAdultMode(checked)) onClose()
            }}
          >
            Enable 18+ Language
          </button>
        </div>
        <button
          type="button"
          className="btn quiet block"
          style={{ marginTop: 8 }}
          onClick={async () => {
            await app.declareUnder18()
            onClose()
          }}
        >
          I’m under 18
        </button>
      </div>
    </div>
  )
}

export function Toasts() {
  const s = useApp()
  return (
    <div className="toasts" aria-live="polite">
      {s.toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  )
}

/** Browser-preview glasses emulator (labelled). In the Even app the real SDK renders to the G2. */
export function GlassesPreview({ device }: { device: PreviewDevice | null }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const s = useApp()
  useEffect(() => {
    if (!device) return
    device.attach(ref.current)
    return () => device.attach(null)
  }, [device])
  useEffect(() => {
    if (!device) return
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'ArrowUp') device.inject('up')
      else if (e.key === 'ArrowDown') device.inject('down')
      else if (e.key === 'Enter') device.inject('tap')
      else if (e.key === 'Backspace') device.inject('double')
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [device])
  if (!device) {
    return (
      <div className="rows">
        <div className="block small">
          Rendering on your G2 through the Even Hub SDK. Current glasses screen: <b>{s.glassesScreen.name}</b>.
        </div>
      </div>
    )
  }
  return (
    <div>
      <div className="glasses-frame">
        <canvas ref={ref} className="pixel" aria-label={`Glasses preview: ${s.glassesScreen.name}`} />
      </div>
      <div className="row" style={{ marginTop: 10, gap: 8 }}>
        <button type="button" className="btn sm line" onClick={() => device.inject('up')} aria-label="Swipe up">
          ▲
        </button>
        <button type="button" className="btn sm line" onClick={() => device.inject('down')} aria-label="Swipe down">
          ▼
        </button>
        <button type="button" className="btn sm go" onClick={() => device.inject('tap')}>
          Tap
        </button>
        <button type="button" className="btn sm line" onClick={() => device.inject('double')}>
          Double-tap
        </button>
      </div>
      <p className="tiny faint" style={{ margin: '8px 0 0' }}>
        Browser emulation of the 576×288 display — not the SDK. Keys: ↑ ↓ Enter, Backspace = double-tap.
      </p>
    </div>
  )
}
