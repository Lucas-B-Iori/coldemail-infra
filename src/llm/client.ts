import { config } from '../config.ts';
import { errMsg, sleep } from '../lib/util.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Cliente para qualquer API compatível com OpenAI (DeepSeek, Qwen, Moonshot, OpenRouter...). */
/** Só modelos baratos. GPT/Claude (e afins caros) são bloqueados por política de custo. */
const CHEAP_FALLBACKS = (process.env.LLM_FALLBACK_MODELS ?? 'deepseek/deepseek-chat,xiaomi/mimo-v2-flash')
  .split(',').map((m) => m.trim()).filter(Boolean);
const BLOCKED_MODEL = /(openai\/|anthropic\/|\bgpt-|claude|(^|\/)o[134](-|$))/i;

export function assertCheapModel(model: string): void {
  if (BLOCKED_MODEL.test(model)) throw new Error(`Modelo "${model}" bloqueado: use apenas DeepSeek/MiMo (modelos baratos).`);
}

export async function chatJson<T>(messages: ChatMessage[], temperature = 1.1): Promise<T> {
  if (!config.llm.apiKey) throw new Error('LLM_API_KEY não configurada no .env');
  assertCheapModel(config.llm.model);
  CHEAP_FALLBACKS.forEach(assertCheapModel);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
        const isOpenRouter = config.llm.baseUrl.includes('openrouter.ai');
        const bodyPayload: Record<string, unknown> = {
          model: config.llm.model,
          messages,
          temperature,
          max_tokens: 400,
          response_format: { type: 'json_object' },
        };
        if (isOpenRouter) {
          bodyPayload.models = [...new Set([config.llm.model, ...CHEAP_FALLBACKS])];
        }
        const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
          body: JSON.stringify(bodyPayload),
          signal: AbortSignal.timeout(45_000),
        });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data: unknown = await res.json();
      if (!isRecord(data) || !Array.isArray(data.choices) || !isRecord(data.choices[0]) ||
          !isRecord(data.choices[0].message) || !nonEmptyString(data.choices[0].message.content)) {
        throw new Error('LLM retornou envelope sem conteúdo textual');
      }
      const raw = data.choices[0].message.content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
      return JSON.parse(raw) as T;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await sleep(1500 * attempt);
    }
  }
  throw new Error(`LLM falhou após 3 tentativas: ${errMsg(lastErr)}`);
}
