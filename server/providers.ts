import { AI_PROVIDER_IDS, GEMINI_RESPONSE_JSON_SCHEMA, normalizeModelActions, parseAiResponse, type AiProviderId, type AiRequest, type AiResponse } from '../src/shared/ai'
import type { ServerConfig } from './config'
import { GeminiProvider, type AiFailure, type AiProvider, type AiResult } from './gemini'
import { buildSystemInstruction, buildUserContent } from './prompt'

/**
 * Optional AI providers. Gemini stays the default.
 * Every provider:
 *  - runs on the server only; keys and base URLs come from the server environment, never the client,
 *  - receives the same trusted system policy and the same minimized <data> context,
 *  - must return the same JSON contract, which is validated with Zod before anything reaches the app,
 *  - can only PROPOSE actions; the app still asks the user to confirm every write.
 * Nothing here stores prompts, replies or audio.
 */

const MAX_OUTPUT_TOKENS = 1500

/** OpenAI strict structured outputs need additionalProperties:false and every key listed as required.
 *  Our optional keys are already nullable, so this keeps the same meaning. */
export function strictJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictJsonSchema)
  if (!node || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = k === 'enum' || k === 'required' ? v : strictJsonSchema(v)
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    out.additionalProperties = false
    out.required = Object.keys(out.properties as object)
  }
  return out
}

const SCHEMA_HINT = `\nOUTPUT FORMAT: reply with ONE JSON object (no markdown, no prose) that matches this JSON Schema exactly:\n${JSON.stringify(GEMINI_RESPONSE_JSON_SCHEMA)}`

/** Parse model text into the validated contract. Tolerates a ```json fence from looser models. */
export function parseModelText(text: string | null | undefined): AiResult {
  if (!text) return { ok: false, error: 'invalid_output' }
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
  let raw: unknown
  try {
    raw = JSON.parse(cleaned)
  } catch {
    return { ok: false, error: 'invalid_output' }
  }
  return parseObject(raw)
}

function parseObject(raw: unknown): AiResult {
  const parsed = parseAiResponse(normalizeModelActions(raw))
  return parsed ? { ok: true, response: parsed } : { ok: false, error: 'invalid_output' }
}

type HttpResult = { status: number; body: unknown } | { failure: AiFailure }

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<HttpResult> {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal })
    const json = await r.json().catch(() => null)
    return { status: r.status, body: json }
  } catch {
    return { failure: signal.aborted ? 'timeout' : 'upstream_error' }
  }
}

function httpFailure(status: number): AiFailure {
  if (status === 429) return 'rate_limited'
  if (status === 401 || status === 403) return 'upstream_error'
  return 'upstream_error'
}

/** Text-only providers answer voice by transcribing first (OpenAI) or are routed to an audio-capable provider. */
function transcriptOnly(req: AiRequest, transcript: string): AiRequest {
  return { ...req, mode: 'chat', audio: undefined, message: transcript.slice(0, 500) }
}

function unclearVoice(): AiResponse {
  return {
    transcript: '',
    dialogue: "I didn't catch that. Say it again?",
    cleanDialogue: null,
    emotion: 'thinking',
    intent: 'unclear',
    needsClarification: true,
    actions: [],
    memoryCandidates: [],
    droppedActions: 0,
  }
}

// ----------------------------------------------------------------- OpenAI-compatible (OpenAI, OpenRouter)

interface CompatOptions {
  id: 'openai' | 'openrouter'
  apiKey: string
  model: string
  baseUrl: string
  extraHeaders?: Record<string, string>
  extraBody?: Record<string, unknown>
  transcribeModel?: string
}

export class OpenAICompatProvider implements AiProvider {
  readonly id: AiProviderId
  readonly model: string
  readonly audio: boolean
  constructor(private o: CompatOptions) {
    this.id = o.id
    this.model = o.model
    this.audio = !!o.transcribeModel
  }

