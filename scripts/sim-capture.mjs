#!/usr/bin/env node
/**
 * Drives the OFFICIAL Even Hub simulator through its automation HTTP API
 * (evenhub-simulator --automation-port) and records evidence:
 *   evidence/simulator/<nn>_<step>.png  (raw RGBA framebuffer, 576×288)
 *   evidence/simulator/run.json         (steps, screen markers, failures, console errors)
 *
 * Prereqs: `npm run dev` (serves http://127.0.0.1:5173) and the simulator started with
 *   evenhub-simulator --automation-port 9898 "http://127.0.0.1:5173/?demo=reset"
 * (Linux CI: wrap with `xvfb-run -a`). Demo mode only: synthetic save, calendar and inboxes.
 *
 * In demo mode the app logs `[questling/screen] <name>` and `[questling/list] {screen, items}`
 * (synthetic data only), so this script can pick menu entries by label like a person would.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.SIM_URL ?? 'http://127.0.0.1:9898'
const OUT = process.env.SIM_OUT ?? 'evidence/simulator'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let lastId = -1
const screens = []
const lists = []
const errors = []
async function poll() {
  const url = lastId >= 0 ? `${BASE}/api/console?since_id=${lastId}` : `${BASE}/api/console`
  const r = await fetch(url).then((x) => x.json())
  for (const e of r.entries) {
    lastId = Math.max(lastId, e.id)
    const m = /\[questling\/screen\] (\S+)/.exec(e.message)
    if (m) screens.push(m[1])
    const l = /\[questling\/list\] (\{.*\})$/.exec(e.message)
    if (l) lists.push(JSON.parse(l[1]))
    if (e.level === 'error' || e.message.startsWith('[uncaught]') || e.message.startsWith('[unhandledrejection]') || e.message.includes('[questling/glasses]')) errors.push(e.message)
  }
}
async function currentScreen() {
  await poll()
  return screens[screens.length - 1]
}
async function input(action) {
  const r = await fetch(`${BASE}/api/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })
  if (!r.ok) throw new Error(`input ${action} failed: ${r.status}`)
  await sleep(900)
}
let n = 0
const steps = []
async function shot(label) {
  await sleep(1300) // let serial image transfers finish
  const screen = await currentScreen()
  const buf = Buffer.from(await (await fetch(`${BASE}/api/screenshot/glasses`)).arrayBuffer())
  const file = `${String(++n).padStart(2, '0')}_${label}.png`
  writeFileSync(join(OUT, file), buf)
  steps.push({ step: n, label, screen, file })
  console.log(`${file}  screen=${screen}`)
  return screen
}
async function waitFor(pred, ms = 8000) {
  const t = Date.now()
  while (Date.now() - t < ms) {
    if (pred(await currentScreen())) return true
    await sleep(300)
  }
  return false
}
/** Select the first list item whose label matches, on the current screen (selection starts at the top after a page change). */
async function pick(re) {
  await poll()
  const cur = screens[screens.length - 1]
  const list = [...lists].reverse().find((l) => l.screen === cur)
  const idx = list ? list.items.findIndex((x) => re.test(x)) : -1
  if (idx < 0) {
    errors.push(`[walkthrough] no item ${re} on ${cur}: ${JSON.stringify(list?.items ?? [])}`)
    return false
  }
  for (let i = 0; i < idx; i++) await input('down')
  await input('click')
  return true
}
async function home() {
  for (let i = 0; i < 6 && (await currentScreen()) !== 'home'; i++) await input('double_click')
  return waitFor((s) => s === 'home')
}

const ping = await fetch(`${BASE}/api/ping`).then((r) => r.text()).catch(() => '')
if (ping !== 'pong') {
  console.error('Simulator automation API not reachable at', BASE)
  process.exit(2)
}
await sleep(3500)
await waitFor((s) => s === 'companion', 10_000)
// a heads-up that arrives while another screen is busy waits on Home behind “★ … says…”
if ((await currentScreen()) === 'home') {
  await pick(/^★/)
  await waitFor((s) => s === 'companion')
}

