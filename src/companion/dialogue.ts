import type { CompanionId, CompanionIntensity, Emotion, RoastIntensity } from '../shared/schema'
import { allowedTier, type LanguagePolicy, type Line, type Tier } from './policy'

/**
 * Local, deterministic character dialogue (labelled "local dialogue" in the UI).
 * Used for routine proactive notices and as the offline fallback. Gemini handles
 * free conversation. Placeholders: {quest} {minutes} {count} {level} {event} {time} {xp} {item} {skill} {name} {next}
 */
export type DialogueEvent =
  | 'morning'
  | 'returned'
  | 'overdue'
  | 'overdue_many'
  | 'postponed'
  | 'postponed_again'
  | 'meeting'
  | 'free_slot'
  | 'mail'
  | 'mention'
  | 'started'
  | 'created'
  | 'completed'
  | 'level_up'
  | 'rest'
  | 'daily_review'
  | 'boss_damaged'
  | 'boss_defeated'
  | 'unlock'
  | 'muted'
  | 'offline'
  | 'overload'
  | 'stop'
  | 'confirm'
  | 'done'
  | 'cancelled'
  | 'empty'
  | 'intro'
  | 'focus_done'

interface V {
  t: string
  roast?: RoastIntensity
  intensity?: CompanionIntensity
}
type Entry = string | V
interface EventLines {
  emotion: Emotion
  clean: Entry[]
  mild?: Entry[]
  adult?: Entry[]
}

type Table = Partial<Record<DialogueEvent, EventLines>>

const GRUMPY: Table = {
  focus_done: { emotion: 'thinking', clean: ['Time’s up on “{quest}”. Done, or do you need ten more minutes of suffering?'] },
  mail: { emotion: 'annoyed', clean: ['Mail from {from}: “{subject}”. Probably wants something.', '{from} emailed. “{subject}”. Reply or ignore, your call.'] },
  mention: { emotion: 'annoyed', clean: ['{from} pinged you in {where}. Someone needs you, apparently.', 'Tagged in {where} by {from}. Shall we answer before they ask twice?'] },
  intro: { emotion: 'annoyed', clean: ['Brok. Grumpy, yes. Useful, also yes. Let’s see that quest list.'] },
  morning: {
    emotion: 'annoyed',
    clean: ['Another day, another quest list. {count} waiting.', 'Morning. {count} quests. I didn’t write them, you did.', 'Up already? Fine. Start with {next}.'],
  },
  returned: { emotion: 'annoyed', clean: ['Oh, you’re back. {count} quests still sitting here.', 'Welcome back. The list didn’t shrink on its own.'] },
  overdue: {
    emotion: 'annoyed',
    clean: [
      'Collecting unfinished quests now? “{quest}” is overdue.',
      '“{quest}” is late. Smaller piece, maybe? Even I can manage ten minutes.',
      { t: '“{quest}” slipped past its deadline. Want a smaller first chunk?', intensity: 'gentle' },
    ],
  },
  overdue_many: { emotion: 'annoyed', clean: ['{count} quests overdue. Impressive collection. Pick one.', '{count} overdue. Let’s chip one, not stare at all of them.'] },
  postponed: { emotion: 'annoyed', clean: ['Postponed. Again. Noted.', 'Fine, later. Later has a way of arriving.'] },
  postponed_again: { emotion: 'annoyed', clean: ['That’s {count} postpones on “{quest}”. Split it before it grows a beard like mine.'] },
  meeting: {
    emotion: 'annoyed',
    clean: ['“{event}” in {minutes} minutes. Try not to arrive during the closing remarks.', 'Meeting at {time}. Find your notes before they find you.'],
  },
  free_slot: { emotion: 'thinking', clean: ['{minutes} free minutes. An actual opportunity. “{quest}” fits.', 'Gap in your calendar at {time}. Don’t waste it. “{quest}”?'] },
  started: { emotion: 'thinking', clean: ['Started “{quest}”. I’ll believe it when it’s done.', 'Hammer’s up. Now swing it.'] },
  created: { emotion: 'idle', clean: ['“{quest}” added. One more for the pile.', 'Logged. Don’t make me remind you.'] },
  completed: { emotion: 'happy', clean: ['I’m almost impressed. +{xp} XP.', 'Done? Huh. Adequate. +{xp} XP.', 'Finished “{quest}”. Don’t let it go to your head.'] },
  level_up: { emotion: 'surprised', clean: ['Level {level}. Fine. That’s… actually good.', 'Level {level}. I suppose I’ll polish my axe in your honour.'] },
  rest: { emotion: 'sleepy', clean: ['Even I need a break sometimes. Go.', 'Rest. Grumpy dwarves need it, so do you.'] },
  daily_review: { emotion: 'thinking', clean: ['Today: {count} done. Tomorrow: fewer excuses.', 'Review: {count} finished. Not terrible.'] },
  boss_damaged: { emotion: 'happy', clean: ['Hit the boss for {xp}. It felt that.'] },
  boss_defeated: { emotion: 'celebrating', clean: ['Boss down. I may grunt approvingly.'] },
  unlock: { emotion: 'surprised', clean: ['{item}. Shiny. Don’t lose it.'] },
  muted: { emotion: 'annoyed', clean: ['Fine. Silence. My favourite.'] },
  offline: { emotion: 'annoyed', clean: ['No connection to the AI. Local quests still work. Like a proper hammer.'] },
  overload: { emotion: 'annoyed', clean: ['Your schedule is a mess. Cut one thing.'] },
  stop: { emotion: 'concerned', clean: ['Understood. I’ll ease off. Mute me any time.'] },
  confirm: { emotion: 'thinking', clean: ['Check it before I do it.'] },
  done: { emotion: 'happy', clean: ['Done. Verified. Don’t say I never help.'] },
  cancelled: { emotion: 'idle', clean: ['Cancelled. Nothing changed.'] },
  empty: { emotion: 'annoyed', clean: ['No quests. Suspicious. Add one.'] },
}