  private async complete(req: AiRequest, signal: AbortSignal, structured: 'schema' | 'object'): Promise<AiResult | { retry: true }> {
    const system = buildSystemInstruction(req) + (structured === 'object' ? SCHEMA_HINT : '')
    const body = {
      model: this.o.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: buildUserContent(req) },
      ],
      max_completion_tokens: MAX_OUTPUT_TOKENS * 3,
      response_format:
        structured === 'schema'
          ? { type: 'json_schema', json_schema: { name: 'questling_reply', strict: true, schema: strictJsonSchema(GEMINI_RESPONSE_JSON_SCHEMA) } }
          : { type: 'json_object' },
      ...(this.o.extraBody ?? {}),
    }
    const r = await postJson(`${this.o.baseUrl}/chat/completions`, { authorization: `Bearer ${this.o.apiKey}`, ...(this.o.extraHeaders ?? {}) }, body, signal)
    if ('failure' in r) return { ok: false, error: r.failure }
    // a model/route without json_schema support answers 400/404/422: retry once with plain JSON mode
    if (structured === 'schema' && (r.status === 400 || r.status === 404 || r.status === 422)) return { retry: true }
    if (r.status < 200 || r.status >= 300) return { ok: false, error: httpFailure(r.status) }
    const choice = (r.body as { choices?: Array<{ finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }> })?.choices?.[0]
    if (!choice) return { ok: false, error: 'invalid_output' }
    if (choice.message?.refusal || choice.finish_reason === 'content_filter') return { ok: false, error: 'refused' }
    return parseModelText(choice.message?.content)
  }

  private async transcribe(req: AiRequest, signal: AbortSignal): Promise<{ ok: true; text: string } | { ok: false; error: AiFailure }> {
    if (!req.audio || !this.o.transcribeModel) return { ok: false, error: 'not_configured' }
    const form = new FormData()
    form.append('model', this.o.transcribeModel)
    form.append('response_format', 'json')
    form.append('file', new Blob([Buffer.from(req.audio.base64, 'base64')], { type: 'audio/wav' }), 'speech.wav')
    try {
      const r = await fetch(`${this.o.baseUrl}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${this.o.apiKey}` }, body: form, signal })
      if (!r.ok) return { ok: false, error: httpFailure(r.status) }
      const b = (await r.json().catch(() => null)) as { text?: unknown } | null
      return { ok: true, text: typeof b?.text === 'string' ? b.text.trim() : '' }
    } catch {
      return { ok: false, error: signal.aborted ? 'timeout' : 'upstream_error' }
    }
  }

  async generate(req: AiRequest, signal: AbortSignal): Promise<AiResult> {
    let request = req
    let transcript: string | null = null
    if (req.mode === 'voice') {
      const t = await this.transcribe(req, signal)
      if (!t.ok) return t
      if (!t.text) return { ok: true, response: unclearVoice() }
      transcript = t.text.slice(0, 600)
      request = transcriptOnly(req, transcript)
    }
    let r = await this.complete(request, signal, 'schema')
    if ('retry' in r) r = await this.complete(request, signal, 'object')
    if ('retry' in r) return { ok: false, error: 'invalid_output' }
    if (r.ok && transcript !== null) r = { ok: true, response: { ...r.response, transcript } }
    return r
  }
}

// ----------------------------------------------------------------- Anthropic (Messages API, forced tool call)

export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic' as const
  readonly audio = false
  constructor(
    private apiKey: string,
    readonly model: string,
    private baseUrl: string,
  ) {}

  async generate(req: AiRequest, signal: AbortSignal): Promise<AiResult> {
    if (req.mode === 'voice') return { ok: false, error: 'not_configured' }
    const body = {
      model: this.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: buildSystemInstruction(req),
      messages: [{ role: 'user', content: buildUserContent(req) }],
      tools: [{ name: 'questling_reply', description: 'Return the companion reply in the required structure.', input_schema: GEMINI_RESPONSE_JSON_SCHEMA }],
      tool_choice: { type: 'tool', name: 'questling_reply' },
    }
    const r = await postJson(`${this.baseUrl}/v1/messages`, { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }, body, signal)
    if ('failure' in r) return { ok: false, error: r.failure }
    if (r.status < 200 || r.status >= 300) return { ok: false, error: httpFailure(r.status) }
    const b = r.body as { stop_reason?: string; content?: Array<{ type: string; name?: string; input?: unknown }> } | null
    if (b?.stop_reason === 'refusal') return { ok: false, error: 'refused' }
    const tool = b?.content?.find((c) => c.type === 'tool_use' && c.name === 'questling_reply')
    if (!tool) return { ok: false, error: 'invalid_output' }
    return parseObject(tool.input)
  }
}

// ----------------------------------------------------------------- Ollama (self-hosted, native /api/chat with JSON-schema format)

