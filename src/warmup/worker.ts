import { classifySendError, makeMessageId, sendMail } from '../email/smtp.ts';
import { markWarmupMessage } from '../email/imap.ts';
import { clearAccountErrors, getAccount, isCoolingDown, recordAccountError, rollDay } from '../accounts/accounts.ts';
import type { Account } from '../accounts/accounts.ts';
import { addLog, q } from '../db/index.ts';
import { newWarmupEmail, replyWarmupEmail } from '../llm/warmupPrompts.ts';
import { config } from '../config.ts';
import {
  addMs, errMsg, inWindow, log, msLeftInWindow, nowIso, pLimit, randFloat, randInt, tryLock, unlock,
} from '../lib/util.ts';

interface Thread {
  id: number;
  initiator_id: number;
  peer_id: number;
  subject: string;
  turns: number;
  max_turns: number;
  next_actor_id: number | null;
  retry_count: number;
}
interface WMsg {
  id: number;
  message_id: string;
  from_account_id: number;
  to_account_id: number;
  body: string;
  sent_at: string;
}

const limit = pLimit(config.concurrency);
const firstName = (a: Account) => a.display_name.split(/\s+/)[0];
const signoff = (body: string) => body.trim();

/** Um tick do warm-up: inicia conversas novas e responde as que venceram o jitter. */
export async function tickWarmup(): Promise<void> {
  rollDay();
  if (!inWindow(config.warmupWindow)) return;
  await Promise.allSettled([startConversations(), answerDueThreads()]);
}

// ---------------------------------------------------------------------------
// 1) Novas conversas
// ---------------------------------------------------------------------------
async function startConversations(): Promise<void> {
  const candidates = q.all<Account>(
    `SELECT a.* FROM accounts a
      WHERE a.status IN ('warming','active')
        AND (a.next_warmup_at IS NULL OR a.next_warmup_at <= ?)
        AND (a.cooldown_until IS NULL OR a.cooldown_until <= ?)
        AND a.warmup_sent_today
            + (SELECT COUNT(*) FROM warmup_threads t WHERE t.status='open' AND t.next_actor_id = a.id)
            < a.warmup_target_today`,
    nowIso(), nowIso(),
  );
  await Promise.allSettled(candidates.map((a) => limit(() => initiate(a))));
}

