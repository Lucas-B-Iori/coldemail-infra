import { addLog, q } from '../db/index.ts';
import { config } from '../config.ts';
import { nowIso } from '../lib/util.ts';
import { lintEmail } from './templates.ts';

export const SIGNATURE_MARKER = '[ASSINATURA]';
export const DEFAULT_OPT_OUT = 'Caso prefira não receber mais e-mails meus, responda "sair" e eu não escrevo mais.';
const OPT_OUT_RE = /(n[ãa]o (escrevo|escreva|insisto|incomodo|volto a escrever|envio|mando) mais|n[ãa]o (insisto|volto a escrever|te incomodo)|n[ãa]o receber mais|paro por aqui|encerro (por aqui|o contato)|(é|e) s[óo] (me )?(avisar|dizer|responder)|me avis[ae]|me diga|responda "?sair"?|responder "?n[ãa]o"?|um "n[ãa]o"|descadastr|tiro seu contato|basta me avisar)/i;
const PROMISE_RE = /(mais clientes|vender mais|primeiro lugar|1º lugar|topo do google|garant|grátis|gratuito|sem custo)/i;

export const hasOptOut = (body: string): boolean => OPT_OUT_RE.test(body);

/** Insere o opt-out antes do bloco de assinatura (parágrafo com o nome/[ASSINATURA]) quando o corpo não tem. */
export function ensureOptOut(body: string): string {
  if (hasOptOut(body)) return body;
  const paras = body.trim().split(/\n{2,}/);
  const idx = paras.findIndex((p) => p.includes(SIGNATURE_MARKER));
  if (idx >= 0) paras.splice(idx, 0, DEFAULT_OPT_OUT);
  else paras.push(DEFAULT_OPT_OUT);
  return paras.join('\n\n');
}

/** Avisos (não bloqueiam): lint básico + filtro de promessas. */
export function copyWarnings(subject: string, body: string, step = 1): string[] {
  const w: string[] = [];
  const probe = body.split(SIGNATURE_MARKER).join('Assinatura');
  const lint = lintEmail(subject, probe, step);
  if (lint) w.push(`lint: ${lint}`);
  const m = (subject + ' ' + body).match(PROMISE_RE);
  if (m) w.push(`promessa: "${m[0]}"`);
  if (!body.includes(SIGNATURE_MARKER)) w.push('sem marcador [ASSINATURA]');
  return w;
}

/** Bloqueios duros (segurança de cabeçalho / marcador não resolvido). */
export function copyBlockers(subject: string, body: string): string[] {
  const b: string[] = [];
  if (!subject.trim()) b.push('assunto vazio');
  if (/[\r\n\x00-\x1f\x7f]/.test(subject)) b.push('caractere de controle no assunto');
  if (body.trim().split(/\s+/).length < 5) b.push('corpo vazio/curto');
  return b;
}

export interface ImportedCopy { subject: string; body: string }

/** Copy importada pronta para enfileirar, ou motivo para não enfileirar. null = lead não tem copy importada. */
export function importedCopyFor(leadId: number, step: number): { ok: true; copy: ImportedCopy; warnings: string[] } | { ok: false; reason: string } | null {
  const row = q.get<{ subject: string; body: string }>('SELECT subject, body FROM lead_copies WHERE lead_id=? AND step_number=?', leadId, step);
  if (!row) return null;
  if (row.body.includes(SIGNATURE_MARKER) && !config.signatureBlock) {
    return { ok: false, reason: 'SIGNATURE_BLOCK não configurado: copy importada não enfileirada' };
  }
  const body = ensureOptOut(row.body).split(SIGNATURE_MARKER).join(config.signatureBlock).replace(/\n{3,}/g, '\n\n').trim();
  const blockers = copyBlockers(row.subject, body);
  if (blockers.length) return { ok: false, reason: `copy importada inválida: ${blockers.join('; ')}` };
  return { ok: true, copy: { subject: row.subject, body }, warnings: copyWarnings(row.subject, row.body, step) };
}

export interface CopyImportReport {
  imported: number; updated: number; unmatched: string[]; duplicates: string[];
  dupSubjects: string[]; dupBodies: string[]; warnings: { email: string; issues: string[] }[]; blocked: { email: string; issues: string[] }[];
  missingCopy: string[];
}

/**
 * Importa CSV com colunas: prioridade,email,empresa,cidade,assunto,corpo (empresa/cidade só conferência).
 * Assunto e corpo são gravados EXATAMENTE como estão (sem spintax/IA). Define leads.priority.
 */
export function importLeadCopies(rows: Record<string, string>[], opts: { step?: number; dryRun?: boolean; source?: string } = {}): CopyImportReport {
  const step = opts.step ?? 1;
  const r: CopyImportReport = { imported: 0, updated: 0, unmatched: [], duplicates: [], dupSubjects: [], dupBodies: [], warnings: [], blocked: [], missingCopy: [] };
  const seen = new Set<string>(), subj = new Map<string, string>(), bodies = new Map<string, string>();
  const now = nowIso();
  for (const row of rows) {
    const email = (row.email ?? '').trim().toLowerCase();
    const subject = row.assunto ?? row.subject ?? '';
    const body = (row.corpo ?? row.body ?? '').replace(/\r\n/g, '\n');
    if (!email) continue;
    if (seen.has(email)) { r.duplicates.push(email); continue; }
    seen.add(email);
    const sk = subject.trim().toLowerCase(), bk = body.replace(/\s+/g, ' ').trim().toLowerCase();
    if (subj.has(sk)) r.dupSubjects.push(`${email} = ${subj.get(sk)}`); else subj.set(sk, email);
    if (bodies.has(bk)) r.dupBodies.push(`${email} = ${bodies.get(bk)}`); else bodies.set(bk, email);
    const blockers = copyBlockers(subject, body);
    if (blockers.length) { r.blocked.push({ email, issues: blockers }); continue; }
    const warns = copyWarnings(subject, body, step);
    if (!hasOptOut(body)) warns.push('sem opt-out (será adicionado automaticamente)');
    if (warns.length) r.warnings.push({ email, issues: warns });
    const lead = q.get<{ id: number }>('SELECT id FROM leads WHERE email=?', email);
    if (!lead) { r.unmatched.push(email); continue; }
    if (opts.dryRun) { r.imported++; continue; }
    const existed = q.get('SELECT 1 FROM lead_copies WHERE lead_id=? AND step_number=?', lead.id, step);
    q.run(
      `INSERT INTO lead_copies (lead_id, step_number, subject, body, source, imported_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(lead_id, step_number) DO UPDATE SET subject=excluded.subject, body=excluded.body, source=excluded.source, imported_at=excluded.imported_at`,
      lead.id, step, subject, body, opts.source ?? null, now,
    );
    const prio = parseInt(row.prioridade ?? row.priority ?? '', 10);
    q.run('UPDATE leads SET priority=?, updated_at=? WHERE id=?', Number.isFinite(prio) ? prio : null, now, lead.id);
    existed ? r.updated++ : r.imported++;
  }
  if (!opts.dryRun) addLog({ kind: 'info', event: 'copies_import', detail: `${r.imported} novas, ${r.updated} atualizadas, ${r.unmatched.length} sem lead` });
  return r;
}
