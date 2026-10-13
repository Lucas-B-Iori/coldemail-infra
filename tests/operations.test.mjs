import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
process.env.ENCRYPTION_KEY = "test-key-never-use-in-production";
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "cold-ops-")), "test.db");
process.env.AUTO_SEED_FLEET = "false";
const { encrypt, decrypt } = await import("../src/lib/crypto.ts");
test("credentials cannot fall back to unencrypted plaintext", () => {
  assert.throws(() => decrypt("plaintext-credential"), /criptograf|encrypted/i);
});
test("ciphertext corruption is rejected without exposing credentials", () => {
  const value = encrypt("isolated-secret");
  assert.equal(decrypt(value), "isolated-secret");
  const parts = value.split(":");
  parts[3] = Buffer.alloc(16).toString("base64");
  assert.throws(() => decrypt(parts.join(":")), /credencial|decrypt|chave/i);
});
test("backup is restorable and preserves committed WAL rows", async () => {
  const { backupDatabase } = await import("../src/operations.ts");
  const dir = mkdtempSync(join(tmpdir(), "cold-backup-"));
  const db = new DatabaseSync(join(dir, "source.db"));
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('durable')",
  );
  const path = await backupDatabase(db, join(dir, "snapshots"));
  const restored = new DatabaseSync(path, { readOnly: true });
  assert.equal(
    restored.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
  assert.equal(
    restored.prepare("SELECT value FROM proof").get().value,
    "durable",
  );
  restored.close();
  db.close();
});
test("failed uncertainty notification is retried before advancing durable cursor", async () => {
  const { q, db, addLog } = await import("../src/db/index.ts");
  const { runMaintenance } = await import("../src/operations.ts");
  addLog({ kind: "error", event: "delivery_uncertain", detail: "test claim" });
  process.env.ALERT_WEBHOOK_URL = "https://example.invalid/alerts";
  let calls = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("", { status: ++calls === 1 ? 503 : 200 });
  try {
    await runMaintenance();
    assert.equal(
      q.get("SELECT value FROM operations_state WHERE key='last_uncertain'"),
      undefined,
    );
    await runMaintenance();
    assert.ok(
      q.get("SELECT value FROM operations_state WHERE key='last_uncertain'"),
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = oldFetch;
    delete process.env.ALERT_WEBHOOK_URL;
    db.close();
  }
});
