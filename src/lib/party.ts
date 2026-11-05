import { db } from "@/db";
import { chatMessages, partyState, queueItems, users } from "@/db/schema";
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { ADMIN_PASSWORD } from "./constants";
import type {
  ChatMessageDTO,
  PartySnapshot,
  QueueItemDTO,
  UserDTO,
} from "./types";

export const STATE_ID = 1;

/** Don't rewrite `lastSeen` on every 1s poll — only when it is this stale. */
const HEARTBEAT_MIN_INTERVAL_MS = 20_000;
const MAX_QUEUE_ROWS = 80;
const MAX_HISTORY_ROWS = 30;
const MAX_CHAT_ROWS = 60;

export async function ensureState() {
  const rows = await db
    .select()
    .from(partyState)
    .where(eq(partyState.id, STATE_ID))
    .limit(1);
  if (rows.length) return rows[0];
  await db
    .insert(partyState)
    .values({ id: STATE_ID })
    .onConflictDoNothing();
  const again = await db
    .select()
    .from(partyState)
    .where(eq(partyState.id, STATE_ID))
    .limit(1);
  return again[0];
}

export function isAdminKey(key: string | null | undefined) {
  return !!key && key === ADMIN_PASSWORD;
}

export function elapsedSec(state: {
  isPlaying: boolean;
  positionSec: number;
  updatedAt: Date;
}) {
  if (!state.isPlaying) return state.positionSec;
  const drift = (Date.now() - new Date(state.updatedAt).getTime()) / 1000;
  return state.positionSec + Math.max(0, drift);
}

/**
 * Mark current as done and promote the next queued item.
 *
 * `expectedQueueId` makes the call idempotent: every guest reports "ended"
 * for the same track, and without this guard the second request (which waits
 * on the row lock) would advance *again* and silently skip a song.
 */
export async function advanceQueue(expectedQueueId?: number | null): Promise<void> {
  await ensureState();
  // Run the promotion inside a transaction with a row lock so two devices
  // reporting "ended" at the same time can't advance the queue twice.
  await db.transaction(async (tx) => {
    const locked = await tx
      .select({ currentQueueId: partyState.currentQueueId })
      .from(partyState)
      .where(eq(partyState.id, STATE_ID))
      .for("update");

    const currentQueueId = locked[0]?.currentQueueId ?? null;

    // Someone else already moved the room on while we waited for the lock.
    if (
      expectedQueueId != null &&
      currentQueueId != null &&
      currentQueueId !== expectedQueueId
    ) {
      return;
    }

    if (currentQueueId) {
      await tx
        .update(queueItems)
        .set({ status: "done" })
        .where(eq(queueItems.id, currentQueueId));
    }

    const next = await tx
      .select()
      .from(queueItems)
      .where(eq(queueItems.status, "queued"))
      .orderBy(asc(queueItems.id))
      .limit(1);

    if (next.length) {
      const n = next[0];
      const cur = await tx
        .select({ playCount: partyState.playCount })
        .from(partyState)
        .where(eq(partyState.id, STATE_ID))
        .limit(1);
      await tx
        .update(queueItems)
        .set({ status: "playing" })
        .where(eq(queueItems.id, n.id));
      await tx
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
          playCount: (cur[0]?.playCount ?? 0) + 1,
          updatedAt: new Date(),
        })
        .where(eq(partyState.id, STATE_ID));
    } else {
      await tx
        .update(partyState)
        .set({
          currentQueueId: null,
          videoId: null,
          title: null,
          artist: null,
          thumbnail: null,
          durationSec: 0,
          isPlaying: false,
          positionSec: 0,
          startedByName: "",
          updatedAt: new Date(),
        })
        .where(eq(partyState.id, STATE_ID));
    }
  });
}

/** If nothing is playing but songs are queued, kick things off. */
export async function autostartIfIdle() {
  const state = await ensureState();
  if (!state.currentQueueId) {
    const queued = await db
      .select({ id: queueItems.id })
      .from(queueItems)
      .where(eq(queueItems.status, "queued"))
      .limit(1);
    if (queued.length) await advanceQueue();
  }
}

export async function systemMessage(content: string) {
  await db.insert(chatMessages).values({
    userId: null,
    userName: "VIBE",
    userColor: "#a78bfa",
    isAdmin: false,
    kind: "system",
    content,
  });
}

