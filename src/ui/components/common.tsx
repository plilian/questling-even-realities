import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { TASK_PROVIDER_LABELS } from '../../shared/tasks'
import { questIconPath } from '../art/questIcons'
import type { Quest } from '../../shared/schema'
import { formatDateTime, formatDuration, formatRelative, zonedParts } from '../../shared/time'
import { isOverdue } from '../../game/reducer'
import { levelInfo } from '../../game/rules'

export const asset = (p: string) => `./assets/${p}`

/** Painted icons (skills, categories, items, medals) scale smoothly; the small generated ones stay pixel-crisp. */
/** Dialogue inside a <q> already gets outer quotes: turn inner double quotes into single ones. */
export function nestQuotes(text: string): string {
  return text.replace(/["“]([^"“”]*)["”]/g, '‘$1’')
}
export const PAINTED_ICON = /^(skill_|cat_|item_|ach_)/
export function Icon({ name, size = 20, alt = '' }: { name: string; size?: number; alt?: string }) {
  return <img className={PAINTED_ICON.test(name) ? 'painted' : 'pixel'} src={asset(`icons/${name}.png`)} width={size} height={size} alt={alt} />
}

export type TimeOfDay = 'dawn' | 'day' | 'dusk' | 'night'
export function timeOfDay(now: number, tz: string): TimeOfDay {
  const h = zonedParts(now, tz).hour
  if (h >= 5 && h < 8) return 'dawn'
  if (h >= 8 && h < 17) return 'day'
  if (h >= 17 && h < 20) return 'dusk'
  return 'night'
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const SHORT_M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function shortDate(now: number, tz: string): string {
  const p = zonedParts(now, tz)
  return `${p.weekday}, ${SHORT_M[p.month - 1]} ${p.day}`
}

/** Small hand-drawn sprig used beside the title mark. */
export function Sprig({ flip = false }: { flip?: boolean }) {
  return (
    <svg viewBox="0 0 26 14" aria-hidden="true" style={{ transform: flip ? 'scaleX(-1)' : undefined }}>
      <path d="M1 7 C8 7 15 6 25 3" stroke="currentColor" strokeWidth="1.3" fill="none" />
      <path d="M7 7 C6 3 9 2 11 2 C11 5 9 7 7 7Z M12 6 C12 2 15 1 17 1 C16 4 14 6 12 6Z M17 5 C17 2 20 1 22 1 C21 3 19 5 17 5Z" fill="currentColor" />
      <path d="M9 7 C9 10 12 12 14 12 C13 9 11 8 9 7Z M15 6 C16 9 19 10 21 10 C19 7 17 6 15 6Z" fill="currentColor" opacity="0.75" />
    </svg>
  )
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export function longDate(now: number, tz: string): { weekday: string; date: string } {
  const p = zonedParts(now, tz)
  const wd = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
  return { weekday: DAYS[wd]!, date: `${p.day} ${MONTHS[p.month - 1]}` }
}

/** Segmented XP bar (20 pips) — reads like a game meter, not a web progress bar. */
export function XpPips({ totalXp }: { totalXp: number }) {
  const li = levelInfo(totalXp)
  const on = Math.round((li.into / li.need) * 20)
  return (
    <div className="xp" role="progressbar" aria-label="Experience to next level" aria-valuemin={0} aria-valuemax={li.need} aria-valuenow={li.into}>
      {Array.from({ length: 20 }, (_, i) => (
        <span key={i} className={i < on ? 'on' : ''} />
      ))}
    </div>
  )
}

export function Toggle({ on, onChange, label, adult }: { on: boolean; onChange: (v: boolean) => void; label: string; adult?: boolean }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle ${adult ? 'adult' : ''} ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />
}

export function Row({ title, sub, children, onClick }: { title: ReactNode; sub?: ReactNode; children?: ReactNode; onClick?: () => void }) {
  const inner = (
    <>
      <div className="txt">
        <b>{title}</b>
        {sub && <span>{sub}</span>}
      </div>
      {children}
    </>
  )
  return onClick ? (
    <button type="button" className="r" style={{ width: '100%', background: 'none', border: 0, borderBottom: '1px solid var(--rule-soft)', textAlign: 'left', color: 'inherit' }} onClick={onClick}>
      {inner}
    </button>
  ) : (
    <div className="r">{inner}</div>
  )
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ v: T; l: string; disabled?: boolean }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.v} type="button" role="radio" aria-checked={value === o.v} disabled={o.disabled} className={value === o.v ? 'on' : ''} onClick={() => onChange(o.v)}>
          {o.l}
        </button>
      ))}
    </div>
  )
}

