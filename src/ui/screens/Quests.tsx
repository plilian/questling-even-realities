import { useEffect, useState } from 'react'
import { app, useApp } from '../useApp'
import { isOpen, isOverdue, prioritizedQuests } from '../../game/reducer'
import { rewardFor } from '../../game/rules'
import { CATEGORIES, DIFFICULTIES, SKILLS, SKILL_HINTS, type Category, type Difficulty, type Quest, type Skill } from '../../shared/schema'
import { dayKey, parseLocalDateTime, toLocalInput } from '../../shared/time'
import { Entry, QuestMeta, Seg, Sheet } from '../components/common'
import { onNewQuestRequest } from '../uiEvents'

type Filter = 'open' | Category | 'done' | 'archive'

export function Quests() {
  const s = useApp()
  const [filter, setFilter] = useState<Filter>('open')
  const [editing, setEditing] = useState<Quest | 'new' | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [bossOpen, setBossOpen] = useState(false)
  useEffect(() => onNewQuestRequest(() => setEditing('new')), [])
  const quests = s.save.quests
  const today = dayKey(s.now, s.tz)
  const complete = (id: string) => void app.questCommand({ type: 'quest/complete', id, method: 'self_reported' })
  const open = prioritizedQuests(s.save, s.now).filter((q) => filter === 'open' || q.category === filter)
  const groups: Array<{ label: string; items: Quest[] }> =
    filter === 'done'
      ? [{ label: 'Completed', items: quests.filter((q) => q.status === 'completed').sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)).slice(0, 60) }]
      : filter === 'archive'
        ? [{ label: 'Archived', items: quests.filter((q) => q.status === 'archived').slice(-60).reverse() }]
        : [
            { label: 'Overdue', items: open.filter((q) => isOverdue(q, s.now)) },
            { label: 'Today', items: open.filter((q) => !isOverdue(q, s.now) && (q.status === 'in_progress' || (q.deadline && dayKey(q.deadline.at, s.tz) === today) || q.category === 'daily')) },
            { label: 'Later', items: open.filter((q) => !isOverdue(q, s.now) && !(q.status === 'in_progress' || (q.deadline && dayKey(q.deadline.at, s.tz) === today) || q.category === 'daily')) },
            { label: 'Done today', items: quests.filter((q) => q.status === 'completed' && q.completedAt && dayKey(q.completedAt, s.tz) === today && (filter === 'open' || q.category === filter)) },
          ]
  const q = detail ? quests.find((x) => x.id === detail) : null
  const sync = q ? app.taskSyncFor(q.id) : null
  const calConnected = s.calendar.status.state === 'connected' || s.calendar.status.state === 'demo'
  const empty = groups.every((g) => g.items.length === 0)
  return (
    <>
      <div className="tabs journal-tabs" role="tablist">
        {(['open', 'daily', 'personal', 'work', 'boss', 'done', 'archive'] as Filter[]).map((f) => (
          <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
            {f === 'open' ? 'All open' : f}
          </button>
        ))}
      </div>
      <article className="paper journal-page" style={{ marginTop: 14 }}>
        <span className="ribbon" aria-hidden="true" />
        {empty && (
          <div className="empty" style={{ paddingBottom: 8 }}>
            <p style={{ color: 'var(--ink-soft)' }}>{filter === 'done' ? 'No victories yet — the first one is the sweetest.' : 'Nothing here. A quiet page is fine too.'}</p>
            <button type="button" className="btn primary" onClick={() => setEditing('new')}>
              Write a quest
            </button>
          </div>
        )}
        {groups
          .filter((g) => g.items.length)
          .map((g) => (
            <section key={g.label} style={{ marginTop: 18 }}>
              <div className="rule-label left" style={{ color: g.label === 'Overdue' ? 'var(--crimson)' : undefined }}>
                {g.label} · {g.items.length}
              </div>
              <div>
                {g.items.map((x) => (
                  <Entry key={x.id} q={x} now={s.now} tz={s.tz} onOpen={() => setDetail(x.id)} tag rail={({ Overdue: 'var(--crimson)', Today: 'var(--moss)', Later: '#8a6d3b', 'Done today': '#a89470', Completed: '#a89470', Archived: '#a89470' } as Record<string, string>)[g.label]} />
                ))}
              </div>
            </section>
          ))}
      </article>
      {(!s.save.boss || s.save.boss.defeatedAt) && (
        <button type="button" className="btn quiet block" style={{ marginTop: 18 }} onClick={() => setBossOpen(true)}>
          Start a boss campaign →
        </button>
      )}
      {q && (
        <Sheet label={q.title} onClose={() => setDetail(null)}>
          <div className="eyebrow">{q.category} · {q.difficulty}</div>
          <h2 style={{ marginTop: 6 }}>{q.title}</h2>
          <QuestMeta q={q} now={s.now} tz={s.tz} />
          {q.description && <p className="muted small">{q.description}</p>}
          <div className="grid2" style={{ marginTop: 18 }}>
            {isOpen(q) && (
              <button
                type="button"
                className="btn go"
                onClick={() => {
                  setDetail(null)
                  complete(q.id)
                }}
              >
                Mark done
              </button>
            )}
            {(q.status === 'pending' || q.status === 'postponed') && (
              <button type="button" className="btn" onClick={() => void app.questCommand({ type: 'quest/start', id: q.id })}>
                Start
              </button>
            )}
            {isOpen(q) && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setDetail(null)
                  void app.startFocus(q.id)
                }}
              >
                Focus {Math.max(5, Math.min(90, q.estimatedMinutes))} min
              </button>
            )}
            {isOpen(q) && (
              <button type="button" className="btn" onClick={() => void app.questCommand({ type: 'quest/postpone', id: q.id, deadline: { at: Math.max(s.now, q.deadline?.at ?? s.now) + 3600_000, tz: s.tz } })}>
                In an hour
              </button>
            )}
            {isOpen(q) && (
              <button type="button" className="btn" onClick={() => void app.questCommand({ type: 'quest/postpone', id: q.id, deadline: { at: Math.max(s.now, q.deadline?.at ?? s.now) + 86400_000, tz: s.tz } })}>
                Tomorrow
              </button>
            )}
            {isOpen(q) && calConnected && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setDetail(null)
                  void app.findSlot(q.id)
                }}
              >
                Book time
              </button>
            )}
            {q.status !== 'completed' && q.status !== 'archived' && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setDetail(null)
                  setEditing(q)
                }}
              >
                Edit
              </button>
            )}
            {(q.status === 'completed' || q.status === 'archived') && (
              <button type="button" className="btn" onClick={() => void app.questCommand({ type: 'quest/repeat', id: q.id })}>
                Do it again
              </button>
            )}
            {sync && (
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  setDetail(null)
                  app.proposeTaskComplete(q.id)
                }}
              >
                Tick off in {sync.label}
              </button>
            )}
            {q.status !== 'archived' && (
              <button
                type="button"
                className="btn danger"
                onClick={() => {
                  setDetail(null)
                  void app.questCommand({ type: 'quest/archive', id: q.id })
                }}
              >
                Archive
              </button>
            )}
          </div>
          <p className="tiny faint" style={{ marginBottom: 0 }}>
            Completion is on your honour. Each quest pays out once — never for chatting or calendar changes.
          </p>
        </Sheet>
      )}
      {editing && <QuestEditor quest={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {bossOpen && <BossEditor onClose={() => setBossOpen(false)} />}
    </>
  )
}

