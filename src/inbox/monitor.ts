import { createHash } from "node:crypto";
import {
  getAccount,
  limitBounces,
  recordAccountError,
} from "../accounts/accounts.ts";
import type { Account } from "../accounts/accounts.ts";
import { addLog, q, tx } from "../db/index.ts";
import { fetchNewMessages } from "../email/imap.ts";
import { cancelQueuedForLead } from "../outreach/leads.ts";
import type { Lead } from "../outreach/leads.ts";
import { config } from "../config.ts";
import {
  addMs,
  errMsg,
  log,
  nowIso,
  pLimit,
  tryLock,
  unlock,
} from "../lib/util.ts";
import { isAutoReply, isUnsubscribe, parseBounce, replyText } from "./parse.ts";
import type { InboxMessage } from "../email/imap.ts";
import { classifyLeadReply } from "../llm/copyGenerator.ts";
const POLL_EVERY_MS = 4 * 60_000;
const limit = pLimit(Math.max(2, Math.floor(config.concurrency / 2)));
/** Varre a INBOX das caixas (a cada ~4 min por caixa) atrás de bounces e respostas de leads. */
export async function tickInbox(): Promise<void> {
  const due = q.all<Account>(
    `SELECT * FROM accounts WHERE status IN ('warming','active') AND warmup_only=0 AND provider!='gmail' AND (imap_last_poll_at IS NULL OR imap_last_poll_at <= ?)`,
    addMs(-POLL_EVERY_MS),
  );
  await Promise.allSettled(due.map((a) => limit(() => pollAccount(a))));
}
export async function pollAccount(
  a: Account,
): Promise<{ bounces: number; replies: number }> {
  if (
    a.warmup_only ||
    a.provider === "gmail" ||
    ["paused", "banned"].includes(a.status)
  )
    return { bounces: 0, replies: 0 };
  const key = `imap:${a.id}`;
  if (!tryLock(key)) return { bounces: 0, replies: 0 };
  let bounces = 0,
    replies = 0;
  try {
    const { messages, maxUid, cursors } = await fetchNewMessages(
      a,
      a.imap_last_uid,
    );
    const fleet = new Set(
      q
        .all<{ email: string }>("SELECT email FROM accounts")
        .map((r) => r.email.toLowerCase()),
    );
    for (const m of messages) {
      const messageKey = inboxMessageKey(m);
      if (
        q.get(
          "SELECT 1 FROM processed_inbox_messages WHERE account_id=? AND message_key=?",
          a.id,
          messageKey,
        )
      )
        continue;
      const r = await handleMessage(a, m, fleet);
      q.run(
        "INSERT OR IGNORE INTO processed_inbox_messages(account_id,message_key,processed_at) VALUES(?,?,?)",
        a.id,
        messageKey,
        nowIso(),
      );
      if (r === "bounce") bounces++;
      if (r === "reply") replies++;
    }
    tx(() => {
      for (const c of cursors)
        q.run(
          `INSERT INTO imap_cursors(account_id,mailbox,uid_validity,last_uid) VALUES(?,?,?,?) ON CONFLICT(account_id,mailbox) DO UPDATE SET uid_validity=excluded.uid_validity,last_uid=excluded.last_uid`,
          a.id,
          c.mailbox,
          c.uidValidity,
          c.lastUid,
        );
      q.run(
        `UPDATE accounts SET imap_last_uid=?, imap_last_poll_at=? WHERE id=?`,
        maxUid,
        nowIso(),
        a.id,
      );
    });
    if (bounces || replies)
      log("inbox", `${a.email}: ${bounces} bounce(s), ${replies} resposta(s)`);
  } catch (e) {
    const msg = errMsg(e);
    q.run(`UPDATE accounts SET imap_last_poll_at=? WHERE id=?`, nowIso(), a.id);
    log("inbox", `ERRO IMAP ${a.email}: ${msg}`);
    const auth =
      /AUTHENTICATIONFAILED|invalid credentials|login failed|authentication failed/i.test(
        msg,
      );
    recordAccountError(
      getAccount(a.id) ?? a,
      auth ? "auth" : "temp",
      `IMAP: ${msg}`,
    );
  } finally {
    unlock(key);
  }
  return { bounces, replies };
}
async function handleMessage(
  acc: Account,
  m: InboxMessage,
  fleet: Set<string>,
): Promise<"bounce" | "reply" | "ignored"> {
  const p = m.parsed;
  const from = (p.from?.value?.[0]?.address ?? "").toLowerCase();
  // 1) Bounce / DSN
  const b = parseBounce(p, fleet);
  if (b.isBounce) {
    // ignora DSNs de warm-up entre caixas da própria frota
    if (b.recipients.length && b.recipients.every((r) => fleet.has(r)))
      return "ignored";
    registerBounce(acc, b);
    return "bounce";
  }
  // 2) Mensagens entre caixas da frota (warm-up) nunca são resposta de lead
  if (fleet.has(from)) return "ignored";
  // 3) Resposta de lead
  const refs = [
    p.inReplyTo,
    ...(Array.isArray(p.references)
      ? p.references
      : p.references
        ? [p.references]
        : []),
  ].filter(Boolean) as string[];
  let lead: Lead | undefined;
  if (refs.length) {
    lead = q.get<Lead>(
      `SELECT l.* FROM outreach_queue o JOIN leads l ON l.id=o.lead_id
        WHERE o.account_id=? AND o.message_id IN (${refs.map(() => "?").join(",")}) LIMIT 1`,
      acc.id,
      ...refs,
    );
  }
  lead ??= q.get<Lead>(
    "SELECT * FROM leads WHERE email=? AND assigned_account_id=? AND current_step>0",
    from,
    acc.id,
  );
  if (!lead) return "ignored";
  if (isAutoReply(p)) {
    addLog({
      account_id: acc.id,
      lead_id: lead.id,
      kind: "info",
      event: "auto_reply_ignored",
      detail: p.subject,
    });
    return "ignored";
  }
  if (["bounced", "unsubscribed"].includes(lead.status)) return "ignored";
  const text = replyText(p);
  const unsub = isUnsubscribe(text);
  let status = unsub ? "unsubscribed" : "replied";
  const receivedAt = nowIso();
  tx(() => {
    q.run(
      `UPDATE leads SET status=?,replied_at=?,last_reply_snippet=?,next_due_at=NULL,updated_at=? WHERE id=?`,
      status,
      receivedAt,
      text.slice(0, 500),
      receivedAt,
      lead!.id,
    );
    cancelQueuedForLead(lead!.id, `lead ${status}`);
  });
  let replyIntent: string | null = null;
  let suggested = "";
  if (!unsub) {
    const classification = await classifyLeadReply(
      text,
      lead.name,
      lead.firm_name,
    );
    replyIntent = classification.intent;
    suggested = `[Copiloto IA]: ${classification.suggestedReply}`;
    if (replyIntent === "sem_interesse") {
      status = "unsubscribed";
    }
  }
  q.run(
    `UPDATE leads SET status=?, replied_at=?, last_reply_snippet=?, reply_intent=?, notes=COALESCE(?, notes), next_due_at=NULL, updated_at=? WHERE id=? AND replied_at=? AND status IN ('replied','unsubscribed')`,
    status,
    receivedAt,
    text.slice(0, 500),
    replyIntent,
    suggested || null,
    nowIso(),
    lead.id,
    receivedAt,
  );
  addLog({
    account_id: acc.id,
    lead_id: lead.id,
    kind: "info",
    event: unsub || replyIntent === "sem_interesse" ? "unsubscribe" : "reply",
    detail: `[${replyIntent || "opt-out"}] ${text.slice(0, 250)}`,
    action: suggested
      ? `Copiloto sugeriu resposta (${replyIntent})`
      : "follow-ups cancelados",
  });
  return "reply";
}
function registerBounce(acc: Account, b: ReturnType<typeof parseBounce>): void {
  q.run(`UPDATE accounts SET bounces_today=bounces_today+1 WHERE id=?`, acc.id);
  let matched = false;
  for (const email of b.recipients) {
    const lead = q.get<Lead>(
      "SELECT * FROM leads WHERE email=? AND assigned_account_id=? AND current_step>0",
      email,
      acc.id,
    );
    if (!lead) continue;
    matched = true;
    let action = "apenas registrado (soft)";
    if (b.type === "hard") {
      cancelQueuedForLead(lead.id, "bounce hard");
      q.run(
        `UPDATE leads SET status='bounced', next_due_at=NULL, notes=?, updated_at=? WHERE id=?`,
        b.reason.slice(0, 200),
        nowIso(),
        lead.id,
      );
      action = "lead marcado como bounced e removido da cadência";
    }
    addLog({
      account_id: acc.id,
      lead_id: lead.id,
      kind: b.type,
      event: "bounce",
      detail: `${b.status ?? ""} ${b.reason}`,
      action,
    });
  }
  if (!matched)
    addLog({
      account_id: acc.id,
      kind: b.type,
      event: "bounce_unmatched",
      detail: `${b.recipients.join(",")} ${b.reason}`,
    });
  limitBounces(acc); // circuit breaker: > MAX_BOUNCES_PER_DAY pausa a caixa
}
function inboxMessageKey(message: InboxMessage): string {
  const mail = message.parsed;
  if (mail.messageId?.trim()) return `id:${mail.messageId.trim()}`;
  const stableContent = JSON.stringify({
    from: mail.from?.text,
    to: mail.to,
    subject: mail.subject,
    date: mail.date?.toISOString(),
    inReplyTo: mail.inReplyTo,
    references: mail.references,
    text: mail.text,
    html: mail.html,
    attachments: mail.attachments?.map((a) => ({
      type: a.contentType,
      content: a.content.toString("base64"),
    })),
  });
  return `sha256:${createHash("sha256").update(stableContent).digest("hex")}`;
}