function toQueueItemDTO(q: typeof queueItems.$inferSelect): QueueItemDTO {
  return {
    id: q.id,
    videoId: q.videoId,
    title: q.title,
    artist: q.artist,
    thumbnail: q.thumbnail,
    durationSec: q.durationSec,
    addedByName: q.addedByName,
    status: q.status,
    createdAt: q.createdAt.toISOString(),
  };
}

export async function getSnapshot(youId?: string | null): Promise<PartySnapshot> {
  // Heartbeat. Guests poll once a second; writing `lastSeen` on every poll
  // is what turns a 10-person room into 10 writes/second. Only touch the row
  // when it is actually stale (online cutoff is 90s, so 20s is plenty).
  if (youId) {
    await db
      .update(users)
      .set({ lastSeen: new Date() })
      .where(
        and(
          eq(users.id, youId),
          lt(users.lastSeen, new Date(Date.now() - HEARTBEAT_MIN_INTERVAL_MS))
        )
      )
      .catch(() => undefined);
  }

  let state = await ensureState();

  // Auto-advance if the current song is long overdue (keeps party alive
  // even if every player's "ended" callback got lost).
  if (state.isPlaying && state.currentQueueId && state.durationSec > 0) {
    const pos = elapsedSec(state);
    if (pos > state.durationSec + 15) {
      await advanceQueue();
      state = await ensureState();
    }
  }

  // Bounded reads: an all-night party must not grow the payload (or the
  // query cost) of a poll that every guest runs once a second.
  const [queuedRows, historyRows, userRows, chatRows] = await Promise.all([
    db
      .select()
      .from(queueItems)
      .where(eq(queueItems.status, "queued"))
      .orderBy(asc(queueItems.id))
      .limit(MAX_QUEUE_ROWS),
    db
      .select()
      .from(queueItems)
      .where(eq(queueItems.status, "done"))
      .orderBy(desc(queueItems.id))
      .limit(MAX_HISTORY_ROWS),
    db.select().from(users).orderBy(asc(users.createdAt)).limit(100),
    db
      .select()
      .from(chatMessages)
      .orderBy(desc(chatMessages.id))
      .limit(MAX_CHAT_ROWS),
  ]);

  const onlineCutoff = Date.now() - 90 * 1000;
  const usersDto: UserDTO[] = userRows
    .filter((u) => new Date(u.lastSeen).getTime() > onlineCutoff)
    .map((u) => ({
      id: u.id,
      name: u.name,
      isAdmin: u.isAdmin,
      color: u.color,
      lastSeen: u.lastSeen.toISOString(),
    }));

  const queueDto: QueueItemDTO[] = queuedRows.map(toQueueItemDTO);

  // Oldest -> newest, matching what the history list expects.
  const historyDto: QueueItemDTO[] = [...historyRows].reverse().map(toQueueItemDTO);

  const chatDto: ChatMessageDTO[] = chatRows
    .map((c) => ({
      id: c.id,
      userId: c.userId,
      userName: c.userName,
      userColor: c.userColor,
      isAdmin: c.isAdmin,
      kind: c.kind as ChatMessageDTO["kind"],
      content: c.content,
      createdAt: c.createdAt.toISOString(),
    }))
    .reverse();

  const you = youId
    ? usersDto.find((u) => u.id === youId) ?? null
    : null;

  return {
    serverNow: Date.now(),
    party: {
      isOpen: state.isOpen,
      isPlaying: state.isPlaying,
      positionSec: state.positionSec,
      durationSec: state.durationSec,
      updatedAtMs: new Date(state.updatedAt).getTime(),
      playCount: state.playCount,
    },
    nowPlaying: state.videoId
      ? {
          queueId: state.currentQueueId,
          videoId: state.videoId,
          title: state.title ?? "",
          artist: state.artist ?? "",
          thumbnail: state.thumbnail ?? "",
          durationSec: state.durationSec ?? 0,
          addedByName: state.startedByName ?? "",
        }
      : null,
    queue: queueDto,
    history: historyDto,
    users: usersDto,
    chat: chatDto,
    you,
  };
}

/** Danger zone: wipe all party data (admin "close party"). */
export async function wipeParty(close: boolean) {
  await db.delete(chatMessages);
  await db.delete(queueItems);
  await db.delete(users);
  await db
    .update(partyState)
    .set({
      isOpen: !close,
      currentQueueId: null,
      videoId: null,
      title: null,
      artist: null,
      thumbnail: null,
      durationSec: 0,
      isPlaying: false,
      positionSec: 0,
      startedByName: "",
      playCount: 0,
      updatedAt: new Date(),
    })
    .where(eq(partyState.id, STATE_ID));
}

export const bumpStmt = sql`select 1`;
