import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.ts";
mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
for (const [table, column, definition] of [
  ["warmup_messages", "read_due_at", "TEXT"],
  ["warmup_daily_health", "operational", "INTEGER NOT NULL DEFAULT 1"],
] as const) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!columns.some((c) => c.name === column))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
// Migração incremental de colunas de qualificação
function migrateLeadsTable(): void {
  const existing = new Set(
    (
      db.prepare("PRAGMA table_info(leads)").all() as unknown as {
        name: string;
      }[]
    ).map((c) => c.name),
  );
  const newCols: [string, string][] = [
    ['site', 'TEXT'],
    ['role', 'TEXT'],
    ['source_url', 'TEXT'],
    ['practice_area', 'TEXT'],
    ['observed_fact', 'TEXT'],
    ['need_hypothesis', 'TEXT'],
    ['fit_score', 'INTEGER NOT NULL DEFAULT 0'],
    ['variant', "TEXT NOT NULL DEFAULT 'modelo_a'"],
    ['reply_intent', 'TEXT'],
    ['next_action', 'TEXT'],
    ['scheduled_meeting_at', 'TEXT'],
    ['demo_done', 'INTEGER NOT NULL DEFAULT 0'],
    ['customer_paid', 'INTEGER NOT NULL DEFAULT 0'],
    ['deal_value', 'TEXT'],
    // rubrica de lead (venda de site one-page)
    ['city', 'TEXT'],
    ['neighborhood', 'TEXT'],
    ['phone', 'TEXT'],
    ['instagram', 'TEXT'],
    ['maps_rating', 'REAL'],
    ['maps_reviews', 'INTEGER'],
    ['site_status', 'TEXT'],
    ['contact_known', 'INTEGER NOT NULL DEFAULT 0'],
    // motivo de revisão manual (IA falhou, sem fato_observado, copy repetida). NULL = ok para enviar
    ['needs_review', 'TEXT'],
  ];
  for (const [col, typeDef] of newCols) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE leads ADD COLUMN ${col} ${typeDef}`);
    }
  }
}
migrateLeadsTable();
type Param = string | number | null | undefined | bigint;
const norm = (p: Param[]) =>
  p.map((v) => (v === undefined ? null : v)) as (
    | string
    | number
    | null
    | bigint
  )[];
/** Helpers tipados e síncronos sobre o SQLite (driver síncrono = sem race conditions no mesmo processo). */
export const q = {
  all<T>(sql: string, ...p: Param[]): T[] {
    return db.prepare(sql).all(...norm(p)) as unknown as T[];
  },
  get<T>(sql: string, ...p: Param[]): T | undefined {
    return db.prepare(sql).get(...norm(p)) as unknown as T | undefined;
  },
  run(sql: string, ...p: Param[]): { changes: number; id: number } {
    const r = db.prepare(sql).run(...norm(p));
    return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
  },
};
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function addLog(l: {
  account_id?: number | null;
  lead_id?: number | null;
  queue_id?: number | null;
  kind: "hard" | "soft" | "error" | "info" | "auto_action";
  event: string;
  detail?: string;
  action?: string;
}): void {
  q.run(
    `INSERT INTO bounces_and_logs (account_id, lead_id, queue_id, kind, event, detail, action_taken, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    l.account_id,
    l.lead_id,
    l.queue_id,
    l.kind,
    l.event,
    l.detail?.slice(0, 2000),
    l.action,
    new Date().toISOString(),
  );
}
import { autoSeedFleetIfEmpty } from "./autoSeed.ts";
autoSeedFleetIfEmpty();