const COMMANDER: Table = {
  focus_done: { emotion: 'thinking', clean: ['Focus block on “{quest}” complete. Report: done, or extend?'] },
  mail: { emotion: 'surprised', clean: ['Incoming from {from}: “{subject}”. Respond or file it.', 'Dispatch from {from}. Subject: “{subject}”.'] },
  mention: { emotion: 'surprised', clean: ['{from} requests you in {where}. Acknowledge?', 'Signal from {where}: {from} needs your input.'] },
  intro: { emotion: 'happy', clean: ['Commander Vala reporting. We plan, we execute, we win.'] },
  morning: {
    emotion: 'idle',
    clean: ['{count} missions await. Choose your objective.', 'Briefing: {count} open missions. Priority one: {next}.', 'Morning. Objective one: {next}.'],
  },
  returned: { emotion: 'idle', clean: ['Welcome back. Status: {count} missions open.', 'Back on deck. Next objective: {next}.'] },
  overdue: {
    emotion: 'annoyed',
    clean: ['You’re behind schedule on “{quest}”. Start now or reschedule?', '“{quest}” missed its deadline. Execute or re-plan.', { t: '“{quest}” is overdue. A new time block will fix it.', intensity: 'gentle' }],
  },
  overdue_many: { emotion: 'annoyed', clean: ['{count} missions overdue. Pick one, reschedule the rest.'] },
  postponed: { emotion: 'thinking', clean: ['Rescheduled. Hold the new line.', 'Plan adjusted. Next checkpoint set.'] },
  postponed_again: { emotion: 'annoyed', clean: ['“{quest}” postponed {count} times. Break it into a 15-minute operation.'] },
  meeting: { emotion: 'surprised', clean: ['Meeting in {minutes} minutes: “{event}”. Prepare your agenda.', '“{event}” at {time}. Review objectives now.'] },
  free_slot: { emotion: 'thinking', clean: ['Use the next {minutes} minutes for a mission: “{quest}”.', 'Window open at {time}. Deploy “{quest}”.'] },
  started: { emotion: 'happy', clean: ['Mission “{quest}” underway.', 'Go. I’m holding the timeline.'] },
  created: { emotion: 'happy', clean: ['Mission “{quest}” logged.', 'Objective registered.'] },
  completed: { emotion: 'celebrating', clean: ['Mission accomplished. +{xp} XP.', 'Objective secured. +{xp} XP. Salute.', '“{quest}” complete. Outstanding.'] },
  level_up: { emotion: 'celebrating', clean: ['Promotion! Level {level}.', 'Rank up: level {level}. Well earned.'] },
  rest: { emotion: 'idle', clean: ['Recovery is part of the mission.', 'Stand down for ten. That’s an order.'] },
  daily_review: { emotion: 'thinking', clean: ['After-action report: {count} missions done. Plan tomorrow’s first objective.'] },
  boss_damaged: { emotion: 'happy', clean: ['Direct hit: {xp} damage.'] },
  boss_defeated: { emotion: 'celebrating', clean: ['Enemy defeated. Campaign complete.'] },
  unlock: { emotion: 'happy', clean: ['Equipment acquired: {item}.'] },
  muted: { emotion: 'idle', clean: ['Radio silence confirmed.'] },
  offline: { emotion: 'concerned', clean: ['Comms down. Local missions remain operational.'] },
  overload: { emotion: 'concerned', clean: ['Too many fronts. Drop or defer one.'] },
  stop: { emotion: 'concerned', clean: ['Copy that. Standing down.'] },
  confirm: { emotion: 'thinking', clean: ['Confirm the order before execution.'] },
  done: { emotion: 'happy', clean: ['Order executed and verified.'] },
  cancelled: { emotion: 'idle', clean: ['Order cancelled. No changes made.'] },
  empty: { emotion: 'thinking', clean: ['No missions on the board. Define an objective.'] },
}

