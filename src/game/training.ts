/**
 * Training: the tutorial IS part of the RPG. Seven short steps teach the assistant
 * by doing it for real; each awards XP once (recorded in save.training, never in the quest ledger).
 */
export const TRAINING_STEPS = [
  { id: 'meet', title: 'Meet your companion', how: 'Tap your companion in the Today scene to open the conversation.', xp: 10 },
  { id: 'plan', title: 'Plan your day', how: 'Tap “Plan my day”. You get your three things, when they fit, and who is waiting.', xp: 20 },
  { id: 'catchup', title: 'Catch up', how: 'Tap “Catch me up” for a three-line summary of what needs you.', xp: 10 },
  { id: 'reply', title: 'Answer someone', how: 'Open a message, pick a reply, check the exact words, confirm.', xp: 20 },
  { id: 'focus', title: 'Focus', how: 'Start a focus session on your next quest. Heads-ups wait until you’re done.', xp: 20 },
  { id: 'complete', title: 'Finish a quest', how: 'Done something for real? Press its wax seal to collect XP.', xp: 20 },
  { id: 'glasses', title: 'Do it on your glasses', how: 'On the glasses, choose “Plan my day” from the home menu with a tap.', xp: 20 },
] as const
export type TrainingStepId = (typeof TRAINING_STEPS)[number]['id']
export const TRAINING_STEP_IDS = TRAINING_STEPS.map((s) => s.id) as TrainingStepId[]
export const TRAINING_TOTAL_XP = TRAINING_STEPS.reduce((s, x) => s + x.xp, 0)
export const trainingStep = (id: string) => TRAINING_STEPS.find((s) => s.id === id)
