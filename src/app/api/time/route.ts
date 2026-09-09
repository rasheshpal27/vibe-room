import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Lightweight server-clock endpoint used by clients for NTP-style offset
 * estimation (round-trip-time compensated). Returns the server's epoch ms.
 */
export async function GET() {
  return NextResponse.json(
    { t: Date.now() },
    { headers: { "Cache-Control": "no-store" } }
  );
}
