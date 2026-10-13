import test from "node:test";

import assert from "node:assert/strict";

import { DatabaseSync } from "node:sqlite";

import { mkdtempSync, readFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import nodemailer from "nodemailer";

import { ImapFlow } from "imapflow";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "cold-core-")),
  "test.db",
);

process.env.ENCRYPTION_KEY = "a".repeat(64);

process.env.LLM_API_KEY = "isolated";

for (const k of ["WARMUP_WINDOW_START", "SEND_WINDOW_START"])
  process.env[k] = "0";

for (const k of ["WARMUP_WINDOW_END", "SEND_WINDOW_END"]) process.env[k] = "24";

process.env.SEND_WEEKDAYS_ONLY = "false";

const seed = new DatabaseSync(process.env.DB_PATH);

seed.exec(
  readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8"),
);

for (let i = 1; i <= 2; i++)
  seed
    .prepare(
      `INSERT INTO accounts(email,display_name,provider,smtp_host,smtp_port,smtp_user,smtp_pass,imap_host,warmup_started_at,created_at) VALUES(?, 'Lucas','other','invalid',587,?,'unused','invalid','2000-01-01',?)`,
    )
    .run(
      `test${i}@example.invalid`,
      `test${i}@example.invalid`,
      new Date().toISOString(),
    );

seed.close();

const { q, db } = await import("../src/db/index.ts");

const { rollDay, getAccount, resumeAccount, recordAccountError } = await import(
  "../src/accounts/accounts.ts"
);

const { encrypt } = await import("../src/lib/crypto.ts");

q.run("UPDATE accounts SET smtp_pass=?", encrypt("test"));

let sends = 0,
  smtpAction = async () => {};

nodemailer.createTransport = () => ({
  sendMail: async (o) => {
    sends++;
    await smtpAction(o);
    return {};
  },
  close() {},
});

ImapFlow.prototype.connect = async function () {};

ImapFlow.prototype.logout = async function () {};

ImapFlow.prototype.getMailboxLock = async function () {
  this.mailbox = { uidValidity: 1n };
  return { release() {} };
};

ImapFlow.prototype.list = async () => [];

ImapFlow.prototype.search = async () => [1];

ImapFlow.prototype.messageFlagsAdd = async () => true;

ImapFlow.prototype.fetch = async function* () {};

globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              subject: "Revisão",
              body: "Podemos conversar sobre a rotina? Se não desejar receber mensagens, avise. Lucas",
            }),
          },
        },
      ],
    }),
  );

const { tickWarmup } = await import("../src/warmup/worker.ts");

const { pollAccount } = await import("../src/inbox/monitor.ts");

const { planQueue } = await import("../src/outreach/planner.ts");

const { tickDispatch } = await import("../src/outreach/dispatcher.ts");

const now = () => new Date().toISOString();

function reset() {
  ImapFlow.prototype.search = async () => [1];
  q.run("DELETE FROM warmup_deliveries");
  q.run("DELETE FROM bounces_and_logs");
  q.run("DELETE FROM outreach_queue");
  q.run("DELETE FROM leads");
  q.run("DELETE FROM sequence_steps");
  q.run("DELETE FROM sequences");
  q.run("DELETE FROM warmup_messages");
  q.run("DELETE FROM warmup_threads");
  q.run(
    `UPDATE accounts SET status='warming',warmup_only=0,auto_promote=1,counters_date=NULL,cooldown_until=NULL,consecutive_errors=0,next_send_at=NULL,next_warmup_at=NULL`,
  );
  sends = 0;
  smtpAction = async () => {};
}

function cadence() {
  const s = q.run("INSERT INTO sequences(name) VALUES('core')").id;
  for (const n of [1, 2])
    q.run(
      "INSERT INTO sequence_steps(sequence_id,step_number,subject_template,body_template) VALUES(?,?,'Revisão','Texto')",
      s,
      n,
    );
  return s;
}