export class OllamaProvider implements AiProvider {
  readonly id = 'ollama' as const
  readonly audio = false
  constructor(
    readonly model: string,
    private baseUrl: string,
  ) {}

  async generate(req: AiRequest, signal: AbortSignal): Promise<AiResult> {
    if (req.mode === 'voice') return { ok: false, error: 'not_configured' }
    const body = {
      model: this.model,
      stream: false,
      format: GEMINI_RESPONSE_JSON_SCHEMA,
      messages: [
        { role: 'system', content: buildSystemInstruction(req) + SCHEMA_HINT },
        { role: 'user', content: buildUserContent(req) },
      ],
      options: { temperature: 0.8, num_predict: MAX_OUTPUT_TOKENS },
    }
    const r = await postJson(`${this.baseUrl}/api/chat`, {}, body, signal)
    if ('failure' in r) return { ok: false, error: r.failure }
    if (r.status < 200 || r.status >= 300) return { ok: false, error: httpFailure(r.status) }
    return parseModelText((r.body as { message?: { content?: string } } | null)?.message?.content)
  }
}

// ----------------------------------------------------------------- registry

export function buildProviders(cfg: ServerConfig): Map<AiProviderId, AiProvider> {
  const m = new Map<AiProviderId, AiProvider>()
  if (cfg.geminiApiKey) m.set('gemini', new GeminiProvider(cfg.geminiApiKey, cfg.geminiModel))
  if (cfg.openai.apiKey && cfg.openai.model) m.set('openai', new OpenAICompatProvider({ id: 'openai', apiKey: cfg.openai.apiKey, model: cfg.openai.model, baseUrl: cfg.openai.baseUrl, transcribeModel: cfg.openai.transcribeModel }))
  if (cfg.anthropic.apiKey && cfg.anthropic.model) m.set('anthropic', new AnthropicProvider(cfg.anthropic.apiKey, cfg.anthropic.model, cfg.anthropic.baseUrl))
  if (cfg.openrouter.apiKey && cfg.openrouter.model)
    m.set(
      'openrouter',
      new OpenAICompatProvider({
        id: 'openrouter',
        apiKey: cfg.openrouter.apiKey,
        model: cfg.openrouter.model,
        baseUrl: cfg.openrouter.baseUrl,
        extraHeaders: { 'HTTP-Referer': cfg.appBaseUrl, 'X-Title': 'Questling' },
        // only route to upstream endpoints that honour response_format
        extraBody: { provider: { require_parameters: true } },
      }),
    )
  if (cfg.ollama.model) m.set('ollama', new OllamaProvider(cfg.ollama.model, cfg.ollama.baseUrl))
  return m
}

export function defaultProviderId(providers: Map<AiProviderId, AiProvider>, preferred: AiProviderId | null): AiProviderId | null {
  if (preferred && providers.has(preferred)) return preferred
  for (const id of AI_PROVIDER_IDS) if (providers.has(id)) return id
  return null
}

/** Pick the provider for one request. Voice on a text-only provider is routed to an audio-capable one and reported. */
export function resolveProvider(
  providers: Map<AiProviderId, AiProvider>,
  defaultId: AiProviderId | null,
  requested: AiProviderId | undefined,
  mode: 'chat' | 'voice',
): { ok: true; provider: AiProvider; routed: boolean } | { ok: false; error: 'ai_not_configured' | 'provider_not_configured' | 'voice_not_configured' } {
  if (!providers.size || !defaultId) return { ok: false, error: 'ai_not_configured' }
  if (requested && !providers.has(requested)) return { ok: false, error: 'provider_not_configured' }
  const chosen = providers.get(requested ?? defaultId)!
  if (mode === 'chat' || chosen.audio) return { ok: true, provider: chosen, routed: false }
  const voiceDefault = providers.get(defaultId)
  const fallback = voiceDefault?.audio ? voiceDefault : [...providers.values()].find((p) => p.audio)
  if (!fallback) return { ok: false, error: 'voice_not_configured' }
  return { ok: true, provider: fallback, routed: true }
}

export function providerStatus(providers: Map<AiProviderId, AiProvider>) {
  const anyAudio = [...providers.values()].some((p) => p.audio)
  return [...providers.values()].map((p) => ({ id: p.id, model: p.model, voice: p.audio ? 'native' : anyAudio ? 'routed' : 'none' }))
}
