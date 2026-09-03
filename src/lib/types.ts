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

export interface PartySnapshot {
  serverNow: number; // ms epoch
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
    addedByName: string;
  } | null;
  queue: QueueItemDTO[];
  users: UserDTO[];
  chat: ChatMessageDTO[];
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
