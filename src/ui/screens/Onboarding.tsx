import { useState } from 'react'
import { app } from '../useApp'
import { COMPANIONS, COMPANION_ORDER } from '../../companion/roster'
import { AVATARS, type AvatarId, type CompanionId } from '../../shared/schema'
import { asset, nestQuotes, timeOfDay } from '../components/common'
import { PixelText } from '../components/PixelText'
import { HAS_HERO_SPRITES } from '../art/manifest'

const AVATAR_INFO: Record<AvatarId, string> = {
  adventurer: 'Red scarf, bedroll, a sword that has seen some roads.',
  knight: 'Plate armour, griffin crest, zero excuses.',
  mage: 'Moon-hat, crystal staff, potions on the belt.',
}

export function Onboarding() {
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState<AvatarId>('adventurer')
  const [companion, setCompanion] = useState<CompanionId>('grumpy')
  const [goal, setGoal] = useState('')
  const [quiet, setQuiet] = useState({ enabled: true, start: '22:00', end: '08:00' })
  const [active, setActive] = useState({ start: '08:00', end: '22:00' })
  const [questTitle, setQuestTitle] = useState('')
  const steps = 5

  const finish = async (withQuest: boolean) => {
    await app.completeOnboarding({ name, avatar, companion, goal, quietHours: quiet, activeHours: active })
    if (withQuest && questTitle.trim()) {
      await app.questCommand({ type: 'quest/create', input: { title: questTitle.trim().slice(0, 80), category: 'personal', difficulty: 'easy', estimatedMinutes: 10, skill: 'DIS', source: 'manual' } })
    }
  }

  return (
    <div className="onboard">
      {step === 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          <div className="welcome-scene pixel" style={{ backgroundImage: `url(${asset(`scenes/${timeOfDay(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')}.webp`)})` }}>
            <img className="pixel" src={asset('companions/optimist/happy.png')} alt="Pip, a cheerful forest sprite" />
          </div>
          <PixelText text="QUESTLING" px={5} />
          <h1 style={{ fontSize: 34, marginTop: 14, fontStyle: 'italic', fontWeight: 500 }}>A little companion. A bigger adventure.</h1>
          <p className="muted" style={{ fontSize: 17, margin: '12px 0 0' }}>
            A character who lives on your glasses, notices what’s due, nags you in its own voice — and actually helps you get it done.
          </p>
          <div className="small faint" style={{ margin: '14px 0 0', lineHeight: 1.7 }}>
            No account · your save stays on this device · works offline
          </div>
          <div className="spacer" style={{ minHeight: 24 }} />
          <button type="button" className="btn primary block" onClick={() => setStep(1)}>
            Begin
          </button>
          <button type="button" className="btn quiet block" style={{ marginTop: 6 }} onClick={() => void app.setMode('demo')}>
            Look around with demo data
          </button>
        </div>
      )}
      {step > 0 && (
        <div className="steps" aria-label={`Step ${step} of ${steps - 1}`}>
          {Array.from({ length: steps - 1 }, (_, i) => (
            <span key={i} className={i < step ? 'on' : ''} />
          ))}
        </div>
      )}
      {step === 1 && (
        <>
          <div className="eyebrow">Step 1 of 4</div>
          <h1 style={{ margin: '4px 0 16px' }}>Who are you, traveller?</h1>
          <div className="field">
            <label htmlFor="ob-name">Name (optional, fictional is fine)</label>
            <input id="ob-name" type="text" maxLength={32} value={name} placeholder="e.g. Rowan" onChange={(e) => setName(e.target.value)} />
          </div>
          {AVATARS.map((a) => (
            <button key={a} type="button" className={`pick ${avatar === a ? 'sel' : ''}`} onClick={() => setAvatar(a)} aria-pressed={avatar === a}>
              <img className={`pixel ${HAS_HERO_SPRITES ? 'hero-full' : ''}`} src={asset(`avatars/${a}${HAS_HERO_SPRITES ? '_full' : ''}.png`)} alt="" />
              <span>
                <span className="name" style={{ textTransform: 'capitalize' }}>{a}</span>
                <span className="muted small" style={{ display: 'block' }}>
                  {AVATAR_INFO[a]}
                </span>
              </span>
            </button>
          ))}
          <p className="tiny faint">Purely cosmetic — every hero can train every skill.</p>
          <div className="spacer" />
          <button type="button" className="btn primary block" onClick={() => setStep(2)}>
            Next: pick a companion
          </button>
        </>
      )}
      {step === 2 && (
        <>
          <div className="eyebrow">Step 2 of 4</div>
          <h1 style={{ margin: '4px 0 6px' }}>Pick a companion</h1>
          <p className="muted" style={{ marginTop: 0 }}>Same overdue invoice, five very different reactions. Switch anytime.</p>
          {COMPANION_ORDER.map((id) => {
            const c = COMPANIONS[id]
            const line = app.previewLine(id, 'overdue', { quest: 'Send invoice' }).line.text
            return (
              <button key={id} type="button" className={`pick ${companion === id ? 'sel' : ''}`} onClick={() => setCompanion(id)} aria-pressed={companion === id}>
                <img className="pixel" src={asset(`companions/${id}/${companion === id ? 'happy' : 'idle'}.png`)} alt="" />
                <span style={{ minWidth: 0 }}>
                  <span className="name" style={{ color: c.accent }}>{c.name}</span> <span className="tiny faint">{c.title}</span>
                  <q>{nestQuotes(line)}</q>
                </span>
              </button>
            )
          })}
          <p className="tiny faint">Previews are clean. Grix’s optional 18+ Language Mode can be switched on later by adults.</p>
          <div className="grid2">
            <button type="button" className="btn line" onClick={() => setStep(1)}>
              Back
            </button>
            <button type="button" className="btn primary" onClick={() => setStep(3)}>
              Next
            </button>
          </div>
        </>
      )}
      {step === 3 && (
        <>
          <div className="eyebrow">Step 3 of 4 · optional</div>
          <h1 style={{ margin: '4px 0 16px' }}>Your rhythm</h1>
          <div className="field">
            <label htmlFor="ob-goal">A goal you’re working toward</label>
            <input id="ob-goal" type="text" maxLength={160} value={goal} placeholder="e.g. Finish my portfolio by Friday" onChange={(e) => setGoal(e.target.value)} />
            <span className="tiny muted">Saved to local memory so your companion can prioritize. You can delete it anytime.</span>
          </div>
          <div className="grid2">
            <div className="field">
              <label htmlFor="ob-as">Active from</label>
              <input id="ob-as" type="time" value={active.start} onChange={(e) => setActive({ ...active, start: e.target.value || '08:00' })} />
            </div>
            <div className="field">
              <label htmlFor="ob-ae">Active until</label>
              <input id="ob-ae" type="time" value={active.end} onChange={(e) => setActive({ ...active, end: e.target.value || '22:00' })} />
            </div>
          </div>
          <div className="grid2">
            <div className="field">
              <label htmlFor="ob-qs">Quiet hours start</label>
              <input id="ob-qs" type="time" value={quiet.start} onChange={(e) => setQuiet({ ...quiet, start: e.target.value || '22:00' })} />
            </div>
            <div className="field">
              <label htmlFor="ob-qe">Quiet hours end</label>
              <input id="ob-qe" type="time" value={quiet.end} onChange={(e) => setQuiet({ ...quiet, end: e.target.value || '08:00' })} />
            </div>
          </div>
          <p className="tiny faint">Check-ins only happen while Questling is open — never in quiet hours, at most four a day, at least 20 minutes apart.</p>
          <div className="grid2">
            <button type="button" className="btn line" onClick={() => setStep(2)}>
              Back
            </button>
            <button type="button" className="btn primary" onClick={() => setStep(4)}>
              Next
            </button>
          </div>
        </>
      )}
      {step === 4 && (
        <>
          <div className="eyebrow">Step 4 of 4</div>
          <h1 style={{ margin: '4px 0 6px' }}>Your first quest</h1>
          <p className="muted" style={{ marginTop: 0 }}>Something small you could finish today. It pays out when you actually do it.</p>
          <div className="field">
            <label htmlFor="ob-q">Quest</label>
            <input id="ob-q" type="text" maxLength={80} value={questTitle} placeholder="e.g. Drink a glass of water" onChange={(e) => setQuestTitle(e.target.value)} />
          </div>
          <p className="small faint" style={{ margin: '0 0 18px' }}>
            Google Calendar can wait — connect it later in Camp. Every calendar change asks you first.
          </p>
          <button type="button" className="btn primary block" disabled={!questTitle.trim()} onClick={() => void finish(true)}>
            Create quest and begin
          </button>
          <button type="button" className="btn quiet block" style={{ marginTop: 6 }} onClick={() => void finish(false)}>
            Skip for now
          </button>
        </>
      )}
    </div>
  )
}
