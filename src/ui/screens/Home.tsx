import { app, useApp } from '../useApp'
import { bossHp, isOverdue, prioritizedQuests, todayProgress } from '../../game/reducer'
import { levelInfo } from '../../game/rules'
import { formatRelative, formatTime } from '../../shared/time'
import { pickLine } from '../../companion/dialogue'
import { finalizeLine } from '../../companion/policy'
import { Scene } from '../components/overlays'
import { Entry, Icon, QuestMeta, XpPips, asset, shortDate } from '../components/common'
import { questIconPath } from '../art/questIcons'

const SKILL_NAMES = { STR: 'Strength', INT: 'Intellect', DIS: 'Discipline', SOC: 'Social' } as const
import type { Tab } from '../App'
import { openTalk } from '../talk'
import { InboxGlance } from './Messages'
import { CaptureCard, FocusBanner, TrainingCard } from './Assist'
import { MESSAGE_PROVIDER_IDS } from '../../shared/messages'
import { COMPANIONS } from '../../companion/roster'

export function Home({ go }: { go: (t: Tab) => void }) {
  const talk = openTalk
  const s = useApp()
  const save = s.save
  const open = prioritizedQuests(save, s.now)
  const next = open[0]
  const prog = todayProgress(save, s.now, s.tz)
  const li = levelInfo(save.player.totalXp)
  const calConnected = s.calendar.status.state === 'connected' || s.calendar.status.state === 'demo'
  const events = s.calendar.events.filter((e) => e.status !== 'cancelled' && !e.allDay && e.end > s.now).sort((a, b) => a.start - b.start)
  const idle = finalizeLine(pickLine(save.companion.id, open.length ? 'morning' : 'empty', { count: open.length, next: next ? `“${next.title}”` : '' }, s.policy, { seed: 'home' }).line, s.policy, save.companion.id).text
  const muted = save.reminders.mutedUntil !== null && save.reminders.mutedUntil > s.now
  const total = Math.max(prog.total, prog.done, 1)
  const later = open.slice(1, 4)

  return (
    <>
      <Scene
        card
        onTalk={talk}
        idleText={idle}
        extra={
          <div className="reply-row">
            <button type="button" className="chipbtn lead" onClick={() => void app.planDay()}>
              Plan my day
            </button>
            {Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: s.tz }).format(s.now)) >= 17 ? (
              <button type="button" className="chipbtn" onClick={() => void app.recapDay()}>
                Recap my day
              </button>
            ) : (
              <button type="button" className="chipbtn" onClick={() => void app.catchUp()}>
                Catch me up
              </button>
            )}
            <button type="button" className="chipbtn" onClick={talk}>
              Talk to {COMPANIONS[save.companion.id].name}
            </button>
            {muted && (
              <button type="button" className="chipbtn" onClick={() => void app.unmute()}>
                Muted · unmute
              </button>
            )}
          </div>
        }
      />

      <FocusBanner />
      <div className="dayline">
        <img className="pixel" src={asset('icons/calendar.png')} alt="" />
        <h1>{shortDate(s.now, s.tz)}</h1>
      </div>
      <div className="rule-label dark" style={{ color: 'var(--gold-soft)' }}>
        Today’s quests · {prog.done}/{total}
      </div>
      <DayGlance />
      <div className="levelrow">
        <div className="hex" aria-label={`Level ${li.level}`}>
          <div>
            <small>Lv</small>
            <b>{li.level}</b>
          </div>
        </div>
        <div>
          <div className="row small" style={{ marginBottom: 6 }}>
            <b className="num">
              {li.into} / {li.need} XP
            </b>
            <span className="spacer" />
            <span className="tiny faint">{save.rewardLedger.length} deeds done</span>
          </div>
          <div className="xpframe">
            <XpPips totalXp={save.player.totalXp} />
          </div>
        </div>
      </div>

      <TrainingCard onCamp={() => go('settings')} />
      <div className="path" style={{ marginTop: 16 }} aria-label={`${prog.done} of ${total} done today`}>
        {Array.from({ length: Math.min(total, 8) }, (_, i) => (
          <span key={i} style={{ display: 'contents' }}>
            {i > 0 && <i />}
            <b className={i < prog.done ? 'done' : ''} />
          </span>
        ))}
      </div>

      <div style={{ height: 18 }} />
      {next ? (
        <article className="featured paper">
          <span className="pin l" aria-hidden="true" />
          <span className="pin r" aria-hidden="true" />
          <span className="ribbon" aria-hidden="true" />
          <div className="inner">
            <div className="eyebrow" style={{ color: isOverdue(next, s.now) ? 'var(--crimson)' : undefined }}>
              {next.status === 'in_progress' ? 'Quest in progress' : isOverdue(next, s.now) ? 'Overdue quest' : 'Featured quest'}
            </div>
            <div className="title">{next.title}</div>
            <div className="fq-body">
              <img className="pixel fq-art" src={asset(`${questIconPath(next)}.png`)} alt="" />
              <div className="fq-text">
                {next.description && <p className="fq-desc">{next.description}</p>}
                <QuestMeta q={next} now={s.now} tz={s.tz} />
              </div>
            </div>
            <div className="fq-foot">
              <span className="fq-tags">
                <span aria-hidden="true">✧</span> {next.skill ? SKILL_NAMES[next.skill] : 'Any skill'} <span aria-hidden="true">•</span> {next.category}
              </span>
              <span className="xptag stamp">+{next.reward.xp} XP</span>
            </div>
            <div className="actions">
              {next.status !== 'in_progress' && (
                <button type="button" className="btn sm line" onClick={() => void app.questCommand({ type: 'quest/start', id: next.id })}>
                  Start
                </button>
              )}
              <button type="button" className="btn sm line" onClick={() => void app.startFocus(next.id)}>
                Focus
              </button>
              {calConnected && (
                <button type="button" className="btn sm line" onClick={() => void app.findSlot(next.id)}>
                  <Icon name="calendar" size={16} /> Find time
                </button>
              )}
            </div>
          </div>
          <button type="button" className="waxseal" aria-label={`Mark done: ${next.title}`} onClick={() => void app.questCommand({ type: 'quest/complete', id: next.id, method: 'self_reported' })}>
            <span />
            <i>Complete</i>
            <svg className="seal-text" viewBox="0 0 104 104" aria-hidden="true">
              <defs>
                <path id="sealArc" d="M 22 54 A 30 30 0 0 1 82 54" />
              </defs>
              <text>
                <textPath href="#sealArc" startOffset="50%" textAnchor="middle">
                  COMPLETE
                </textPath>
              </text>
            </svg>
          </button>
        </article>
      ) : (
        <div className="empty">
          <p>The page is blank. What’s one small thing worth doing today?</p>
          <button type="button" className="btn primary" onClick={() => go('quests')}>
            Write a quest
          </button>
        </div>
      )}

      {later.length > 0 && (
        <>
          <div className="section">
            <h3>Also on the list</h3>
            <button type="button" className="link" onClick={() => go('quests')}>
              Journal →
            </button>
          </div>
          <div className="ledger" style={{ borderTop: 0 }}>
            {later.map((q) => (
              <Entry key={q.id} q={q} now={s.now} tz={s.tz} onOpen={() => go('quests')} onComplete={() => void app.questCommand({ type: 'quest/complete', id: q.id, method: 'self_reported' })} />
            ))}
          </div>
        </>
      )}

      <CaptureCard />
      <InboxGlance />

      {save.boss && !save.boss.defeatedAt && (
        <>
          <div className="section">
            <h3>Boss</h3>
          </div>
          <div className="panel">
            <div className="row">
              <Icon name="cat_boss" size={28} />
              <b className="serif" style={{ flex: 1, fontSize: 17 }}>
                {save.boss.goal}
              </b>
              <span className="small num" style={{ color: 'var(--danger)' }}>
                {bossHp(save.boss)} HP
              </span>
            </div>
            <div className="xp" style={{ gridTemplateColumns: 'repeat(10, 1fr)' }}>
              {Array.from({ length: 10 }, (_, i) => (
                <span key={i} style={{ background: i < Math.ceil(bossHp(save.boss!) / 100) ? 'var(--danger)' : undefined }} />
              ))}
            </div>
          </div>
        </>
      )}

      <div className="section">
        <h3>Agenda</h3>
        <span className="tiny faint">{s.mode === 'demo' ? 'Synthetic calendar' : calConnected ? 'Google Calendar' : ''}</span>
      </div>
      {!calConnected ? (
        <div className="panel row">
          <Icon name="calendar" size={26} />
          <span className="small muted" style={{ flex: 1 }}>
            Connect Google Calendar for meeting heads-ups and to book focus time.
          </span>
          <button type="button" className="btn sm" onClick={() => go('settings')}>
            Connect
          </button>
        </div>
      ) : events.length === 0 ? (
        <p className="muted small">Nothing else scheduled in the next two days.</p>
      ) : (
        <div className="timeline">
          {events.slice(0, 4).map((e) => (
            <div key={e.id} className={`tl ${e.start - s.now < 3600_000 ? 'soon' : ''}`}>
              <div className="t">{formatTime(e.start, s.tz)}</div>
              <div className="dot" />
              <div>
                <div className="what">{e.title}</div>
                <div className="rel">{formatRelative(e.start, s.now)}</div>
              </div>
            </div>
          ))}
          {s.calendar.fetchedAt && (
            <p className="tiny faint" style={{ margin: '6px 0 0 76px' }}>
              Updated {formatRelative(s.calendar.fetchedAt, s.now)}
              {s.calendar.error ? ` · ${s.calendar.error.replace(/_/g, ' ')}` : ''}
            </p>
          )}
        </div>
      )}
    </>
  )
}

/** One glanceable line under the date: the next meeting and who is waiting for you. */
function DayGlance() {
  const s = useApp()
  const ev = s.calendar.events.filter((e) => e.status !== 'cancelled' && !e.allDay && e.end > s.now && !e.title.startsWith('Quest: ')).sort((a, b) => a.start - b.start)[0]
  const waiting = MESSAGE_PROVIDER_IDS.flatMap((p) => s.inbox[p].items).filter((m) => m.important && m.canReply)
  if (!ev && !waiting.length) return null
  return (
    <button type="button" className="dayglance" onClick={() => void app.planDay()} aria-label="Plan my day">
      {ev && (
        <span>
          <b>{formatTime(ev.start, s.tz)}</b> {ev.title}
          {ev.start > s.now ? ` · ${formatRelative(ev.start, s.now)}` : ' · now'}
        </span>
      )}
      {waiting.length > 0 && (
        <span>
          <b>{waiting.length}</b> {waiting.length === 1 ? 'reply' : 'replies'} waiting
        </span>
      )}
    </button>
  )
}
