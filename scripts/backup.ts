import { db } from "../src/db/index.ts";
import { backupDatabase } from "../src/operations.ts";
import { config } from "../src/config.ts";
import { dirname, join } from "node:path";
try {
  console.log(
    await backupDatabase(
      db,
      process.env.BACKUP_DIR || join(dirname(config.dbPath), "backups"),
    ),
  );
} finally {
  db.close();
}