// 1) the companion speaks up on its own: meeting in 15 minutes → prep me
await shot('proactive_meeting_heads_up')
await pick(/^Prep me/)
await waitFor((s) => s === 'brief')
await shot('meeting_prep')
await home()
// 2) the glanceable home: next meeting, next quest, who needs you, then progress
await shot('home_at_a_glance')
// 3) plan my day → book focus blocks with one confirmation, each verified
await pick(/^Plan my day/)
await waitFor((s) => s === 'plan')
await shot('plan_my_day')
await pick(/^Book \d focus block/)
await waitFor((s) => s === 'confirm-pending')
await shot('confirm_focus_blocks')
await pick(/^Confirm/)
await waitFor((s) => s === 'confirm-done', 12_000)
await shot('focus_blocks_verified')
await pick(/^Continue/)
await home()
// 4) catch me up
await pick(/^Catch me up/)
await waitFor((s) => s === 'brief')
await shot('catch_me_up')
await home()
// 5) inbox: who needs you first (!), a note from your own Telegram bot on top
await pick(/^Inbox/)
await waitFor((s) => s === 'inbox')
await shot('inbox_triaged')
await pick(/Mira Hansen/)
await waitFor((s) => s === 'message')
await shot('message_telegram')
await pick(/^Quick reply/)
await waitFor((s) => s === 'quickreply')
await shot('quick_replies')
await pick(/^Yes, that works/)
await waitFor((s) => s === 'confirm-pending')
await shot('confirm_reply')
await pick(/^Confirm/)
await waitFor((s) => s === 'confirm-done', 12_000)
await shot('reply_sent_verified')
await pick(/^Continue/)
await home()
await pick(/^Inbox/)
await waitFor((s) => s === 'inbox')
await pick(/acme\/web|Add billing export/)
await waitFor((s) => s === 'message')
await shot('github_review_request')
await home()
await pick(/^Inbox/)
await waitFor((s) => s === 'inbox')
await pick(/^\+ Quest:/)
await waitFor((s) => s === 'confirm-pending')
await shot('telegram_capture_to_quest')
await pick(/^Confirm/)
await waitFor((s) => s === 'confirm-done', 12_000)
await pick(/^Continue/)
await home()
// 6) calendar: an exact write is proposed — cancel writes nothing
await pick(/^Calendar/)
await waitFor((s) => s === 'calendar')
await shot('calendar_agenda')
await pick(/^Find time/)
await waitFor((s) => s?.startsWith('confirm'))
await shot('confirm_calendar_write')
await pick(/^Cancel/)
await sleep(800)
await home()
// 7) focus on the next quest, finish it → XP and the companion's reaction (rewarded once)
await pick(/^Next quest/)
await waitFor((s) => s === 'quest')
await shot('quest_detail')
await pick(/^Focus \d+ min/)
await waitFor((s) => s === 'focus')
await shot('focus_session')
await pick(/Done — complete it/)
await waitFor((s) => s === 'companion', 6000)
await shot('quest_completed_celebration')
await input('double_click')
await home()
// 8) character sheet
await pick(/^Character/)
await waitFor((s) => s === 'character')
await shot('character')
await input('click')
await home()
// 9) voice: without an AI key the app says so honestly (no fake transcript)
await pick(/^Talk/)
await waitFor((s) => s?.startsWith('voice'))
await shot('voice_state')
await input('double_click')
await home()
// 10) root double-tap → system exit dialog (QA rule: shutDownPageContainer(1))
await input('double_click')
await sleep(1500)
await shot('exit_dialog_requested')

await poll()
const result = { date: new Date().toISOString(), simulator: BASE, steps, screensSeen: [...new Set(screens)], errors }
writeFileSync(join(OUT, 'run.json'), JSON.stringify(result, null, 2))
console.log(`\nscreens: ${result.screensSeen.join(', ')}\nerrors: ${errors.length}`)
if (errors.length) console.log(errors.join('\n'))
process.exit(errors.length ? 1 : 0)
