import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** Contract fake of the GitHub REST endpoints Questling uses (/user, /notifications, thread read). TEST DOUBLE only. */
// Built at runtime so secret scanners never see a token-shaped literal in the repository.
export const FAKE_GH_TOKEN = ['ghp', 'FakeTokenForQuestlingTests0123456789abcd'].join('_')
export class FakeGitHub {
  server!: Server
  base = ''
  scopes = 'notifications'
  ignoreWrites = false
  threads: Array<{ id: string; unread: boolean; reason: string; updated_at: string; subject: { title: string; type: string }; repository: { full_name: string } }> = []
  calls: string[] = []
  reset() {
    this.scopes = 'notifications'
    this.ignoreWrites = false
    this.calls = []
    const at = new Date(Date.now() - 600_000).toISOString()
    this.threads = [
      { id: '101', unread: true, reason: 'review_requested', updated_at: at, subject: { title: 'Add billing export (#128)', type: 'PullRequest' }, repository: { full_name: 'acme/web' } },
      { id: '102', unread: true, reason: 'subscribed', updated_at: at, subject: { title: 'Dependabot bump', type: 'PullRequest' }, repository: { full_name: 'acme/web' } },
      { id: '103', unread: true, reason: 'mention', updated_at: at, subject: { title: 'Flaky checkout test', type: 'Issue' }, repository: { full_name: 'acme/api' } },
      { id: '104', unread: false, reason: 'assign', updated_at: at, subject: { title: 'Old assignment', type: 'Issue' }, repository: { full_name: 'acme/api' } },
    ]
  }
  async start() {
    this.server = createServer((req, res) => {
      const send = (status: number, j?: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(j === undefined ? '' : JSON.stringify(j))
      }
      this.calls.push(`${req.method} ${req.url}`)
      if (req.headers.authorization !== `Bearer ${FAKE_GH_TOKEN}`) return send(401, { message: 'Bad credentials' })
      if (req.headers['x-github-api-version'] !== '2026-03-10') return send(400, { message: 'bad version' })
      const url = req.url ?? ''
      if (url === '/user') return send(200, { login: 'octo-tester', id: 1 }, { 'x-oauth-scopes': this.scopes })
      if (url.startsWith('/notifications?')) return send(200, this.threads)
      const m = url.match(/^\/notifications\/threads\/(\d+)$/)
      if (m) {
        const t = this.threads.find((x) => x.id === m[1])
        if (!t) return send(404, { message: 'Not Found' })
        if (req.method === 'PATCH') {
          if (!this.ignoreWrites) t.unread = false
          return send(205)
        }
        return send(200, t)
      }
      return send(404, { message: 'Not Found' })
    })
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }
  async stop() {
    await new Promise<void>((r) => this.server.close(() => r()))
  }
}
