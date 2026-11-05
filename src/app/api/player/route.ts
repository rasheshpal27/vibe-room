import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { partyState, queueItems } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  advanceQueue,
  ensureState,
  isAdminKey,
  STATE_ID,
  systemMessage,
} from "@/lib/party";

export const dynamic = "force-dynamic";

/**
 * Transport controls.
 *  - `ended`   : callable by any client, idempotent queue advance
 *  - everything else requires the admin key
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");
  const state = await ensureState();

  if (action === "ended") {
    const qid = Number(body.queueId ?? 0);
    if (state.currentQueueId && qid === state.currentQueueId) {
      await advanceQueue();
    }
    return NextResponse.json({ ok: true });
  }

  /**
   * A guest's player exhausted every automatic recovery attempt because the
   * video itself cannot be embedded (YouTube 100/101/150). That is identical
   * for everyone in the room, so move the party on instead of stalling.
   * Idempotent: only the first report for the *current* track does anything.
   */
  if (action === "unplayable") {
    const qid = Number(body.queueId ?? 0);
    const videoId = String(body.videoId ?? "");
    if (
      state.currentQueueId &&
      qid === state.currentQueueId &&
      (!videoId || !state.videoId || videoId === state.videoId)
    ) {
      await systemMessage(
        `Skipped "${state.title ?? "that track"}" — YouTube blocks it from playing here`
      );
      await advanceQueue();
      return NextResponse.json({ ok: true, skipped: true });
    }
    return NextResponse.json({ ok: true, skipped: false });
  }

  if (!isAdminKey(String(body.adminKey ?? req.headers.get("x-admin-key") ?? ""))) {
    return NextResponse.json({ ok: false, error: "Admin only" }, { status: 401 });
  }

  switch (action) {
    case "pause": {
      const pos = Math.max(0, Number(body.positionSec ?? state.positionSec));
      await db
        .update(partyState)
        .set({ isPlaying: false, positionSec: pos, updatedAt: new Date() })
        .where(eq(partyState.id, STATE_ID));
      return NextResponse.json({ ok: true });
    }
    case "resume": {
      const pos = Math.max(0, Number(body.positionSec ?? state.positionSec));
      await db
        .update(partyState)
        .set({ isPlaying: true, positionSec: pos, updatedAt: new Date() })
        .where(eq(partyState.id, STATE_ID));
      return NextResponse.json({ ok: true });
    }
    case "seek": {
      const pos = Math.max(0, Number(body.positionSec ?? 0));
      await db
        .update(partyState)
        .set({ isPlaying: true, positionSec: pos, updatedAt: new Date() })
        .where(eq(partyState.id, STATE_ID));
      return NextResponse.json({ ok: true });
    }
    case "skip": {
      await systemMessage(`The host skipped the track`);
      await advanceQueue();
      return NextResponse.json({ ok: true });
    }
    case "playNow": {
      const id = Number(body.queueId ?? 0);
      const rows = await db.select().from(queueItems).where(eq(queueItems.id, id));
      if (!rows.length) {
        return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
      }
      if (state.currentQueueId) {
        await db
          .update(queueItems)
          .set({ status: "done" })
          .where(eq(queueItems.id, state.currentQueueId));
      }
      const n = rows[0];
      await db.update(queueItems).set({ status: "playing" }).where(eq(queueItems.id, id));
      await db
        .update(partyState)
        .set({
          currentQueueId: n.id,
          videoId: n.videoId,
          title: n.title,
          artist: n.artist,
          thumbnail: n.thumbnail,
          durationSec: n.durationSec,
          isPlaying: true,
          positionSec: 0,
          startedByName: n.addedByName,
          updatedAt: new Date(),
        })
        .where(eq(partyState.id, STATE_ID));
      await systemMessage(`The host jumped the queue: ${n.title}`);
      return NextResponse.json({ ok: true });
    }
    default:
      return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
  }
}
