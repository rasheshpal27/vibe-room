import { db } from "@/db";
import { chatMessages, partyState, queueItems, users } from "@/db/schema";
import { and, asc, desc, eq, gt, lt, ne, sql } from "drizzle-orm";
import { verifyAdminPassword } from "./env";
import { REACTION_MAX_ROWS, REACTION_WINDOW_MS } from "./reactions";
import type {
  ChatMessageDTO,
  PartySnapshot,
  QueueItemDTO,
  ReactionDTO,
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

/**
 * Host check. Constant-time, and false whenever ADMIN_PASSWORD is unset —
 * an unconfigured deployment has no host, it does not have a free one.
 */
export function isAdminKey(key: string | null | undefined) {
  return verifyAdminPassword(key);
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

export interface SnapshotOptions {
  /**
   * Highest chat id the client already has. When present the chat log comes
   * back as an increment instead of the whole window — a chat-heavy room
   * stops re-sending sixty messages on every one-second poll.
   */
  chatSince?: number | null;
}

export async function getSnapshot(
  youId?: string | null,
  options: SnapshotOptions = {}
): Promise<PartySnapshot> {
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

  const chatSince =
    typeof options.chatSince === "number" && Number.isFinite(options.chatSince)
      ? Math.max(0, Math.floor(options.chatSince))
      : null;
  const chatDelta = chatSince !== null;

  // Reactions share the chat table but never the chat log: they are ephemeral
  // confetti, not conversation.
  const notAReaction = ne(chatMessages.kind, "reaction");
  const chatWhere = chatDelta
    ? and(notAReaction, gt(chatMessages.id, chatSince))
    : notAReaction;

  // Bounded reads: an all-night party must not grow the payload (or the
  // query cost) of a poll that every guest runs once a second.
  const [queuedRows, historyRows, userRows, chatRows, reactionRows, chatMaxRows] =
    await Promise.all([
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
      .where(chatWhere)
      .orderBy(desc(chatMessages.id))
      .limit(MAX_CHAT_ROWS),
    db
      .select()
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.kind, "reaction"),
          gt(chatMessages.createdAt, new Date(Date.now() - REACTION_WINDOW_MS))
        )
      )
      .orderBy(desc(chatMessages.id))
      .limit(REACTION_MAX_ROWS),
    db
      .select({
        maxId: sql<number>`coalesce(max(${chatMessages.id}), 0)`,
      })
      .from(chatMessages)
      .where(notAReaction),
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

  const reactionsDto: ReactionDTO[] = [...reactionRows]
    .reverse()
    .map((r) => ({
      id: r.id,
      userId: r.userId,
      emoji: r.content,
      userName: r.userName,
      userColor: r.userColor,
      atMs: new Date(r.createdAt).getTime(),
    }));

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
    chatDelta,
    chatMaxId: Number(chatMaxRows[0]?.maxId ?? 0),
    reactions: reactionsDto,
    you,
  };
}

/**
 * Everything in a snapshot that a client would actually re-render for.
 *
 * `serverNow` and the heartbeat timestamps change on literally every poll,
 * so hashing the raw body would never produce a repeat. This mirrors the
 * client's own render signature and backs the ETag: an unchanged room
 * answers 304 with no body at all.
 */
export function snapshotSignature(snap: PartySnapshot): string {
  return JSON.stringify({
    p: snap.party,
    n: snap.nowPlaying,
    q: snap.queue,
    h: snap.history.map((x) => x.id),
    u: snap.users.map((x) => `${x.id}:${x.name}:${x.isAdmin}:${x.color}`),
    c: snap.chat.map((x) => x.id),
    cd: snap.chatDelta,
    cm: snap.chatMaxId,
    r: snap.reactions.map((x) => x.id),
    y: snap.you ? `${snap.you.id}:${snap.you.isAdmin}:${snap.you.color}` : null,
  });
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
