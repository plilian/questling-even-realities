#!/usr/bin/env node
/**
 * Repository policy checks (security and privacy invariants), run by `npm run lint`:
 *  1. No secrets in client code: client must never reference any provider API key / OAuth client secret / VITE_*SECRET/KEY.
 *  2. Provider tokens never written to storage: no localStorage/setLocalStorage of tokens or session handles.
 *  3. No dangerouslySetInnerHTML / eval in the client.
 *  4. No AI/tool path can enable adult mode: enableAdultMode is only called from the consent dialog.
 *  5. Built bundle (if present) contains no secret-looking values from .env.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const errors = []
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|js|mjs)$/.test(f)) out.push(p)
  }
  return out
}
const client = walk('src')
for (const f of client) {
  const s = readFileSync(f, 'utf8')
  if (/(GEMINI|OPENAI|ANTHROPIC|OPENROUTER)_API_KEY|(GOOGLE|TODOIST|NOTION|SLACK)_CLIENT_SECRET|process\.env/.test(s)) errors.push(`${f}: client code references server secrets/env`)
  if (/import\.meta\.env\.VITE_\w*(SECRET|KEY|TOKEN)/.test(s)) errors.push(`${f}: secret-looking VITE_ variable in client`)
  if (/dangerouslySetInnerHTML|\beval\(|new Function\(/.test(s)) errors.push(`${f}: unsafe HTML/eval`)
  if (/(localStorage|setLocalStorage|kv\.set)\([^)]*(token|handle|access_token|sessionHandle)/i.test(s)) errors.push(`${f}: credential written to storage`)
  if (/enableAdultMode\(/.test(s) && !/(controller\.ts|overlays\.tsx)$/.test(f)) errors.push(`${f}: enableAdultMode called outside the consent dialog`)
}
if (existsSync('dist')) {
  let env = ''
  try {
    env = readFileSync('.env', 'utf8')
  } catch {
    /* no .env */
  }
  const secrets = env
    .split('\n')
    .map((l) => l.split('=').slice(1).join('=').trim())
    .filter((v) => v.length >= 12)
  for (const f of walk('dist')) {
    const s = readFileSync(f, 'utf8')
    for (const v of secrets) if (s.includes(v)) errors.push(`${f}: contains a value from .env`)
    if (/AIza[0-9A-Za-z_-]{30,}/.test(s)) errors.push(`${f}: looks like a Google API key`)
    if (/GOCSPX-[0-9A-Za-z_-]{10,}/.test(s)) errors.push(`${f}: looks like a Google OAuth client secret`)
    if (/sk-(proj-|ant-|or-)?[0-9A-Za-z_-]{24,}/.test(s)) errors.push(`${f}: looks like an OpenAI/Anthropic/OpenRouter key`)
    if (/xox[abposr]-[0-9A-Za-z-]{10,}/.test(s)) errors.push(`${f}: looks like a Slack token`)
  }
}
if (errors.length) {
  console.error('policy-lint failed:\n' + errors.map((e) => ' - ' + e).join('\n'))
  process.exit(1)
}
console.log(`policy-lint: ${client.length} client files checked, no violations`)
