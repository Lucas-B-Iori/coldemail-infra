import { WARMUP_DAYS, config } from '../config.ts';
import { addLog, q } from '../db/index.ts';
import { decrypt, encrypt } from '../lib/crypto.ts';
import { addMs, daysBetweenLocal, localDate, log, nowIso } from '../lib/util.ts';
import { outreachLimit, warmupTargetFor } from './ramp.ts';

export type AccountStatus = 'warming' | 'active' | 'paused' | 'banned';
export type AccountProvider = 'gmail' | 'outlook' | 'm365' | 'other';

export interface Account {
  id: number;
  email: string;
  display_name: string;
  provider: AccountProvider;
  auth_mode: 'password' | 'oauth';
  group_name: string;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_pass: string;
  imap_host: string;
  imap_port: number;
  daily_limit: number;
  limit_override: number | null;
  sent_today: number;
  warmup_sent_today: number;
  warmup_target_today: number;
  bounces_today: number;
  counters_date: string | null;
  last_sent_at: string | null;
  next_send_at: string | null;
  next_warmup_at: string | null;
  status: AccountStatus;
  pause_reason: string | null;
  cooldown_until: string | null;
  throttle_count: number;
  consecutive_errors: number;
  warmup_only: number;
  auto_promote: number;
  warmup_started_at: string;
  imap_last_uid: number;
  imap_last_poll_at: string | null;
  created_at: string;
}

export const PROVIDER_PRESETS = {
  gmail: { smtp_host: 'smtp.gmail.com', smtp_port: 465, imap_host: 'imap.gmail.com', imap_port: 993 },
  outlook: { smtp_host: 'smtp-mail.outlook.com', smtp_port: 587, imap_host: 'outlook.office365.com', imap_port: 993 },
  m365: { smtp_host: 'smtp.office365.com', smtp_port: 587, imap_host: 'outlook.office365.com', imap_port: 993 },
} as const;

export interface NewAccount {
  email: string;
  password: string;
  provider?: AccountProvider;
  /** 'oauth' = IMAP/SMTP via token do Entra ID (necessário para IMAP no Microsoft 365). */
  authMode?: 'password' | 'oauth';
  displayName?: string;
  group?: string;
  /** Permite entrar já "pré-aquecida": dia 1 = começa do zero, 22 = pula direto para produção. */
  startDay?: number;
  warmupOnly?: boolean;
  autoPromote?: boolean;
  smtp_host?: string;
  smtp_port?: number;
  imap_host?: string;
  imap_port?: number;
}

function guessProvider(email: string): AccountProvider {
  const d = email.split('@')[1]?.toLowerCase() ?? '';
  if (/^(gmail|googlemail)\./.test(d)) return 'gmail';
  if (/^(outlook|hotmail|live|msn)\./.test(d)) return 'outlook';
  return 'other';
}

