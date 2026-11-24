/* eslint-disable @typescript-eslint/no-require-imports */
/* global window, document, localStorage, __dirname */
/**
 * Phone screenshots for README/docs (Playwright, 390×844 @2x, demo data only).
 * Prereq: `npm run dev`. Usage: node scripts/screenshots.cjs [baseUrl]
 * (Playwright is not a project dependency: NODE_PATH=$(npm root -g) if installed globally.)
 */
const { chromium } = require('playwright')
const path = require('node:path')

const BASE = process.argv[2] || 'http://127.0.0.1:5173'
const OUT = path.join(__dirname, '..', 'docs', 'screenshots')

;(async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const nav = (n) => page.getByRole('navigation').getByRole('button', { name: n }).click()
  const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` })

  await page.goto(`${BASE}/?demo=reset`)
  await page.waitForTimeout(1500)
  await shot('phone_home')
  // Training sits right under the XP bar
  await page.locator('.training').scrollIntoViewIfNeeded()
  await page.evaluate(() => window.scrollBy(0, 160)); await page.waitForTimeout(250)
  await shot('phone_training')
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(200)
  await page.getByRole('button', { name: /Later/ }).first().click().catch(() => {})
  await page.keyboard.press('Escape')
  await nav('Quest Journal'); await page.waitForTimeout(500)
  await shot('phone_quests')
  await nav('Character'); await page.waitForTimeout(500)
  await shot('phone_character')
  await nav('Today'); await page.waitForTimeout(300)
  await page.getByRole('button', { name: /^Talk with/ }).first().click(); await page.waitForTimeout(400)
  await page.getByRole('button', { name: 'What should I do next?' }).click(); await page.waitForTimeout(900)
  await shot('phone_companion')
  await page.locator('.voices').scrollIntoViewIfNeeded()
  await page.evaluate(() => document.querySelector('.talk-body')?.scrollBy(0, -90)); await page.waitForTimeout(300)
  await shot('phone_five_voices')
  await page.getByRole('button', { name: 'Close conversation' }).click()

  await nav('Camp'); await page.waitForTimeout(500)
  await shot('phone_settings')
  // demo integrations: synthetic data, nothing leaves the device
  await page.getByRole('button', { name: 'Connect Todoist' }).click()
  await page.waitForTimeout(500)
  await page.locator('h3', { hasText: 'Task lists' }).scrollIntoViewIfNeeded()
  await page.evaluate(() => window.scrollBy(0, -70))
  await shot('phone_task_lists')

  await nav('Today'); await page.waitForTimeout(400)
  await page.getByRole('heading', { name: 'Messages' }).scrollIntoViewIfNeeded()
  await page.evaluate(() => window.scrollBy(0, 260)); await page.waitForTimeout(200)
  await shot('phone_mail')
  await page.getByRole('button', { name: /^Mira Hansen:/ }).first().click(); await page.waitForTimeout(400)
  await page.getByRole('button', { name: 'Yes, that works for me.' }).click()
  await page.waitForTimeout(200)
  await shot('phone_reply')
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)

  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(200)
  await page.getByRole('button', { name: 'Plan my day' }).first().click(); await page.waitForTimeout(500)
  await shot('phone_plan')
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)

  // dismiss whatever the companion is saying, then catch up and focus
  for (let i = 0; i < 3; i++) { await page.locator('.scene button', { hasText: '×' }).first().click({ timeout: 1500 }).catch(() => {}); await page.waitForTimeout(250) }
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(200)
  await page.getByRole('button', { name: /^(Catch me up|Recap my day)$/ }).first().click(); await page.waitForTimeout(500)
  await shot('phone_brief')
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)
  await page.locator('.featured').getByRole('button', { name: 'Focus', exact: true }).click(); await page.waitForTimeout(500)
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(3500)
  await shot('phone_focus')
  await page.locator('.focusbar').getByRole('button', { name: 'Stop' }).click(); await page.waitForTimeout(300)
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(200)
  await page.getByRole('button', { name: /Mark done: / }).first().click()
  await page.waitForTimeout(900)
  await shot('phone_celebration')

  const p2 = await ctx.newPage()
  p2.on('pageerror', (e) => errors.push(String(e)))
  await p2.goto(`${BASE}/?device=preview`)
  await p2.evaluate(() => localStorage.clear())
  await p2.reload(); await p2.waitForTimeout(1200)
  await p2.screenshot({ path: `${OUT}/phone_welcome.png` })
  await p2.getByRole('button', { name: 'Begin' }).click(); await p2.waitForTimeout(400)
  await p2.screenshot({ path: `${OUT}/phone_onboarding_hero.png` })
  await p2.getByRole('button', { name: /pick a companion/i }).click(); await p2.waitForTimeout(400)
  await p2.screenshot({ path: `${OUT}/phone_pick_companion.png` })

  console.log('errors', JSON.stringify(errors))
  await browser.close()
  process.exit(errors.length ? 1 : 0)
})()