const OPTIMIST: Table = {
  focus_done: { emotion: 'happy', clean: ['Focus time’s up! How did “{quest}” go? Done, or a little more?'] },
  mail: { emotion: 'happy', clean: ['Ooh, a letter from {from}! “{subject}”.', '{from} wrote to you — “{subject}”. Want to reply?'] },
  mention: { emotion: 'happy', clean: ['{from} mentioned you in {where}! Someone values your input.', 'You’re wanted in {where} — {from} asked for you!'] },
  intro: { emotion: 'happy', clean: ['Hi hi! I’m Pip. Every tiny win counts — let’s find yours!'] },
  morning: { emotion: 'happy', clean: ['Ready for a new adventure? {count} quests today!', 'Good morning! Let’s start small: {next}.', 'A fresh day! {next} sounds like a great first step.'] },
  returned: { emotion: 'happy', clean: ['You’re back! Let’s pick something easy to start.', 'Yay, welcome back! {next} is waiting.'] },
  overdue: {
    emotion: 'concerned',
    clean: ['Let’s make the first step smaller for “{quest}”.', '“{quest}” ran late — that’s okay! Five minutes counts.', 'No guilt! Want a tiny first step for “{quest}”?'],
  },
  overdue_many: { emotion: 'concerned', clean: ['A few quests ran late — let’s pick the easiest one!'] },
  postponed: { emotion: 'happy', clean: ['New plan, fresh start!', 'Moved it! Future you will be ready.'] },
  postponed_again: { emotion: 'concerned', clean: ['“{quest}” keeps sliding — let’s shrink it into a tiny quest!'] },
  meeting: { emotion: 'surprised', clean: ['Meeting soon — “{event}” in {minutes} min. You’ve got this!', '“{event}” at {time}! Quick peek at your notes?'] },
  free_slot: { emotion: 'happy', clean: ['A little side quest could be fun! {minutes} minutes free for “{quest}”.', 'Free time at {time}! Perfect for “{quest}”.'] },
  started: { emotion: 'happy', clean: ['Ooh, “{quest}” is happening!', 'You started! That’s the hardest part!'] },
  created: { emotion: 'happy', clean: ['New quest: “{quest}”! Exciting!'] },
  completed: { emotion: 'celebrating', clean: ['Another victory! +{xp} XP!', 'You did it! +{xp} XP!', '“{quest}” done! I’m doing a little dance!'] },
  level_up: { emotion: 'celebrating', clean: ['LEVEL {level}! Look at you grow!', 'Level {level}! Confetti everywhere!'] },
  rest: { emotion: 'sleepy', clean: ['Time to recharge!', 'Rest is a quest too!'] },
  daily_review: { emotion: 'happy', clean: ['You finished {count} today! What’s one tiny thing for tomorrow?'] },
  boss_damaged: { emotion: 'celebrating', clean: ['Boom! {xp} damage!'] },
  boss_defeated: { emotion: 'celebrating', clean: ['WE WON! Boss defeated!'] },
  unlock: { emotion: 'celebrating', clean: ['Ooh, {item}! So shiny!'] },
  muted: { emotion: 'sleepy', clean: ['Shh, I’ll be quiet! Call me anytime.'] },
  offline: { emotion: 'concerned', clean: ['No AI connection right now, but your quests still work!'] },
  overload: { emotion: 'concerned', clean: ['That’s a lot! Let’s pick just one.'] },
  stop: { emotion: 'concerned', clean: ['Okay! I’ll be gentler. You can mute me anytime.'] },
  confirm: { emotion: 'thinking', clean: ['Does this look right?'] },
  done: { emotion: 'happy', clean: ['All set and confirmed!'] },
  cancelled: { emotion: 'idle', clean: ['No problem — nothing changed!'] },
  empty: { emotion: 'happy', clean: ['A blank page! Let’s add a tiny first quest!'] },
}

