import { q } from '../db/index.ts';
import { config } from '../config.ts';

/**
 * Unicidade de copy: shingles de 3 palavras + similaridade de Jaccard.
 * Antes de comparar, os dados do lead (nome do negócio, contato, cidade, bairro, segmento) viram marcadores,
 * para que dois e-mails com a MESMA estrutura e só o nome trocado sejam detectados como repetidos.
 */
export function normalizeCore(text: string, leadTokens: (string | null | undefined)[]): string {
  let t = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const toks = leadTokens
    .filter((x): x is string => !!x && x.trim().length >= 3)
    .map((x) => x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim())
    .sort((a, b) => b.length - a.length);
  for (const tok of toks) t = t.split(tok).join(' _x_ ');
  return t.replace(/[^a-z0-9_\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function shingles(core: string, n = 3): Set<string> {
  const w = core.split(' ').filter(Boolean);
  const out = new Set<string>();
  if (w.length < n) { if (w.length) out.add(w.join(' ')); return out; }
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Maior similaridade do candidato contra as últimas N copies (todos os passos) e contra `extra` (tentativas da rodada). */
export function maxSimilarity(
  core: string,
  extra: string[] = [],
  self?: { leadId: number; step: number },
): { score: number; againstId: number | null } {
  const cand = shingles(core);
  let best = 0;
  let againstId: number | null = null;
  const rows = q.all<{ id: number; core: string }>(
    // ignora copies do PRÓPRIO lead/passo (regeneração após falha de enfileiramento não conta como repetição)
    `SELECT id, core FROM generated_copies WHERE NOT (lead_id = ? AND step_number = ?) ORDER BY id DESC LIMIT ?`,
    self?.leadId ?? -1, self?.step ?? -1, config.uniq.compareLast,
  );
  for (const r of rows) {
    const s = jaccard(cand, shingles(r.core));
    if (s > best) { best = s; againstId = r.id; }
  }
  for (const e of extra) {
    const s = jaccard(cand, shingles(e));
    if (s > best) { best = s; againstId = null; }
  }
  return { score: best, againstId };
}

export function recordCopy(leadId: number, step: number, subject: string, core: string, score: number): void {
  q.run(
    `INSERT INTO generated_copies (lead_id, step_number, subject, core, max_jaccard, created_at) VALUES (?,?,?,?,?,?)`,
    leadId, step, subject, core, score, new Date().toISOString(),
  );
}
