import { useEffect, useState } from 'react'
import { useApp } from './useApp'
import { Home } from './screens/Home'
import { Quests } from './screens/Quests'
import { TalkSheet } from './screens/Companion'
import { ReplySheet } from './screens/Messages'
import { PlanSheet } from './screens/Plan'
import { BriefSheet, NotesSheet } from './screens/Assist'
import { Character } from './screens/Character'
import { Settings } from './screens/Settings'
import { Onboarding } from './screens/Onboarding'
import { ProposalSheet, Toasts } from './components/overlays'
import { Sprig, asset } from './components/common'
import { closeTalk, openTalk, useTalkOpen } from './talk'
import { requestNewQuest } from './uiEvents'
import { COMPANIONS } from '../companion/roster'
import { LineIcon, type LineIconName } from './components/LineIcons'
import { PixelText } from './components/PixelText'
import type { PreviewDevice } from '../device/preview'

/** Four tabs as in the UI concept; the companion lives in the scene and the conversation sheet. */
export type Tab = 'home' | 'quests' | 'character' | 'settings'
/** Page headers as in the UI concept: an icon, a serif title and a small-caps line. */
const HEADS: Record<Exclude<Tab, 'home'>, { title: string; sub: string; icon: LineIconName }> = {
  quests: { title: 'Quest journal', sub: 'Your quest log', icon: 'journal' },
  character: { title: 'Character sheet', sub: 'Your adventurer', icon: 'character' },
  settings: { title: 'Camp', sub: 'Settings & connections', icon: 'camp' },
}

const TABS: Array<{ id: Tab; label: string; icon: LineIconName }> = [
  { id: 'home', label: 'Today', icon: 'today' },
  { id: 'quests', label: 'Quest Journal', icon: 'journal' },
  { id: 'character', label: 'Character', icon: 'character' },
  { id: 'settings', label: 'Camp', icon: 'camp' },
]

export function App({ preview }: { preview: PreviewDevice | null }) {
  const s = useApp()
  const [tab, setTab] = useState<Tab>('home')
  const talk = useTalkOpen()
  if (!s?.ready) {
    return (
      <div className="onboard" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <PixelText text="QUESTLING" px={4} />
        <p className="muted">Loading your save…</p>
      </div>
    )
  }
  if (!s.save.preferences.onboarded) {
    return (
      <div className={s.save.preferences.reducedMotion ? 'reduced' : ''}>
        <Onboarding />
        <Toasts />
      </div>
    )
  }
  const go = (t: Tab) => {
    closeTalk()
    setTab(t)
    window.scrollTo({ top: 0 })
  }
  const ai = s.server.reachable && s.server.ai.configured
  return (
    <div className={`app ${s.save.preferences.reducedMotion ? 'reduced' : ''}`}>
      <header className={`topbar center ${tab === 'home' ? 'brandbar' : 'pagebar'}`}>
        <div className="title-block">
          {tab === 'home' ? (
            <div className="title-mark">
              <Sprig />
              <span>Questling</span>
              <Sprig flip />
            </div>
          ) : (
            <>
              <div className="title-mark page">
                <LineIcon name={HEADS[tab].icon} size={26} />
                <span>{HEADS[tab].title}</span>
              </div>
              <div className="head-sub">{HEADS[tab].sub}</div>
            </>
          )}
          {(s.mode === 'demo' || s.policy.adultEnabled || s.persist === 'unsaved') && (
            <div className="flags">
              {s.mode === 'demo' && <span className="flag demo">Demo</span>}
              {s.policy.adultEnabled && <span className="flag adult">18+</span>}
              {s.persist === 'unsaved' && <span className="flag warn">Unsaved</span>}
            </div>
          )}
        </div>
        <div className="corner left">
          {tab !== 'settings' && (
            <button type="button" className="iconbtn" aria-label="Camp (settings)" onClick={() => go('settings')}>
              <LineIcon name="gear" />
            </button>
          )}
        </div>
        <div className="corner right">
          <span className={`statusdot ${ai ? 'on' : ''}`} role="img" aria-label={ai ? `AI connected (${s.chat.label})` : 'AI offline — local mode'} title={ai ? `${s.chat.label} connected` : 'AI offline — local mode'} />
          {tab === 'quests' ? (
            <button type="button" className="iconbtn" aria-label="Write a new quest" onClick={requestNewQuest}>
              <LineIcon name="quill" />
            </button>
          ) : (
            <button type="button" className="iconbtn" aria-label="Quest journal" onClick={() => go('quests')}>
              <LineIcon name="book" />
            </button>
          )}
        </div>
      </header>
      <main className="content">
        {s.loadOutcome === 'reset_corrupt' && (
          <div className="panel small" style={{ borderColor: '#5c4b22', marginBottom: 12 }}>
            Your previous save could not be read, so Questling started fresh. A copy of the damaged data was kept on this device.
          </div>
        )}
        {tab === 'home' && <Home go={go} />}
        {tab === 'quests' && <Quests />}
        {tab === 'character' && <Character />}
        {tab === 'settings' && <Settings preview={preview} />}
      </main>
      <nav className="nav" aria-label="Main">
        <div className="nav-inner">
          {TABS.map((t) => (
            <button key={t.id} type="button" className={tab === t.id ? 'active' : ''} aria-current={tab === t.id ? 'page' : undefined} onClick={() => go(t.id)}>
              <LineIcon name={t.icon} size={25} />
              <span className="lbl">{t.label}</span>
              {t.id === 'home' && s.notice && tab !== 'home' && !talk && <span className="dot" aria-label="New message" />}
            </button>
          ))}
        </div>
      </nav>
      {tab !== 'home' && tab !== 'settings' && !talk && <CompanionPeek />}
      {talk && <TalkSheet onClose={closeTalk} />}
      <ReplySheet />
      <PlanSheet />
      <BriefSheet />
      <NotesSheet />
      <ProposalSheet />
      <Toasts />
    </div>
  )
}

/** The companion follows you to the other tabs: a small portrait that opens the conversation. */
function CompanionPeek() {
  const s = useApp()
  const n = s.notice
  const cid = n?.companionId ?? s.save.companion.id
  const c = COMPANIONS[cid]
  const frame = s.reactionFrame ?? n?.emotion ?? s.emotion
  // step aside while you scroll down through a list; come back when you scroll up or pause
  const [away, setAway] = useState(false)
  useEffect(() => {
    let last = window.scrollY
    let timer: ReturnType<typeof setTimeout> | undefined
    const onScroll = () => {
      const y = window.scrollY
      if (Math.abs(y - last) > 6) setAway(y > last && y > 80)
      last = y
      clearTimeout(timer)
      timer = setTimeout(() => setAway(false), 1400)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      clearTimeout(timer)
    }
  }, [])
  return (
    <button type="button" className={`peek ${n ? 'has-news' : ''} ${away && !n ? 'away' : ''}`} onClick={openTalk} aria-label={n ? `${c.name} has something to say — open conversation` : `Talk with ${c.name}`}>
      <img className="pixel" src={asset(`companions/${cid}/${frame}.png`)} alt="" />
      {n && <span className="peek-dot" aria-hidden="true" />}
    </button>
  )
}
