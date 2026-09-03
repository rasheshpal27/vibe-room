import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { queueItems, users } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import {
  advanceQueue,
  autostartIfIdle,
  ensureState,
  isAdminKey,
  systemMessage,
} from "@/lib/party";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Add a song to the queue */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const userId = String(body.userId ?? "");
  const videoId = String(body.videoId ?? "").trim();
  const title = String(body.title ?? "").slice(0, 200);
  const artist = String(body.artist ?? "").slice(0, 120);
  const thumbnail = String(body.thumbnail ?? "").slice(0, 300);
  const durationSec = Math.max(0, Math.floor(Number(body.durationSec ?? 0)));

  if (!videoId || !title) {
    return NextResponse.json({ ok: false, error: "Missing song" }, { status: 400 });
  }
  if (!UUID_RE.test(userId)) {
    return NextResponse.json({ ok: false, error: "Join the party first" }, { status: 401 });
  }
  const found = await db.select().from(users).where(eq(users.id, userId));
  if (!found.length) {
    return NextResponse.json({ ok: false, error: "Join the party first" }, { status: 401 });
  }

  const state = await ensureState();
  const currentDup = state.currentQueueId && state.videoId === videoId;
  const queueDup = await db
    .select({ id: queueItems.id })
    .from(queueItems)
    .where(eq(queueItems.status, "queued"));
  const dup = currentDup || queueDup.length >= 60; // soft cap

  if (!currentDup) {
    await db.insert(queueItems).values({
      videoId,
      title,
      artist,
      thumbnail,
      durationSec,
      addedById: userId,
      addedByName: found[0].name,
      status: "queued",
    });
  }
  if (dup) {
    return NextResponse.json(
      { ok: false, error: "Queue is full, wait for a few songs to play." },
      { status: 429 }
    );
  }

  await autostartIfIdle();
  return NextResponse.json({ ok: true });
}

/** Remove a queued item (admin) */
export async function DELETE(req: NextRequest) {
  if (!isAdminKey(req.headers.get("x-admin-key"))) {
    return NextResponse.json({ ok: false, error: "Admin only" }, { status: 401 });
  }
  const id = Number(req.nextUrl.searchParams.get("id") ?? 0);
  if (!id) return NextResponse.json({ ok: false, error: "Missing id" }, { status: 400 });

  const state = await ensureState();
  if (state.currentQueueId === id) {
    await advanceQueue();
  } else {
    const rows = await db.select().from(queueItems).where(eq(queueItems.id, id));
    await db.delete(queueItems).where(eq(queueItems.id, id));
    if (rows.length) {
      await systemMessage(`${rows[0].title} was removed from the queue`);
    }
  }
  return NextResponse.json({ ok: true });
}

/** Reorder: move queued item up/down (admin) */
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!isAdminKey(String(body.adminKey ?? ""))) {
    return NextResponse.json({ ok: false, error: "Admin only" }, { status: 401 });
  }
  const id = Number(body.id ?? 0);
  const dir = body.dir === "down" ? "down" : "up";

  const queued = await db
    .select()
    .from(queueItems)
    .where(eq(queueItems.status, "queued"))
    .orderBy(asc(queueItems.id));
  const idx = queued.findIndex((q) => q.id === id);
  const swapIdx = dir === "up" ? idx - 1 : idx + 1;
  if (idx < 0 || swapIdx < 0 || swapIdx >= queued.length) {
    return NextResponse.json({ ok: true });
  }

  const a = queued[idx];
  const b = queued[swapIdx];
  const fieldsOf = (r: typeof a) => ({
    videoId: r.videoId,
    title: r.title,
    artist: r.artist,
    thumbnail: r.thumbnail,
    durationSec: r.durationSec,
    addedById: r.addedById,
    addedByName: r.addedByName,
  });
  await db.update(queueItems).set(fieldsOf(a)).where(eq(queueItems.id, b.id));
  await db.update(queueItems).set(fieldsOf(b)).where(eq(queueItems.id, a.id));

  return NextResponse.json({ ok: true });
}
