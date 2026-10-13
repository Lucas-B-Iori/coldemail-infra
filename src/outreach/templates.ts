import { config } from '../config.ts';
import type { Account } from '../accounts/accounts.ts';
import { pick } from '../lib/util.ts';

export interface LeadVars {
  name: string;
  firm_name?: string | null;
  city_state?: string | null;
}

/** Resolve spintax {a|b|c} (suporta aninhamento simples). */
export function spin(text: string): string {
  let out = text;
  const re = /\{([^{}|]*\|[^{}]*)\}/;
  for (let i = 0; i < 50 && re.test(out); i++) out = out.replace(re, (_, g: string) => pick(g.split('|')));
  return out;
}

const TITLE = /^(dr|dra|dr\.|dra\.|prof|prof\.|profa|profa\.)$/i;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

export function firstName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (TITLE.test(parts[0]) && parts[1]) return `${cap(parts[0].replace('.', ''))}. ${cap(parts[1])}`;
  return cap(parts[0]);
}

export function renderTemplate(tpl: string, lead: LeadVars): string {
  const vars: Record<string, string> = {
    first_name: firstName(lead.name),
    name: lead.name,
    firm_name: lead.firm_name || 'seu escritório',
    city: (lead.city_state || '').split(/[\/,-]/)[0].trim(),
  };
  return spin(tpl).replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);
}

export function signature(a: Pick<Account, 'display_name'>): string {
  const person = a.display_name.split('|')[0].trim(); // "Lucas Iori | Synapze" -> "Lucas Iori"
  const line2 = [config.signature.role, config.signature.phone].filter(Boolean).join(' | ');
  return `\n\nAtenciosamente,\n${person}\n${line2}`;
}

const URL_RE = /(https?:\/\/|www\.|wa\.me|bit\.ly|\b[a-z0-9-]+\.(com|com\.br|net|org|io|app|adv\.br|br)\b)/i;
const SPAM_RE = /(grátis|gratis|100% |garantido|clique aqui|oferta imperdível|últimas vagas|promoção|ganhe dinheiro|sem compromisso algum)/i;

export const OPT_OUT = 'Se preferir não receber mais mensagens, basta me avisar.';

export function withOptOut(body: string): string {
  return body.includes(OPT_OUT) ? body.trim() : `${body.trim()}\n\n${OPT_OUT}`;
}

/**
 * Trava de segurança de entregabilidade. Retorna a descrição do problema ou null se OK.
 * - Toque 1: nenhum link/domínio.
 * - Nunca enviar placeholder não resolvido.
 */
export function lintEmail(subject: unknown, body: unknown, step: number): string | null {
  if (typeof subject !== 'string' || !subject.trim()) return 'assunto vazio ou inválido';
  if (typeof body !== 'string' || body.trim().length < 10 || body.trim().split(/\s+/).length < 3) return 'corpo vazio ou inválido';
  if (/[\r\n\x00-\x1f\x7f]/.test(subject)) return 'caractere de controle no assunto';
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body)) return 'caractere de controle no corpo';
  if (/\{\{|\}\}/.test(subject + body)) return 'placeholder não resolvido';
  if (step === 1 && URL_RE.test(subject + ' ' + body)) return 'link/domínio no toque 1 (proibido)';
  if (SPAM_RE.test(subject + ' ' + body)) return 'termo promocional/spam';
  const words = body.trim().split(/\s+/).length;
  if (words > 140) return `corpo longo demais (${words} palavras)`;
  if (subject.length > 70) return 'assunto longo demais';
  return null;
}
