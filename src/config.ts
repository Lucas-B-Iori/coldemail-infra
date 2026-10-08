import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const str = (k: string, d = ''): string => process.env[k] ?? d;
const int = (k: string, d: number): number => {
  const v = parseInt(process.env[k] ?? '', 10);
  return Number.isFinite(v) ? v : d;
};

export const WARMUP_DAYS = 21;

export const config = {
  dbPath: str('DB_PATH', 'data/engine.db'),
  tz: str('TZ_NAME', 'America/Sao_Paulo'),
  encryptionKey: str('ENCRYPTION_KEY'),

  sendWindow: { start: int('SEND_WINDOW_START', 8), end: int('SEND_WINDOW_END', 18) },
  /** Cold só de segunda a sexta (padrão B2B). SEND_WEEKDAYS_ONLY=false para liberar o fim de semana. */
  weekdaysOnly: str('SEND_WEEKDAYS_ONLY', 'true') !== 'false',
  warmupWindow: { start: int('WARMUP_WINDOW_START', 8), end: int('WARMUP_WINDOW_END', 20) },

  llm: {
    baseUrl: str('LLM_BASE_URL', 'https://api.deepseek.com').replace(/\/$/, ''),
    apiKey: str('LLM_API_KEY'),
    model: str('LLM_MODEL', 'deepseek-chat'),
  },

  signature: {
    role: str('SIGNATURE_ROLE', 'Fundador | Dendrix'),
    phone: str('SIGNATURE_PHONE', ''),
  },

  concurrency: int('CONCURRENCY', 16),
  maxBouncesPerDay: int('MAX_BOUNCES_PER_DAY', 3),
  maintenance: [int('MAINTENANCE_MIN', 6), int('MAINTENANCE_MAX', 10)] as [number, number],

  /** Microsoft 365 via OAuth2 (client credentials). Necessário para IMAP; recomendado também para SMTP. */
  m365: {
    tenantId: str('M365_TENANT_ID'),
    clientId: str('M365_CLIENT_ID'),
    clientSecret: str('M365_CLIENT_SECRET'),
  },

  /** Teto de segurança global por caixa/dia (cold). 0 = sem teto (vale só a rampa). */
  dailyCap: int('DAILY_CAP', 0),
  /** Envia multipart (text + HTML simples). Padrão false: texto puro entrega melhor no cold. */
  sendHtml: str('SEND_HTML', 'false') === 'true',

  /** Intervalo entre cold da mesma caixa (padrão 7-9 min com jitter de ±90s). Ajustável em segundos. */
  coldIntervalMs: {
    min: int('COLD_INTERVAL_MIN_SEC', 7 * 60) * 1000,
    max: int('COLD_INTERVAL_MAX_SEC', 9 * 60) * 1000,
    jitter: int('COLD_JITTER_SEC', 90) * 1000,
  },
  /** Latência humana do warm-up: resposta 8-35 min depois do recebimento. */
  replyDelayMs: { min: 8 * 60_000, max: 35 * 60_000 },
  flagProbability: 0.2,
};
