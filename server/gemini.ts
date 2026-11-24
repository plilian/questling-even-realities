import { GoogleGenAI, HarmBlockThreshold, HarmCategory, ThinkingLevel } from '@google/genai'
import { GEMINI_RESPONSE_JSON_SCHEMA, normalizeModelActions, parseAiResponse, type AiProviderId, type AiRequest, type AiResponse } from '../src/shared/ai'
import { buildSystemInstruction, buildUserContent } from './prompt'

export type AiFailure = 'not_configured' | 'timeout' | 'rate_limited' | 'refused' | 'invalid_output' | 'upstream_error'

export type AiResult = { ok: true; response: AiResponse } | { ok: false; error: AiFailure }

export interface AiProvider {
  readonly id: AiProviderId
  readonly model: string
  /** accepts the WAV request directly (or transcribes it itself) */
  readonly audio: boolean
  generate(req: AiRequest, signal: AbortSignal): Promise<AiResult>
}

/**
 * Provider safety settings are kept ON (never BLOCK_NONE). Only in “Full 18+” (adult-attested, opted in,
 * the Savage) is the sexual-content filter set to MEDIUM so cheeky innuendo is not refused — explicit
 * content is still blocked. Hate speech stays at LOW, harassment and dangerous content at MEDIUM.
 */
export function safetyFor(req: AiRequest) {
  const full = req.companionId === 'savage' && req.language.adultEnabled && req.language.profanityLevel === 'uncensored'
  return [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: full ? HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE : HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  ]
}

export class GeminiProvider implements AiProvider {
  readonly id = 'gemini' as const
  readonly audio = true
  private client: GoogleGenAI
  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new GoogleGenAI({ apiKey })
  }

  async generate(req: AiRequest, signal: AbortSignal): Promise<AiResult> {
    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [{ text: buildUserContent(req) }]
    if (req.mode === 'voice' && req.audio) parts.push({ inlineData: { mimeType: req.audio.mimeType, data: req.audio.base64 } })
    try {
      const resp = await this.client.models.generateContent({
        model: this.model,
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction: buildSystemInstruction(req),
          responseMimeType: 'application/json',
          responseJsonSchema: GEMINI_RESPONSE_JSON_SCHEMA,
          maxOutputTokens: 1400,
          temperature: 0.9,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          safetySettings: safetyFor(req),
          abortSignal: signal,
        },
      })
      const blocked = resp.promptFeedback?.blockReason || resp.candidates?.[0]?.finishReason === 'SAFETY' || resp.candidates?.[0]?.finishReason === 'PROHIBITED_CONTENT'
      if (blocked) return { ok: false as const, error: 'refused' as const }
      const text = resp.text
      if (!text) return { ok: false as const, error: 'invalid_output' as const }
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        return { ok: false as const, error: 'invalid_output' as const }
      }
      const parsed = parseAiResponse(normalizeModelActions(raw))
      if (!parsed) return { ok: false as const, error: 'invalid_output' as const }
      return { ok: true as const, response: parsed }
    } catch (err) {
      if (signal.aborted) return { ok: false as const, error: 'timeout' as const }
      const status = (err as { status?: number }).status
      if (status === 429) return { ok: false as const, error: 'rate_limited' as const }
      return { ok: false as const, error: 'upstream_error' as const }
    }
  }
}
