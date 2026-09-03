"use client";

import { useEffect, useRef, useState } from "react";
import { SendHorizontal, Smile, ImagePlay, Crown, X, Radio } from "lucide-react";
import { CURATED_GIFS } from "@/lib/constants";
import type { ChatMessageDTO } from "@/lib/types";
import type { JoinedUser } from "./EntryGate";

const EMOJI_GROUPS: { label: string; emojis: string[] }[] = [
  {
    label: "Party",
    emojis: ["🔥", "🎉", "🕺", "💃", "🪩", "🎶", "🎵", "🎧", "🎤", "🍾", "🥂", "⚡", "✨", "💯", "🙌", "👏"],
  },
  {
    label: "Vibes",
    emojis: ["😍", "🥹", "😭", "🥺", "😎", "🤯", "😴", "🌙", "❤️", "💜", "🖤", "💖", "💔", "🫶", "😮‍💨", "🫠"],
  },
  {
    label: "Reactions",
    emojis: ["😂", "🤣", "💀", "👍", "👎", "🙏", "👀", "🤝", "✌️", "🤘", "👑", "🐐", "🚗", "🌊", "🍕", "☕"],
  },
];

export default function ChatPanel({ me, chat }: { me: JoinedUser; chat: ChatMessageDTO[] }) {
  const [text, setText] = useState("");
  const [picker, setPicker] = useState<"none" | "emoji" | "gif">("none");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastIdRef = useRef(0);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    const last = chat[chat.length - 1];
    if (!el || !last) return;
    if (last.id !== lastIdRef.current) {
      lastIdRef.current = last.id;
      if (stickRef.current) {
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
      }
    }
  }, [chat]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const send = async (kind: "text" | "gif", content: string) => {
    const payload = content.trim();
    if (!payload || sending) return;
    setSending(true);
    try {
      await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: me.id, kind, content: payload }),
      });
      if (kind === "text") setText("");
      setPicker("none");
      stickRef.current = true;
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="relative flex h-full min-h-[55vh] flex-col lg:min-h-0">
      {/* messages */}
      <div ref={scrollRef} onScroll={onScroll} className="nice-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {chat.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Radio className="h-8 w-8 text-zinc-600" strokeWidth={1.5} />
            <p className="font-serif text-lg italic text-zinc-500">
              quiet room… say something scandalous
            </p>
          </div>
        )}
        {chat.map((m) => {
          if (m.kind === "system") {
            return (
              <div key={m.id} className="flex justify-center">
                <span className="rounded-full border border-white/5 bg-white/5 px-3.5 py-1 text-[10px] font-medium uppercase tracking-[0.15em] text-zinc-500">
                  {m.content}
                </span>
              </div>
            );
          }
          const mine = m.userId === me.id;
          return (
            <div key={m.id} className={`flex gap-2.5 ${mine ? "flex-row-reverse" : ""} animate-pop-in`}>
              <div
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-black/80"
                style={{ backgroundColor: m.userColor }}
              >
                {m.userName.slice(0, 1).toUpperCase()}
              </div>
              <div className={`max-w-[75%] ${mine ? "items-end text-right" : ""}`}>
                <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold" style={{ color: m.userColor }}>
                  {m.userName}
                  {m.isAdmin && <Crown className="h-3 w-3 text-amber-300" />}
                  <span className="ml-1 font-normal text-zinc-600">
                    {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </p>
                {m.kind === "gif" ? (
                  <img
                    src={m.content}
                    alt="gif"
                    loading="lazy"
                    className="max-h-52 rounded-2xl border border-white/10"
                  />
                ) : (
                  <span
                    className={`inline-block rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                      mine
                        ? "rounded-br-md bg-gradient-to-br from-violet-500/30 to-fuchsia-500/20 text-white"
                        : "rounded-bl-md bg-white/[0.07] text-zinc-100"
                    }`}
                  >
                    {m.content}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* pickers */}
      {picker !== "none" && (
        <div className="glass-deep absolute bottom-[76px] left-3 right-3 z-20 max-h-72 animate-pop-in overflow-hidden rounded-2xl">
          <div className="flex items-center justify-between border-b border-white/5 px-4 py-2.5">
            <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-zinc-500">
              {picker === "emoji" ? "emojis" : "GIFs"}
            </p>
            <button onClick={() => setPicker("none")} className="rounded-full p-1 text-zinc-500 hover:bg-white/10 hover:text-white">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="nice-scroll max-h-56 overflow-y-auto p-3">
            {picker === "emoji" ? (
              EMOJI_GROUPS.map((g) => (
                <div key={g.label} className="mb-3">
                  <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
                    {g.label}
                  </p>
                  <div className="grid grid-cols-8 gap-1">
                    {g.emojis.map((e) => (
                      <button
                        key={e}
                        onClick={() => setText((t) => t + e)}
                        className="flex h-9 items-center justify-center rounded-lg text-xl transition hover:scale-125 hover:bg-white/10"
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {CURATED_GIFS.map((g) => (
                    <button
                      key={g.id}
                      onClick={() => send("gif", g.url)}
                      className="group relative overflow-hidden rounded-xl transition hover:ring-2 hover:ring-fuchsia-400/60"
                    >
                      <img
                        src={g.url}
                        alt={g.tag}
                        loading="lazy"
                        className="h-20 w-full object-cover transition group-hover:scale-105"
                        onError={(e) => ((e.target as HTMLImageElement).parentElement!.style.display = "none")}
                      />
                      <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-white">
                        {g.tag}
                      </span>
                    </button>
                  ))}
                </div>
                <p className="mt-3 text-center text-[10px] leading-relaxed text-zinc-500">
                  Tip: paste any GIPHY / Tenor link straight into the chat box.
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {/* input */}
      <div className="border-t border-white/5 p-3">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setPicker((p) => (p === "emoji" ? "none" : "emoji"))}
            className={`flex h-11 w-10 items-center justify-center rounded-xl transition ${
              picker === "emoji" ? "bg-fuchsia-500/20 text-fuchsia-300" : "text-zinc-500 hover:bg-white/10 hover:text-white"
            }`}
            title="Emojis"
          >
            <Smile className="h-5 w-5" />
          </button>
          <button
            onClick={() => setPicker((p) => (p === "gif" ? "none" : "gif"))}
            className={`flex h-11 w-10 items-center justify-center rounded-xl transition ${
              picker === "gif" ? "bg-cyan-400/20 text-cyan-300" : "text-zinc-500 hover:bg-white/10 hover:text-white"
            }`}
            title="GIFs"
          >
            <ImagePlay className="h-5 w-5" />
          </button>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send("text", text)}
            onFocus={() => setPicker("none")}
            placeholder={`Say it, ${me.name}…`}
            maxLength={500}
            className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white outline-none transition placeholder:text-zinc-600 focus:border-violet-400/50"
          />
          <button
            onClick={() => send("text", text)}
            disabled={!text.trim() || sending}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white transition hover:shadow-[0_0_22px_rgba(168,85,247,0.5)] disabled:opacity-30"
          >
            <SendHorizontal className="h-4.5 w-4.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