function prospect(s) {
  return q.run(
    `INSERT INTO leads(name,email,status,sequence_id,current_step,assigned_account_id,next_due_at,created_at,updated_at) VALUES('Teste','prospect@example.invalid','sent',?,1,1,?,?,?)`,
    s,
    now(),
    now(),
    now(),
  ).id;
}

function thread(max = 2) {
  const t = q.run(
    `INSERT INTO warmup_threads(initiator_id,peer_id,subject,turns,max_turns,next_actor_id,reply_due_at,created_at,updated_at) VALUES(2,1,'Revisão',1,?,1,?,?,?)`,
    max,
    now(),
    now(),
    now(),
  ).id;
  q.run(
    `INSERT INTO warmup_messages(thread_id,message_id,from_account_id,to_account_id,subject,body,sent_at) VALUES(?,'<warm@invalid>',2,1,'Revisão','Olá',?)`,
    t,
    now(),
  );
  return t;
}

test("calendar age alone never promotes a mailbox", () => {
  reset();
  rollDay();
  assert.equal(getAccount(1).status, "warming");
  assert.equal(getAccount(1).daily_limit, 0);
});

test("resuming a personal seed cannot enable cold", () => {
  reset();
  q.run("UPDATE accounts SET warmup_only=1,status='paused' WHERE id=1");
  resumeAccount(getAccount(1));
  assert.equal(getAccount(1).status, "warming");
});

test("warmup reply respects the hard daily target", async () => {
  reset();
  rollDay();
  q.run("UPDATE accounts SET warmup_target_today=3,warmup_sent_today=3");
  thread();
  await tickWarmup();
  assert.equal(sends, 0);
  assert.equal(getAccount(1).warmup_sent_today, 3);
});

test("a missing received warmup message never generates a reply", async () => {
  reset();
  rollDay();
  q.run(
    "UPDATE accounts SET warmup_target_today=3,warmup_sent_today=2,next_warmup_at=?",
    "2999-01-01",
  );
  const t = thread();
  q.run("UPDATE warmup_threads SET retry_count=4 WHERE id=?", t);
  ImapFlow.prototype.search = async () => [];
  await tickWarmup();
  assert.equal(sends, 0);
  ImapFlow.prototype.search = async () => [1];
});

test("paused mailbox error does not repeat pause events", () => {
  reset();
  q.run("UPDATE accounts SET status='paused',consecutive_errors=5 WHERE id=1");
  recordAccountError(getAccount(1), "temp", "failure");
  assert.equal(
    q.get("SELECT count(*) n FROM bounces_and_logs WHERE event='auto_pause'").n,
    0,
  );
});

test("reply stops followups before slow classification completes", async () => {
  reset();
  rollDay();
  const id = prospect(cadence());
  q.run(
    "UPDATE accounts SET status='active',daily_limit=10,next_send_at=? WHERE id=1",
    now(),
  );
  q.run("UPDATE accounts SET status='paused' WHERE id=2");
  let started, release;
  const waiting = new Promise((r) => (started = r));
  globalThis.fetch = async (_u, o) => {
    if (JSON.parse(o.body).messages[0].content.includes("classificador")) {
      started();
      return new Promise(
        (r) =>
          (release = () =>
            r(
              new Response(
                JSON.stringify({
                  choices: [
                    {
                      message: {
                        content: JSON.stringify({
                          intent: "manda_video",
                          suggestedReply: "Obrigado",
                        }),
                      },
                    },
                  ],
                }),
              ),
            )),
      );
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                subject: "Revisão",
                body: "Podemos conversar? Caso não deseje, avise. Lucas",
              }),
            },
          },
        ],
      }),
    );
  };
  ImapFlow.prototype.fetch = async function* () {
    yield {
      uid: 1,
      source: Buffer.from(
        "From: prospect@example.invalid\r\nSubject: Re: Revisão\r\n\r\nPode mandar o vídeo",
      ),
    };
  };
  const polling = pollAccount(getAccount(1));
  await waiting;
  const during = q.get("SELECT status FROM leads WHERE id=?", id).status;
  await planQueue();
  release();
  await polling;
  assert.equal(during, "replied");
  assert.equal(
    q.get("SELECT count(*) n FROM outreach_queue WHERE status='queued'").n,
    0,
  );
});

