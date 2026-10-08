import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { ParsedMail } from 'mailparser';
import { getPassword } from '../accounts/accounts.ts';
import type { Account } from '../accounts/accounts.ts';
import { chance } from '../lib/util.ts';
import { getM365Token } from './oauth.ts';
import { config } from '../config.ts';

export async function withImap<T>(a: Account, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  // Exchange Online não aceita senha em IMAP desde 2022: precisa de XOAUTH2 (accessToken)
  const auth =
    a.auth_mode === 'oauth' || a.provider === 'm365'
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
  client.on('error', () => {
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
    const lock = await c.getMailboxLock('INBOX');
    lock.release();
  });
}

const stripBrackets = (id: string) => id.replace(/^<|>$/g, '');

async function searchInbox(c: ImapFlow, messageId: string): Promise<number[]> {
  const lock = await c.getMailboxLock('INBOX');
  try {
    const r = await c.search({ header: { 'message-id': stripBrackets(messageId) } }, { uid: true });
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
export async function markWarmupMessage(a: Account, messageId: string): Promise<WarmupReadResult> {
  return withImap(a, async (c) => {
    let uids = await searchInbox(c, messageId);
    let rescued = false;

    if (!uids.length) {
      const boxes = await c.list();
      const junk = boxes.filter((b) => b.specialUse === '\\Junk' || /spam|junk|lixo/i.test(b.path));
      for (const box of junk) {
        const lock = await c.getMailboxLock(box.path);
        try {
          const found = (await c.search({ header: { 'message-id': stripBrackets(messageId) } }, { uid: true })) || [];
          if (found.length) {
            await c.messageMove(found, 'INBOX', { uid: true });
            rescued = true;
          }
        } finally {
          lock.release();
        }
        if (rescued) break;
      }
      if (rescued) uids = await searchInbox(c, messageId);
    }

    if (!uids.length) return { found: false, rescuedFromSpam: false, flagged: false };

    const lock = await c.getMailboxLock('INBOX');
    try {
      await c.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
      const flagged = chance(config.flagProbability);
      if (flagged) await c.messageFlagsAdd(uids, ['\\Flagged'], { uid: true });
      return { found: true, rescuedFromSpam: rescued, flagged };
    } finally {
      lock.release();
    }
  });
}

/** Marca uma mensagem específica por UID como lida (\Seen) e opcionalmente com estrela (\Flagged). */
export async function markMessageReadByUid(a: Account, uid: number, flag = false): Promise<void> {
  return withImap(a, async (c) => {
    const lock = await c.getMailboxLock('INBOX');
    try {
      await c.messageFlagsAdd([uid], ['\\Seen'], { uid: true });
      if (flag) await c.messageFlagsAdd([uid], ['\\Flagged'], { uid: true });
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
): Promise<{ messages: InboxMessage[]; maxUid: number }> {
  return withImap(a, async (c) => {
    const lock = await c.getMailboxLock('INBOX');
    try {
      let uids: number[];
      if (lastUid > 0) {
        uids = ((await c.search({ uid: `${lastUid + 1}:*` }, { uid: true })) || []).filter((u) => u > lastUid);
      } else {
        uids = (await c.search({ since: new Date(Date.now() - 48 * 3_600_000) }, { uid: true })) || [];
      }
      uids = uids.sort((x, y) => x - y).slice(0, max);
      const messages: InboxMessage[] = [];
      if (uids.length) {
        for await (const m of c.fetch(uids, { uid: true, source: true }, { uid: true })) {
          if (m.source) messages.push({ uid: m.uid, parsed: await simpleParser(m.source) });
        }
      }
      return { messages, maxUid: uids.length ? uids[uids.length - 1] : lastUid };
    } finally {
      lock.release();
    }
  });
}
