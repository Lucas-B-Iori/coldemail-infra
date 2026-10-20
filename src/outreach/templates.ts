import { config } from '../config.ts';
import type { Account } from '../accounts/accounts.ts';
import { pick } from '../lib/util.ts';

export interface LeadVars {
  name: string;
  firm_name?: string | null;
  city_state?: string | null;
  city?: string | null;
  neighborhood?: string | null;
  practice_area?: string | null;
  maps_rating?: number | null;
  maps_reviews?: number | null;
  site_status?: string | null;
  instagram?: string | null;
  contact_known?: number | null;
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

/** Remove caracteres que quebrariam o spintax/placeholder. */
const safe = (v: string) => v.replace(/[{}|]/g, '').trim();

/**
 * Variáveis disponíveis nos templates:
 *  {{first_name}} {{name}} {{greeting}} {{firm_name}} {{business}} {{city}} {{neighborhood}} {{place}}
 *  {{segment}} {{maps_phrase}} {{site_phrase}} {{price}} {{sender}}
 */
export function leadVars(lead: LeadVars, sender = ''): Record<string, string> {
  const fn = lead.contact_known === 0 ? '' : firstName(lead.name);
  const city = lead.city || (lead.city_state || '').split(/[\/,-]/)[0].trim();
  const nb = lead.neighborhood || '';
  const business = lead.firm_name || 'seu negócio';
  const rating = lead.maps_rating ?? null;
  const reviews = lead.maps_reviews ?? null;
  const mapsPhrase =
    rating !== null && rating >= 4.3 && reviews && reviews >= 20
      ? ` e vi a nota ${rating.toFixed(1).replace('.', ',')} com ${reviews} avaliações no Google`
      : '';
  const sitePhrase =
    lead.site_status === 'nenhum' ? 'vocês ainda não têm um site próprio'
    : lead.site_status === 'ruim' ? 'o site atual de vocês poderia mostrar melhor o trabalho, principalmente no celular'
    : 'quem procura vocês no Google cai direto no Maps ou no Instagram';
  const v: Record<string, string> = {
    first_name: fn,
    name: lead.name,
    greeting: fn ? `Oi, ${fn}, tudo bem?` : 'Oi, tudo bem?',
    firm_name: business,
    business,
    city,
    neighborhood: nb,
    place: city || nb || 'na sua região',
    segment: (lead.practice_area || 'comércio').toLowerCase(),
    maps_phrase: mapsPhrase,
    site_phrase: sitePhrase,
    price: config.sitePrice,
    sender: sender,
  };
  for (const k of Object.keys(v)) v[k] = k === 'maps_phrase' ? v[k].replace(/[{}|]/g, '') : safe(v[k]);
  return v;
}

/** Substitui {{vars}} primeiro e depois resolve o spintax (valores do lead são sanitizados de { } |). */
export function renderTemplate(tpl: string, lead: LeadVars, sender = ''): string {
  const vars = leadVars(lead, sender);
  const filled = tpl.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);
  return spin(filled).replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ').replace(/ ,/g, ',');
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