test("planner revalidates a reply received while drafting", async () => {
  reset();
  rollDay();
  const id = prospect(cadence());
  q.run(
    `INSERT INTO warmup_daily_health(account_id,day,target,sent,external_reads,healthy) VALUES(1,?,3,3,1,1)`,
    "1999-01-01",
  );
  for (let i = 2; i <= 21; i++)
    q.run(
      `INSERT INTO warmup_daily_health(account_id,day,target,sent,external_reads,healthy) VALUES(1,?,3,3,1,1)`,
      `1999-01-${String(i).padStart(2, "0")}`,
    );
  q.run("UPDATE accounts SET status='active',daily_limit=10 WHERE id=1");
  globalThis.fetch = async () => {
    q.run(
      "UPDATE leads SET status='replied',replied_at=? WHERE id=?",
      now(),
      id,
    );
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                subject: "Revisão",
                body: "Posso ajudar a organizar sua rotina? Se não desejar receber mensagens, avise. Lucas",
              }),
            },
          },
        ],
      }),
    );
  };
  await planQueue();
  assert.equal(q.get("SELECT count(*) n FROM outreach_queue").n, 0);
});

test("SMTP acceptance cannot overwrite a concurrently received reply", async () => {
  reset();
  rollDay();
  const s = cadence(),
    id = prospect(s);
  q.run(
    "UPDATE accounts SET status='active',daily_limit=10,next_send_at=? WHERE id=1",
    now(),
  );
  q.run("UPDATE accounts SET status='paused' WHERE id=2");
  q.run(
    `INSERT INTO outreach_queue(account_id,lead_id,step_number,subject,body,scheduled_for,created_at) VALUES(1,?,2,'Revisão','Mensagem válida.',?,?)`,
    id,
    now(),
    now(),
  );
  smtpAction = async () => {
    q.run(
      "UPDATE leads SET status='replied',replied_at=? WHERE id=?",
      now(),
      id,
    );
  };
  await tickDispatch();
  assert.equal(
    q.get("SELECT status FROM leads WHERE id=?", id).status,
    "replied",
  );
});

test("unknown SMTP outcome persists identifier and blocks automatic resend", async () => {
  reset();
  rollDay();
  const id = prospect(cadence());
  q.run(
    "UPDATE accounts SET status='active',daily_limit=10,next_send_at=? WHERE id=1",
    now(),
  );
  q.run("UPDATE accounts SET status='paused' WHERE id=2");
  q.run(
    `INSERT INTO outreach_queue(account_id,lead_id,step_number,subject,body,scheduled_for,created_at) VALUES(1,?,2,'Revisão','Mensagem válida.',?,?)`,
    id,
    now(),
    now(),
  );
  smtpAction = async () => {
    throw new Error("lost acceptance response");
  };
  await tickDispatch();
  const r = q.get("SELECT * FROM outreach_queue");
  assert.equal(r.status, "failed");
  assert.match(r.error_log, /delivery_uncertain/);
  assert.ok(r.message_id);
});

test("21 verified healthy completed days permit promotion; seed still cannot become active", () => {
  reset();
  q.run("DELETE FROM warmup_daily_health");
  for (let i = 1; i <= 21; i++)
    q.run(
      `INSERT INTO warmup_daily_health(account_id,day,target,sent,external_reads,healthy) VALUES(1,?,3,3,1,1)`,
      `2000-01-${String(i).padStart(2, "0")}`,
    );
  rollDay();
  assert.equal(getAccount(1).status, "active");
  assert.equal(getAccount(2).status, "warming");
  assert.ok(getAccount(1).daily_limit > 0);
  q.run("UPDATE accounts SET warmup_only=1,status='paused' WHERE id=1");
  resumeAccount(getAccount(1));
  assert.equal(getAccount(1).status, "warming");
});

