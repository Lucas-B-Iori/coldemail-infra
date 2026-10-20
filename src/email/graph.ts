import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { Account } from '../accounts/accounts.ts';
import { config } from '../config.ts';
import { log, sleep } from '../lib/util.ts';

/**
 * Envio via Microsoft Graph (app-only / client credentials).
 * POST /users/{mailbox}/sendMail com corpo MIME (base64): preserva Message-ID, In-Reply-To e References
 * exatamente como no SMTP (o JSON do Graph não aceita esses cabeçalhos em internetMessageHeaders).
 * Permissão necessária: Mail.Send (Application) + consentimento de admin; recomendável restringir com
 * ApplicationAccessPolicy às 9 caixas.
 */

let cached: { token: string; expiresAt: number } | null = null;

export const graphConfigured = (): boolean =>
  !!(config.graph.tenantId && config.graph.clientId && config.graph.clientSecret);

export class GraphError extends Error {
  responseCode: number;
  code: string;
  constructor(responseCode: number, code: string, message: string) {
    super(message);
    this.responseCode = responseCode;
    this.code = code;
  }
}

export async function getGraphToken(force = false): Promise<string> {
  if (!graphConfigured()) {
    throw new GraphError(0, 'EGRAPH_CONFIG', 'Graph não configurado: defina AZURE_TENANT_ID, AZURE_CLIENT_ID e AZURE_CLIENT_SECRET no .env');
  }
  if (!force && cached && cached.expiresAt - Date.now() > 120_000) return cached.token;
  const res = await fetch(`https://login.microsoftonline.com/${config.graph.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.graph.clientId,
      client_secret: config.graph.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !data.access_token) {
    throw new GraphError(401, 'EGRAPH_TOKEN', `Falha ao obter token Graph: ${(data.error_description ?? res.statusText).split('\n')[0]}`);
  }
  cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cached.token;
}

/** Lê as roles (permissões de aplicação) do token, sem validar assinatura. Só para diagnóstico. */
export function tokenRoles(token: string): string[] {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { roles?: string[] };
    return payload.roles ?? [];
  } catch {
    return [];
  }
}

/** Fila serial por caixa: nunca há dois POSTs simultâneos da mesma mailbox. */
const chains = new Map<string, Promise<unknown>>();
function serial<T>(mailbox: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(mailbox) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  chains.set(mailbox, next.catch(() => undefined));
  return next;
}

export interface GraphMail {
  from: { name: string; address: string };
  to: string;
  subject: string;
  text: string;
  html?: string;
  messageId: string;
  inReplyTo?: string;
  references?: string;
}

async function buildMime(m: GraphMail): Promise<string> {
  const composer = new MailComposer({
    from: m.from, to: m.to, subject: m.subject, text: m.text, html: m.html,
    messageId: m.messageId, inReplyTo: m.inReplyTo, references: m.references,
  });
  const buf: Buffer = await new Promise((resolve, reject) =>
    composer.compile().build((err: Error | null, msg: Buffer) => (err ? reject(err) : resolve(msg))),
  );
  return buf.toString('base64');
}

const MAX_429_RETRIES = 3;
const MAX_RETRY_AFTER_SEC = 120;

export function sendViaGraph(a: Pick<Account, 'email'>, m: GraphMail): Promise<void> {
  return serial(a.email.toLowerCase(), async () => {
    const mime = await buildMime(m);
    for (let attempt = 0; ; attempt++) {
      const token = await getGraphToken();
      const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(a.email)}/sendMail`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: mime,
        signal: AbortSignal.timeout(40_000),
      });
      if (res.status === 202) return;

      const text = (await res.text().catch(() => '')).slice(0, 300);
      if (res.status === 429 || res.status === 503) {
        const ra = parseInt(res.headers.get('retry-after') ?? '', 10);
        const wait = Number.isFinite(ra) ? ra : 30 * (attempt + 1);
        if (attempt < MAX_429_RETRIES && wait <= MAX_RETRY_AFTER_SEC) {
          log('graph', `${a.email}: HTTP ${res.status}, aguardando Retry-After ${wait}s (tentativa ${attempt + 1}/${MAX_429_RETRIES})`);
          await sleep(wait * 1000);
          continue;
        }
        throw new GraphError(429, 'EGRAPH_THROTTLE', `Graph throttled (HTTP ${res.status}, Retry-After ${wait}s): ${text}`);
      }
      if (res.status === 401 && attempt === 0) {
        cached = null; // token pode ter expirado/sido revogado: renova uma vez
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        const msg = `Graph ${res.status} FORBIDDEN em ${a.email}: falta Mail.Send (Application) com consentimento de admin, `
          + `a caixa está fora da ApplicationAccessPolicy, ou a conta está bloqueada/sem licença. Resposta: ${text}`;
        log('graph', `⚠ ${msg}`);
        throw new GraphError(res.status, 'EGRAPH_FORBIDDEN', msg);
      }
      if (res.status === 400 || res.status === 404) {
        throw new GraphError(res.status, 'EGRAPH_BAD_REQUEST', `Graph ${res.status} em ${a.email}: ${text}`);
      }
      throw new GraphError(res.status, 'EGRAPH_TEMP', `Graph HTTP ${res.status} em ${a.email}: ${text}`);
    }
  });
}