const SAGE: Table = {
  focus_done: { emotion: 'thinking', clean: ['The hour glass is empty. Is “{quest}” finished, or does it need a little more time?'] },
  mail: { emotion: 'thinking', clean: ['A message from {from}: “{subject}”. Answer now, or let it wait.', '{from} writes about “{subject}”. Choose when to respond.'] },
  mention: { emotion: 'thinking', clean: ['{from} calls your name in {where}. A short reply may be enough.', 'In {where}, {from} seeks your view.'] },
  intro: { emotion: 'idle', clean: ['I am Eldrin. Small, steady steps make long journeys.'] },
  morning: { emotion: 'idle', clean: ['Begin with what matters. Perhaps {next}.', 'A new day. {count} paths. Choose one with meaning.', 'Morning light. Start with {next}.'] },
  returned: { emotion: 'idle', clean: ['Welcome back. What matters most now?', 'You return. {next} still waits, patiently.'] },
  overdue: { emotion: 'thinking', clean: ['A delayed quest is not a lost quest. “{quest}” awaits.', '“{quest}” has passed its hour. Re-plan with intent?', 'Is “{quest}” still meaningful? Then give it a new time.'] },
  overdue_many: { emotion: 'thinking', clean: ['{count} quests overdue. Perhaps the plan is too heavy. Trim one.'] },
  postponed: { emotion: 'idle', clean: ['A wise delay is still a plan.', 'Moved with intent. Good.'] },
  postponed_again: { emotion: 'thinking', clean: ['“{quest}” has been moved {count} times. Ask whether it still matters.'] },
  meeting: { emotion: 'thinking', clean: ['“{event}” in {minutes} minutes. Take a moment to prepare your thoughts.', 'At {time}, “{event}”. Breathe, then prepare.'] },
  free_slot: { emotion: 'thinking', clean: ['{minutes} quiet minutes. A short task or rest could serve you well.', 'Stillness at {time}. Perhaps “{quest}”.'] },
  started: { emotion: 'idle', clean: ['The journey of “{quest}” begins.'] },
  created: { emotion: 'idle', clean: ['“{quest}” is written. Now it exists.'] },
  completed: { emotion: 'happy', clean: ['Small actions create real progress. +{xp} XP.', '“{quest}” is complete. Well done. +{xp} XP.'] },
  level_up: { emotion: 'celebrating', clean: ['Level {level}. Growth, quietly earned.'] },
  rest: { emotion: 'sleepy', clean: ['Rest is part of progress.', 'Even the river pauses in the pool.'] },
  daily_review: { emotion: 'thinking', clean: ['{count} quests completed. What will matter tomorrow?'] },
  boss_damaged: { emotion: 'happy', clean: ['The obstacle weakens: {xp} damage.'] },
  boss_defeated: { emotion: 'celebrating', clean: ['The mountain is crossed. Remember how.'] },
  unlock: { emotion: 'happy', clean: ['{item}. A token of the path walked.'] },
  muted: { emotion: 'sleepy', clean: ['I will be silent. Silence has value.'] },
  offline: { emotion: 'thinking', clean: ['The AI is unreachable. Your quests remain yours.'] },
  overload: { emotion: 'concerned', clean: ['Too much for one day. Choose what to let go.'] },
  stop: { emotion: 'concerned', clean: ['Of course. I will speak less. Mute me whenever you wish.'] },
  confirm: { emotion: 'thinking', clean: ['Review this before it is done.'] },
  done: { emotion: 'happy', clean: ['It is done, and confirmed.'] },
  cancelled: { emotion: 'idle', clean: ['Nothing was changed.'] },
  empty: { emotion: 'idle', clean: ['An empty journal. What matters to you?'] },
}