test("internal read history does not create external healthy days", async () => {
  reset();
  q.run("DELETE FROM warmup_daily_health");
  rollDay();
  q.run("UPDATE accounts SET warmup_target_today=3,warmup_sent_today=3");
  const t = thread();
  q.run("UPDATE warmup_messages SET imap_status='read',read_at=?", now());
  const { refreshWarmupHealth } = await import("../src/accounts/accounts.ts");
  refreshWarmupHealth();
  assert.equal(
    q.get("SELECT healthy FROM warmup_daily_health WHERE account_id=2").healthy,
    0,
  );
});

test("final message in closed thread is processed as read", async () => {
  reset();
  rollDay();
  q.run("UPDATE accounts SET warmup_sent_today=warmup_target_today");
  const t = thread();
  q.run(
    "UPDATE warmup_threads SET status='closed',next_actor_id=NULL WHERE id=?",
    t,
  );
  q.run(
    "UPDATE warmup_messages SET sent_at=?",
    new Date(Date.now() - 40 * 60000).toISOString(),
  );
  await tickWarmup();
  assert.equal(
    q.get("SELECT imap_status FROM warmup_messages").imap_status,
    "read",
  );
  assert.equal(sends, 0);
});

test("Junk monitoring persists independent UIDVALIDITY and resumes from each cursor", async () => {
  reset();
  q.run("DELETE FROM imap_cursors");
  let validity = 4n;
  ImapFlow.prototype.list = async () => [
    { path: "Junk", specialUse: "\\Junk" },
  ];
  ImapFlow.prototype.getMailboxLock = async function (path) {
    this.mailbox = { uidValidity: validity };
    this.testPath = path;
    return { release() {} };
  };
  ImapFlow.prototype.search = async function (query) {
    return query.uid ? [3] : [3];
  };
  ImapFlow.prototype.fetch = async function* () {
    yield {
      uid: 3,
      source: Buffer.from(
        "From: unknown@example.invalid\r\nSubject: Hello\r\n\r\nUnrelated message",
      ),
    };
  };
  await pollAccount(getAccount(1));
  assert.equal(
    q.get(`SELECT count(*) n FROM imap_cursors WHERE account_id=1`).n,
    2,
  );
  assert.equal(
    q.get(
      `SELECT uid_validity FROM imap_cursors WHERE account_id=1 AND mailbox='Junk'`,
    ).uid_validity,
    "4",
  );
  validity = 5n;
  await pollAccount(getAccount(1));
  assert.equal(
    q.get(
      `SELECT uid_validity FROM imap_cursors WHERE account_id=1 AND mailbox='Junk'`,
    ).uid_validity,
    "5",
  );
});

test("startup quarantines interrupted SMTP claims without restoring leads", async () => {
  reset();
  const id = prospect(cadence());
  const row = q.run(
    `INSERT INTO outreach_queue(account_id,lead_id,step_number,subject,body,scheduled_for,created_at,status,message_id) VALUES(1,?,2,'Revisão','Texto',?,?,'sending','<persisted@invalid>')`,
    id,
    now(),
    now(),
  ).id;
  const { recoverUncertainDeliveries } = await import("../src/scheduler.ts");
  recoverUncertainDeliveries();
  assert.equal(
    q.get("SELECT status FROM outreach_queue WHERE id=?", row).status,
    "failed",
  );
  assert.equal(
    q.get("SELECT status FROM leads WHERE id=?", id).status,
    "finished",
  );
  assert.equal(
    q.get(
      `SELECT count(*) n FROM bounces_and_logs WHERE event='delivery_uncertain'`,
    ).n,
    1,
  );
  recoverUncertainDeliveries();
  assert.equal(
    q.get(
      `SELECT count(*) n FROM bounces_and_logs WHERE event='delivery_uncertain'`,
    ).n,
    1,
  );
});