async function initiate(a: Account): Promise<void> {
  const key = `acc:${a.id}`;
  if (!tryLock(key)) return;
  try {
    const peers = q.all<Account>(
      `SELECT * FROM accounts WHERE status IN ('warming','active') AND id != ?`, a.id,
    );
    if (!peers.length) return;
    const peer = peers[randInt(0, peers.length - 1)];

    const draft = await newWarmupEmail({ name: firstName(a) }, { name: firstName(peer) });
    const messageId = makeMessageId(a);
    await sendMail(a, { to: peer.email, subject: draft.subject, text: signoff(draft.body), messageId });

    const now = nowIso();
    const maxTurns = randInt(2, 4);
    const t = q.run(
      `INSERT INTO warmup_threads (initiator_id, peer_id, subject, turns, max_turns, next_actor_id, reply_due_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      a.id, peer.id, draft.subject, 1, maxTurns, peer.id,
      addMs(randInt(config.replyDelayMs.min, config.replyDelayMs.max)), now, now,
    );
    q.run(
      `INSERT INTO warmup_messages (thread_id, message_id, from_account_id, to_account_id, subject, body, sent_at)
       VALUES (?,?,?,?,?,?,?)`,
      t.id, messageId, a.id, peer.id, draft.subject, draft.body, now,
    );
    bumpWarmupCounters(a);
    clearAccountErrors(a.id);
    log('warmup', `${a.email} -> ${peer.email} | "${draft.subject}"`);
  } catch (e) {
    handleFailure(a, e);
  } finally {
    unlock(key);
  }
}

/** Contabiliza o envio e espalha os próximos pelo resto da janela, com jitter. */
function bumpWarmupCounters(a: Account): void {
  const f = getAccount(a.id)!;
  const done = f.warmup_sent_today + 1;
  const owed = q.get<{ n: number }>(
    `SELECT COUNT(*) n FROM warmup_threads WHERE status='open' AND next_actor_id=?`, a.id,
  )!.n;
  const remaining = Math.max(1, f.warmup_target_today - done - owed);
  const spacing = (msLeftInWindow(config.warmupWindow) / remaining) * randFloat(0.5, 1.4);
  q.run(
    `UPDATE accounts SET warmup_sent_today=?, last_sent_at=?, next_warmup_at=? WHERE id=?`,
    done, nowIso(), addMs(Math.max(120_000, spacing)), a.id,
  );
}

function handleFailure(a: Account, e: unknown): void {
  const { kind, message } = classifySendError(e);
  const msg = kind === 'unknown' ? errMsg(e) : message;
  log('warmup', `ERRO ${a.email}: ${msg}`);
  recordAccountError(getAccount(a.id) ?? a, kind, msg);
  q.run(`UPDATE accounts SET next_warmup_at=? WHERE id=?`, addMs(10 * 60_000), a.id);
}

// ---------------------------------------------------------------------------
// 2) Respostas (leitura IMAP -> \Seen/\Flagged -> resposta com headers RFC)
// ---------------------------------------------------------------------------
async function answerDueThreads(): Promise<void> {
  const due = q.all<Thread>(
    `SELECT * FROM warmup_threads WHERE status='open' AND reply_due_at <= ? ORDER BY reply_due_at LIMIT 100`,
    nowIso(),
  );
  await Promise.allSettled(due.map((t) => limit(() => respond(t))));
}

function closeThread(id: number): void {
  q.run(`UPDATE warmup_threads SET status='closed', next_actor_id=NULL, reply_due_at=NULL, updated_at=? WHERE id=?`, nowIso(), id);
}

function postpone(t: Thread, minutes: number): void {
  q.run(
    `UPDATE warmup_threads SET reply_due_at=?, retry_count=retry_count+1, updated_at=? WHERE id=?`,
    addMs(minutes * 60_000), nowIso(), t.id,
  );
}

async function respond(t: Thread): Promise<void> {
  const actor = t.next_actor_id ? getAccount(t.next_actor_id) : undefined;
  if (!actor || !['warming', 'active'].includes(actor.status)) return closeThread(t.id);
  if (isCoolingDown(actor)) return; // resposta espera o fim do cooldown da caixa

  const key = `acc:${actor.id}`;
  if (!tryLock(key)) return; // caixa ocupada, tenta no próximo tick
  try {
    const msgs = q.all<WMsg>(`SELECT * FROM warmup_messages WHERE thread_id=? ORDER BY id`, t.id);
    const last = msgs[msgs.length - 1];
    const other = getAccount(last.from_account_id)!;

    // --- Ações no IMAP do destinatário: localizar, ler (\Seen) e talvez favoritar (\Flagged)
    let read;
    try {
      read = await markWarmupMessage(actor, last.message_id);
    } catch (e) {
      log('warmup', `IMAP falhou em ${actor.email}: ${errMsg(e)}`);
      recordAccountError(actor, classifySendError(e).kind === 'auth' ? 'auth' : 'temp', errMsg(e));
      if (t.retry_count >= 4) closeThread(t.id);
      else postpone(t, 6);
      return;
    }
    if (!read.found) {
      const ageMin = (Date.now() - Date.parse(last.sent_at)) / 60_000;
      if (t.retry_count < 3 && ageMin < 90) return postpone(t, 5); // ainda não chegou; espera
      q.run(`UPDATE warmup_messages SET imap_status='not_found' WHERE id=?`, last.id);
      addLog({ account_id: actor.id, kind: 'info', event: 'warmup_not_found', detail: last.message_id });
    } else {
      q.run(
        `UPDATE warmup_messages SET imap_status='read', flagged=?, rescued_from_spam=?, read_at=? WHERE id=?`,
        read.flagged ? 1 : 0, read.rescuedFromSpam ? 1 : 0, nowIso(), last.id,
      );
      if (read.rescuedFromSpam) addLog({ account_id: actor.id, kind: 'info', event: 'warmup_rescued_from_spam', detail: last.message_id });
    }

    // --- Gera e envia a resposta com cabeçalhos de continuidade
    const names = new Map<number, string>([[actor.id, firstName(actor)], [other.id, firstName(other)]]);
    const isLast = t.turns + 1 >= t.max_turns;
    const draft = await replyWarmupEmail(
      { name: firstName(actor) },
      { name: firstName(other) },
      msgs.map((m) => ({ from: names.get(m.from_account_id) ?? 'Colega', body: m.body })),
      isLast,
    );

    const subject = /^re:/i.test(t.subject) ? t.subject : `Re: ${t.subject}`;
    const messageId = makeMessageId(actor);
    await sendMail(actor, {
      to: other.email,
      subject,
      text: signoff(draft.body),
      messageId,
      inReplyTo: last.message_id,
      references: msgs.map((m) => m.message_id).join(' '), // cadeia completa (RFC 5322)
    });

    const now = nowIso();
    q.run(
      `INSERT INTO warmup_messages (thread_id, message_id, in_reply_to, from_account_id, to_account_id, subject, body, sent_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      t.id, messageId, last.message_id, actor.id, other.id, subject, draft.body, now,
    );
    q.run(`UPDATE accounts SET warmup_sent_today=warmup_sent_today+1, last_sent_at=? WHERE id=?`, now, actor.id);
    clearAccountErrors(actor.id);

    if (isLast) closeThread(t.id);
    else {
      q.run(
        `UPDATE warmup_threads SET turns=turns+1, next_actor_id=?, reply_due_at=?, retry_count=0, updated_at=? WHERE id=?`,
        other.id, addMs(randInt(config.replyDelayMs.min, config.replyDelayMs.max)), now, t.id,
      );
    }
    log('warmup', `${actor.email} respondeu ${other.email} | ${subject}${read.flagged ? ' ★' : ''}`);
  } catch (e) {
    log('warmup', `ERRO resposta thread ${t.id}: ${errMsg(e)}`);
    const { kind, message } = classifySendError(e);
    if (kind === 'auth' || kind === 'quota') recordAccountError(actor, kind, message);
    if (t.retry_count >= 4) closeThread(t.id);
    else postpone(t, 8);
  } finally {
    unlock(key);
  }
}
