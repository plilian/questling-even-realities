#!/usr/bin/env node
/**
 * Package Questling as an Even Hub .ehpk with the official CLI.
 * Writes a build manifest (build/app.json) from app.json, adding permissions ONLY when used:
 *  - `network` with the exact API origin from VITE_API_BASE_URL (required: whitelist + CORS)
 *  - `g2-microphone` (voice) only when an API origin exists (voice needs the Gemini proxy)
 * Without VITE_API_BASE_URL the package is local-only: quests, companions, reminders work offline;
 * AI, voice and Calendar show as unavailable. Secrets are never bundled.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'

try {
  process.loadEnvFile?.('.env')
} catch {
  /* optional */
}
const api = (process.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const manifest = JSON.parse(readFileSync('app.json', 'utf8'))
const permissions = []
if (api) {
  const origin = new URL(api).origin
  if (!origin.startsWith('https://') && !process.env.ALLOW_HTTP_API) {
    console.error(`Refusing non-HTTPS API origin ${origin} for a distributable package (set ALLOW_HTTP_API=1 for LAN testing).`)
    process.exit(1)
  }
  permissions.push({ name: 'network', desc: 'Talks to your Questling server for AI replies, voice understanding, Google Calendar, task lists, Gmail and Slack (every change needs your confirmation).', whitelist: [origin] })
  permissions.push({ name: 'g2-microphone', desc: 'Push-to-talk voice commands. The mic is only on while you hold a voice request (max 15 s).' })
}
manifest.permissions = permissions
mkdirSync('build', { recursive: true })
writeFileSync('build/app.json', JSON.stringify(manifest, null, 2))
if (!existsSync('dist/index.html')) {
  console.error('dist/ missing — run `npm run build:client` first')
  process.exit(1)
}
const out = `questling-${manifest.version}.ehpk`
const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx'
execFileSync(bin, ['evenhub', 'pack', 'build/app.json', 'dist', '-o', out, '--sdk-ver', '0.0.16'], { stdio: 'inherit' })
console.log(`\nPackaged ${out} (${api ? `network → ${new URL(api).origin}` : 'local-only: no network permission'})`)
