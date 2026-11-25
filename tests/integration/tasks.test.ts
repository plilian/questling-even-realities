import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handle, setRuntimeForTests } from '../../server/app'
import { loadConfig, type ServerConfig } from '../../server/config'
import { resetGoogleStateForTests } from '../../server/google'
import { resetTaskStateForTests } from '../../server/tasks'
import { FakeGoogle } from '../fakes/google'
import { FakeTasks } from '../fakes/tasks'

const google = new FakeGoogle()
const fake = new FakeTasks(google)
let api: Server
let base = ''
let cfg: ServerConfig

function makeCfg(over: Partial<NodeJS.ProcessEnv> = {}): ServerConfig {
  return loadConfig({
    NODE_ENV: 'test',
    APP_BASE_URL: 'http://app.test',
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    GOOGLE_REDIRECT_URI: 'http://app.test/api/auth/google/callback',
    GOOGLE_AUTH_URL: `${google.base}/auth`,
    GOOGLE_TOKEN_URL: `${google.base}/token`,
    GOOGLE_REVOKE_URL: `${google.base}/revoke`,
    GOOGLE_CALENDAR_BASE: `${google.base}/calendar/v3`,
    GOOGLE_TASKS_BASE: `${fake.base}/gtasks/tasks/v1`,
    TODOIST_CLIENT_ID: 'todo-client',
    TODOIST_CLIENT_SECRET: 'todo-secret',
    TODOIST_AUTH_URL: `${fake.base}/todoist/oauth/authorize`,
    TODOIST_TOKEN_URL: `${fake.base}/todoist/oauth/access_token`,
    TODOIST_API_BASE: `${fake.base}/todoist/api/v1`,
    NOTION_CLIENT_ID: 'notion-client',
    NOTION_CLIENT_SECRET: 'notion-secret',
    NOTION_AUTH_URL: `${fake.base}/notion/v1/oauth/authorize`,
    NOTION_API_BASE: `${fake.base}/notion/v1`,
    ...over,
  })
}

async function call(path: string, init: RequestInit & { token?: string; tasks?: string } = {}) {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
  if (init.token) headers.authorization = `Bearer ${init.token}`
  if (init.tasks) headers['x-lq-tasks'] = init.tasks
  if (init.body && !headers['content-type']) headers['content-type'] = 'application/json'
  const r = await fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' })
  const text = await r.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text)
  } catch {
    body = { html: text }
  }
  return { status: r.status, body, headers: r.headers }
}

async function token(): Promise<string> {
  return (await call('/api/session', { method: 'POST', body: '{}' })).body.token as string
}

