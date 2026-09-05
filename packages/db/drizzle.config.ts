import type { Config } from "drizzle-kit";

export default {
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_dev",
  },
  strict: true,
  verbose: true,
} satisfies Config;
