export const PARTY_PASSWORD =
  process.env.PARTY_PASSWORD ?? "hirashesh";
export const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD ?? "adminrasheshadmin";

export const AVATAR_COLORS = [
  "#a78bfa",
  "#f472b6",
  "#38bdf8",
  "#34d399",
  "#fbbf24",
  "#fb7185",
  "#22d3ee",
  "#c084fc",
  "#4ade80",
  "#f97316",
];

export interface Mood {
  id: string;
  label: string;
  query: string;
  /** tailwind-friendly gradient pair */
  from: string;
  to: string;
  icon: string; // lucide icon name resolved client-side
}

export const MOODS: Mood[] = [
  {
    id: "party",
    label: "Party Anthems",
    query: "best party anthems dance hits official",
    from: "#f43f5e",
    to: "#f59e0b",
    icon: "party-popper",
  },
  {
    id: "chill",
    label: "Late Night Chill",
    query: "chill late night vibes songs",
    from: "#6366f1",
    to: "#22d3ee",
    icon: "moon-star",
  },
  {
    id: "romantic",
    label: "Romantic",
    query: "romantic love songs official audio",
    from: "#ec4899",
    to: "#8b5cf6",
    icon: "heart",
  },
  {
    id: "desi",
    label: "Desi / Bollywood",
    query: "bollywood hits hindi songs official",
    from: "#f97316",
    to: "#e11d48",
    icon: "flame",
  },
  {
    id: "gym",
    label: "Beast Mode",
    query: "workout gym motivation songs edm",
    from: "#84cc16",
    to: "#10b981",
    icon: "dumbbell",
  },
  {
    id: "sad",
    label: "In My Feels",
    query: "sad heartbreak songs playlist official",
    from: "#3b82f6",
    to: "#6366f1",
    icon: "cloud-rain",
  },
  {
    id: "throwback",
    label: "Throwback",
    query: "90s 2000s throwback hits official",
    from: "#eab308",
    to: "#ef4444",
    icon: "disc-3",
  },
  {
    id: "drive",
    label: "Night Drive",
    query: "night drive synthwave retrowave mix",
    from: "#8b5cf6",
    to: "#ec4899",
    icon: "car-front",
  },
  {
    id: "focus",
    label: "Deep Focus",
    query: "deep focus ambient instrumental concentration",
    from: "#0ea5e9",
    to: "#14b8a6",
    icon: "brain",
  },
  {
    id: "acoustic",
    label: "Acoustic",
    query: "acoustic covers unplugged sessions",
    from: "#d97706",
    to: "#65a30d",
    icon: "guitar",
  },
];

/** Curated GIFs used when no GIF API key is configured. */
export const CURATED_GIFS: { id: string; url: string; tag: string }[] = [
  { id: "g1", url: "https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif", tag: "party" },
  { id: "g2", url: "https://media.giphy.com/media/3o7TKMt1VVNkHV4Pa0/giphy.gif", tag: "vibe" },
  { id: "g3", url: "https://media.giphy.com/media/l0MYGb1LuZ3n7dRnO/giphy.gif", tag: "dance" },
  { id: "g4", url: "https://media.giphy.com/media/111ebonMs90YLu/giphy.gif", tag: "yes" },
  { id: "g5", url: "https://media.giphy.com/media/l3q2K5jinAlChoCLS/giphy.gif", tag: "wow" },
  { id: "g6", url: "https://media.giphy.com/media/3oEjI6SIIHBdRxXI40/giphy.gif", tag: "fire" },
  { id: "g7", url: "https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy.gif", tag: "love" },
  { id: "g8", url: "https://media.giphy.com/media/xT9IgG50Fb7Mi0prBC/giphy.gif", tag: "party" },
  { id: "g9", url: "https://media.giphy.com/media/l0HlMG1EX2H38cZeE/giphy.gif", tag: "music" },
  { id: "g10", url: "https://media.giphy.com/media/26tPplGWjN0xLybiU/giphy.gif", tag: "clap" },
  { id: "g11", url: "https://media.giphy.com/media/3o7absbD7PbTFQa0c8/giphy.gif", tag: "sing" },
  { id: "g12", url: "https://media.giphy.com/media/13CoXDiaCcCoyk/giphy.gif", tag: "what" },
  { id: "g13", url: "https://media.giphy.com/media/5GoVLqeAOo6PK/giphy.gif", tag: "lol" },
  { id: "g14", url: "https://media.giphy.com/media/3o6Zt6KHxJTbXCnSvu/giphy.gif", tag: "dance" },
  { id: "g15", url: "https://media.giphy.com/media/QMHoU66sBXqqLq7vGO/giphy.gif", tag: "hype" },
  { id: "g16", url: "https://media.giphy.com/media/ISOckXUybVfQ4/giphy.gif", tag: "dj" },
];
