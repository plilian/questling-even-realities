import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Contract fake of the Telegram Bot API methods Questling uses: getMe, getWebhookInfo, getUpdates
 * (offset confirmation), getBusinessConnection, sendMessage (with business_connection_id and
 * reply_parameters). TEST DOUBLE only — shapes follow core.telegram.org/bots/api (10.5).
 */
// Built at runtime so secret scanners never see a token-shaped literal in the repository.
export const FAKE_BOT_TOKEN = ['123456789', 'AAFakeTokenForQuestlingTests_abcdefghij'].join(':')

export class FakeTelegram {
  server!: Server
  base = ''
  botId = 123456789
  username = 'questling_test_bot'
  webhookUrl = ''
  conflict = false
  alterEcho = false
  updates: Array<{ update_id: number } & Record<string, unknown>> = []
  connections = new Map<string, Record<string, unknown>>()
  sent: Array<Record<string, unknown>> = []
  calls: string[] = []
  /** request bodies by method (latest last) */
  bodies: Array<{ method: string; body: Record<string, unknown> }> = []
  private nextUpdate = 1
  private nextMsg = 900

  reset() {
    this.webhookUrl = ''
    this.conflict = false
    this.alterEcho = false
    this.updates = []
    this.connections.clear()
    this.sent = []
    this.calls = []
    this.bodies = []
  }

  private push(u: Record<string, unknown>) {
    this.updates.push({ update_id: this.nextUpdate++, ...u })
  }
  message(m: { chatId: number; type?: string; title?: string; fromId: number; first: string; text: string; ageSec?: number; replyToBot?: boolean }) {
    const id = this.nextMsg++
    this.push({
      message: {
        message_id: id,
        date: Math.floor(Date.now() / 1000) - (m.ageSec ?? 60),
        chat: { id: m.chatId, type: m.type ?? 'private', ...(m.title ? { title: m.title } : { first_name: m.first }) },
        from: { id: m.fromId, is_bot: m.fromId === this.botId, first_name: m.first },
        text: m.text,
        ...(m.replyToBot ? { reply_to_message: { message_id: 1, from: { id: this.botId, is_bot: true, first_name: 'Bot' } } } : {}),
      },
    })
    return id
  }
  /** a post in a channel where the bot is an admin (Bot API: `channel_post`, no `from`) */
  channelPost(m: { chatId: number; title: string; text: string; ageSec?: number }) {
    const id = this.nextMsg++
    this.push({ channel_post: { message_id: id, date: Math.floor(Date.now() / 1000) - (m.ageSec ?? 60), chat: { id: m.chatId, type: 'channel', title: m.title }, text: m.text } })
    return id
  }
  businessConnection(id: string, userId: number, canReply = true, enabled = true) {
    const c = { id, user: { id: userId, is_bot: false, first_name: 'Owner' }, user_chat_id: userId, date: Math.floor(Date.now() / 1000), is_enabled: enabled, rights: { can_reply: canReply } }
    this.connections.set(id, c)
    this.push({ business_connection: c })
  }
  businessMessage(m: { connection: string; chatId: number; fromId: number; first: string; text: string; ageSec?: number }) {
    const id = this.nextMsg++
    this.push({
      business_message: {
        message_id: id,
        date: Math.floor(Date.now() / 1000) - (m.ageSec ?? 60),
        business_connection_id: m.connection,
        chat: { id: m.chatId, type: 'private', first_name: m.first },
        from: { id: m.fromId, is_bot: false, first_name: m.first },
        text: m.text,
      },
    })
    return id
  }

  async start() {
    this.server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const send = (status: number, j: unknown) => {
          res.statusCode = status
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(j))
        }
        const m = (req.url ?? '').match(/^\/bot([^/]+)\/(\w+)$/)
        if (!m) return send(404, { ok: false, error_code: 404, description: 'Not Found' })
        const [, tok, method] = m
        this.calls.push(method!)
        if (tok !== FAKE_BOT_TOKEN) return send(401, { ok: false, error_code: 401, description: 'Unauthorized' })
        const b = body ? (JSON.parse(body) as Record<string, unknown>) : {}
        this.bodies.push({ method: method!, body: b })
        switch (method) {
          case 'getMe':
            return send(200, { ok: true, result: { id: this.botId, is_bot: true, first_name: 'Questling test', username: this.username, can_connect_to_business: true, can_join_groups: true, can_read_all_group_messages: false } })
          case 'getWebhookInfo':
            return send(200, { ok: true, result: { url: this.webhookUrl, has_custom_certificate: false, pending_update_count: this.updates.length } })
          case 'getUpdates': {
            if (this.conflict) return send(409, { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' })
            const offset = Number(b.offset ?? 0)
            this.updates = this.updates.filter((u) => u.update_id >= offset) // confirmed updates are forgotten
            return send(200, { ok: true, result: this.updates.slice(0, Number(b.limit ?? 100)) })
          }
          case 'getBusinessConnection': {
            const c = this.connections.get(String(b.business_connection_id))
            return c ? send(200, { ok: true, result: c }) : send(400, { ok: false, error_code: 400, description: 'Bad Request: business connection not found' })
          }
          case 'sendMessage': {
            this.sent.push(b)
            const text = String(b.text ?? '')
            return send(200, {
              ok: true,
              result: { message_id: this.nextMsg++, date: Math.floor(Date.now() / 1000), chat: { id: b.chat_id, type: 'private' }, text: this.alterEcho ? `${text}!` : text, ...(b.business_connection_id ? { business_connection_id: b.business_connection_id } : {}) },
            })
          }
          default:
            return send(404, { ok: false, error_code: 404, description: 'Not Found' })
        }
      })
    })
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }
  async stop() {
    await new Promise<void>((r) => this.server.close(() => r()))
  }
}