function QuestEditor({ quest, onClose }: { quest: Quest | null; onClose: () => void }) {
  const s = useApp()
  const [title, setTitle] = useState(quest?.title ?? '')
  const [description, setDescription] = useState(quest?.description ?? '')
  const [category, setCategory] = useState<Exclude<Category, 'boss'>>(quest && quest.category !== 'boss' ? quest.category : 'personal')
  const [difficulty, setDifficulty] = useState<Difficulty>(quest?.difficulty ?? 'normal')
  const [minutes, setMinutes] = useState(quest?.estimatedMinutes ?? 30)
  const [skill, setSkill] = useState<Skill | 'none'>(quest ? (quest.skill ?? 'none') : 'DIS')
  const [deadline, setDeadline] = useState(quest?.deadline ? toLocalInput(quest.deadline.at, s.tz) : '')
  const [err, setErr] = useState('')
  const reward = rewardFor(difficulty, skill === 'none' ? null : skill)
  const save = async () => {
    const t = title.trim()
    if (!t) return setErr('Give your quest a title.')
    if (!(minutes >= 1 && minutes <= 600)) return setErr('Estimate must be 1–600 minutes.')
    let dl: { at: number; tz: string } | undefined
    if (deadline) {
      const at = parseLocalDateTime(deadline, s.tz)
      if (at === null) return setErr('That deadline isn’t a valid time.')
      dl = { at, tz: s.tz }
    }
    const sk = skill === 'none' ? null : skill
    const r = quest
      ? await app.questCommand({ type: 'quest/edit', id: quest.id, patch: { title: t, description: description.trim() || undefined, category, difficulty, estimatedMinutes: minutes, skill: sk, deadline: dl } })
      : await app.questCommand({ type: 'quest/create', input: { title: t, description: description.trim() || undefined, category, difficulty, estimatedMinutes: minutes, skill: sk, deadline: dl, source: 'manual' } })
    if (!r.error) onClose()
    else setErr(r.error.replace(/_/g, ' '))
  }
  return (
    <Sheet label={quest ? 'Edit quest' : 'New quest'} onClose={onClose}>
      <h2 style={{ marginBottom: 16 }}>{quest ? 'Edit quest' : 'A new quest'}</h2>
      <div className="field">
        <label htmlFor="qe-title">What will you do?</label>
        <input id="qe-title" type="text" maxLength={80} value={title} placeholder="e.g. Send the invoice to Mira" onChange={(e) => setTitle(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label htmlFor="qe-desc">Notes</label>
        <textarea id="qe-desc" maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
      </div>
      <div className="field">
        <span className="label">Kind</span>
        <Seg label="Category" value={category} onChange={setCategory} options={CATEGORIES.filter((c) => c !== 'boss').map((c) => ({ v: c as Exclude<Category, 'boss'>, l: c }))} />
      </div>
      <div className="field">
        <span className="label">Effort</span>
        <Seg label="Difficulty" value={difficulty} onChange={setDifficulty} options={DIFFICULTIES.filter((d) => d !== 'major').map((d) => ({ v: d, l: d }))} />
      </div>
      <div className="field">
        <span className="label">Trains</span>
        <Seg label="Skill" value={skill} onChange={setSkill} options={[...SKILLS.map((k) => ({ v: k as Skill | 'none', l: k })), { v: 'none' as const, l: '—' }]} />
        <span className="tiny faint">{skill !== 'none' ? `${skill} · ${SKILL_HINTS[skill]}` : 'No skill points'}</span>
      </div>
      <div className="grid2">
        <div className="field">
          <label htmlFor="qe-min">Minutes</label>
          <input id="qe-min" type="number" min={1} max={600} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
        </div>
        <div className="field">
          <label htmlFor="qe-dl">Deadline</label>
          <input id="qe-dl" type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </div>
      </div>
      <p className="small" style={{ margin: '2px 0 16px' }}>
        Pays <span className="stamp" style={{ marginLeft: 4 }}>+{reward.xp} XP</span>
        {skill !== 'none' && <span className="stamp" style={{ marginLeft: 6 }}>{skill} +{reward.skillPoints}</span>}
      </p>
      {err && (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {err}
        </p>
      )}
      <div className="grid2">
        <button type="button" className="btn line" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={() => void save()}>
          {quest ? 'Save' : 'Add to journal'}
        </button>
      </div>
    </Sheet>
  )
}

function BossEditor({ onClose }: { onClose: () => void }) {
  const [goal, setGoal] = useState('')
  const [skin, setSkin] = useState<'procrastinator' | 'deadline_beast' | 'mountain'>('procrastinator')
  const [ms, setMs] = useState(['', '', ''])
  const valid = goal.trim() && ms.filter((m) => m.trim()).length >= 3
  return (
    <Sheet label="Boss campaign" onClose={onClose}>
      <div className="eyebrow">Boss campaign</div>
      <h2 style={{ margin: '6px 0 8px' }}>Name the thing you keep avoiding</h2>
      <p className="muted small">Break a bigger goal into 3–5 milestones. The boss has 1000 HP and loses a fixed share per milestone. It never heals.</p>
      <div className="field">
        <label htmlFor="b-goal">Goal</label>
        <input id="b-goal" type="text" maxLength={120} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. Launch my portfolio site" />
      </div>
      <div className="field">
        <span className="label">Boss</span>
        <Seg label="Boss" value={skin} onChange={setSkin} options={[{ v: 'procrastinator', l: 'Procrastinator' }, { v: 'deadline_beast', l: 'Deadline' }, { v: 'mountain', l: 'Mountain' }]} />
      </div>
      {ms.map((m, i) => (
        <div key={i} className="field">
          <label htmlFor={`ms${i}`}>Milestone {i + 1}</label>
          <input id={`ms${i}`} type="text" maxLength={80} value={m} onChange={(e) => setMs(ms.map((x, j) => (j === i ? e.target.value : x)))} />
        </div>
      ))}
      {ms.length < 5 && (
        <button type="button" className="btn quiet sm" onClick={() => setMs([...ms, ''])}>
          + Another milestone
        </button>
      )}
      <div className="grid2" style={{ marginTop: 14 }}>
        <button type="button" className="btn line" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!valid}
          onClick={async () => {
            const r = await app.bossCreate(goal.trim(), skin, ms.map((m) => m.trim()).filter(Boolean))
            if (!r.error) onClose()
          }}
        >
          Begin campaign
        </button>
      </div>
    </Sheet>
  )
}