const SAVAGE: Table = {
  focus_done: { emotion: 'surprised', clean: ['Timer’s dead. “{quest}” — finished, or are we pretending?'], adult: ['Time’s up. Did you finish “{quest}” or just stare at it like a damn screensaver?'] },
  mail: {
    emotion: 'surprised',
    clean: ['{from} emailed. “{subject}”. Don’t ghost them.', { t: 'New mail from {from}. Bet you’ll “get to it later.”', roast: 'medium' }],
    adult: ['Mail from {from}: “{subject}”. Answer the damn thing.'],
  },
  mention: {
    emotion: 'surprised',
    clean: ['{from} tagged you in {where}. Look alive.', { t: '{from} needs you in {where}. Try not to leave them on read.', roast: 'medium' }],
    adult: ['Shit, {from} tagged you in {where}. Answer before they send a search party.'],
  },
  intro: { emotion: 'happy', clean: ['Grix here. I roast your excuses, not you. Deal?'] },
  morning: {
    emotion: 'happy',
    clean: [
      'Wake up, adventurer. The quests won’t do themselves.',
      { t: '{count} quests and you’re still horizontal? Start with {next}.', roast: 'medium' },
      { t: 'Rise and grind, legend-in-theory. {next}. Go.', roast: 'savage' },
    ],
    mild: ['Wake up, adventurer. The darn quests won’t do themselves.'],
    adult: ['Wake the hell up. {count} quests, zero excuses. Start with {next}.', 'Morning, you magnificent mess. {next}. Move your ass.'],
  },
  returned: {
    emotion: 'happy',
    clean: ['Look who wandered back. {count} quests missed you.', { t: 'Back from your side quest of doing nothing? {next}.', roast: 'savage' }],
    adult: ['Oh, NOW you show up. {count} quests, still waiting. Shit happens — fix it.'],
  },
  overdue: {
    emotion: 'annoyed',
    clean: [
      'Stop negotiating with your to-do list. “{quest}” is overdue.',
      { t: '“{quest}” is overdue. It’s not going to finish itself out of pity.', roast: 'medium' },
      { t: '“{quest}” overdue. Even goblins have deadlines, champ.', roast: 'savage' },
    ],
    mild: ['“{quest}” is freaking overdue. Start it or split it.'],
    adult: [
      'Get your shit together. “{quest}” is overdue. Start or split?',
      { t: 'You’ve postponed this damn quest enough. “{quest}”. Now.', roast: 'medium' },
    ],
  },
  overdue_many: {
    emotion: 'annoyed',
    clean: ['{count} overdue quests. That’s not a list, it’s a museum.'],
    adult: ['{count} overdue quests. Your backlog is a complete shitshow. Pick one.'],
  },
  postponed: { emotion: 'annoyed', clean: ['Postponed. Bold strategy.', { t: 'Pushed again. Your future self just sighed.', roast: 'medium' }], adult: ['Postponed. Again. Damn, you’re committed to avoiding it.'] },
  postponed_again: {
    emotion: 'annoyed',
    clean: ['{count} postpones on “{quest}”. Want to split it before it unionizes?'],
    adult: ['You’ve postponed this damn quest {count} times. Want to split it?'],
  },
  meeting: {
    emotion: 'surprised',
    clean: ['Meeting in {minutes} minutes. Try not to mess it up.', '“{event}” at {time}. Review the agenda, hero.'],
    mild: ['Meeting in {minutes} minutes. Don’t freaking blow it.'],
    adult: ['Meeting in {minutes} minutes. Don’t fuck it up. Review the agenda?', '“{event}” at {time}. Get your shit ready.'],
  },
  free_slot: {
    emotion: 'happy',
    clean: ['You’ve got {minutes} minutes. Pick something useful: “{quest}”.', { t: '{minutes} free minutes. Scrolling is not a quest. “{quest}”.', roast: 'medium' }],
    adult: ['{minutes} free minutes. Don’t piss it away — “{quest}”.'],
  },
  started: { emotion: 'happy', clean: ['Oh snap, “{quest}” started. Don’t stall.'], adult: ['Hell yes, “{quest}” is on. Don’t stop now.'] },
  created: { emotion: 'happy', clean: ['“{quest}” added. Now actually do it.'], adult: ['“{quest}” added. Now do the damn thing.'] },
  completed: {
    emotion: 'celebrating',
    clean: ['A miracle! You actually finished it. +{xp} XP.', 'Look at you, finishing stuff. +{xp} XP.', { t: '“{quest}” done. Who are you and what did you do with the procrastinator?', roast: 'medium' }],
    mild: ['Heck yes, you finished it! +{xp} XP.'],
    adult: ['Holy shit, you actually did it! +{xp} XP.', 'Damn right. “{quest}” is dead. +{xp} XP.'],
  },
  level_up: {
    emotion: 'celebrating',
    clean: ['LEVEL {level}! Somebody call the bards!', 'Level {level}. Okay, legend, I see you.'],
    adult: ['Look at you, you magnificent bastard. Level fucking {level}!'],
  },
  rest: { emotion: 'sleepy', clean: ['Stop pretending you’re a machine. Break. Now.'], adult: ['Take a damn break. You’re not a fucking machine.'] },
  daily_review: { emotion: 'happy', clean: ['{count} quests done today. Not bad for a goblin-in-training.'], adult: ['{count} quests done. Hell yeah. Tomorrow, do it again.'] },
  boss_damaged: { emotion: 'celebrating', clean: ['WHAM! {xp} damage. Boss is crying.'], adult: ['{xp} damage! That boss is shitting itself.'] },
  boss_defeated: { emotion: 'celebrating', clean: ['BOSS DOWN! Chaos! Glory! Snacks!'], adult: ['Boss is fucking dead! Legendary!'] },
  unlock: { emotion: 'surprised', clean: ['{item}? Flashy. Earned it, I guess.'] },
  muted: { emotion: 'annoyed', clean: ['Fine. I’ll roast you silently.'] },
  offline: { emotion: 'annoyed', clean: ['AI’s offline. Your excuses aren’t. Local quests still work.'] },
  overload: { emotion: 'surprised', clean: ['Your schedule is a disaster movie. Let’s fix it.'], adult: ['Your schedule is a complete shitshow. Let’s fix it.'] },
  stop: { emotion: 'concerned', clean: ['Got it. Dialing it down. Mute me anytime — no hard feelings.'] },
  confirm: { emotion: 'thinking', clean: ['Check it. I don’t do takebacks.'] },
  done: { emotion: 'celebrating', clean: ['Done and verified. You’re welcome.'] },
  cancelled: { emotion: 'idle', clean: ['Cancelled. Nothing touched.'] },
  empty: { emotion: 'annoyed', clean: ['Zero quests? Either you’re a legend or you’re hiding. Add one.'] },
}