test("maintenance target advances effective days after initial warmup", async () => {
  reset();
  q.run("DELETE FROM warmup_daily_health");

  for (let i = 1; i <= 21; i++)
    q.run(
      `INSERT INTO warmup_daily_health(account_id,day,target,sent,external_reads,healthy) VALUES(2,?,3,3,1,1)`,
      `2000-02-${String(i).padStart(2, "0")}`,
    );

  rollDay();
  q.run(
    `UPDATE accounts SET warmup_sent_today=6,warmup_target_today=6 WHERE id=2`,
  );
  q.run(
    `UPDATE accounts SET provider='gmail',email='test1@gmail.invalid' WHERE id=1`,
  );

  const t = thread();
  q.run(`UPDATE warmup_messages SET imap_status='read',read_at=?`, now());

  for (let i = 1; i < 6; i++)
    q.run(
      `INSERT INTO warmup_messages(thread_id,message_id,from_account_id,to_account_id,subject,body,sent_at) VALUES(?,?,2,1,'Review','Hello',?)`,
      t,
      `<maintenance${i}@invalid>`,
      now(),
    );

  const { refreshWarmupHealth } = await import("../src/accounts/accounts.ts");
  refreshWarmupHealth();

  const ledger = q.get(
    `SELECT * FROM warmup_daily_health WHERE account_id=2 ORDER BY day DESC LIMIT 1`,
  );

  assert.equal(ledger.target, 6);
  assert.equal(ledger.healthy, 1);
  q.run(
    `UPDATE accounts SET provider='other',email='test1@example.invalid' WHERE id=1`,
  );
});

test("quota-delayed open thread receipt is still read without SMTP", async () => {
  reset();
  rollDay();
  q.run(`UPDATE accounts SET warmup_sent_today=warmup_target_today`);
  const t = thread();

  q.run(
    `UPDATE warmup_messages SET sent_at=?`,
    new Date(Date.now() - 40 * 60000).toISOString(),
  );

  q.run(`UPDATE warmup_threads SET reply_due_at='2999-01-01' WHERE id=?`, t);

  await tickWarmup();
  assert.equal(
    q.get(`SELECT imap_status FROM warmup_messages`).imap_status,
    "read",
  );
  assert.equal(sends, 0);
});

test("final receipt respects read delay rather than being read immediately", async () => {
  reset();
  rollDay();
  q.run(`UPDATE accounts SET warmup_sent_today=warmup_target_today`);
  const t = thread();
  q.run(
    `UPDATE warmup_threads SET status='closed',next_actor_id=NULL WHERE id=?`,
    t,
  );

  await tickWarmup();
  assert.equal(
    q.get(`SELECT imap_status FROM warmup_messages`).imap_status,
    "unread",
  );
});