/** Drive the shared link page → provider consent → callback → poll flow. */
async function link(tok: string, provider: 'todoist' | 'notion' | 'google_tasks'): Promise<string> {
  const start = await call('/api/tasks/link/start', { method: 'POST', body: JSON.stringify({ provider }), token: tok })
  expect(start.status).toBe(200)
  const { linkId, pollSecret, userCode } = start.body as Record<string, string>
  const page = await call(`/link?code=${encodeURIComponent(userCode!)}`)
  expect(String(page.body.html)).toContain('action="/api/auth/start"')
  const redirect = await call(`/api/auth/start?code=${encodeURIComponent(userCode!)}`)
  expect(redirect.status).toBe(302)
  const auth = new URL(redirect.headers.get('location')!)
  const state = auth.searchParams.get('state')!
  let cbPath: string
  if (provider === 'todoist') {
    expect(auth.origin + auth.pathname).toBe(`${fake.base}/todoist/oauth/authorize`)
    expect(auth.searchParams.get('scope')).toBe('data:read_write')
    cbPath = `/api/auth/todoist/callback?code=${fake.issueTodoistCode()}&state=${state}`
  } else if (provider === 'notion') {
    expect(auth.searchParams.get('owner')).toBe('user')
    expect(auth.searchParams.get('redirect_uri')).toBe('http://app.test/api/auth/notion/callback')
    cbPath = `/api/auth/notion/callback?code=${fake.issueNotionCode()}&state=${state}`
  } else {
    expect(auth.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/tasks')
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256')
    expect(auth.searchParams.get('redirect_uri')).toBe('http://app.test/api/auth/google/callback')
    google.grantedScope = 'https://www.googleapis.com/auth/tasks'
    cbPath = `/api/auth/google/callback?code=${google.issueCode(auth.searchParams.get('code_challenge')!)}&state=${state}`
  }
  const cb = await call(cbPath)
  expect(cb.status).toBe(200)
  expect((await call(cbPath)).status).toBe(400) // state is single-use
  const done = await call('/api/tasks/link/poll', { method: 'POST', body: JSON.stringify({ linkId, pollSecret }), token: tok })
  expect(done.body.status).toBe('connected')
  expect(done.body.provider).toBe(provider)
  // no provider token leaves the server (check the real issued tokens: random handles may contain any short fragment)
  const body = JSON.stringify(done.body)
  for (const t of [...fake.todoistTokens, ...fake.notionTokens, ...google.validTokens, 'never-kept']) expect(body).not.toContain(t)
  return done.body.sessionHandle as string
}

beforeAll(async () => {
  await google.start()
  await fake.start()
  api = createServer((req, res) => void handle(req, res))
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
})
afterAll(async () => {
  await google.stop()
  await fake.stop()
  await new Promise<void>((r) => api.close(() => r()))
})
beforeEach(() => {
  cfg = makeCfg()
  setRuntimeForTests({ cfg })
  resetGoogleStateForTests()
  resetTaskStateForTests()
  fake.reset()
  google.grantedScope = 'https://www.googleapis.com/auth/calendar.events.owned'
})

describe('task integrations: configuration', () => {
  it('reports which integrations are configured and refuses unconfigured ones', async () => {
    expect((await call('/api/status')).body.tasks).toEqual({ todoist: true, notion: true, google_tasks: true })
    setRuntimeForTests({ cfg: makeCfg({ TODOIST_CLIENT_ID: '', NOTION_CLIENT_SECRET: '', GOOGLE_TASKS_ENABLED: 'false' }) })
    expect((await call('/api/status')).body.tasks).toEqual({ todoist: false, notion: false, google_tasks: false })
    const r = await call('/api/tasks/link/start', { method: 'POST', body: JSON.stringify({ provider: 'todoist' }), token: await token() })
    expect(r.status).toBe(503)
    expect(r.body.error).toBe('integration_not_configured')
  })
  it('requires the API token and a task session', async () => {
    expect((await call('/api/tasks/link/start', { method: 'POST', body: JSON.stringify({ provider: 'todoist' }) })).status).toBe(401)
    const r = await call('/api/tasks', { token: await token() })
    expect(r.status).toBe(401)
    expect(r.body.error).toBe('tasks_not_connected')
  })
  it('rejects a callback whose state belongs to another provider', async () => {
    const t = await token()
    const start = await call('/api/tasks/link/start', { method: 'POST', body: JSON.stringify({ provider: 'todoist' }), token: t })
    const redirect = await call(`/api/auth/start?code=${start.body.userCode}`)
    const state = new URL(redirect.headers.get('location')!).searchParams.get('state')
    expect((await call(`/api/auth/notion/callback?code=${fake.issueNotionCode()}&state=${state}`)).status).toBe(400)
  })
  it('a denied consent ends the link without a session', async () => {
    const t = await token()
    const start = await call('/api/tasks/link/start', { method: 'POST', body: JSON.stringify({ provider: 'todoist' }), token: t })
    const redirect = await call(`/api/auth/start?code=${start.body.userCode}`)
    const state = new URL(redirect.headers.get('location')!).searchParams.get('state')
    expect((await call(`/api/auth/todoist/callback?error=access_denied&state=${state}`)).status).toBe(400)
    const poll = await call('/api/tasks/link/poll', { method: 'POST', body: JSON.stringify({ linkId: start.body.linkId, pollSecret: start.body.pollSecret }), token: t })
    expect(poll.body.status).toBe('denied')
  })
})

describe('Todoist', () => {
  it('lists open tasks minimized, completes one with read-back verification, and is idempotent per proposal', async () => {
    const t = await token()
    const h = await link(t, 'todoist')
    const list = await call('/api/tasks', { token: t, tasks: h })
    expect(list.status).toBe(200)
    const tasks = list.body.tasks as Array<Record<string, unknown>>
    expect(tasks.map((x) => x.title)).toEqual(['Water plants', 'Pay electricity bill'])
    expect(JSON.stringify(tasks)).not.toContain('account 12345') // descriptions never leave the server
    expect(tasks[1]).toMatchObject({ id: 't1', dueAllDay: true, done: false, recurring: false })
    const done = await call('/api/tasks/complete', { method: 'POST', body: JSON.stringify({ proposalId: 'prop_ABCDEFGH12', taskId: 't1' }), token: t, tasks: h })
    expect(done.status).toBe(200)
    expect(done.body).toMatchObject({ verified: true, reconciled: false })
    expect(fake.todoist.get('t1')!.checked).toBe(true)
    const replay = await call('/api/tasks/complete', { method: 'POST', body: JSON.stringify({ proposalId: 'prop_ABCDEFGH12', taskId: 't1' }), token: t, tasks: h })
    expect(replay.body.reconciled).toBe(true)
    expect(fake.count('POST', '/tasks/t1/close')).toBe(1)
  })
  it('reports a recurring task as this occurrence done, and fails loudly when the write did not stick', async () => {
    const t = await token()
    const h = await link(t, 'todoist')
    const r = await call('/api/tasks/complete', { method: 'POST', body: JSON.stringify({ proposalId: 'prop_RECUR00001', taskId: 't2' }), token: t, tasks: h })
    expect(r.status).toBe(200)
    expect(String(r.body.note)).toContain('Recurring')
    fake.failClose = true
    const bad = await call('/api/tasks/complete', { method: 'POST', body: JSON.stringify({ proposalId: 'prop_FAILCLOSE1', taskId: 't1' }), token: t, tasks: h })
    expect(bad.status).toBe(502)
    expect(bad.body.error).toBe('task_complete_unverified')
  })
  it('disconnect revokes the token and kills the session', async () => {
    const t = await token()
    const h = await link(t, 'todoist')
    const d = await call('/api/tasks/disconnect', { method: 'POST', body: '{}', token: t, tasks: h })
    expect(d.body.revoked).toBe(true)
    expect(fake.todoistRevoked.size).toBe(1)
    expect((await call('/api/tasks', { token: t, tasks: h })).status).toBe(401)
  })
  it('an upstream 401 expires the session', async () => {
    const t = await token()
    const h = await link(t, 'todoist')
    fake.todoistTokens.clear()
    const r = await call('/api/tasks', { token: t, tasks: h })
    expect(r.status).toBe(401)
    expect(r.body.error).toBe('tasks_session_expired')
  })
})

describe('Notion', () => {
  it('finds the task database by shape, lists open rows without page content, and ticks the checkbox', async () => {
    const t = await token()
    const h = await link(t, 'notion')
    const list = await call('/api/tasks', { token: t, tasks: h })
    expect(list.status).toBe(200)
    expect(list.body.label).toBe('Notion · Tasks')
    expect(list.body.selected).toBe('22222222-aaaa-bbbb-cccc-000000000001')
    expect(list.body.sources).toEqual([
      { id: '22222222-aaaa-bbbb-cccc-000000000009', name: 'Reading list', writable: false },
      { id: '22222222-aaaa-bbbb-cccc-000000000001', name: 'Tasks', writable: true },
    ])
    const tasks = list.body.tasks as Array<Record<string, unknown>>
    expect(tasks.map((x) => x.title)).toEqual(['Draft chapter 3'])
    expect(JSON.stringify(list.body)).not.toContain('private body text')
    expect(fake.calls.every((c) => !c.path.startsWith('/notion/v1/') || c.path.includes('oauth') || c.headers['notion-version'] === '2025-09-03')).toBe(true)
    const r = await call('/api/tasks/complete', { method: 'POST', body: JSON.stringify({ proposalId: 'prop_NOTION0001', taskId: '11111111-aaaa-bbbb-cccc-000000000001' }), token: t, tasks: h })
    expect(r.status).toBe(200)
    expect(fake.notionPages.get('11111111-aaaa-bbbb-cccc-000000000001')!.done).toBe(true)
  })
  it('supports a Status property and moves the row to the first “Complete” option', async () => {
    fake.notionStatusMode = true
    const t = await token()
    const h = await link(t, 'notion')
    expect(((await call('/api/tasks', { token: t, tasks: h })).body.tasks as unknown[]).length).toBe(1)
    const r = await call('/api/tasks/complete', { method: 'POST', body: JSON.stringify({ proposalId: 'prop_NOTION0002', taskId: '11111111-aaaa-bbbb-cccc-000000000001' }), token: t, tasks: h })
    expect(r.status).toBe(200)
    const patch = fake.calls.find((c) => c.method === 'PATCH')!
    expect(JSON.parse(patch.body)).toEqual({ properties: { Status: { status: { name: 'Shipped' } } } })
  })
  it('Ask my notes: finds pages by keyword in a POST body, returns title + excerpt only, never other pages', async () => {
    const t = await token()
    const h = await link(t, 'notion')
    const r = await call('/api/notes/search', { method: 'POST', body: JSON.stringify({ q: 'What did we decide about pricing?' }), token: t, tasks: h })
    expect(r.status).toBe(200)
    const notes = r.body.notes as Array<{ title: string; text: string; editedAt: number }>
    expect(notes.map((n) => n.title)).toEqual(['Pricing decisions', 'Weekly sync'])
    expect(notes[0]!.text).toContain('Plus costs $5 per month')
    expect(notes[0]!.text).toContain('[ ] Tell Alex about the pricing change')
    expect(notes[1]!.text).toBe('Alex wants the pricing slide simplified.')
    expect(JSON.stringify(r.body)).not.toContain('Passport') // unrelated page never leaves the server
    expect(notes[0]!.editedAt).toBe(Date.parse('2026-11-24T09:00:00.000Z'))
    // the question travels in a POST body, never in a URL
    expect(fake.calls.filter((c) => c.path.startsWith('/notion/v1/')).every((c) => !c.path.toLowerCase().includes('pricing'))).toBe(true)
    expect(fake.calls.some((c) => c.path === '/notion/v1/search' && JSON.parse(c.body).query === 'pricing')).toBe(true)
    expect(fake.calls.every((c) => !c.path.startsWith('/notion/v1/') || c.path.includes('oauth') || c.headers['notion-version'] === '2025-09-03')).toBe(true)
  })
  it('Ask my notes: nothing relevant → empty list; bad input and non-Notion connections are refused', async () => {
    const t = await token()
    const h = await link(t, 'notion')
    expect(((await call('/api/notes/search', { method: 'POST', body: JSON.stringify({ q: 'quarterly tax forms' }), token: t, tasks: h })).body.notes as unknown[]).length).toBe(0)
    expect((await call('/api/notes/search', { method: 'POST', body: JSON.stringify({ q: 'x' }), token: t, tasks: h })).status).toBe(400)
    expect((await call('/api/notes/search', { method: 'POST', body: JSON.stringify({ q: 'a'.repeat(201) }), token: t, tasks: h })).status).toBe(400)
    const td = await link(t, 'todoist')
    const r = await call('/api/notes/search', { method: 'POST', body: JSON.stringify({ q: 'pricing' }), token: t, tasks: td })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('notes_need_notion')
  })
  it('disconnect revokes with client credentials', async () => {
    const t = await token()
    const h = await link(t, 'notion')
    expect((await call('/api/tasks/disconnect', { method: 'POST', body: '{}', token: t, tasks: h })).body.revoked).toBe(true)
    expect(fake.notionRevoked.size).toBe(1)
  })
})

describe('Google Tasks', () => {
  it('shares the Calendar redirect URI, reads the default list date-only, and completes with verification', async () => {
    const t = await token()
    const h = await link(t, 'google_tasks')
    const list = await call('/api/tasks', { token: t, tasks: h })
    const tasks = list.body.tasks as Array<Record<string, unknown>>
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ id: 'g1', title: 'Renew passport', dueAllDay: true, list: 'My Tasks' })
    expect(JSON.stringify(tasks)).not.toContain('bring photos')
    const r = await call('/api/tasks/complete', { method: 'POST', body: JSON.stringify({ proposalId: 'prop_GTASK00001', taskId: 'g1' }), token: t, tasks: h })
    expect(r.status).toBe(200)
    expect(fake.gtasks.get('g1')!.status).toBe('completed')
  })
  it('refuses a grant without the Tasks scope', async () => {
    const t = await token()
    const start = await call('/api/tasks/link/start', { method: 'POST', body: JSON.stringify({ provider: 'google_tasks' }), token: t })
    const redirect = await call(`/api/auth/start?code=${start.body.userCode}`)
    const auth = new URL(redirect.headers.get('location')!)
    google.grantedScope = 'https://www.googleapis.com/auth/calendar.events.owned'
    const cb = await call(`/api/auth/google/callback?code=${google.issueCode(auth.searchParams.get('code_challenge')!)}&state=${auth.searchParams.get('state')}`)
    expect(cb.status).toBe(400)
    const poll = await call('/api/tasks/link/poll', { method: 'POST', body: JSON.stringify({ linkId: start.body.linkId, pollSecret: start.body.pollSecret }), token: t })
    expect(poll.body.status).toBe('denied')
  })
})
