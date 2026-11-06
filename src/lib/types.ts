export interface SongResult {
  videoId: string;
  title: string;
  artist: string;
  thumbnail: string;
  durationSec: number;
}

export interface QueueItemDTO extends SongResult {
  id: number;
  addedByName: string;
  status: string;
  createdAt: string;
}

export interface UserDTO {
  id: string;
  name: string;
  isAdmin: boolean;
  color: string;
  lastSeen: string;
}

export interface ChatMessageDTO {
  id: number;
  userId: string | null;
  userName: string;
  userColor: string;
  isAdmin: boolean;
  kind: "text" | "gif" | "system";
  content: string;
  createdAt: string;
}

/** A floating reaction: a chat row of kind "reaction", lifted out of the log. */
export interface ReactionDTO {
  id: number;
  userId: string | null;
  emoji: string;
  userName: string;
  userColor: string;
  atMs: number;
}

export interface PartySnapshot {
  serverNow: number; // UTC ms epoch
  party: {
    isOpen: boolean;
    isPlaying: boolean;
    positionSec: number;
    durationSec: number;
    updatedAtMs: number;
    playCount: number;
  };
  nowPlaying: {
    queueId: number | null;
    videoId: string;
    title: string;
    artist: string;
    thumbnail: string;
    durationSec: number;
    addedByName: string;
  } | null;
  /** Upcoming queued songs (status === "queued") */
  queue: QueueItemDTO[];
  /** Previously played songs in this party session (status === "done"), ordered chronologically */
  history: QueueItemDTO[];
  users: UserDTO[];
  /**
   * Chat log. When the request carried `chatSince` this holds only the rows
   * newer than that id (see `chatDelta`) — a busy room should not re-send
   * sixty messages every second.
   */
  chat: ChatMessageDTO[];
  /** True when `chat` is an increment rather than the full window. */
  chatDelta: boolean;
  /** Highest chat id on the server; lower than the client's means it was cleared. */
  chatMaxId: number;
  /** Reactions from the last few seconds, for the floating overlay. */
  reactions: ReactionDTO[];
  you: UserDTO | null;
}

export const ytThumb = (videoId: string, hq = false) =>
  `https://i.ytimg.com/vi/${videoId}/${hq ? "maxresdefault" : "hqdefault"}.jpg`;

export function formatDuration(totalSec: number) {
  if (!totalSec || totalSec <= 0) return "--:--";
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
