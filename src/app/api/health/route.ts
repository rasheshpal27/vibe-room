import { db } from "@/db";
import { sql } from "drizzle-orm";
import { authConfigured, missingSecrets } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Uptime probe. Reports configuration problems as well as database ones:
 * a room whose passwords are missing is up, reachable, and useless, and an
 * operator should be able to see that without trying to log in.
 */
export async function GET() {
  const configured = authConfigured();
  try {
    await db.execute(sql`select 1`);
    return Response.json(
      {
        ok: configured,
        db: "up",
        config: configured ? "ok" : "missing-secrets",
        missing: configured ? [] : missingSecrets(),
      },
      { status: configured ? 200 : 503 }
    );
  } catch {
    return Response.json(
      {
        ok: false,
        db: "down",
        config: configured ? "ok" : "missing-secrets",
        missing: configured ? [] : missingSecrets(),
      },
      { status: 500 }
    );
  }
}
