import { createDb } from "./client";
import { runMigrations } from "./migrate";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const { db, pool } = createDb(url, { max: 1 });
try {
  await runMigrations(db);
  console.log("migrations applied");
} finally {
  await pool.end();
}
