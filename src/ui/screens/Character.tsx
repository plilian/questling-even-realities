import { TrainingCard } from './Assist'
import { useApp, app } from '../useApp'
import { ACHIEVEMENTS, COSMETICS, levelInfo } from '../../game/rules'
import { AVATARS, SKILLS, SKILL_HINTS, SKILL_LABELS } from '../../shared/schema'
import { Icon, Seg, asset } from '../components/common'
import { HAS_HERO_SPRITES, HAS_RUINS_BACKDROP } from '../art/manifest'

const SKILL_ICON = { STR: 'skill_str', INT: 'skill_int', DIS: 'skill_dis', SOC: 'skill_soc' } as const

export function Character() {
  const s = useApp()
  const p = s.save.player
  const li = levelInfo(p.totalXp)
  const scale = Math.max(10, ...SKILLS.map((k) => p.skills[k]))
  return (
    <>
      <article className="paper sheetpage" style={{ marginTop: 14 }}>
        <span className="ribbon" aria-hidden="true" />
        <div className="hero" style={{ marginTop: 4 }}>
          <div className={`ruins ${HAS_RUINS_BACKDROP ? 'art' : ''}`} style={HAS_RUINS_BACKDROP ? { backgroundImage: `url(${asset('frames/ruins.webp')})` } : undefined}>
            <img className={`pixel ${HAS_HERO_SPRITES ? 'full' : ''}`} src={asset(`avatars/${p.avatar}${HAS_HERO_SPRITES ? '_full' : ''}.png`)} alt={`${p.avatar} avatar`} />
          </div>
          <div className="nameplate">
            <h2>{p.name || 'The Questling'}</h2>
            <div className="row small" style={{ marginTop: 4, color: 'var(--ink-soft)' }}>
              <b style={{ color: 'var(--ink-strong)' }}>Lv {li.level}</b>
              <span className="num">
                {li.into.toLocaleString()} / {li.need.toLocaleString()} XP
              </span>
            </div>
            <p className="small" style={{ margin: '8px 0 0', color: 'var(--ink-soft)' }}>
              {p.avatar === 'knight' ? 'Steady shield, steadier habits.' : p.avatar === 'mage' ? 'Turns small rituals into real magic.' : 'A steady adventurer, turning daily tasks into a grander quest.'}
            </p>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <Seg label="Avatar" value={p.avatar} onChange={(a) => void app.updatePlayer({ avatar: a })} options={AVATARS.map((a) => ({ v: a, l: a }))} />
        </div>

        <div className="rule-label left" style={{ marginTop: 20 }}>
          Skills
        </div>
        {SKILLS.map((k) => {
          const on = Math.round((p.skills[k] / scale) * 10)
          return (
            <div key={k} className="skill">
              <Icon name={SKILL_ICON[k]} size={26} />
              <div>
                <b>{SKILL_LABELS[k]}</b> <span className="tiny" style={{ color: 'var(--ink-soft)' }}>· {SKILL_HINTS[k]}</span>
                <div className="pips">
                  {Array.from({ length: 10 }, (_, i) => (
                    <span key={i} className={i < on ? 'on' : ''} />
                  ))}
                </div>
              </div>
              <b className="serif num" style={{ fontSize: 22, color: 'var(--ink-strong)' }}>
                {p.skills[k]}
              </b>
            </div>
          )
        })}

        <div style={{ marginTop: 18 }}>
          <TrainingCard compact />
        </div>
        <div className="rule-label left" style={{ marginTop: 20 }}>
          Inventory · {s.save.cosmetics.unlocked.length} / 8
        </div>
        <div className="inventory" style={{ marginTop: 10 }}>
          {COSMETICS.map((c) => {
            const got = s.save.cosmetics.unlocked.includes(c.id)
            return (
              <div key={c.id} title={got ? c.name : `Locked — ${c.unlock}`}>
                <div className={`slot ${got ? '' : 'empty'}`}>
                  <img className={got ? 'painted' : 'pixel'} src={asset(`icons/${got ? `item_${c.id}` : 'lock'}.png`)} alt="" />
                </div>
                <div className="slot-label">{got ? c.name : c.unlock}</div>
              </div>
            )
          })}
        </div>
        <p className="tiny" style={{ color: 'var(--ink-soft)', margin: '14px 0 0' }}>
          Playful progress counters — not a measure of your health, intelligence or worth.
        </p>
      </article>

      <div className="section">
        <h3>Deeds</h3>
        <span className="tiny faint num">{s.save.achievements.length} / 8</span>
      </div>
      <div className="ledger">
        {ACHIEVEMENTS.map((a) => {
          const got = s.save.achievements.includes(a.id)
          return (
            <div key={a.id} className={`entry ${got ? '' : 'done'}`} style={{ opacity: got ? 1 : 0.55 }}>
              <div className="glyph">
                <img className={got ? 'painted' : 'pixel'} src={asset(`icons/${got ? `ach_${a.id}` : 'lock'}.png`)} width={30} height={30} alt="" />
              </div>
              <div className="body">
                <div className="title" style={{ textDecoration: 'none' }}>
                  {a.name}
                </div>
                <div className="meta">{a.desc}</div>
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}
