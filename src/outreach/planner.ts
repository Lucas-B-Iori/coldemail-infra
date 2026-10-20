import type { Account } from '../accounts/accounts.ts';
import { rollDay } from '../accounts/accounts.ts';
import { addLog, q } from '../db/index.ts';
import { nowIso, log } from '../lib/util.ts';
import { restoreLead } from './leads.ts';
import type { Lead } from './leads.ts';
import { lintEmail, renderTemplate, signature } from './templates.ts';

import { generateAdaptiveCopy } from '../llm/copyGenerator.ts';

const BACKLOG = 3; // itens prontos por caixa; o ritmo real é governado pelo dispatcher

interface Step {
  step_number: number;
  delay_days: number;
  reply_in_thread: number;
  subject_template: string;
  body_template: string;
}

/**
 * Materializa a fila (outreach_queue). Prioridade: follow-ups vencidos > leads novos.
 * Follow-ups saem da MESMA caixa do toque anterior (mantém a thread). Se a caixa foi banida,
 * o follow-up é reatribuído e abre thread nova automaticamente.
 */
export async function planQueue(): Promise<void> {
  rollDay();
  releaseOrphans();

  const accounts = q.all<Account>(
    `SELECT * FROM accounts WHERE status='active' AND sent_today < daily_limit
        AND (cooldown_until IS NULL OR cooldown_until <= ?) ORDER BY id`,
    nowIso(),
  );
  for (const acc of accounts) {
    const pending = q.get<{ n: number }>(
      `SELECT COUNT(*) n FROM outreach_queue WHERE account_id=? AND status IN ('queued','sending')`, acc.id,
    )!.n;
    let want = Math.min(acc.daily_limit - acc.sent_today - pending, BACKLOG - pending);
    if (want <= 0) continue;

    const followups = q.all<Lead>(
      `SELECT l.* FROM leads l
         JOIN sequence_steps s ON s.sequence_id = l.sequence_id AND s.step_number = l.current_step + 1
        WHERE l.status = 'sent' AND l.next_due_at <= ? AND l.needs_review IS NULL
          AND (l.assigned_account_id = ?
               OR l.assigned_account_id IS NULL
               OR l.assigned_account_id IN (SELECT id FROM accounts WHERE status='banned'))
          AND NOT EXISTS (SELECT 1 FROM outreach_queue o WHERE o.lead_id=l.id AND o.status IN ('queued','sending'))
        ORDER BY l.next_due_at LIMIT ?`,
      nowIso(), acc.id, want,
    );
    for (const lead of followups) {
      if (await enqueue(acc, lead)) want--;
    }

    if (want > 0) {
      const fresh = q.all<Lead>(
        `SELECT * FROM leads WHERE status='pending' AND sequence_id IS NOT NULL AND needs_review IS NULL ORDER BY fit_score DESC, id LIMIT ?`, want,
      );
      for (const lead of fresh) await enqueue(acc, lead);
    }
  }
}

/** Itens na fila de caixas que não estão mais ativas voltam para o pool. */
function releaseOrphans(): void {
  const rows = q.all<{ id: number; lead_id: number }>(
    `SELECT o.id, o.lead_id FROM outreach_queue o JOIN accounts a ON a.id=o.account_id
      WHERE o.status='queued'
        AND (a.status != 'active' OR (a.cooldown_until > ? AND o.step_number = 1))`,
    nowIso(),
  );
  for (const r of rows) {
    q.run(`UPDATE outreach_queue SET status='cancelled', error_log='caixa inativa' WHERE id=?`, r.id);
    restoreLead(r.lead_id);
  }
  if (rows.length) log('planner', `${rows.length} item(ns) devolvido(s) ao pool (caixa inativa)`);
}

async function enqueue(acc: Account, lead: Lead): Promise<boolean> {
  const next = lead.current_step + 1;
  const step = q.get<Step>(
    `SELECT * FROM sequence_steps WHERE sequence_id=? AND step_number=?`, lead.sequence_id, next,
  );
  if (!step) return false;

  const sameThread = !!step.reply_in_thread && lead.assigned_account_id === acc.id && !!lead.last_message_id && !!lead.thread_subject;
  const senderPerson = acc.display_name.split('|')[0].trim();

  // Gera copy adaptativa por IA ou fallback nos modelos oficiais
  const result = await generateAdaptiveCopy(lead, next, senderPerson.split(/\s+/)[0], step);
  if (!result.ok) {
    // Sem template genérico: o lead sai do fluxo automático até alguém revisar (leads review / leads clear-review)
    q.run(`UPDATE leads SET needs_review=?, updated_at=? WHERE id=?`, result.reason, nowIso(), lead.id);
    addLog({ lead_id: lead.id, account_id: acc.id, kind: 'error', event: 'needs_review', detail: result.reason, action: 'lead aguardando revisão (não enviado)' });
    log('planner', `⚠ lead #${lead.id} <${lead.email}> passo ${next} → needs_review: ${result.reason}`);
    return false;
  }
  const copy = result.copy;
  const subject = sameThread
    ? (/^re:/i.test(lead.thread_subject!) ? lead.thread_subject! : `Re: ${lead.thread_subject}`)
    : copy.subject;
  const body = copy.body;

  const problem = lintEmail(subject, body, next);
  if (problem) {
    q.run(`UPDATE leads SET status='finished', notes=?, updated_at=? WHERE id=?`, `lint: ${problem}`, nowIso(), lead.id);
    addLog({ lead_id: lead.id, account_id: acc.id, kind: 'error', event: 'lint_failed', detail: problem, action: 'lead removido da fila' });
    return false;
  }

  if (lead.assigned_account_id !== acc.id) {
    // nova caixa => nova thread
    q.run(
      `UPDATE leads SET assigned_account_id=?, thread_subject=NULL, last_message_id=NULL, thread_references=NULL WHERE id=?`,
      acc.id, lead.id,
    );
  }
  q.run(
    `INSERT INTO outreach_queue (account_id, lead_id, step_number, subject, body, scheduled_for, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    acc.id, lead.id, next, subject, body, nowIso(), nowIso(),
  );
  if (lead.status === 'pending') q.run(`UPDATE leads SET status='queued', updated_at=? WHERE id=?`, nowIso(), lead.id);
  return true;
}

