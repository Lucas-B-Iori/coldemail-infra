import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { getPassword } from '../accounts/accounts.ts';
import type { Account, SendErrorKind } from '../accounts/accounts.ts';
import { config } from '../config.ts';
import { getM365Token } from './oauth.ts';
import { sendViaGraph } from './graph.ts';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  /** HTML simples opcional; se omitido e SEND_HTML=true, é gerado a partir do texto. */
  html?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
}

export const makeMessageId = (a: Pick<Account, 'email'>): string =>
  `<${randomUUID().replace(/-/g, '').slice(0, 20)}.${Date.now().toString(36)}@${a.email.split('@')[1]}>`;

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** HTML mínimo (só <p> e <br>): sem tabelas, sem imagens, sem pixel de rastreio, sem links reescritos. */
export function simpleHtml(text: string): string {
  const paras = text.trim().split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`);
  return `<div style="font-family:Calibri,Arial,sans-serif;font-size:14px">${paras.join('')}</div>`;
}

async function transport(a: Account) {
  const secure = a.smtp_port === 465;
  const auth =
    a.auth_mode === 'oauth'
      ? { type: 'OAuth2' as const, user: a.smtp_user, accessToken: await getM365Token() }
      : { user: a.smtp_user, pass: getPassword(a) };
  return nodemailer.createTransport({
    host: a.smtp_host,
    port: a.smtp_port,
    secure,
    requireTLS: !secure, // STARTTLS obrigatório na 587
    auth,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 40_000,
  });
}

/** Caixas M365 (oauth) usam Graph quando SEND_TRANSPORT=graph; Gmail (senha) segue no SMTP. */
export const usesGraph = (a: Pick<Account, 'auth_mode'>): boolean =>
  config.sendTransport === 'graph' && a.auth_mode === 'oauth';

/** Envia sempre com `text` (fallback obrigatório); inclui `html` simples só se SEND_HTML=true. Retorna o Message-ID. */
export async function sendMail(a: Account, m: OutgoingMail): Promise<string> {
  const messageId = m.messageId ?? makeMessageId(a);
  if (usesGraph(a)) {
    await sendViaGraph(a, {
      from: { name: a.display_name, address: a.email },
      to: m.to, subject: m.subject, text: m.text,
      html: m.html ?? (config.sendHtml ? simpleHtml(m.text) : undefined),
      messageId, inReplyTo: m.inReplyTo, references: m.references,
    });
    return messageId;
  }
  const t = await transport(a);
  try {
    await t.sendMail({
      from: { name: a.display_name, address: a.email }, // From = conta autenticada: "Nome" <email>
      to: m.to,
      subject: m.subject,
      text: m.text,
      html: m.html ?? (config.sendHtml ? simpleHtml(m.text) : undefined),
      messageId,
      inReplyTo: m.inReplyTo,
      references: m.references,
    });
    return messageId;
  } finally {
    t.close();
  }
}

export async function verifySmtp(a: Account): Promise<void> {
  const t = await transport(a);
  try {
    await t.verify();
  } finally {
    t.close();
  }
}

/**
 * Classifica o erro SMTP para o chamador decidir: pausar caixa, cooldown, pular lead ou tentar depois.
 *  - throttle: 451 4.7.500 (Server busy), 550 5.7.708 (acesso negado/IP), 4.7.x, 421 → cooldown + redireciona leads novos
 *  - auth:     535 5.7.139/5.7.3, 5.7.57, 534 → pausa a caixa (basic auth desligado, SMTP AUTH off, senha errada)
 */
export function classifySendError(e: unknown): { kind: SendErrorKind; message: string } {
  const err = e as { code?: string; responseCode?: number; response?: string; message?: string };
  const message = `${err.code ?? ''} ${err.response ?? err.message ?? e}`.trim();
  const rc = err.responseCode ?? 0;

  // Microsoft Graph
  if (err.code === 'EGRAPH_THROTTLE') return { kind: 'throttle', message };
  if (err.code === 'EGRAPH_FORBIDDEN' || err.code === 'EGRAPH_TOKEN' || err.code === 'EGRAPH_CONFIG') return { kind: 'auth', message };
  if (err.code === 'EGRAPH_TEMP') return { kind: 'temp', message };
  if (err.code === 'EGRAPH_BAD_REQUEST') {
    if (/recipient|ErrorInvalidRecipients/i.test(message)) return { kind: 'recipient', message };
    return { kind: 'unknown', message };
  }

  if (/4\.7\.[0-9]{3}|5\.7\.708|5\.7\.7\d\d|server busy|too many (concurrent|connections|messages per)|throttl|rate limit|4\.3\.2|try again later/i.test(message) || rc === 421)
    return { kind: 'throttle', message };
  if (err.code === 'EAUTH' || rc === 535 || rc === 534 || /5\.7\.139|5\.7\.3\b|5\.7\.57|5\.7\.30|credentials|Application-specific|basic authentication is disabled|SmtpClientAuthentication is disabled/i.test(message))
    return { kind: 'auth', message };
  if (/5\.4\.5|daily (user )?sending (limit|quota)|exceeded.*(limit|quota)|SubmissionQuota|5\.2\.[0-9]+.*limit/i.test(message))
    return { kind: 'quota', message };
  if (rc === 550 || rc === 551 || rc === 553 || rc === 552) {
    if (/5\.1\.[0-9]|user unknown|no such user|does not exist|invalid (mailbox|recipient)|recipient (not found|rejected)|couldn'?t be found/i.test(message))
      return { kind: 'recipient', message };
    return { kind: 'temp', message }; // 550 de política/spam: falha da caixa, não do lead
  }
  if (rc >= 400 && rc < 500) return { kind: 'temp', message };
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ESOCKET', 'EDNS', 'ENOTFOUND'].includes(err.code ?? ''))
    return { kind: 'temp', message };
  return { kind: 'unknown', message };
}
