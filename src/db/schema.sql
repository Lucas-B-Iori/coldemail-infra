-- =====================================================================
-- SCHEMA DO MOTOR DE COLD OUTREACH & WARM-UP (SQLite)
-- Timestamps: ISO-8601 UTC (comparáveis lexicograficamente).
-- Datas "de negócio" (counters_date) usam o fuso TZ_NAME (America/Sao_Paulo).
-- =====================================================================
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- ---------------------------------------------------------------------
-- 1. accounts: a frota de caixas postais
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  email               TEXT NOT NULL UNIQUE,
  display_name        TEXT NOT NULL,
  provider            TEXT NOT NULL CHECK (provider IN ('gmail','outlook','m365','other')),
  auth_mode           TEXT NOT NULL DEFAULT 'password' CHECK (auth_mode IN ('password','oauth')),
  group_name          TEXT NOT NULL DEFAULT 'default',   -- para operar em lote (500 caixas)
  smtp_host           TEXT NOT NULL,
  smtp_port           INTEGER NOT NULL,
  smtp_user           TEXT NOT NULL,
  smtp_pass           TEXT NOT NULL,                      -- criptografada (AES-256-GCM)
  imap_host           TEXT NOT NULL,
  imap_port           INTEGER NOT NULL DEFAULT 993,
  daily_limit         INTEGER NOT NULL DEFAULT 0,         -- limite de COLD de hoje (calculado pela rampa)
  limit_override      INTEGER,                            -- se definido, ignora a rampa
  sent_today          INTEGER NOT NULL DEFAULT 0,         -- cold enviados hoje
  warmup_sent_today   INTEGER NOT NULL DEFAULT 0,         -- warm-up enviados hoje
  warmup_target_today INTEGER NOT NULL DEFAULT 0,
  bounces_today       INTEGER NOT NULL DEFAULT 0,
  counters_date       TEXT,                               -- YYYY-MM-DD (fuso de negócio)
  last_sent_at        TEXT,
  next_send_at        TEXT,                               -- próximo cold permitido
  next_warmup_at      TEXT,                               -- próximo warm-up iniciado permitido
  status              TEXT NOT NULL DEFAULT 'warming'
                      CHECK (status IN ('warming','active','paused','banned')),
  pause_reason        TEXT,
  cooldown_until      TEXT,                               -- throttling temporário (451 4.7.500 / 5.7.708)
  throttle_count      INTEGER NOT NULL DEFAULT 0,         -- backoff exponencial do cooldown
  consecutive_errors  INTEGER NOT NULL DEFAULT 0,
  warmup_only         INTEGER NOT NULL DEFAULT 0,         -- 1 = conta semente (apenas aquece a teia, nunca dispara cold)
  auto_promote        INTEGER NOT NULL DEFAULT 1,         -- warming -> active no dia 22
  warmup_started_at   TEXT NOT NULL,
  imap_last_uid       INTEGER NOT NULL DEFAULT 0,
  imap_last_poll_at   TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
CREATE INDEX IF NOT EXISTS idx_accounts_group  ON accounts(group_name);

-- ---------------------------------------------------------------------
-- 2. warmup_threads / warmup_messages: a "teia humanizada"
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS warmup_threads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  initiator_id    INTEGER NOT NULL REFERENCES accounts(id),
  peer_id         INTEGER NOT NULL REFERENCES accounts(id),
  subject         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  turns           INTEGER NOT NULL DEFAULT 0,             -- mensagens já enviadas na thread
  max_turns       INTEGER NOT NULL,
  next_actor_id   INTEGER REFERENCES accounts(id),        -- quem deve responder agora
  reply_due_at    TEXT,                                   -- recebimento + 8..35 min
  retry_count     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wthreads_due ON warmup_threads(status, reply_due_at);

CREATE TABLE IF NOT EXISTS warmup_messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id        INTEGER NOT NULL REFERENCES warmup_threads(id),
  message_id       TEXT NOT NULL UNIQUE,
  in_reply_to      TEXT,
  from_account_id  INTEGER NOT NULL REFERENCES accounts(id),
  to_account_id    INTEGER NOT NULL REFERENCES accounts(id),
  subject          TEXT NOT NULL,
  body             TEXT NOT NULL,
  sent_at          TEXT NOT NULL,
  imap_status      TEXT NOT NULL DEFAULT 'unread'          -- estado na caixa do destinatário
                   CHECK (imap_status IN ('unread','read','not_found')),
  flagged          INTEGER NOT NULL DEFAULT 0,             -- \Flagged aplicado?
  rescued_from_spam INTEGER NOT NULL DEFAULT 0,
  read_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_wmsg_thread ON warmup_messages(thread_id);

