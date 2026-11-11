// Copies the live database to a consistent snapshot. Safe to run while the bot is up.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { loadConfig } from "./config.js";

const config = loadConfig();
const dest =
  process.argv[2] ??
  join(dirname(config.databasePath), "backups", `tribunal-${new Date().toISOString().slice(0, 10)}.db`);
mkdirSync(dirname(dest), { recursive: true });
const db = new DatabaseSync(config.databasePath, { readOnly: true });
await backup(db, dest);
db.close();
console.log(dest);
