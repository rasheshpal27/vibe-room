import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  real,
  uuid,
  serial,
} from "drizzle-orm/pg-core";

/**
 * Single-row table (id = 1) holding the shared "deck" state:
 * what is playing right now, where the playhead is anchored, and
 * whether the room is open for guests.
 */
export const partyState = pgTable("party_state", {
  id: integer("id").primaryKey(),
  isOpen: boolean("is_open").notNull().default(true),

  currentQueueId: integer("current_queue_id"),
  videoId: text("video_id"),
  title: text("title"),
  artist: text("artist"),
  thumbnail: text("thumbnail"),
  durationSec: integer("duration_sec").notNull().default(0),

  isPlaying: boolean("is_playing").notNull().default(false),
  /** Position (seconds) anchored at `updatedAt`. */
  positionSec: real("position_sec").notNull().default(0),
  startedByName: text("started_by_name").default(""),

  /** How many songs have been played this party (for vibes/stats). */
  playCount: integer("play_count").notNull().default(0),

  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  color: text("color").notNull().default("#a78bfa"),
  lastSeen: timestamp("last_seen", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const queueItems = pgTable("queue_items", {
  id: serial("id").primaryKey(),
  videoId: text("video_id").notNull(),
  title: text("title").notNull(),
  artist: text("artist").notNull().default(""),
  thumbnail: text("thumbnail").notNull().default(""),
  durationSec: integer("duration_sec").notNull().default(0),
  addedById: uuid("added_by_id"),
  addedByName: text("added_by_name").notNull().default("Guest"),
  /** queued | playing | done */
  status: text("status").notNull().default("queued"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const chatMessages = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id"),
  userName: text("user_name").notNull().default("Guest"),
  userColor: text("user_color").notNull().default("#a78bfa"),
  isAdmin: boolean("is_admin").notNull().default(false),
  /** text | gif | system */
  kind: text("kind").notNull().default("text"),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
