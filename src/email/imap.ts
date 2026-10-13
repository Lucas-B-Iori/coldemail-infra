import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { ParsedMail } from "mailparser";
import { getPassword } from "../accounts/accounts.ts";
import type { Account } from "../accounts/accounts.ts";
import { chance } from "../lib/util.ts";
import { getM365Token } from "./oauth.ts";
import { q } from "../db/index.ts";
import { config } from "../config.ts";
export async function withImap<T>(
  a: Account,
  fn: (c: ImapFlow) => Promise<T>,
): Promise<T> {
  // Exchange Online não aceita senha em IMAP desde 2022: precisa de XOAUTH2 (accessToken)
  const auth =
    a.auth_mode === "oauth" || a.provider === "m365"
      ? { user: a.smtp_user, accessToken: await getM365Token() }
      : { user: a.smtp_user, pass: getPassword(a) };
  const client = new ImapFlow({
    host: a.imap_host,
    port: a.imap_port,
    secure: a.imap_port === 993,
    auth,
    logger: false,
    socketTimeout: 60_000,
    greetingTimeout: 20_000,
    connectionTimeout: 20_000,
  });
  client.on("error", () => {
    /* evita crash por 'error' não tratado; a falha real sobe pelo await */
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}
export async function verifyImap(a: Account): Promise<void> {
  await withImap(a, async (c) => {
    const lock = await c.getMailboxLock("INBOX");
    lock.release();
  });
}
const stripBrackets = (id: string) => id.replace(/^<|>$/g, "");
async function searchInbox(c: ImapFlow, messageId: string): Promise<number[]> {
  const lock = await c.getMailboxLock("INBOX");
  try {
    const r = await c.search(
      { header: { "message-id": stripBrackets(messageId) } },
      { uid: true },
    );
    return r || [];
  } finally {
    lock.release();
  }
}
export interface WarmupReadResult {
  found: boolean;
  rescuedFromSpam: boolean;
  flagged: boolean;
}
/**
 * Passos do destinatário ANTES de responder uma mensagem de warm-up:
 *  1. localiza a mensagem na INBOX (se caiu no Spam/Junk, resgata para a INBOX);
 *  2. marca \Seen;
 *  3. com ~20% de chance, marca \Flagged (estrela).
 */
export async function markWarmupMessage(
  a: Account,
  messageId: string,
): Promise<WarmupReadResult> {
  return withImap(a, async (c) => {
    let uids = await searchInbox(c, messageId);
    let rescued = false;
    if (!uids.length) {
      const boxes = await c.list();
      const junk = boxes.filter(
        (b) => b.specialUse === "\\Junk" || /spam|junk|lixo/i.test(b.path),
      );
      for (const box of junk) {
        const lock = await c.getMailboxLock(box.path);
        try {
          const found =
            (await c.search(
              { header: { "message-id": stripBrackets(messageId) } },
              { uid: true },
            )) || [];
          if (found.length) {
            await c.messageMove(found, "INBOX", { uid: true });
            rescued = true;
          }
        } finally {
          lock.release();
        }
        if (rescued) break;
      }
      if (rescued) uids = await searchInbox(c, messageId);
    }
    if (!uids.length)
      return { found: false, rescuedFromSpam: false, flagged: false };
    const lock = await c.getMailboxLock("INBOX");
    try {
      await c.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
      const flagged = chance(config.flagProbability);
      if (flagged) await c.messageFlagsAdd(uids, ["\\Flagged"], { uid: true });
      return { found: true, rescuedFromSpam: rescued, flagged };
    } finally {
      lock.release();
    }
  });
}
export interface InboxMessage {
  uid: number;
  parsed: ParsedMail;
}
/**
 * Lê mensagens novas da INBOX (UID > lastUid). Na primeira leitura (lastUid = 0)
 * olha apenas as últimas 48h para não varrer a caixa inteira.
 */
export async function fetchNewMessages(
  a: Account,
  lastUid: number,
  max = 200,
): Promise<{
  messages: InboxMessage[];
  maxUid: number;
  cursors: { mailbox: string; uidValidity: string; lastUid: number }[];
}> {
  return withImap(a, async (c) => {
    const boxes = await c.list();
    const paths = [
      "INBOX",
      ...boxes
        .filter(
          (b) => b.specialUse === "\\Junk" || /spam|junk|lixo/i.test(b.path),
        )
        .map((b) => b.path),
    ];
    const messages: InboxMessage[] = [];
    let maxUid = lastUid;
    const cursors: { mailbox: string; uidValidity: string; lastUid: number }[] =
      [];
    for (const path of [...new Set(paths)]) {
      const lock = await c.getMailboxLock(path);
      try {
        const validity = c.mailbox ? String(c.mailbox.uidValidity) : "unknown";
        const cursor = q.get<{ uid_validity: string; last_uid: number }>(
          `SELECT * FROM imap_cursors WHERE account_id=? AND mailbox=?`,
          a.id,
          path,
        );
        const previous =
          cursor?.uid_validity === validity ? cursor.last_uid : 0;
        let uids = (
          (await c.search(
            previous > 0
              ? { uid: `${previous + 1}:*` }
              : cursor
                ? { uid: "1:*" }
                : { since: new Date(Date.now() - 48 * 3600000) },
            { uid: true },
          )) || []
        )
          .filter((u) => u > previous)
          .sort((x, y) => x - y)
          .slice(0, max);
        let consumed = previous;
        const pending = new Set(uids);
        if (uids.length)
          for await (const m of c.fetch(
            uids,
            { uid: true, source: true },
            { uid: true },
          )) {
            // Servers may interleave unsolicited FLAGS-only FETCH notifications.
            // Drain those updates; only complete requested UID bodies count as fetched.
            if (!pending.has(m.uid) || !Buffer.isBuffer(m.source)) continue;
            messages.push({ uid: m.uid, parsed: await simpleParser(m.source) });
            pending.delete(m.uid);
            consumed = Math.max(consumed, m.uid);
          }
        // An incomplete requested message must remain retryable on the next poll.
        // Throw before returning any mailbox cursor so higher UIDs cannot hide a gap.
        if (pending.size)
          throw new Error(
            `IMAP source missing after FETCH: ${path}; requested UIDs: ${[...pending].join(",")}`,
          );
        cursors.push({
          mailbox: path,
          uidValidity: validity,
          lastUid: consumed,
        });
        if (path === "INBOX") maxUid = consumed;
      } finally {
        lock.release();
      }
    }
    return { messages, maxUid, cursors };
  });
}
