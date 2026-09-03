import { db } from "@/db";
import { chatMessages, partyState, queueItems, users } from "@/db/schema";
import { asc, desc, eq, sql } from "drizzle-orm";
import { ADMIN_PASSWORD } from "./constants";
import type {
  ChatMessageDTO,
  PartySnapshot,
  QueueItemDTO,
  UserDTO,
} from "./types";

export const STATE_ID = 1;

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

/** Mark current as done and promote the next queued item. */
export async function advanceQueue(): Promise<void> {
  const state = await ensureState();
  if (state.currentQueueId) {
    await db
      .update(queueItems)
      .set({ status: "done" })
      .where(eq(queueItems.id, state.currentQueueId));
  }
  const next = await db
    .select()
    .from(queueItems)
    .where(eq(queueItems.status, "queued"))
    .orderBy(asc(queueItems.id))
    .limit(1);

  if (next.length) {
    const n = next[0];
    await db
      .update(queueItems)
      .set({ status: "playing" })
      .where(eq(queueItems.id, n.id));
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
        playCount: (state.playCount ?? 0) + 1,
        updatedAt: new Date(),
      })
      .where(eq(partyState.id, STATE_ID));
  } else {
    await db
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

export async function getSnapshot(youId?: string | null): Promise<PartySnapshot> {
  // heartbeat
  if (youId) {
    await db
      .update(users)
      .set({ lastSeen: new Date() })
      .where(eq(users.id, youId))
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

  const [queuedRows, userRows, chatRows] = await Promise.all([
    db
      .select()
      .from(queueItems)
      .where(eq(queueItems.status, "queued"))
      .orderBy(asc(queueItems.id)),
    db.select().from(users).orderBy(asc(users.createdAt)),
    db
      .select()
      .from(chatMessages)
      .orderBy(desc(chatMessages.id))
      .limit(120),
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

  const queueDto: QueueItemDTO[] = queuedRows.map((q) => ({
    id: q.id,
    videoId: q.videoId,
    title: q.title,
    artist: q.artist,
    thumbnail: q.thumbnail,
    durationSec: q.durationSec,
    addedByName: q.addedByName,
    status: q.status,
    createdAt: q.createdAt.toISOString(),
  }));

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
          addedByName: state.startedByName ?? "",
        }
      : null,
    queue: queueDto,
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