test("late external receipt completes original source-day health ledger", async () => {
  reset();
  q.run("DELETE FROM warmup_daily_health");
  rollDay();
  const date = new Date(Date.now() - 24 * 3600000);
  const { localDate } = await import("../src/lib/util.ts");
  const day = localDate(date);
  q.run(
    `UPDATE accounts SET provider='gmail',email='test1@gmail.invalid' WHERE id=1`,
  );
  const t = thread();
  q.run(
    `UPDATE warmup_messages SET sent_at=?,imap_status='read',read_at=?`,
    date.toISOString(),
    now(),
  );
  for (let i = 1; i < 3; i++)
    q.run(
      `INSERT INTO warmup_messages(thread_id,message_id,from_account_id,to_account_id,subject,body,sent_at) VALUES(?,?,2,1,'Review','Hello',?)`,
      t,
      `<late${i}@invalid>`,
      date.toISOString(),
    );
  q.run(
    `INSERT INTO warmup_daily_health(account_id,day,target,sent,external_reads,healthy,operational) VALUES(2,?,3,3,0,0,1)`,
    day,
  );
  const { refreshWarmupHealth, healthyWarmupDays } = await import(
    "../src/accounts/accounts.ts"
  );
  refreshWarmupHealth();
  assert.equal(
    q.get(
      `SELECT healthy FROM warmup_daily_health WHERE account_id=2 AND day=?`,
      day,
    ).healthy,
    1,
  );
  assert.equal(healthyWarmupDays(2), 1);
  q.run(
    `UPDATE accounts SET provider='other',email='test1@example.invalid' WHERE id=1`,
  );
});
test("quota-mutated counters do not substitute for successful warmup sends", async () => {
  reset();
  q.run("DELETE FROM warmup_daily_health");
  rollDay();
  q.run(
    `UPDATE accounts SET provider='gmail',email='test1@gmail.invalid' WHERE id=1`,
  );
  thread();
  q.run(`UPDATE warmup_messages SET imap_status='read',read_at=?`, now());
  q.run(
    `UPDATE accounts SET warmup_target_today=3,warmup_sent_today=3 WHERE id=2`,
  );
  const { refreshWarmupHealth } = await import("../src/accounts/accounts.ts");
  refreshWarmupHealth();
  const ledger = q.get(`SELECT * FROM warmup_daily_health WHERE account_id=2`);
  assert.equal(ledger.sent, 1);
  assert.equal(ledger.healthy, 0);
  q.run(
    `UPDATE accounts SET provider='other',email='test1@example.invalid' WHERE id=1`,
  );
});
test("explicit re-enrollment clears old reply stop state", async () => {
  reset();
  const id = prospect(cadence());
  q.run(
    `UPDATE leads SET status='replied',replied_at=?,last_reply_snippet='Old response',reply_intent='manda_video' WHERE id=?`,
    now(),
    id,
  );
  const { enrollLead } = await import("../src/outreach/leads.ts");
  enrollLead(id, "core");
  const lead = q.get("SELECT * FROM leads WHERE id=?", id);
  assert.equal(lead.replied_at, null);
  assert.equal(lead.last_reply_snippet, null);
  assert.equal(lead.reply_intent, null);
  assert.equal(lead.status, "pending");
});
test("replayed DSN is counted once across mailbox moves and UIDVALIDITY resets", async () => {
  reset();
  q.run("DELETE FROM imap_cursors");
  const id = prospect(cadence());
  let validity = 6n;
  ImapFlow.prototype.list = async () => [
    { path: "Junk", specialUse: "\\Junk" },
  ];
  ImapFlow.prototype.getMailboxLock = async function () {
    this.mailbox = { uidValidity: validity };
    return { release() {} };
  };
  ImapFlow.prototype.search = async () => [8];
  ImapFlow.prototype.fetch = async function* () {
    yield {
      uid: 8,
      source: Buffer.from(
        "Message-ID: <dsn@invalid>\r\nFrom: mailer-daemon@invalid.test\r\nSubject: Delivery failed\r\n\r\nFinal-Recipient: rfc822; prospect@example.invalid\r\nStatus: 5.1.1\r\nNo such user",
      ),
    };
  };
  q.run("UPDATE accounts SET bounces_today=0 WHERE id=1");
  await pollAccount(getAccount(1));
  validity = 7n;
  await pollAccount(getAccount(1));
  assert.equal(getAccount(1).bounces_today, 1);
  assert.equal(
    q.get(`SELECT count(*) n FROM bounces_and_logs WHERE event='bounce'`).n,
    1,
  );
});
test("warmup start refuses peer whose daily reply quota is exhausted", async () => {
  reset();
  rollDay();
  q.run(
    "UPDATE accounts SET warmup_target_today=3,warmup_sent_today=0 WHERE id=1",
  );
  q.run(
    "UPDATE accounts SET warmup_target_today=3,warmup_sent_today=3 WHERE id=2",
  );
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                subject: "Review",
                body: "Can you review the wording? Thanks Lucas",
              }),
            },
          },
        ],
      }),
    );
  await tickWarmup();
  assert.equal(sends, 0);
  assert.equal(q.get("SELECT count(*) n FROM warmup_threads").n, 0);
});
test("DSN without Message-ID uses durable stable-content dedup", async () => {
  reset();
  q.run("DELETE FROM imap_cursors");
  prospect(cadence());
  let validity = 9n;
  ImapFlow.prototype.list = async () => [];
  ImapFlow.prototype.getMailboxLock = async function () {
    this.mailbox = { uidValidity: validity };
    return { release() {} };
  };
  ImapFlow.prototype.search = async () => [10];
  ImapFlow.prototype.fetch = async function* () {
    yield {
      uid: 10,
      source: Buffer.from(
        "From: mailer-daemon@invalid.test\r\nSubject: Delivery failed without id\r\n\r\nFinal-Recipient: rfc822; prospect@example.invalid\r\nStatus: 5.1.1\r\nNo such user",
      ),
    };
  };
  q.run("UPDATE accounts SET bounces_today=0 WHERE id=1");
  await pollAccount(getAccount(1));
  validity = 10n;
  await pollAccount(getAccount(1));
  assert.equal(getAccount(1).bounces_today, 1);
});
test("warmup intake considers existing owed replies, even before they are due", async () => {
  reset();
  rollDay();
  q.run(
    "UPDATE accounts SET warmup_target_today=3,warmup_sent_today=0 WHERE id=1",
  );
  q.run(
    "UPDATE accounts SET warmup_target_today=1,warmup_sent_today=0,next_warmup_at=? WHERE id=2",
    "2999-01-01",
  );
  const t = thread();
  q.run(
    `UPDATE warmup_threads SET next_actor_id=2,reply_due_at='2999-01-01' WHERE id=?`,
    t,
  );
  await tickWarmup();
  assert.equal(sends, 0);
  assert.equal(q.get("SELECT count(*) n FROM warmup_threads").n, 1);
});
test("warmup peer capacity is revalidated after asynchronous drafting", async () => {
  reset();
  rollDay();
  q.run(
    "UPDATE accounts SET warmup_target_today=3,warmup_sent_today=0 WHERE id=1",
  );
  q.run(
    "UPDATE accounts SET warmup_target_today=3,warmup_sent_today=2,next_warmup_at=? WHERE id=2",
    "2999-01-01",
  );
  globalThis.fetch = async () => {
    q.run("UPDATE accounts SET warmup_sent_today=3 WHERE id=2");
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                subject: "Review",
                body: "Can you review the wording? Thanks Lucas",
              }),
            },
          },
        ],
      }),
    );
  };
  await tickWarmup();
  assert.equal(sends, 0);
});
test("unsolicited FETCH flags notifications do not abort full source processing", async () => {
  reset();
  q.run("DELETE FROM imap_cursors");
  ImapFlow.prototype.list = async () => [];
  ImapFlow.prototype.getMailboxLock = async function () {
    this.mailbox = { uidValidity: 15n };
    return { release() {} };
  };
  ImapFlow.prototype.search = async () => [11, 12];
  const source = Buffer.from(
    "From: unknown@example.invalid\r\nSubject: Review\r\n\r\nHello",
  );
  ImapFlow.prototype.fetch = async function* () {
    yield { seq: 2, flags: new Set(["\\Seen"]) };
    yield { uid: 11, source };
    yield { uid: 12, flags: new Set(["\\Seen"]) };
    yield { uid: 12, source };
    yield { uid: 999, source };
  };
  const { fetchNewMessages } = await import("../src/email/imap.ts");
  const result = await fetchNewMessages(getAccount(1), 0);
  assert.deepEqual(
    result.messages.map((m) => m.uid),
    [11, 12],
  );
  assert.equal(result.maxUid, 12);
  assert.equal(result.cursors[0].lastUid, 12);
});
test("missing requested source fails after stream drain without advancing cursor", async () => {
  reset();
  q.run("DELETE FROM imap_cursors");
  q.run(
    `INSERT INTO imap_cursors(account_id,mailbox,uid_validity,last_uid) VALUES(1,'INBOX','15',10)`,
  );
  ImapFlow.prototype.search = async () => [11, 12];
  let drained = false;
  ImapFlow.prototype.fetch = async function* () {
    yield {
      uid: 11,
      source: Buffer.from(
        "From: unknown@example.invalid\r\nSubject: Review\r\n\r\nHello",
      ),
    };
    yield { seq: 3, flags: new Set(["\\Seen"]) };
    drained = true;
  };
  const { fetchNewMessages } = await import("../src/email/imap.ts");
  await assert.rejects(
    fetchNewMessages(getAccount(1), 10),
    /requested UIDs: 12/,
  );
  assert.equal(drained, true);
  assert.equal(
    q.get(
      `SELECT last_uid FROM imap_cursors WHERE account_id=1 AND mailbox='INBOX'`,
    ).last_uid,
    10,
  );
});
function warmupDsnFixture(id, status, original) {
  ImapFlow.prototype.list = async () => [];
  ImapFlow.prototype.getMailboxLock = async function () {
    this.mailbox = { uidValidity: 20n };
    return { release() {} };
  };
  ImapFlow.prototype.search = async () => [20];
  ImapFlow.prototype.fetch = async function* () {
    yield {
      uid: 20,
      source: Buffer.from(
        `Message-ID: <${id}@invalid>\r\nFrom: mailer-daemon@invalid.test\r\nSubject: Delivery failed\r\n\r\nFinal-Recipient: rfc822; test1@example.invalid\r\nOriginal-Message-ID: ${original}\r\nStatus: ${status}\r\nDiagnostic-Code: smtp; ${status} ${status.startsWith("5.7") ? "message blocked by reputation policy" : "No such user"}`,
      ),
    };
  };
}
test("matched warmup permanent DSN closes its thread without cold bounce counters", async () => {
  reset();
  q.run("DELETE FROM imap_cursors");
  q.run("UPDATE accounts SET bounces_today=0");
  const t = thread();
  warmupDsnFixture("warmup-permanent", "5.1.1", "<warm@invalid>");
  await pollAccount(getAccount(2));
  assert.equal(
    q.get("SELECT status FROM warmup_threads WHERE id=?", t).status,
    "closed",
  );
  assert.equal(
    q.get("SELECT imap_status FROM warmup_messages").imap_status,
    "not_found",
  );
  assert.equal(getAccount(2).bounces_today, 0);
  assert.equal(
    q.get(`SELECT count(*) n FROM bounces_and_logs WHERE event='warmup_bounce'`)
      .n,
    1,
  );
});
test("matched warmup reputation DSN applies sender cooldown", async () => {
  reset();
  q.run("DELETE FROM imap_cursors");
  q.run("UPDATE accounts SET bounces_today=0,throttle_count=0");
  thread();
  warmupDsnFixture("warmup-policy", "5.7.26", "<warm@invalid>");
  await pollAccount(getAccount(2));
  assert.ok(getAccount(2).cooldown_until);
  assert.equal(getAccount(2).throttle_count, 1);
  assert.equal(getAccount(2).bounces_today, 0);
});
test("unmatched fleet-recipient DSN logs evidence without guessing a warmup thread", async () => {
  reset();
  q.run("DELETE FROM imap_cursors");
  q.run("UPDATE accounts SET bounces_today=0");
  const t = thread();
  warmupDsnFixture("warmup-unknown", "5.7.26", "<unknown@invalid>");
  await pollAccount(getAccount(2));
  assert.equal(
    q.get(
      `SELECT count(*) n FROM bounces_and_logs WHERE event='warmup_bounce_unmatched'`,
    ).n,
    1,
  );
  assert.equal(
    q.get("SELECT status FROM warmup_threads WHERE id=?", t).status,
    "open",
  );
  assert.equal(getAccount(2).cooldown_until, null);
  assert.equal(getAccount(2).bounces_today, 0);
});
test("matched temporary warmup DSN preserves pending receipt and thread", async () => {
  reset();
  q.run("DELETE FROM imap_cursors");
  q.run("UPDATE accounts SET bounces_today=0");
  const t = thread();
  warmupDsnFixture("warmup-delayed", "4.2.2", "<warm@invalid>");
  await pollAccount(getAccount(2));
  assert.equal(
    q.get("SELECT status FROM warmup_threads WHERE id=?", t).status,
    "open",
  );
  assert.equal(
    q.get("SELECT imap_status FROM warmup_messages").imap_status,
    "unread",
  );
  assert.equal(getAccount(2).bounces_today, 0);
  assert.equal(
    q.get(`SELECT count(*) n FROM bounces_and_logs WHERE event='warmup_bounce'`)
      .n,
    1,
  );
});
test.after(() => db.close());
