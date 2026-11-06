import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSnapshot, snapshotSignature } from "@/lib/party";

export const dynamic = "force-dynamic";

/**
 * The room snapshot.
 *
 * Two bandwidth savers ride along with it:
 *
 *  - `chatSince`: the client sends the newest chat id it holds and gets back
 *    only what is newer.
 *  - ETag: most polls describe a room where nothing visible changed, and
 *    those answer 304 with no body. `X-Server-Now` is still sent on a 304 so
 *    the client keeps getting a free clock sample out of every poll.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const u = params.get("u");
  const sinceRaw = params.get("chatSince");
  const chatSince =
    sinceRaw !== null && sinceRaw !== "" && Number.isFinite(Number(sinceRaw))
      ? Number(sinceRaw)
      : null;

  const snapshot = await getSnapshot(u, { chatSince });
  const serverNow = String(snapshot.serverNow);

  const etag = `W/"${createHash("sha1")
    .update(snapshotSignature(snapshot))
    .digest("base64url")}"`;

  const baseHeaders: Record<string, string> = {
    "Cache-Control": "no-store",
    ETag: etag,
    "X-Server-Now": serverNow,
  };

  if (req.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: baseHeaders });
  }

  return NextResponse.json(snapshot, { headers: baseHeaders });
}
