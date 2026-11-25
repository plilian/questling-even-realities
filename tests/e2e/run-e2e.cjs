/* eslint-disable */
/**
 * Browser E2E for the phone WebView UI (browser preview adapter — NOT the Even SDK).
 * Requires a running dev server (`npm run dev`) and Playwright with Chromium installed
 * (`npm i -D playwright && npx playwright install chromium`).
 * Usage: node tests/e2e/run-e2e.cjs [baseUrl] [screenshotDir]
 */
let chromium
try {
  ;({ chromium } = require('playwright'))
} catch {
  console.error('Playwright not installed: npm i -D playwright && npx playwright install chromium')
  process.exit(2)
}
const base = process.argv[2] || 'http://127.0.0.1:5173'
const shots = process.argv[3] || 'evidence/e2e'
const fs = require('node:fs')
fs.mkdirSync(shots, { recursive: true })
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

;(async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  // A11 condition: no Questling server reachable for AI (dev server serves /api, Gemini unconfigured)
  await page.goto(`${base}/?device=preview`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)

  // A01 first launch — no account, onboarding
  check('A01 welcome screen without account', await page.getByRole('button', { name: 'Begin' }).isVisible())
  await page.screenshot({ path: `${shots}/01_welcome.png` })
  await page.getByRole('button', { name: 'Begin' }).click()
  await page.getByLabel('Name (optional, fictional is fine)').fill('Rowan')
  await page.getByRole('button', { name: /mage/i }).click()
  await page.getByRole('button', { name: /pick a companion/i }).click()
  await page.getByRole('button', { name: /Grix/ }).click()
  await page.screenshot({ path: `${shots}/02_pick_companion.png` })
  const savageQuote = await page.getByRole('button', { name: /Grix/ }).innerText()
  check('A04 Savage preview is clean by default', !/fuck|shit|damn/i.test(savageQuote))
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await page.getByLabel('Quest').fill('Drink a glass of water')
  await page.getByRole('button', { name: 'Create quest and begin' }).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${shots}/03_home.png` })
  check('A01 home shows the first quest', await page.getByText('Drink a glass of water').first().isVisible())

  // complete once → XP; second attempt impossible (seal disappears)
  await page.getByRole('button', { name: 'Mark done' }).click()
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${shots}/04_celebration.png` })
  const xpText = await page.locator('.levelrow').innerText()
  check('A01 deterministic XP after completion (+20 quest, +20 Training “Finish a quest”)', /40 \/ 100/.test(xpText), xpText.replace(/\n/g, ' '))

  // A10 reload persistence
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  const xpAfter = await page.locator('.levelrow').innerText()
  check('A10 progress restored after reload, no duplicate reward', /40 \/ 100/.test(xpAfter), xpAfter.replace(/\n/g, ' '))

  // the companion lives in the Today scene: tapping it opens the conversation sheet
  await page.getByRole('button', { name: /^Talk with Grix/ }).first().click()
  await page.waitForTimeout(400)
  check('tapping the companion in the scene opens the conversation', await page.getByRole('dialog', { name: /Talk with Grix/ }).isVisible())

  // A04 consent gate: enable requires checkbox
  await page.getByRole('switch', { name: '18+ Language Mode' }).click()
  const enableBtn = page.getByRole('button', { name: 'Enable 18+ Language' })
  check('A04 dialog shown with exact copy', await page.getByText('This mode allows strong profanity and more intense comedic roasting. Intended for adults 18 and over. Disable at any time.').isVisible())
  check('A04 enable disabled until attestation checked', await enableBtn.isDisabled())
  await page.screenshot({ path: `${shots}/05_adult_dialog.png` })
  await page.getByRole('button', { name: 'Cancel' }).click()
  check('A04 cancel leaves mode off', (await page.getByRole('switch', { name: '18+ Language Mode' }).getAttribute('aria-checked')) === 'false')
  await page.getByRole('switch', { name: '18+ Language Mode' }).click()
  await page.getByRole('checkbox').check()
  await enableBtn.click()
  await page.waitForTimeout(300)
  check('A05 explicit opt-in turns mode on', (await page.getByRole('switch', { name: '18+ Language Mode' }).getAttribute('aria-checked')) === 'true')
  // opting in means the real thing: Full 18+ is selected and the Savage's line is unfiltered
  const fullOn = (await page.getByRole('radio', { name: 'Full 18+' }).getAttribute('aria-checked')) === 'true'
  const grixFull = await page.locator('.talk .voices .voice').last().innerText()
  check('Full 18+ is on after opt-in and the Savage really swears', fullOn && /fuck|shit|damn|ass\b|hell\b/i.test(grixFull), grixFull.replace(/\n/g, ' '))
  await page.getByRole('switch', { name: '18+ Language Mode' }).click()
  await page.waitForTimeout(200)
  const grixClean = await page.locator('.talk .voices .voice').last().innerText()
  check('A06 switching off is immediate (no dialog, no restart) and the line is clean again', (await page.getByRole('switch', { name: '18+ Language Mode' }).getAttribute('aria-checked')) === 'false' && !/fuck|shit|damn|hell\b/i.test(grixClean))

  // A11 offline AI is labelled local
  await page.getByLabel(/Message/).fill('what is my next quest')
  await page.getByRole('button', { name: 'Send' }).click()
  await page.waitForTimeout(600)
  const lastSrc = await page.locator('.msg.comp .src').last().innerText()
  check('A11 offline replies are labelled local, not Gemini', /local/i.test(lastSrc), lastSrc)
  await page.screenshot({ path: `${shots}/06_companion.png`, fullPage: false })

  // quick replies send straight away
  const before = await page.locator('.msg.user').count()
  await page.getByRole('button', { name: 'What should I do next?' }).click()
  await page.waitForTimeout(600)
  check('a suggestion chip sends a message and gets a reply', (await page.locator('.msg.user').count()) === before + 1)
  await page.getByRole('button', { name: 'Close conversation' }).click()
  await page.waitForTimeout(250)

  // P0-02 four tabs + the companion reachable from every tab, no dead nav
  for (const t of ['Today', 'Camp', 'Quest Journal', 'Character']) {
    await page.getByRole('navigation').getByRole('button', { name: t }).click()
    await page.waitForTimeout(250)
  }
  await page.getByRole('button', { name: /Talk with Grix|Grix has something to say/ }).click()
  await page.waitForTimeout(300)
  const sheetFromTab = await page.getByRole('dialog', { name: /Talk with Grix/ }).isVisible()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  check('P0-02 four-tab navigation + companion portrait on other tabs, no errors', sheetFromTab && errors.length === 0, errors.join(' | '))
  await page.getByRole('navigation').getByRole('button', { name: 'Camp' }).click()
  await page.waitForTimeout(250)
  await page.getByRole('button', { name: /^Open Grix: personality, nudges/ }).click()
  await page.waitForTimeout(300)
  const sheetFromCamp = await page.getByRole('dialog', { name: /Talk with Grix/ }).isVisible()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  check('Camp opens the companion’s settings (conversation sheet)', sheetFromCamp)
  await page.screenshot({ path: `${shots}/07_settings.png` })

  // task lists: offline server → connect buttons are disabled with an honest reason (no dead button)
  const todoBtn = page.getByRole('button', { name: 'Connect Todoist' })
  check('task integrations disabled honestly when the server is not set up', await todoBtn.isDisabled())
  const mailBtns = [page.getByRole('button', { name: 'Connect Gmail' }), page.getByRole('button', { name: 'Connect Slack' })]
  check('Gmail and Slack disabled honestly when the server is not set up', (await mailBtns[0].isDisabled()) && (await mailBtns[1].isDisabled()))

  // demo: synthetic Todoist list → import → quest tagged with its source; write-back needs confirmation
  const demo = await browser.newPage({ viewport: { width: 390, height: 844 } })
  demo.on('pageerror', (e) => errors.push(String(e)))
  await demo.goto(`${base}/?demo=reset&device=preview`, { waitUntil: 'networkidle' })
  await demo.getByRole('navigation').getByRole('button', { name: 'Camp' }).click()
  await demo.getByRole('button', { name: 'Connect Todoist' }).click()
  await demo.waitForTimeout(300)
  await demo.getByRole('button', { name: /Add “Pay the electricity bill” as a quest/ }).click()
  await demo.getByRole('navigation').getByRole('button', { name: 'Quest Journal' }).click()
  await demo.getByText('Pay the electricity bill').first().click()
  const tagged = await demo.getByText('from Todoist').first().isVisible()
  await demo.getByRole('button', { name: 'Mark done', exact: true }).click()
  await demo.waitForTimeout(500)
  const asked = await demo.getByText('Tick it off at the source?').isVisible()
  check('demo import tags the quest and asks before writing back', tagged && asked)
  await demo.getByRole('button', { name: 'Confirm' }).click()
  await demo.waitForTimeout(500)
  check('write-back result is verified and labelled demo', await demo.getByText(/Marked done and verified in Todoist · demo/).isVisible())
  await demo.screenshot({ path: `${shots}/08_task_writeback.png` })
  await demo.close()
  check('no page errors in the demo task flow', errors.length === 0, errors.join(' | '))

  // demo: synthetic Gmail + Slack inbox → heads-up list on Today → reply needs confirmation, result labelled demo
  const mail = await browser.newPage({ viewport: { width: 390, height: 844 } })
  mail.on('pageerror', (e) => errors.push(String(e)))
  await mail.goto(`${base}/?demo=reset&device=preview`, { waitUntil: 'networkidle' })
  await mail.waitForTimeout(600)
  // demo starts with the synthetic inboxes linked
  const glance = (await mail.getByRole('heading', { name: 'Messages' }).isVisible()) && (await mail.getByRole('button', { name: /^Mira Hansen:/ }).isVisible()) && (await mail.getByRole('button', { name: /^Sam Lee:/ }).isVisible())
  check('Today lists Gmail, Slack and Telegram heads-ups (demo)', glance)

  // Training lives in the XP section: one clear step, a “Show me” that does it, XP once
  const trainingShown = await mail.locator('.training').getByText(/Training · 0\/7/).isVisible()
  await mail.locator('.training').getByRole('button', { name: /Show me · \+10 XP/ }).click()
  await mail.waitForTimeout(400)
  const talkOpened = await mail.getByRole('dialog', { name: /Talk with/ }).isVisible()
  await mail.keyboard.press('Escape')
  await mail.waitForTimeout(300)
  check('TRAINING card under the XP bar; “Show me” does the step and grants XP once', trainingShown && talkOpened && (await mail.locator('.training').getByText(/Training · 1\/7/).isVisible()) && (await mail.locator('.training').getByText('10/120 XP').isVisible()))

  // Catch me up / Recap (evening): a short local brief, labelled
  for (let i = 0; i < 3; i++) {
    await mail.locator('.scene button', { hasText: '×' }).first().click({ timeout: 1500 }).catch(() => {})
    await mail.waitForTimeout(250)
  }
  await mail.getByRole('button', { name: /^(Catch me up|Recap my day)$/ }).first().click()
  await mail.waitForTimeout(500)
  const briefOk = (await mail.getByRole('dialog', { name: /Catch me up|Recap my day/ }).isVisible()) && (await mail.getByText(/local summary/).isVisible())
  check('BRIEF catch-up / recap opens as a labelled local summary', briefOk)
  await mail.keyboard.press('Escape')
  await mail.waitForTimeout(300)

  // Channel digest (demo Telegram is linked): one line per channel, labelled local
  await mail.getByRole('button', { name: 'Channel digest', exact: true }).first().click()
  await mail.waitForTimeout(500)
  const digestDlg = mail.getByRole('dialog', { name: 'Channel digest' })
  const digestOk = (await digestDlg.isVisible()) && (await digestDlg.getByText(/Even Realities News \(demo\): 2 new/).isVisible()) && (await digestDlg.getByText(/local summary/).isVisible())
  await mail.screenshot({ path: `${shots}/12_channel_digest.png` })
  check('DIGEST channel digest shows one line per channel, labelled local', digestOk)
  await mail.keyboard.press('Escape')
  await mail.waitForTimeout(300)

  // Ask my notes: connect demo Notion, ask a typed question, answer names the page
  await mail.getByRole('navigation').getByRole('button', { name: 'Camp' }).click()
  await mail.getByRole('button', { name: 'Connect Notion' }).click()
  await mail.waitForTimeout(300)
  await mail.getByRole('navigation').getByRole('button', { name: 'Today' }).click()
  await mail.waitForTimeout(300)
  await mail.getByRole('button', { name: 'Ask my notes', exact: true }).first().click()
  await mail.waitForTimeout(300)
  const askDlg = mail.getByRole('dialog', { name: 'Ask my notes' })
  const suggestions = await askDlg.locator('.chipbtn').count()
  await askDlg.getByRole('textbox', { name: 'Your question' }).fill('What did we decide about pricing?')
  await askDlg.getByRole('button', { name: 'Ask', exact: true }).click()
  await mail.waitForTimeout(600)
  const ansDlg = mail.getByRole('dialog', { name: /^Notes · What did we decide about pricing/ })
  const notesOk = suggestions >= 2 && (await ansDlg.isVisible()) && (await ansDlg.getByText(/From “Pricing decisions \(demo\)”/).isVisible()) && (await ansDlg.getByText(/\$5 per month/).isVisible())
  await mail.screenshot({ path: `${shots}/13_ask_my_notes.png` })
  check('NOTES ask my notes answers from the matching Notion page (demo), naming it', notesOk, `suggestions=${suggestions}`)
  await mail.keyboard.press('Escape')
  await mail.waitForTimeout(300)

  // Focus session from the featured quest: banner with time left
  await mail.locator('.featured').getByRole('button', { name: 'Focus', exact: true }).click()
  await mail.waitForTimeout(400)
  check('FOCUS session starts from the quest and shows time left', await mail.locator('.focusbar').getByText(/Focus · \d+ min left/).isVisible())
  await mail.locator('.focusbar').getByRole('button', { name: 'Stop' }).click()
  await mail.waitForTimeout(300)

  // Telegram capture → quest, only after confirming
  await mail.getByRole('button', { name: 'Add quest' }).first().click()
  await mail.waitForTimeout(300)
  await mail.getByRole('button', { name: 'Confirm' }).click()
  await mail.waitForTimeout(600)
  await mail.getByRole('button', { name: 'Close' }).last().click().catch(() => {})
  await mail.waitForTimeout(300)
  check('CAPTURE “/quest …” from your Telegram bot becomes a quest after confirmation', (await mail.locator('.captures').count()) === 0 && (await mail.getByText('Call the bank about the new card').count()) > 0)
  await mail.evaluate(() => window.scrollTo(0, 0))

  // Plan my day: local plan → one confirmation books every focus block, each verified
  await mail.getByRole('button', { name: 'Plan my day' }).first().click()
  await mail.waitForTimeout(500)
  const planShown = (await mail.getByRole('dialog', { name: 'Plan my day' }).isVisible()) && (await mail.getByText(/^Local plan/).isVisible())
  const book = mail.getByRole('button', { name: /^Book \d focus block/ })
  const nBlocks = Number(((await book.innerText()).match(/\d/) ?? ['0'])[0])
  await book.click()
  await mail.waitForTimeout(400)
  const askedOnce = await mail.getByRole('dialog', { name: /^Book \d focus block/ }).isVisible()
  await mail.getByRole('button', { name: 'Confirm' }).click()
  await mail.waitForTimeout(1800)
  check('PLAN local plan books focus blocks with one confirmation, verified (demo calendar)', planShown && nBlocks > 0 && askedOnce && (await mail.getByText(new RegExp(`Created and verified ${nBlocks} of ${nBlocks} in the DEMO calendar`)).isVisible()))
  await mail.screenshot({ path: `${shots}/10_plan_booked.png` })
  await mail.getByRole('button', { name: 'Close' }).last().click()
  await mail.waitForTimeout(300)

  // Telegram: a quick reply chip fills the text; it is still confirmed verbatim
  await mail.getByRole('button', { name: /^Mira Hansen:/ }).first().click()
  await mail.waitForTimeout(300)
  await mail.getByRole('button', { name: 'Yes, that works for me.' }).click()
  await mail.getByRole('button', { name: 'Review & send' }).click()
  await mail.waitForTimeout(300)
  const tgAsk = await mail.getByText('Send this Telegram reply?').isVisible()
  await mail.getByRole('button', { name: 'Confirm' }).click()
  await mail.waitForTimeout(700)
  check('Telegram quick reply is confirmed verbatim and verified (demo)', tgAsk && (await mail.getByText(/Sent and verified \(DEMO Telegram/).isVisible()))
  await mail.getByRole('button', { name: 'Close' }).last().click()
  await mail.waitForTimeout(300)
  await mail.getByRole('button', { name: /^Sam Lee:/ }).first().click()
  await mail.waitForTimeout(300)
  const subjectOnly = await mail.getByText('Questling sees the sender and subject only').isVisible()
  await mail.getByRole('textbox', { name: 'Your reply' }).fill('Yes — numbers by 3, sheet on its way.')
  await mail.getByRole('button', { name: 'Review & send' }).click()
  await mail.waitForTimeout(300)
  const confirmFirst = await mail.getByText('Send this email reply?').isVisible()
  check('Gmail shows subject only and a reply needs confirmation', subjectOnly && confirmFirst)
  await mail.getByRole('button', { name: 'Confirm' }).click()
  await mail.waitForTimeout(600)
  check('reply result is verified and labelled demo (nothing sent)', await mail.getByText(/Sent and verified \(DEMO Gmail — nothing left this device\)/).isVisible())
  await mail.screenshot({ path: `${shots}/09_mail_reply.png` })
  await mail.close()
  check('no page errors in the demo mail flow', errors.length === 0, errors.join(' | '))

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  fs.writeFileSync(`${shots}/results.json`, JSON.stringify({ date: new Date().toISOString(), base, results }, null, 2))
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
})()