const CAT_ICON: Record<Quest['category'], string> = { daily: 'cat_daily', personal: 'cat_personal', work: 'cat_work', boss: 'cat_boss' }
export const catIcon = (c: Quest['category']) => CAT_ICON[c]

export function QuestMeta({ q, now, tz }: { q: Quest; now: number; tz: string }) {
  const late = isOverdue(q, now)
  return (
    <div className="meta">
      {q.status === 'in_progress' && <span className="live">In progress</span>}
      {late && <span className="late">Overdue · {formatRelative(q.deadline!.at, now)}</span>}
      {!late && q.deadline && q.status !== 'completed' && <span>Due {formatDateTime(q.deadline.at, tz)}</span>}
      <span>{formatDuration(q.estimatedMinutes)}</span>
      <span className="xpv">
        +{q.reward.xp} XP{q.skill ? ` · ${q.skill}+${q.reward.skillPoints}` : ''}
      </span>
      {q.postponeCount > 0 && <span>moved {q.postponeCount}×</span>}
      {q.source === 'ai' && <span>via AI</span>}
      {(q.source === 'todoist' || q.source === 'notion' || q.source === 'google_tasks') && <span>from {TASK_PROVIDER_LABELS[q.source]}</span>}
    </div>
  )
}

/** One journal entry. The wax seal completes the quest (self-reported, rewarded once). */
export function Entry({ q, now, tz, onOpen, onComplete, tag, rail }: { q: Quest; now: number; tz: string; onOpen?: () => void; onComplete?: () => void; tag?: boolean; rail?: string }) {
  const done = q.status === 'completed'
  return (
    <div className={`entry ${done ? 'done' : ''}`} style={rail ? ({ '--rail': rail } as React.CSSProperties) : undefined}>
      <div className="glyph">
        <img className="painted" src={asset(`${questIconPath(q)}.png`)} width={26} height={26} alt="" />
      </div>
      <div className="body">
        <button type="button" className="title" onClick={onOpen} disabled={!onOpen} style={{ cursor: onOpen ? 'pointer' : 'default' }}>
          {q.title}
        </button>
        {q.description && <div className="sub">{q.description}</div>}
        <QuestMeta q={q} now={now} tz={tz} />
      </div>
      {tag && (
        <span className="xptag" aria-label={`${q.reward.xp} XP`}>
          +{q.reward.xp}
          <small>XP</small>
        </span>
      )}
      {!tag && onComplete && !done && q.status !== 'archived' && (
        <button type="button" className="seal" aria-label={`Complete ${q.title}`} title="Complete" onClick={onComplete}>
          <img className="pixel" src={asset('icons/seal_open.png')} alt="" />
        </button>
      )}
      {!tag && done && (
        <span className="seal" aria-label="Completed">
          <img className="pixel" src={asset('icons/seal_done.png')} alt="" />
        </span>
      )}
    </div>
  )
}

export function Sheet({ children, onClose, label }: { children: ReactNode; onClose?: () => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose?.()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={ref}>
        <div className="grab" />
        {children}
      </div>
    </div>
  )
}

export function useTicker(ms: number) {
  const [, setN] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), ms)
    return () => clearInterval(t)
  }, [ms])
}