-- ---------------------------------------------------------------------
-- 3. Sequências (cadências de follow-up) e leads
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sequences (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE IF NOT EXISTS sequence_steps (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence_id      INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  step_number      INTEGER NOT NULL,                        -- 1, 2, 3...
  delay_days       INTEGER NOT NULL DEFAULT 0,              -- espera APÓS o passo anterior
  reply_in_thread  INTEGER NOT NULL DEFAULT 1,              -- 1 = "Re:" na mesma thread
  subject_template TEXT NOT NULL,
  body_template    TEXT NOT NULL,
  UNIQUE (sequence_id, step_number)
);

CREATE TABLE IF NOT EXISTS leads (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,
  email               TEXT NOT NULL UNIQUE,
  firm_name           TEXT,
  city_state          TEXT,
  list_name           TEXT NOT NULL DEFAULT 'default',     -- listas: default, nurture, ligacao...
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','queued','sent','replied','bounced',
                                        'unsubscribed','finished','nurture','call')),
  sequence_id         INTEGER REFERENCES sequences(id),
  current_step        INTEGER NOT NULL DEFAULT 0,          -- último passo ENVIADO
  assigned_account_id INTEGER REFERENCES accounts(id),     -- follow-up sai da mesma caixa
  thread_subject      TEXT,
  last_message_id     TEXT,
  thread_references   TEXT,                                -- cadeia de Message-IDs
  last_contacted_at   TEXT,
  next_due_at         TEXT,                                -- quando o próximo passo vence
  replied_at          TEXT,
  last_reply_snippet  TEXT,
  notes               TEXT,
  site                TEXT,
  role                TEXT,
  source_url          TEXT,
  practice_area       TEXT,
  observed_fact       TEXT,
  need_hypothesis     TEXT,
  fit_score           INTEGER NOT NULL DEFAULT 0,
  variant             TEXT NOT NULL DEFAULT 'modelo_a',
  reply_intent        TEXT,
  next_action         TEXT,
  scheduled_meeting_at TEXT,
  demo_done           INTEGER NOT NULL DEFAULT 0,
  customer_paid       INTEGER NOT NULL DEFAULT 0,
  deal_value          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_status   ON leads(status, list_name);
CREATE INDEX IF NOT EXISTS idx_leads_due      ON leads(status, next_due_at);
CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_account_id);

-- ---------------------------------------------------------------------
-- 4. outreach_queue: tudo que foi/será enviado
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach_queue (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     INTEGER NOT NULL REFERENCES accounts(id),
  lead_id        INTEGER NOT NULL REFERENCES leads(id),
  step_number    INTEGER NOT NULL DEFAULT 1,
  subject        TEXT NOT NULL,
  body           TEXT NOT NULL,
  scheduled_for  TEXT NOT NULL,
  sent_at        TEXT,
  message_id     TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  error_log      TEXT,
  status         TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','sending','sent','failed','cancelled')),
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_pick    ON outreach_queue(account_id, status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_queue_lead    ON outreach_queue(lead_id, status);
CREATE INDEX IF NOT EXISTS idx_queue_msgid   ON outreach_queue(message_id);

-- ---------------------------------------------------------------------
-- 5. bounces_and_logs: auditoria + mitigação automática
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bounces_and_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER REFERENCES accounts(id),
  lead_id      INTEGER REFERENCES leads(id),
  queue_id     INTEGER REFERENCES outreach_queue(id),
  kind         TEXT NOT NULL CHECK (kind IN ('hard','soft','error','info','auto_action')),
  event        TEXT NOT NULL,
  detail       TEXT,
  action_taken TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_acc ON bounces_and_logs(account_id, created_at);

-- ---------------------------------------------------------------------
-- copies geradas por IA (núcleo do texto, sem opt-out/assinatura) para checagem de unicidade
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS generated_copies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id     INTEGER NOT NULL REFERENCES leads(id),
  step_number INTEGER NOT NULL,
  subject     TEXT NOT NULL,
  core        TEXT NOT NULL,              -- texto normalizado (vars do lead substituídas por marcadores)
  max_jaccard REAL NOT NULL DEFAULT 0,    -- maior similaridade encontrada no momento da geração
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gen_copies_step ON generated_copies(step_number, id);
