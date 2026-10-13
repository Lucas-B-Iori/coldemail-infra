import {
  clearAccountErrors,
  getAccount,
  limitBounces,
  recordAccountError,
  rollDay,
  coldEligible,
} from "../accounts/accounts.ts";
import type { Account } from "../accounts/accounts.ts";
import { addLog, q, tx } from "../db/index.ts";
import { classifySendError, makeMessageId, sendMail } from "../email/smtp.ts";
import { config } from "../config.ts";
import {
  addMs,
  errMsg,
  inWindow,
  isWeekday,
  log,
  msLeftInWindow,
  nowIso,
  pLimit,
  randInt,
  tryLock,
  unlock,
} from "../lib/util.ts";
import { restoreLead } from "./leads.ts";
import type { Lead } from "./leads.ts";
import { planQueue } from "./planner.ts";
interface QueueRow {
  id: number;
  account_id: number;
  lead_id: number;
  step_number: number;
  subject: string;
  body: string;
  attempts: number;
}
const limit = pLimit(config.concurrency);
/**
 * Tick do dispatcher (roda a cada ~20s). Cada caixa tem seu próprio relógio (`next_send_at`):
 * todas as caixas operam em paralelo, mas cada uma respeita seu intervalo de 7-9 min ±90s.
 */
export async function tickDispatch(): Promise<void> {
  rollDay();
  if (!inWindow(config.sendWindow) || (config.weekdaysOnly && !isWeekday()))
    return;
  await planQueue();
  // Escalona a primeira mensagem do dia (evita 8 caixas disparando juntas às 08:00)
  const fresh = q.all<Account>(
    `SELECT * FROM accounts WHERE status='active' AND warmup_only=0 AND provider!='gmail' AND next_send_at IS NULL`,
  );
  for (const a of fresh) {
    q.run(
      `UPDATE accounts SET next_send_at=? WHERE id=?`,
      addMs(randInt(5_000, config.coldIntervalMs.max)),
      a.id,
    );
  }
  const now = nowIso();
  const ready = q.all<Account>(
    `SELECT a.* FROM accounts a
      WHERE a.status='active' AND a.warmup_only=0 AND a.provider!='gmail' AND a.sent_today < a.daily_limit AND a.next_send_at <= ?
        AND (a.cooldown_until IS NULL OR a.cooldown_until <= ?)
        AND EXISTS (SELECT 1 FROM outreach_queue o WHERE o.account_id=a.id AND o.status='queued' AND o.scheduled_for <= ?)`,
    now,
    now,
    now,
  );
  await Promise.allSettled(ready.map((a) => limit(() => sendNext(a))));
}
/** Próximo intervalo: distribui o que resta da cota pelo que resta da janela, com piso e jitter. */
function nextInterval(a: Account): number {
  const remaining = Math.max(1, a.daily_limit - a.sent_today);
  const base = msLeftInWindow(config.sendWindow) / remaining;
  const { min, max, jitter } = config.coldIntervalMs;
  const target = Math.min(Math.max(base, min * 0.4), max * 1.5);
  return Math.max(3 * 60_000, target + randInt(-jitter, jitter));
}
async function sendNext(acc: Account): Promise<void> {
  const key = `acc:${acc.id}`;
  if (!tryLock(key)) return;
  let row: QueueRow | undefined;
  try {
    const fresh = getAccount(acc.id);
    if (
      !fresh ||
      !coldEligible(fresh) ||
      (fresh.cooldown_until && fresh.cooldown_until > nowIso()) ||
      fresh.sent_today >= fresh.daily_limit
    )
      return;
    acc = fresh;
    row = q.get<QueueRow>(
      `SELECT * FROM outreach_queue WHERE account_id=? AND status='queued' AND scheduled_for<=? ORDER BY id LIMIT 1`,
      acc.id,
      nowIso(),
    );
    if (!row) return;
    // claim atômico
    if (
      !q.run(
        `UPDATE outreach_queue SET status='sending', attempts=attempts+1 WHERE id=? AND status='queued'`,
        row.id,
      ).changes
    )
      return;
    // Revalida o lead no último instante (resposta/bounce pode ter chegado depois do planejamento)
    const lead = q.get<Lead>("SELECT * FROM leads WHERE id=?", row.lead_id)!;
    if (!["queued", "sent"].includes(lead.status)) {
      q.run(
        `UPDATE outreach_queue SET status='cancelled', error_log=? WHERE id=?`,
        `lead ${lead.status}`,
        row.id,
      );
      return;
    }
    const threaded =
      /^re:/i.test(row.subject) &&
      lead.assigned_account_id === acc.id &&
      !!lead.last_message_id;
    const messageId = makeMessageId(acc);
    q.run(
      `UPDATE outreach_queue SET message_id=? WHERE id=?`,
      messageId,
      row.id,
    );
    await sendMail(acc, {
      to: lead.email,
      subject: row.subject,
      text: row.body,
      messageId,
      inReplyTo: threaded ? lead.last_message_id! : undefined,
      references: threaded
        ? (lead.thread_references ?? lead.last_message_id!)
        : undefined,
    });
    onSent(acc, lead, row, messageId, threaded);
    log(
      "dispatch",
      `${acc.email} -> ${lead.email} | passo ${row.step_number} | ${acc.sent_today + 1}/${acc.daily_limit}`,
    );
  } catch (e) {
    if (row) onFailed(acc, row, e);
    else log("dispatch", `ERRO ${acc.email}: ${errMsg(e)}`);
  } finally {
    unlock(key);
  }
}
function onSent(
  acc: Account,
  lead: Lead,
  row: QueueRow,
  messageId: string,
  threaded: boolean,
): void {
  tx(() => {
    const now = nowIso();
    q.run(
      `UPDATE outreach_queue SET status='sent', sent_at=?, message_id=? WHERE id=?`,
      now,
      messageId,
      row.id,
    );
    const done = acc.sent_today + 1;
    q.run(
      `UPDATE accounts SET sent_today=?, last_sent_at=?, next_send_at=? WHERE id=?`,
      done,
      now,
      addMs(nextInterval({ ...acc, sent_today: done })),
      acc.id,
    );
    clearAccountErrors(acc.id);
    const nextStep = q.get<{ delay_days: number }>(
      `SELECT delay_days FROM sequence_steps WHERE sequence_id=? AND step_number=?`,
      lead.sequence_id,
      row.step_number + 1,
    );
    // vencimento do próximo passo: delay em dias + 0-4h para não formar "ondas" no mesmo horário
    const due = nextStep
      ? addMs(nextStep.delay_days * 86_400_000 + randInt(0, 4 * 3_600_000))
      : null;
    const refs = threaded
      ? `${lead.thread_references ?? lead.last_message_id} ${messageId}`
      : messageId;
    q.run(
      `UPDATE leads SET status=CASE WHEN status IN ('queued','sent') AND replied_at IS NULL THEN ? ELSE status END, current_step=?, assigned_account_id=?, thread_subject=?, last_message_id=?,
        thread_references=?, last_contacted_at=?, next_due_at=CASE WHEN status IN ('queued','sent') AND replied_at IS NULL THEN ? ELSE NULL END, updated_at=? WHERE id=?`,
      nextStep ? "sent" : "finished",
      row.step_number,
      acc.id,
      threaded ? lead.thread_subject : row.subject,
      messageId,
      refs,
      now,
      due,
      now,
      lead.id,
    );
  });
}
function onFailed(acc: Account, row: QueueRow, e: unknown): void {
  const { kind, message } = classifySendError(e);
  log("dispatch", `FALHA ${acc.email} (${kind}): ${message.slice(0, 150)}`);
  const smtp = e as { responseCode?: number; command?: string; code?: string };
  // A timeout/reset or unclassified error may happen after SMTP accepted DATA.
  if (
    kind === "unknown" ||
    (!smtp.responseCode &&
      !["EAUTH", "ECONNREFUSED", "EDNS", "ENOTFOUND"].includes(
        smtp.code ?? "",
      ) &&
      !["CONN", "AUTH"].includes(smtp.command ?? ""))
  ) {
    tx(() => {
      q.run(
        `UPDATE outreach_queue SET status='failed',error_log=? WHERE id=?`,
        `delivery_uncertain: ${message}`,
        row.id,
      );
      q.run(
        `UPDATE leads SET status='finished',next_due_at=NULL,notes=? WHERE id=? AND status IN ('queued','sent')`,
        `delivery_uncertain: reconciliação manual necessária (${row.id})`,
        row.lead_id,
      );
      addLog({
        account_id: acc.id,
        lead_id: row.lead_id,
        queue_id: row.id,
        kind: "error",
        event: "delivery_uncertain",
        detail: message,
        action: "reenvio automático bloqueado; reconciliar Message-ID",
      });
    });
    recordAccountError(getAccount(acc.id) ?? acc, kind, message);
    return;
  }
  if (kind === "recipient") {
    q.run(
      `UPDATE outreach_queue SET status='failed', error_log=? WHERE id=?`,
      message,
      row.id,
    );
    q.run(
      `UPDATE leads SET status='bounced', notes=?, updated_at=? WHERE id=? AND status IN ('queued','sent')`,
      `rejeitado no SMTP: ${message.slice(0, 200)}`,
      nowIso(),
      row.lead_id,
    );
    q.run(
      `UPDATE accounts SET bounces_today=bounces_today+1 WHERE id=?`,
      acc.id,
    );
    addLog({
      account_id: acc.id,
      lead_id: row.lead_id,
      queue_id: row.id,
      kind: "hard",
      event: "smtp_reject",
      detail: message,
      action: "lead marcado como bounced",
    });
    limitBounces(acc);
    return;
  }
  recordAccountError(getAccount(acc.id) ?? acc, kind, message);
  if (
    kind === "auth" ||
    kind === "quota" ||
    kind === "throttle" ||
    row.attempts + 1 >= 3
  ) {
    q.run(
      `UPDATE outreach_queue SET status='${row.attempts + 1 >= 3 && kind !== "throttle" ? "failed" : "cancelled"}', error_log=? WHERE id=?`,
      message,
      row.id,
    );
    restoreLead(row.lead_id); // lead novo volta ao pool e outra caixa saudável o pega
  } else {
    q.run(
      `UPDATE outreach_queue SET status='queued', scheduled_for=?, error_log=? WHERE id=?`,
      addMs(10 * 60_000),
      message,
      row.id,
    );
  }
  q.run(
    `UPDATE accounts SET next_send_at=? WHERE id=?`,
    addMs(5 * 60_000),
    acc.id,
  );
}
