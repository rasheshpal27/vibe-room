import { defineConfig } from "drizzle-kit";

/**
 * Reads DATABASE_URL from your shell environment (falls back to .env, which
 * drizzle-kit loads automatically, then to the local dev database).
 *
 * Push the schema to a hosted database like this:
 *   DATABASE_URL="postgres://user:pass@host-pooler.region.aws.neon.tech/db?sslmode=require" npx drizzle-kit push
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@127.0.0.1:5432/app_db",
  },
});
