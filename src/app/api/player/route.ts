import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { partyState, queueItems } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  advanceQueue,
  elapsedSec,
  ensureState,
  isAdminKey,
  STATE_ID,
  systemMessage,
} from "@/lib/party";
import { shouldAcceptEndReport } from "@/lib/playback";

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
      // Clients report the end themselves, and with crossfade they do it a
      // few seconds early on purpose so the next song can overlap. A report
      // that is far too early (stale client, wrong clock) must not cut the
      // track short for everyone.
      const accepted = shouldAcceptEndReport({
        elapsedSec: elapsedSec(state),
        stateDurationSec: state.durationSec ?? 0,
        clientDurationSec: Number(body.durationSec ?? 0) || null,
      });
      if (!accepted) {
        return NextResponse.json({ ok: true, ignored: "too-early" });
      }
      // Pass the id so simultaneous reports from every guest can only ever
      // advance this one track (otherwise the room skips a song).
      await advanceQueue(qid);
    }
    return NextResponse.json({ ok: true });
  }

  /**
   * Any client may correct the stored duration: search providers sometimes
   * report a wrong length, which freezes the progress bar and makes the
   * server cut the song short. Only applies to the track that is playing.
   */
  if (action === "duration") {
    const qid = Number(body.queueId ?? 0);
    const seconds = Math.round(Number(body.durationSec ?? 0));
    if (
      state.currentQueueId &&
      qid === state.currentQueueId &&
      Number.isFinite(seconds) &&
      seconds >= 20 &&
      seconds <= 7200 &&
      Math.abs(seconds - (state.durationSec ?? 0)) > 2
    ) {
      await db
        .update(partyState)
        .set({ durationSec: seconds })
        .where(eq(partyState.id, STATE_ID));
      await db
        .update(queueItems)
        .set({ durationSec: seconds })
        .where(eq(queueItems.id, qid));
      return NextResponse.json({ ok: true, updated: true });
    }
    return NextResponse.json({ ok: true, updated: false });
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
      await advanceQueue(qid);
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
