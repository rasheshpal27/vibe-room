import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * High-precision world-clock / server-clock endpoint used by clients for
 * multi-sample NTP-style offset estimation (round-trip-time compensated).
 * Returns exact UTC epoch milliseconds (`t` and `utcMs`) and ISO string.
 */
export async function GET() {
  const nowMs = Date.now();
  return NextResponse.json(
    {
      t: nowMs,
      utcMs: nowMs,
      iso: new Date(nowMs).toISOString(),
    },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
      },
    }
  );
}
