import { useEffect, useRef, useState } from 'react'
import { app, useApp } from '../useApp'
import { COMPANIONS, COMPANION_ORDER } from '../../companion/roster'
import { finalizeLine } from '../../companion/policy'
import type { DialogueEvent } from '../../companion/dialogue'
import { formatDateTime } from '../../shared/time'
import { Icon, Row, Seg, Toggle, asset, nestQuotes } from '../components/common'
import { AdultDialog, Scene } from '../components/overlays'
import { AI_PROVIDER_LABELS } from '../../shared/ai'
import type { CompanionId } from '../../shared/schema'

const MOMENTS: Array<{ ev: DialogueEvent; label: string; vars: Record<string, string | number> }> = [
  { ev: 'overdue', label: 'Overdue', vars: { quest: 'Send invoice' } },
  { ev: 'meeting', label: 'Meeting soon', vars: { event: 'Design review', minutes: 15, time: '14:30' } },
  { ev: 'completed', label: 'Victory', vars: { quest: 'Run 5k', xp: 40 } },
  { ev: 'free_slot', label: 'Free time', vars: { minutes: 30, quest: 'Read chapter 4', time: '15:00' } },
  { ev: 'rest', label: 'Rest', vars: {} },
]

const QUICK: Record<CompanionId, string> = {
  grumpy: 'Fine. What’s the damage today?',
  commander: 'Give me my orders.',
  optimist: 'Cheer me on!',
  sage: 'Help me plan this wisely.',
  savage: 'Roast my to-do list.',
}

/** The conversation, opened from the Today scene, the floating portrait or a notice. */
export function TalkSheet({ onClose }: { onClose: () => void }) {
  const s = useApp()
  const c = COMPANIONS[s.save.companion.id]
  const ai = s.server.reachable && s.server.ai.configured
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.sheet-backdrop')) onClose()
    }
    window.addEventListener('keydown', k)
    document.body.classList.add('talk-open')
    return () => {
      window.removeEventListener('keydown', k)
      document.body.classList.remove('talk-open')
    }
  }, [onClose])
  return (
    <div className="talk" role="dialog" aria-modal="true" aria-label={`Talk with ${c.name}`} ref={ref} tabIndex={-1}>
      <div className="talk-top">
        <button type="button" className="iconbtn" aria-label="Close conversation" onClick={onClose}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <div className="talk-title">
          <b style={{ color: c.accent }}>{c.name}</b>
          <span>{c.title}</span>
        </div>
        <span className={`pill ${ai ? 'on' : ''}`}>
          <i /> {ai ? s.chat.label : 'Local'}
        </span>
      </div>
      <div className="talk-body">
        <Companion inSheet />
      </div>
    </div>
  )
}

