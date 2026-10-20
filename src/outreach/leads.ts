import { addLog, q } from "../db/index.ts";
import { nowIso } from "../lib/util.ts";

export type LeadStatus =
  | "pending"
  | "queued"
  | "sent"
  | "replied"
  | "bounced"
  | "unsubscribed"
  | "finished"
  | "nurture"
  | "call";

export interface Lead {
  id: number;
  name: string;
  email: string;
  firm_name: string | null;
  city_state: string | null;
  list_name: string;
  status: LeadStatus;
  sequence_id: number | null;
  current_step: number;
  assigned_account_id: number | null;
  thread_subject: string | null;
  last_message_id: string | null;
  thread_references: string | null;
  last_contacted_at: string | null;
  next_due_at: string | null;
  replied_at: string | null;
  last_reply_snippet: string | null;
  notes: string | null;
  site: string | null;
  role: string | null;
  source_url: string | null;
  practice_area: string | null;
  observed_fact: string | null;
  need_hypothesis: string | null;
  fit_score: number;
  variant: string;
  reply_intent: string | null;
  next_action: string | null;
  scheduled_meeting_at: string | null;
  demo_done: number;
  customer_paid: number;
  deal_value: string | null;
  city: string | null;
  neighborhood: string | null;
  phone: string | null;
  instagram: string | null;
  maps_rating: number | null;
  maps_reviews: number | null;
  site_status: string | null;
  contact_known: number;
  created_at: string;
  updated_at: string;
}

const normKey = (k: string): string =>
  k.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/[\s-]+/g, '_');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function getSequenceId(name: string): number {
  const s = q.get<{ id: number }>(
    "SELECT id FROM sequences WHERE name=?",
    name,
  );
  if (!s)
    throw new Error(`Sequência "${name}" não existe (veja: sequences list)`);
  return s.id;
}

export function importLeads(
  rows: Record<string, string>[],
  opts: { list: string; sequence?: string },
): { added: number; duplicates: number; invalid: number } {
  const seqId = opts.sequence ? getSequenceId(opts.sequence) : null;
  let added = 0,
    duplicates = 0,
    invalid = 0;
  const now = nowIso();
  for (const raw of rows) {
    // cabeçalhos já vêm em minúsculas do parseCsv; normaliza acentos/espaços para aceitar "Avaliações Maps" etc.
    const r: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) r[normKey(k)] = (v ?? '').trim();
    const pickCol = (...keys: string[]) => keys.map((k) => r[normKey(k)]).find((v) => v) || null;

    const email = (pickCol('email', 'e-mail', 'email_profissional') || '').toLowerCase();
    if (!EMAIL_RE.test(email)) {
      invalid++;
      continue;
    }
    const exclude = (pickCol('excluir_contato') || '').toLowerCase();
    if (exclude === 'sim' || exclude === 'true' || exclude === '1') continue;

    const firmName = pickCol('empresa', 'nome_empresa', 'firm_name', 'escritorio');
    const contact = pickCol('contato', 'nome', 'name');
    const name = contact || firmName || email.split('@')[0];
    const city = pickCol('cidade', 'city');
    const uf = pickCol('uf', 'estado');
    const cityState = pickCol('city_state', 'cidade_uf') || (city ? (uf ? `${city}/${uf}` : city) : null);
    const siteStatusRaw = (pickCol('site_status') || '').toLowerCase();
    const siteStatus = ['nenhum', 'ruim', 'ok'].includes(siteStatusRaw) ? siteStatusRaw : null;
    const rating = parseFloat((pickCol('nota_maps') || '').replace(',', '.'));
    const reviews = parseInt((pickCol('avaliacoes_maps') || '').replace(/\D/g, ''), 10);

    const res = q.run(
      `INSERT OR IGNORE INTO leads (
         name, email, firm_name, city_state, list_name, sequence_id,
         site, role, source_url, practice_area, observed_fact, need_hypothesis,
         fit_score, variant, city, neighborhood, phone, instagram, maps_rating, maps_reviews, site_status, contact_known,
         created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      name, email, firmName, cityState, opts.list, seqId,
      pickCol('site'), pickCol('funcao', 'role'), pickCol('fonte_url', 'url_origem', 'source_url'),
      pickCol('segmento', 'practice_area'), pickCol('fato_observado', 'observed_fact'),
      pickCol('hipotese_necessidade', 'need_hypothesis'),
      parseInt(pickCol('pontos', 'pontuacao', 'fit_score') || '0', 10) || 0,
      pickCol('variante', 'variant') || 'modelo_a',
      city || (cityState ? cityState.split(/[\/,-]/)[0].trim() : null), pickCol('bairro', 'neighborhood'),
      pickCol('telefone', 'whatsapp', 'phone'), pickCol('instagram'),
      Number.isFinite(rating) ? rating : null, Number.isFinite(reviews) ? reviews : null,
      siteStatus, contact ? 1 : 0,
      now, now,
    );
    res.changes ? added++ : duplicates++;
  }
  return { added, duplicates, invalid };
}

/** Cancela qualquer envio pendente do lead (usado quando responde / bounce / descadastro). */
export function cancelQueuedForLead(leadId: number, reason: string): void {
  q.run(
    `UPDATE outreach_queue SET status='cancelled', error_log=? WHERE lead_id=? AND status='queued'`,
    reason,
    leadId,
  );
}

/** Devolve o lead ao estado anterior ao enfileiramento (quando o envio não aconteceu). */
export function restoreLead(leadId: number): void {
  const l = q.get<Lead>("SELECT * FROM leads WHERE id=?", leadId);
  if (!l || !["queued", "sent"].includes(l.status)) return;
  const status: LeadStatus = l.current_step === 0 ? "pending" : "sent";
  q.run(
    `UPDATE leads SET status=?, updated_at=? WHERE id=?`,
    status,
    nowIso(),
    leadId,
  );
}

/** Muda status manualmente (replied -> nurture, call, etc.) e remove da fila. */
export function setLeadStatus(
  leadId: number,
  status: LeadStatus,
  note?: string,
): void {
  cancelQueuedForLead(leadId, `status manual: ${status}`);
  q.run(
    `UPDATE leads SET status=?, notes=COALESCE(?, notes), updated_at=? WHERE id=?`,
    status,
    note ?? null,
    nowIso(),
    leadId,
  );
  addLog({
    lead_id: leadId,
    kind: "info",
    event: `lead_status:${status}`,
    detail: note,
  });
}

/** Coloca o lead em uma nova sequência do zero (ex.: nurture) e libera para a fila. */
export function enrollLead(
  leadId: number,
  sequenceName: string,
  listName?: string,
): void {
  const seq = getSequenceId(sequenceName);
  cancelQueuedForLead(leadId, "re-enroll");
  q.run(
    `UPDATE leads SET sequence_id=?, current_step=0, status='pending', next_due_at=NULL,
       replied_at=NULL, last_reply_snippet=NULL, reply_intent=NULL,
       list_name=COALESCE(?, list_name), updated_at=? WHERE id=?`,
    seq,
    listName ?? null,
    nowIso(),
    leadId,
  );
  addLog({
    lead_id: leadId,
    kind: "info",
    event: "enrolled",
    detail: sequenceName,
  });
}
