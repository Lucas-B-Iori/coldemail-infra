import { backup, DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.ts";
import { localDate, nowIso, inWindow, errMsg, log } from "./lib/util.ts";

/** SQLite online backup includes committed WAL pages; every snapshot is restore-checked. */
export async function backupDatabase(
  database: DatabaseSync,
  directory: string,
): Promise<string> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `engine-${nowIso().replace(/[:.]/g, "-")}.db`);
  await backup(database, path);
  const restored = new DatabaseSync(path, { readOnly: true });
  try {
    if (
      restored.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok"
    ) {
      throw new Error("Backup SQLite inválido");
    }
  } finally {
    restored.close();
  }
  chmodSync(path, 0o600);
  return path;
}

/** Durable deduplication survives restart; webhook is optional, dashboard logs are always available. */
export async function runMaintenance(): Promise<void> {
  const { db, q, addLog } = await import("./db/index.ts");
  db.exec(
    "CREATE TABLE IF NOT EXISTS operations_state(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
  );
  const today = localDate();
  if (
    q.get<{ value: string }>(
      "SELECT value FROM operations_state WHERE key=?",
      "backup_day",
    )?.value !== today
  ) {
    try {
      const path = await backupDatabase(
        db,
        process.env.BACKUP_DIR || join(dirname(config.dbPath), "backups"),
      );
      q.run(
        "INSERT OR REPLACE INTO operations_state VALUES (?,?)",
        "backup_day",
        today,
      );
      addLog({
        kind: "info",
        event: "backup_verified",
        detail: path,
        action: "SQLite íntegro, restauração verificada",
      });
    } catch (e) {
      await incident("backup_failed", errMsg(e));
    }
  }
  const cutoff = new Date(Date.now() - 6 * 3_600_000).toISOString();
  const incidents = q.all<{
    id: number;
    email: string;
    status: string;
    pause_reason: string | null;
    last_sent_at: string | null;
  }>(
    "SELECT id,email,status,pause_reason,last_sent_at FROM accounts WHERE status='paused' OR (status IN ('warming','active') AND (last_sent_at IS NULL OR last_sent_at<?))",
    cutoff,
  );
  for (const account of incidents) {
    if (
      account.status === "paused" ||
      (inWindow(config.warmupWindow) &&
        new Date().getTime() - Date.parse(`${today}T00:00:00Z`) >
          12 * 3_600_000)
    ) {
      await incident(
        `account:${account.id}`,
        `${account.email}: ${account.pause_reason || "sem envio há mais de 6h; verificar aquecimento"}`,
      );
    }
  }
  for (const event of q.all<{
    id: number;
    event: string;
    detail: string | null;
  }>(
    "SELECT id,event,detail FROM bounces_and_logs WHERE event='delivery_uncertain' AND id>COALESCE((SELECT CAST(value AS INTEGER) FROM operations_state WHERE key='last_uncertain'),0) ORDER BY id",
  )) {
    if (
      !(await incident(
        `uncertain:${event.id}`,
        `Entrega incerta (evento ${event.id}); reconciliar Message-ID antes de reenviar.`,
      ))
    )
      break;
    q.run(
      "INSERT OR REPLACE INTO operations_state VALUES (?,?)",
      "last_uncertain",
      event.id.toString(),
    );
  }
  async function incident(key: string, detail: string): Promise<boolean> {
    const stateKey = `incident:${today}:${key}`;
    if (q.get("SELECT value FROM operations_state WHERE key=?", stateKey))
      return true;
    addLog({
      kind: "error",
      event: "operations_alert",
      detail,
      action: "verifique o painel de saúde",
    });
    log("operations", detail);
    const webhook = process.env.ALERT_WEBHOOK_URL;
    if (webhook) {
      try {
        const response = await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: `ColdMail: ${detail}` }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (e) {
        log("operations", `Falha ao notificar: ${errMsg(e)}`);
        return false;
      }
    }
    q.run(
      "INSERT OR REPLACE INTO operations_state VALUES (?,?)",
      stateKey,
      nowIso(),
    );
    return true;
  }
}