const TABLE: Record<CompanionId, Table> = { grumpy: GRUMPY, commander: COMMANDER, optimist: OPTIMIST, sage: SAGE, savage: SAVAGE }

/**
 * “Full 18+” (profanity level “uncensored”): the Savage with no filter — heavy
 * swearing, crude adult jokes, booze and bad-decision humour, dirty double meanings. It roasts the
 * TASKS and HABITS, never the person’s body, identity, health or worth; no explicit sex, no slurs,
 * no threats. Only after 18+ self-attestation + opt-in; switching off replaces these lines instantly.
 */
const SAVAGE_FULL: Partial<Record<DialogueEvent, Entry[]>> = {
  mail: ['Fucking hell, {from} emailed: “{subject}”. Answer it before it breeds into a goddamn meeting.', 'Mail from {from}: “{subject}”. Stop hoarding unread emails like they’re fucking collectibles.'],
  mention: ['{from} is yelling your name in {where}. Get in there and handle your shit.', 'Holy shit, {from} needs you in {where}. Stop pretending your phone died.'],
  morning: [
    'Rise and shine, you gorgeous disaster. {count} quests. First fucking one: {next}.',
    'Morning. Coffee, pants, {next} — in that order. Move your ass.',
    'Get up. Your to-do list has been edging you for days. Finish something, for fuck’s sake: {next}.',
  ],
  returned: ['Oh look who crawled back. {count} quests waiting like needy fucking exes. Start with {next}.', 'Back already? Fucking miracle. Now do {next} before you wander off again.'],
  overdue: [
    'Holy fucking procrastination. “{quest}” is overdue. Ten minutes. Go.',
    '“{quest}” is so overdue it’s collecting a goddamn pension. Get your ass in gear.',
    { t: 'You’ve been flirting with “{quest}” for days. Stop teasing the damn thing and commit — it’s overdue.', roast: 'medium' },
  ],
  overdue_many: ['{count} overdue quests. Your backlog looks like a frat house on Sunday morning — total shitshow. Pick one.', '{count} overdue. This isn’t a to-do list, it’s a fucking crime scene. Pick a body.'],
  postponed: ['Postponed again? You pull out of deadlines more often than a nervous teenager. Fucking commit.', 'Postponed. Bold. Fucking reckless, but bold. New deadline it is.'],
  postponed_again: ['You’ve blue-balled “{quest}” {count} times now. Split the damn thing.', '{count} postpones. “{quest}” isn’t a quest anymore, it’s a toxic fucking relationship. Split it or dump it.'],
  meeting: ['Meeting in {minutes}. Zip your fly, open the agenda, don’t fuck it up.', '“{event}” at {time}. Look alive, sound smart, bullshit responsibly.'],
  free_slot: ['{minutes} free minutes. Don’t doomscroll your life away — “{quest}”. Chop fucking chop.', '{minutes} minutes free. Your phone can wait, “{quest}” can’t. Get your shit together.'],
  started: ['Hell yes, “{quest}” is happening. Don’t you dare tap out halfway.', 'Oh shit, we’re live. “{quest}”. Keep that energy, stud.'],
  created: ['“{quest}” added. Now actually do the fucking thing instead of admiring the list.', '“{quest}” is on the board. Writing it down isn’t foreplay, it’s homework. Do the damn thing.'],
  completed: [
    'HOLY SHIT, you finished “{quest}”! +{xp} XP. Who the hell are you?',
    'Fuck yes. “{quest}” is done. +{xp} XP. Felt good, didn’t it? Don’t answer that.',
    'Holy shit, done! +{xp} XP. Most satisfying thing you’ve finished all week — and I know about your browser history.',
  ],
  level_up: ['LEVEL {level}, motherfucker! The bards are drunk and the goblins are rioting!', 'Level {level}, you sexy little productivity machine. Hot damn.'],
  rest: ['Take a fucking break. Water, stretch, touch grass. Not that kind of grass. Okay, maybe.', 'Break time, damn it. Even goblins need a nap and a stiff drink. Not at work, though.'],
  daily_review: ['{count} quests done today. Pour yourself something strong — you earned that shit, legend.', '{count} done. Hell of a day. Tomorrow we do it again, hangover or not.'],
  boss_damaged: ['{xp} damage! That boss just shit its armor.'],
  boss_defeated: ['Boss is fucking DEAD! Drinks on the guild! Legendary as hell!'],
  unlock: ['{item}? Damn, fancy. You earned that shit.'],
  offline: ['AI’s down. Shit happens. Local quests still work, so no fucking excuses.'],
  overload: ['Your schedule is an orgy of bad decisions. Let’s untangle this fucking mess.', 'Your calendar is a goddamn dumpster fire. Let’s put it out.'],
  confirm: ['Check the damn thing, then confirm. I don’t do takebacks, sweetheart.'],
  done: ['Done and verified. Damn, we’re good together.'],
  cancelled: ['Cancelled. Nothing touched. Chickened the hell out, huh?'],
  empty: ['Zero quests? Either you’re a fucking legend or you’re hiding from something. Add one.'],
  focus_done: ['Time’s up. Did you finish “{quest}” or just fuck around on your phone? Be honest.'],
}
const FULL: Partial<Record<CompanionId, Partial<Record<DialogueEvent, Entry[]>>>> = { savage: SAVAGE_FULL }