export function Companion({ inSheet = false }: { inSheet?: boolean }) {
  const s = useApp()
  const save = s.save
  const cid = save.companion.id
  const c = COMPANIONS[cid]
  const [text, setText] = useState('')
  const [moment, setMoment] = useState(0)
  const [adultOpen, setAdultOpen] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" })
  }, [s.chat.turns.length])
  const muted = save.reminders.mutedUntil !== null && save.reminders.mutedUntil > s.now
  const ai = s.server.reachable && s.server.ai.configured
  const chosen = s.server.ai.providers.find((p) => p.id === s.chat.provider)
  const voiceTarget = chosen?.voice === 'native' ? chosen : (s.server.ai.providers.find((p) => p.id === s.server.ai.default && p.voice === 'native') ?? s.server.ai.providers.find((p) => p.voice === 'native'))
  const voiceLabel = voiceTarget ? AI_PROVIDER_LABELS[voiceTarget.id] : 'the AI server'
  const rec = s.voice.state === 'listening'
  const m = MOMENTS[moment]!
  const intro = app.previewLine(cid, 'intro', {}).line.text
  const lastEmotion = [...s.chat.turns].reverse().find((t) => t.role === 'companion')?.emotion
  const goal = save.preferences.goal.trim()
  const inboxOn = Object.values(s.inbox).some((v) => v.items.length > 0)
  const quick = ['What should I do next?', QUICK[cid], ...(inboxOn ? ['What needs a reply?'] : []), goal ? `Break down: ${goal.slice(0, 60)}` : 'Break down a big goal into steps', 'Find 30 minutes today']

  return (
    <>
      <Scene compact={inSheet} quiet={inSheet && (s.chat.turns.length > 0 || s.chat.sending)} idleEmotion={s.chat.sending ? 'thinking' : lastEmotion} idleText={intro} />

      {!inSheet && (
      <div className="row" style={{ alignItems: 'flex-end', margin: '4px 0 4px' }}>
        <div style={{ flex: 1 }}>
          <div className="eyebrow">{c.title}</div>
          <h1 style={{ color: c.accent }}>{c.name}</h1>
        </div>
        <span className={`pill ${ai ? 'on' : ''}`}>
          <i /> {ai ? s.chat.label : 'Offline'}
        </span>
      </div>
      )}
      <p className="muted" style={{ margin: inSheet ? '12px 0 0' : '6px 0 0' }}>
        {c.motivation}
      </p>

      <div className="section">
        <h3>Conversation</h3>
      </div>
      <div className="chat" aria-live="polite">
        {s.chat.turns.length === 0 && (
          <p className="muted small" style={{ margin: 0 }}>
            Ask anything about your day, or tap a suggestion below.
          </p>
        )}
        {s.chat.turns.slice(-16).map((t) =>
          t.role === 'user' ? (
            <div key={t.id} className="msg user">
              {t.text}
            </div>
          ) : (
            <div key={t.id} className="msg comp">
              <img className="pixel" src={asset(`companions/${cid}/${t.emotion ?? 'idle'}.png`)} alt="" />
              <div className="say">
                {t.line ? finalizeLine(t.line, s.policy, cid).text : t.text}
                <span className="src">{t.source === 'ai' ? (t.provider ? AI_PROVIDER_LABELS[t.provider] : 'AI') : 'Local'}</span>
              </div>
            </div>
          ),
        )}
        {s.chat.sending && (
          <div className="msg comp">
            <img className="pixel" src={asset(`companions/${cid}/thinking.png`)} alt="" />
            <div className="say typing" aria-label={`${c.name} is thinking`}>
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
        <div ref={endRef} className="chat-end" />
      </div>
      <div className={inSheet ? 'dock' : undefined}>
      {!rec && (
        <div className="quick" aria-label="Suggestions">
          {quick.map((q) => (
            <button key={q} type="button" className="chipbtn" disabled={s.chat.sending} onClick={() => void app.sendChat(q)}>
              {q}
            </button>
          ))}
        </div>
      )}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          const msg = text
          setText('')
          void app.sendChat(msg)
        }}
      >
        <input type="text" aria-label={`Message ${c.name}`} placeholder={rec ? `Listening… ${Math.floor(s.voice.elapsedMs / 1000)}s` : `Message ${c.name}`} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} disabled={s.chat.sending || rec} />
        {text.trim() ? (
          <button type="submit" className="btn primary sm" disabled={s.chat.sending}>
            Send
          </button>
        ) : (
          <button
            type="button"
            className={`mic ${rec ? 'rec' : ''}`}
            aria-label={rec ? 'Stop and send voice' : 'Push to talk'}
            disabled={s.voice.state === 'processing'}
            onClick={() => void (rec ? app.stopVoice() : app.startVoice())}
          >
            <Icon name="mic" size={22} />
          </button>
        )}
      </form>
      <p className="tiny faint" style={{ margin: '8px 4px 0' }}>
        {rec ? (
          <>
            Recording — tap the mic to send, or{' '}
            <button type="button" className="btn quiet sm" style={{ minHeight: 0, padding: 0 }} onClick={() => void app.cancelVoice()}>
              cancel
            </button>
            .
          </>
        ) : s.voice.state === 'unsupported' || s.voice.state === 'error' ? (
          s.voice.message
        ) : (
          `Push-to-talk (${s.device.kind === 'even' ? 'glasses mic' : 'browser mic'}). Audio goes to ${voiceLabel} for this one request and is never stored.`
        )}
      </p>
      </div>

      <div className="section">
        <h3>Who walks with you</h3>
      </div>
      <div className="roster">
        {COMPANION_ORDER.map((id) => (
          <button key={id} type="button" className={id === cid ? 'sel' : ''} onClick={() => void app.setCompanion(id)} aria-pressed={id === cid}>
            <img className="pixel" src={asset(`companions/${id}/${id === cid ? 'happy' : 'idle'}.png`)} alt="" />
            {COMPANIONS[id].name}
          </button>
        ))}
      </div>

      <div className="section">
        <h3>Five voices, one moment</h3>
      </div>
      <div className="tabs" role="tablist" style={{ marginTop: 0 }}>
        {MOMENTS.map((x, i) => (
          <button key={x.ev} type="button" role="tab" aria-selected={i === moment} className={i === moment ? 'on' : ''} onClick={() => setMoment(i)}>
            {x.label}
          </button>
        ))}
      </div>
      <div className="voices">
        {COMPANION_ORDER.map((id) => {
          const r = app.previewLine(id, m.ev, m.vars, false)
          return (
            <div key={id} className="voice">
              <img className="pixel" src={asset(`companions/${id}/${r.emotion}.png`)} alt="" />
              <div>
                <div className="eyebrow" style={{ color: COMPANIONS[id].accent }}>
                  {COMPANIONS[id].name}
                </div>
                <q>{nestQuotes(r.line.text)}</q>
              </div>
            </div>
          )
        })}
      </div>

      <div className="section">
        <h3>How {c.name} nudges you</h3>
      </div>
      <div className="rows">
        <div className="block">
          <div className="label" style={{ marginBottom: 8 }}>
            Reminder style
          </div>
          <Seg label="Reminder style" value={save.companion.intensity} onChange={(v) => void app.setCompanionStyle({ intensity: v })} options={[{ v: 'gentle', l: 'Gentle' }, { v: 'balanced', l: 'Balanced' }, { v: 'intense', l: 'Intense' }]} />
        </div>
        <div className="block">
          <div className="label" style={{ marginBottom: 8 }}>
            Roast intensity · The Savage
          </div>
          <Seg label="Roast intensity" value={save.companion.roastIntensity} onChange={(v) => void app.setCompanionStyle({ roastIntensity: v })} options={[{ v: 'light', l: 'Light' }, { v: 'medium', l: 'Medium' }, { v: 'savage', l: 'Savage' }]} />
          <div className="tiny faint" style={{ marginTop: 6 }}>
            {s.policy.adultEnabled ? 'Sharper roasts unlocked by 18+ Language Mode.' : 'Without 18+ mode, roasts stay playful and clean.'}
          </div>
        </div>
        <Row title="Proactive check-ins" sub="Reminders and suggestions while Questling is open">
          <Toggle label="Proactive check-ins" on={save.preferences.proactiveEnabled} onChange={(v) => void app.updatePreferences({ proactiveEnabled: v })} />
        </Row>
        <div className="block">
          {muted ? (
            <div className="row">
              <span className="small" style={{ flex: 1 }}>
                Quiet until {save.reminders.mutedUntil! > 8e15 ? 'you unmute' : formatDateTime(save.reminders.mutedUntil!, s.tz)}
              </span>
              <button type="button" className="btn sm" onClick={() => void app.unmute()}>
                Unmute
              </button>
            </div>
          ) : (
            <>
              <div className="label" style={{ marginBottom: 8 }}>
                Mute
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                {(
                  [
                    ['15m', '15 min'],
                    ['1h', '1 hour'],
                    ['tomorrow', 'Until morning'],
                    ['indefinite', 'Until I say'],
                  ] as const
                ).map(([d, l]) => (
                  <button key={d} type="button" className="btn sm line" onClick={() => void app.mute(d)}>
                    {l}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="section">
        <h3>Language</h3>
      </div>
      <div className="rows">
        <Row title="18+ Language Mode" sub={s.policy.adultEnabled ? `On — ${s.policy.profanityLevel === 'uncensored' ? 'Full 18+: no filter on The Savage' : 'The Savage may swear'}. Switching off is instant.` : 'Off. Lets The Savage go full adult: real swearing and crude jokes. Adults only.'}>
          <Toggle label="18+ Language Mode" adult on={s.policy.adultEnabled} onChange={() => (s.policy.adultEnabled ? void app.disableAdultMode() : setAdultOpen(true))} />
        </Row>
        <div className="block">
          <div className="label" style={{ marginBottom: 8 }}>
            Profanity
          </div>
          <Seg
            label="Profanity level"
            value={s.policy.profanityLevel}
            onChange={(v) => void app.setProfanityLevel(v)}
            options={[
              { v: 'none', l: 'None' },
              { v: 'mild', l: 'Mild' },
              { v: 'strong', l: 'Strong', disabled: !s.policy.adultEnabled },
              { v: 'uncensored', l: 'Full 18+', disabled: !s.policy.adultEnabled },
            ]}
          />
          <div className="tiny faint" style={{ marginTop: 6 }}>
            Mild = clean euphemisms (darn, heck). Strong = real swearing. Full 18+ = no filter: heavy swearing, crude adult jokes and innuendo — never explicit sex, slurs or attacks on you. Strong and Full need 18+ mode.
          </div>
        </div>
      </div>
      {adultOpen && <AdultDialog onClose={() => setAdultOpen(false)} />}

      <MemoryPanel />
    </>
  )
}

function MemoryPanel() {
  const s = useApp()
  const m = s.save.memory
  const [newText, setNewText] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  return (
    <>
      <div className="section">
        <h3>What I remember</h3>
        <span className="tiny faint">On this device only</span>
      </div>
      {s.pendingMemory.length > 0 && (
        <div className="receipt">
          <div className="line">May I remember this?</div>
          {s.pendingMemory.map((p) => (
            <div key={p.id} className="row small" style={{ marginTop: 8 }}>
              <span style={{ flex: 1 }}>{p.text}</span>
              <button type="button" className="btn sm primary" onClick={() => app.approveMemory(p.id)}>
                Keep
              </button>
              <button type="button" className="btn sm line" style={{ color: 'var(--ink)' }} onClick={() => app.rejectMemory(p.id)}>
                No
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="rows">
        <Row title="Long-term memory" sub="Goals and preferences you approve, plus the last 12 messages.">
          <Toggle label="Long-term memory" on={m.enabled} onChange={(v) => void app.setMemoryEnabled(v)} />
        </Row>
        {m.entries.length === 0 && <div className="block small muted">Nothing remembered yet.</div>}
        {m.entries.map((e) => (
          <div key={e.id} className="r">
            {editId === e.id ? (
              <input type="text" value={editText} maxLength={160} aria-label="Edit memory" onChange={(x) => setEditText(x.target.value)} />
            ) : (
              <div className="txt">
                <b style={{ fontWeight: 400 }}>{e.text}</b>
                <span>{e.kind}</span>
              </div>
            )}
            {editId === e.id ? (
              <button
                type="button"
                className="btn sm primary"
                onClick={() => {
                  void app.editMemory(e.id, editText)
                  setEditId(null)
                }}
              >
                Save
              </button>
            ) : (
              <button
                type="button"
                className="btn sm quiet"
                onClick={() => {
                  setEditId(e.id)
                  setEditText(e.text)
                }}
              >
                Edit
              </button>
            )}
            <button type="button" className="btn sm quiet" style={{ color: 'var(--danger)' }} aria-label="Forget" onClick={() => void app.deleteMemory(e.id)}>
              Forget
            </button>
          </div>
        ))}
        {m.enabled && (
          <form
            className="block row"
            onSubmit={(e) => {
              e.preventDefault()
              void app.addMemory('preference', newText)
              setNewText('')
            }}
          >
            <input type="text" maxLength={160} placeholder="Teach me a preference…" aria-label="Add memory" value={newText} onChange={(e) => setNewText(e.target.value)} />
            <button type="submit" className="btn sm" disabled={!newText.trim()}>
              Add
            </button>
          </form>
        )}
        <div className="block row" style={{ gap: 8 }}>
          <button type="button" className="btn sm line" onClick={() => void app.clearConversation()}>
            Clear conversation
          </button>
          <button type="button" className="btn sm danger" onClick={() => void app.resetMemory()}>
            Reset memory
          </button>
        </div>
      </div>
    </>
  )
}
