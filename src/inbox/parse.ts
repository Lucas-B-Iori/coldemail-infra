import type { ParsedMail } from 'mailparser';

export interface BounceInfo {
  isBounce: boolean;
  type: 'hard' | 'soft';
  status?: string;
  recipients: string[];
  reason: string;
}

const BOUNCE_FROM = /mailer-daemon|postmaster|mail delivery subsystem|microsoft outlook <.*postmaster/i;
const BOUNCE_SUBJECT =
  /delivery status notification|undeliver|delivery (has )?failed|delivery failure|failure notice|returned mail|mail delivery failed|falha na entrega|n[ãa]o (foi )?entregue|mensagem n[ãa]o entregue|n[ãa]o p[ôo]de ser entregue/i;
const HARD_TEXT =
  /user unknown|no such user|does not exist|doesn'?t exist|address not found|couldn'?t be found|unable to receive mail|invalid (recipient|mailbox|address)|n[ãa]o existe|recipient address rejected|mailbox unavailable|account (has been )?disabled/i;
const SOFT_TEXT = /mailbox (is )?full|over quota|quota exceeded|temporar|try again|greylist|too many|rate limit|deferred/i;
const REPUTATION_TEXT = /5\.7\.\d|blocked|spam|reputation|policy|blacklist|denied|not authenticated|rejected due to/i;

const EMAIL_G = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function parseBounce(m: ParsedMail, ownEmails: Set<string>): BounceInfo {
  const from = m.from?.value?.[0]?.address ?? m.from?.text ?? '';
  const subject = m.subject ?? '';
  const ctype = String(m.headers.get('content-type')?.toString() ?? '');
  const dsn = m.attachments?.find((a) => /delivery-status/i.test(a.contentType));
  const isBounce = BOUNCE_FROM.test(from) || BOUNCE_SUBJECT.test(subject) || /report-type=delivery-status/i.test(ctype) || !!dsn;
  if (!isBounce) return { isBounce: false, type: 'soft', recipients: [], reason: '' };

  const dsnText = dsn ? dsn.content.toString('utf8') : '';
  const text = `${dsnText}\n${m.text ?? ''}`;

  const recipients = new Set<string>();
  for (const r of text.matchAll(/(?:Final|Original)-Recipient:\s*(?:rfc822;)?\s*<?([^\s>]+@[^\s>]+)>?/gi)) recipients.add(r[1].toLowerCase());
  if (!recipients.size) {
    for (const e of text.match(EMAIL_G) ?? []) {
      const l = e.toLowerCase();
      if (!ownEmails.has(l) && !BOUNCE_FROM.test(l) && !/^(postmaster|mailer-daemon)@/.test(l)) recipients.add(l);
    }
  }

  const status = /Status:\s*([245]\.\d+\.\d+)/i.exec(text)?.[1] ?? /\b([45]\.\d{1,3}\.\d{1,3})\b/.exec(text)?.[1];
  const diag = /Diagnostic-Code:[^\n]*(?:\n\s+[^\n]+)*/i.exec(text)?.[0]?.replace(/\s+/g, ' ').trim();

  let type: 'hard' | 'soft';
  if (status?.startsWith('4') || (SOFT_TEXT.test(text) && !HARD_TEXT.test(text))) type = 'soft';
  else if (status === '5.1.1' || status?.startsWith('5.1') || HARD_TEXT.test(text)) type = 'hard';
  else if (REPUTATION_TEXT.test(text)) type = 'soft'; // bloqueio de reputação: não é culpa do endereço
  else type = status?.startsWith('5') ? 'hard' : 'soft';

  return {
    isBounce: true,
    type,
    status,
    recipients: [...recipients],
    reason: (diag ?? subject).slice(0, 300) + (REPUTATION_TEXT.test(text) && type === 'soft' ? ' [possível bloqueio de reputação]' : ''),
  };
}

const AUTO_SUBJECT = /resposta autom[áa]tica|automatic reply|auto-?reply|out of office|fora do escrit[óo]rio|ausente|f[ée]rias/i;
export function isAutoReply(m: ParsedMail): boolean {
  const auto = String(m.headers.get('auto-submitted') ?? '');
  if (auto && auto !== 'no') return true;
  if (m.headers.get('x-autoreply') || m.headers.get('x-autorespond')) return true;
  if (/bulk|auto_reply|junk/i.test(String(m.headers.get('precedence') ?? ''))) return true;
  return AUTO_SUBJECT.test(m.subject ?? '');
}

const UNSUB =
  /\b(remov(a|er|am)|descadastr\w*|n[ãa]o quero|n[ãa]o tenho interesse|sem interesse|n[ãa]o me (envie|mande|escreva)|pare de|parem de|unsubscribe|stop|exclu[ai]\w* (meu|o) (e-?mail|contato))\b/i;

/** Pega só o texto novo da resposta (corta citação "Em ... escreveu:" e linhas com ">"). */
export function replyText(m: ParsedMail): string {
  const lines = (m.text ?? '').split(/\r?\n/);
  const out: string[] = [];
  for (const l of lines) {
    if (/^>/.test(l) || /^(Em .+ escreveu:|On .+ wrote:|De:|From:|-----)/i.test(l.trim())) break;
    out.push(l);
  }
  return out.join('\n').trim();
}

export const isUnsubscribe = (text: string): boolean => UNSUB.test(text.slice(0, 400));