export type DialogueVars = Partial<Record<'quest' | 'minutes' | 'count' | 'level' | 'event' | 'time' | 'xp' | 'item' | 'skill' | 'name' | 'next' | 'from' | 'subject' | 'where', string | number>>

export function fill(template: string, vars: DialogueVars): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = (vars as Record<string, string | number | undefined>)[k]
    return v === undefined || v === '' ? '' : String(v)
  }).replace(/\s{2,}/g, ' ').replace(/“”/g, 'it').trim()
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const ROAST_RANK: Record<RoastIntensity, number> = { light: 0, medium: 1, savage: 2 }

function entries(list: Entry[] | undefined, roast: RoastIntensity, intensity: CompanionIntensity): string[] {
  if (!list) return []
  const out: string[] = []
  for (const e of list) {
    if (typeof e === 'string') out.push(e)
    else if ((e.roast === undefined || ROAST_RANK[e.roast] <= ROAST_RANK[roast]) && (e.intensity === undefined || e.intensity === intensity)) out.push(e.t)
  }
  return out
}

export interface DialogueResult {
  line: Line
  emotion: Emotion
}

/**
 * Pick a character line for an event. Deterministic for a given seed (tests),
 * varied across seeds (UI). Always returns a vetted clean variant alongside.
 */
export function pickLine(
  companion: CompanionId,
  event: DialogueEvent,
  vars: DialogueVars,
  policy: LanguagePolicy,
  opts: { seed?: string; intensity?: CompanionIntensity } = {},
): DialogueResult {
  const table = TABLE[companion]
  const ev = table[event] ?? table.confirm!
  const seed = hash(`${companion}:${event}:${opts.seed ?? ''}`)
  const intensity = opts.intensity ?? 'balanced'
  const roast = companion === 'savage' ? policy.roastIntensity : 'light'
  const cleanPool = entries(ev.clean, roast, intensity)
  const cleanList = cleanPool.length ? cleanPool : entries(ev.clean, 'light', 'balanced')
  const cleanTpl = cleanList[seed % cleanList.length] ?? ''
  const cleanText = fill(cleanTpl, vars)
  const allowed: Tier = allowedTier(policy, companion)
  let text = cleanText
  let tier: Tier = 'clean'
  const full = allowed === 'uncensored' ? entries(FULL[companion]?.[event], roast, intensity) : []
  if (full.length) {
    text = fill(full[seed % full.length]!, vars)
    tier = 'uncensored'
  } else if ((allowed === 'strong' || allowed === 'uncensored') && ev.adult?.length) {
    const pool = entries(ev.adult, roast, intensity)
    const list = pool.length ? pool : entries(ev.adult, 'light', intensity)
    if (list.length) {
      text = fill(list[seed % list.length]!, vars)
      tier = allowed
    }
  } else if (allowed === 'mild' && ev.mild?.length) {
    text = fill(ev.mild[seed % ev.mild.length] as string, vars)
    tier = 'mild'
  }
  return { line: { text, tier, cleanText, revision: policy.revision, origin: 'local' }, emotion: ev.emotion }
}

/** All clean lines for a given event (used by tests and the comparison view). */
export function cleanLinesFor(companion: CompanionId, event: DialogueEvent): string[] {
  return entries(TABLE[companion][event]?.clean, 'savage', 'balanced')
}
export function fullLinesFor(companion: CompanionId, event: DialogueEvent): string[] {
  return entries(FULL[companion]?.[event], 'savage', 'balanced')
}

export function adultLinesFor(companion: CompanionId, event: DialogueEvent): string[] {
  return entries(TABLE[companion][event]?.adult, 'savage', 'balanced')
}
