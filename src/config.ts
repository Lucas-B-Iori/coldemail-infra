import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

if (existsSync(".env")) process.loadEnvFile(".env");
// Deployment-only settings stay on the persistent volume, outside Git/Docker images.
const runtimeEnv = join(
  dirname(process.env.DB_PATH || "data/engine.db"),
  "runtime.env",
);
if (existsSync(runtimeEnv)) process.loadEnvFile(runtimeEnv);

const str = (k: string, d = ""): string => process.env[k] ?? d;
const int = (k: string, d: number): number => {
  const v = parseInt(process.env[k] ?? "", 10);
  return Number.isFinite(v) ? v : d;
};

export const WARMUP_DAYS = 21;

export const config = {
  dbPath: str("DB_PATH", "data/engine.db"),
  tz: str("TZ_NAME", "America/Sao_Paulo"),
  encryptionKey: str("ENCRYPTION_KEY"),

  sendWindow: {
    start: int("SEND_WINDOW_START", 8),
    end: int("SEND_WINDOW_END", 18),
  },
  /** Cold só de segunda a sexta (padrão B2B). SEND_WEEKDAYS_ONLY=false para liberar o fim de semana. */
  weekdaysOnly: str("SEND_WEEKDAYS_ONLY", "true") !== "false",
  warmupWindow: {
    start: int("WARMUP_WINDOW_START", 8),
    end: int("WARMUP_WINDOW_END", 20),
  },

  llm: {
    baseUrl: str('LLM_BASE_URL', 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
    apiKey: str('LLM_API_KEY'),
    model: str('LLM_MODEL', 'deepseek/deepseek-chat'),
  },

  signature: {
    role: str('SIGNATURE_ROLE', ''),
    phone: str('SIGNATURE_PHONE', ''),
  },

  concurrency: int("CONCURRENCY", 16),
  maxBouncesPerDay: int("MAX_BOUNCES_PER_DAY", 3),
  maintenance: [int("MAINTENANCE_MIN", 6), int("MAINTENANCE_MAX", 10)] as [
    number,
    number,
  ],

  /** Microsoft 365 via OAuth2 (client credentials). Necessário para IMAP; recomendado também para SMTP. */
  m365: {
    tenantId: str("M365_TENANT_ID"),
    clientId: str("M365_CLIENT_ID"),
    clientSecret: str("M365_CLIENT_SECRET"),
  },

  /**
   * Microsoft Graph (client credentials, escopo graph.microsoft.com/.default). Usa AZURE_*; se ausente, cai para M365_*.
   */
  graph: {
    tenantId: str('AZURE_TENANT_ID', str('M365_TENANT_ID')),
    clientId: str('AZURE_CLIENT_ID', str('M365_CLIENT_ID')),
    clientSecret: str('AZURE_CLIENT_SECRET', str('M365_CLIENT_SECRET')),
  },
  /** Transporte das caixas M365 (auth_mode=oauth): graph (recomendado) ou smtp (legado XOAUTH2). Gmail sempre SMTP. */
  sendTransport: (str('SEND_TRANSPORT', 'smtp') === 'graph' ? 'graph' : 'smtp') as 'graph' | 'smtp',
  /** template = usa a sequência do banco (determinístico); ai = IA reescreve com base no template (fallback no template). */
  copyMode: (str('COPY_MODE', 'ai') === 'template' ? 'template' : 'ai') as 'ai' | 'template',
  /** Valor do site, só para a copy. */
  sitePrice: str('SITE_PRICE', 'R$1.000'),

  /**
   * Rampa de cold independente do warm-up. Se COLD_START_DATE (YYYY-MM-DD, fuso TZ_NAME) estiver definido,
   * o cold começa nessa data: COLD_START_PER_DAY/dia por caixa, +COLD_STEP a cada COLD_STEP_DAYS, até COLD_MAX_PER_DAY.
   * O warm-up continua rodando em paralelo. Sem COLD_START_DATE vale a rampa legada (cold só após 21 dias).
   */
  coldRamp: {
    startDate: str('COLD_START_DATE', ''),
    startPerDay: int('COLD_START_PER_DAY', 10),
    step: int('COLD_STEP', 5),
    stepDays: Math.max(1, int('COLD_STEP_DAYS', 2)),
    maxPerDay: int('COLD_MAX_PER_DAY', 40),
  },
  /** Unicidade da copy por IA: Jaccard máximo (shingles de 3 palavras) contra copies anteriores e tentativas. */
  uniq: {
    maxJaccard: Number(process.env.UNIQ_MAX_JACCARD ?? '') || 0.35,
    maxAttempts: Math.max(1, int('UNIQ_MAX_ATTEMPTS', 3)),
    compareLast: int('UNIQ_COMPARE_LAST', 2000),
  },

  /** Teto de segurança global por caixa/dia (cold). 0 = sem teto (vale só a rampa). */
  dailyCap: Math.min(80, Math.max(1, int("DAILY_CAP", 80) || 80)),
  /** Envia multipart (text + HTML simples). Padrão false: texto puro entrega melhor no cold. */
  sendHtml: str("SEND_HTML", "false") === "true",

  /** Intervalo entre cold da mesma caixa (padrão 7-9 min com jitter de ±90s). Ajustável em segundos. */
  coldIntervalMs: {
    min: int("COLD_INTERVAL_MIN_SEC", 7 * 60) * 1000,
    max: int("COLD_INTERVAL_MAX_SEC", 9 * 60) * 1000,
    jitter: int("COLD_JITTER_SEC", 90) * 1000,
  },
  /** Latência humana do warm-up: resposta 8-35 min depois do recebimento. */
  replyDelayMs: { min: 8 * 60_000, max: 35 * 60_000 },
  flagProbability: 0.2,
};