function nameFromEmail(email: string): string {
  const local = email.split('@')[0].replace(/[0-9._-]+/g, ' ').trim();
  const w = local.split(/\s+/)[0] || 'Contato';
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** Aplica o teto global DAILY_CAP (0 = sem teto) ao limite diário de cold. */
const capLimit = (n: number): number => (config.dailyCap > 0 ? Math.min(n, config.dailyCap) : n);

export function addAccount(a: NewAccount): number {
  const email = a.email.trim().toLowerCase();
  const provider = a.provider ?? guessProvider(email);
  const preset = provider === 'other' ? null : PROVIDER_PRESETS[provider];
  const smtp_host = a.smtp_host ?? preset?.smtp_host;
  const imap_host = a.imap_host ?? preset?.imap_host;
  if (!smtp_host || !imap_host) throw new Error(`Provider "other" exige smtp_host e imap_host (${email})`);

  const startedAt = addMs(-((a.startDay ?? 1) - 1) * 86_400_000);
  const warmupOnly = a.warmupOnly ? 1 : 0;
  const autoPromote = a.warmupOnly ? 0 : (a.autoPromote ?? true ? 1 : 0);

  return q.run(
    `INSERT INTO accounts (email, display_name, provider, auth_mode, group_name, smtp_host, smtp_port, smtp_user, smtp_pass,
       imap_host, imap_port, warmup_started_at, warmup_only, auto_promote, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    email, a.displayName?.trim() || nameFromEmail(email), provider, a.authMode ?? 'password', a.group ?? 'default',
    smtp_host, a.smtp_port ?? preset?.smtp_port ?? 587, email, encrypt(a.password.replace(/\s+/g, '')),
    imap_host, a.imap_port ?? preset?.imap_port ?? 993, startedAt,
    warmupOnly, autoPromote,
    !warmupOnly && (a.startDay ?? 1) > WARMUP_DAYS ? 'active' : 'warming', nowIso(),
  ).id;
}

export const getPassword = (a: Account): string => decrypt(a.smtp_pass);
export const getAccount = (id: number): Account | undefined => q.get<Account>('SELECT * FROM accounts WHERE id=?', id);

/** Dia do ciclo de vida da caixa (1 = primeiro dia de warm-up). */
export const accountDay = (a: Pick<Account, 'warmup_started_at'>): number =>
  daysBetweenLocal(a.warmup_started_at) + 1;

/**
 * Virada de dia (fuso de negócio): zera contadores, sorteia a meta de warm-up,
 * calcula o limite de cold pela rampa e promove warming -> active no dia 22.
 */
export function rollDay(): void {
  const today = localDate();
  const rows = q.all<Account>(
    `SELECT * FROM accounts WHERE status != 'banned' AND (counters_date IS NULL OR counters_date != ?)`, today,
  );
  for (const a of rows) {
    const day = accountDay(a);
    let status = a.status;
    if (status === 'warming' && day > WARMUP_DAYS && a.auto_promote && !a.warmup_only) {
      status = 'active';
      addLog({ account_id: a.id, kind: 'auto_action', event: 'promoted', action: `warming -> active (dia ${day})` });
    }
    q.run(
      `UPDATE accounts SET counters_date=?, sent_today=0, warmup_sent_today=0, bounces_today=0,
         warmup_target_today=?, daily_limit=?, status=?, next_warmup_at=NULL, next_send_at=NULL WHERE id=?`,
      today, warmupTargetFor(day), capLimit(a.limit_override ?? outreachLimit(day)), status, a.id,
    );
  }
}

export function setStatus(id: number, status: AccountStatus, reason?: string): void {
  q.run(`UPDATE accounts SET status=?, pause_reason=?, consecutive_errors=0 WHERE id=?`, status, reason ?? null, id);
  addLog({ account_id: id, kind: 'auto_action', event: `status:${status}`, detail: reason });
}

/** Retoma uma caixa pausada voltando para a fase correta (warming/active). */
export function resumeAccount(a: Account): void {
  const status: AccountStatus = accountDay(a) > WARMUP_DAYS ? 'active' : 'warming';
  q.run(`UPDATE accounts SET status=?, pause_reason=NULL, consecutive_errors=0, bounces_today=0 WHERE id=?`, status, a.id);
  addLog({ account_id: a.id, kind: 'info', event: 'resumed', detail: status });
}

/** Pausa automática + libera a fila pendente (o planner redistribui os leads). */
export function autoPause(a: Account, reason: string): void {
  setStatus(a.id, 'paused', reason);
  addLog({ account_id: a.id, kind: 'auto_action', event: 'auto_pause', detail: reason, action: 'conta pausada' });
}

export type SendErrorKind = 'auth' | 'quota' | 'throttle' | 'recipient' | 'temp' | 'unknown';

/** Cooldown em minutos: 30 → 60 → 120 → ... (máx 6h); 5.7.708 (IP/serviço negado) parte de 2h (máx 12h). */
function cooldownMinutes(count: number, message: string): number {
  const base = /5\.7\.708/.test(message) ? 120 : 30;
  const cap = base === 120 ? 720 : 360;
  return Math.min(base * 2 ** Math.max(0, count - 1), cap);
}

export const isCoolingDown = (a: Pick<Account, 'cooldown_until'>): boolean =>
  !!a.cooldown_until && a.cooldown_until > nowIso();

/** Registra falha de conexão/envio da CAIXA e aplica o disjuntor de erros. */
export function recordAccountError(a: Account, kind: SendErrorKind, message: string): void {
  addLog({ account_id: a.id, kind: 'error', event: `send_${kind}`, detail: message });
  if (kind === 'auth') {
    log('accounts', `⛔ CAIXA PAUSADA ${a.email} por erro de autenticação/permissão: ${message.slice(0, 200)} (retome com: accounts resume)`);
    autoPause(a, `Falha de autenticação: ${message.slice(0, 120)}`);
    return;
  }
  if (kind === 'throttle') {
    const count = (getAccount(a.id)?.throttle_count ?? a.throttle_count) + 1;
    const mins = cooldownMinutes(count, message);
    q.run(`UPDATE accounts SET cooldown_until=?, throttle_count=? WHERE id=?`, addMs(mins * 60_000), count, a.id);
    addLog({
      account_id: a.id, kind: 'auto_action', event: 'cooldown', detail: message,
      action: `cooldown de ${mins} min (ocorrência ${count}); leads novos redirecionados para outras caixas`,
    });
    return;
  }
  if (kind === 'quota') {
    // limite diário do provedor estourou: encerra o dia da caixa
    q.run(`UPDATE accounts SET sent_today=daily_limit, warmup_sent_today=warmup_target_today WHERE id=?`, a.id);
    addLog({ account_id: a.id, kind: 'auto_action', event: 'quota_stop', action: 'caixa encerrada por hoje' });
    return;
  }
  const errors = a.consecutive_errors + 1;
  q.run(`UPDATE accounts SET consecutive_errors=? WHERE id=?`, errors, a.id);
  if (errors >= 5) autoPause(a, `5 erros consecutivos: ${message.slice(0, 120)}`);
}

/** Envio bem-sucedido: zera erros e o backoff de throttling. */
export const clearAccountErrors = (id: number): void =>
  void q.run(`UPDATE accounts SET consecutive_errors=0, throttle_count=0, cooldown_until=NULL WHERE id=?`, id);

export function limitBounces(a: Account): void {
  const fresh = getAccount(a.id)!;
  if (fresh.status !== 'paused' && fresh.bounces_today > config.maxBouncesPerDay) {
    autoPause(fresh, `Circuit breaker: ${fresh.bounces_today} bounces hoje (limite ${config.maxBouncesPerDay})`);
  }
}

export interface AccountFilter {
  ids?: number[];
  group?: string;
  status?: string;
  all?: boolean;
}

export function selectAccounts(f: AccountFilter): Account[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.ids?.length) {
    where.push(`id IN (${f.ids.map(() => '?').join(',')})`);
    params.push(...f.ids);
  }
  if (f.group) (where.push('group_name = ?'), params.push(f.group));
  if (f.status) (where.push('status = ?'), params.push(f.status));
  if (!where.length && !f.all) return [];
  return q.all<Account>(`SELECT * FROM accounts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`, ...params);
}
