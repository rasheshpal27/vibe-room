"use client";

import { useState } from "react";
import {
  AudioLines,
  LockKeyhole,
  ArrowRight,
  Sparkles,
  UserRound,
  DoorClosed,
  LoaderCircle,
} from "lucide-react";
import Aurora from "./Aurora";
import { markAudioUnlocked } from "@/lib/audio-unlock";

export interface JoinedUser {
  id: string;
  name: string;
  isAdmin: boolean;
  color: string;
}

const LS_ADMIN = "vibe_admin_key";
type Stage = "form" | "closed";

export default function EntryGate({ onJoined }: { onJoined: (u: JoinedUser) => void }) {
  const [stage, setStage] = useState<Stage>("form");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);

  const fail = (msg: string) => {
    setError(msg);
    setShake((s) => s + 1);
    setBusy(false);
  };

  const submitJoin = async (e?: React.FormEvent) => {
    e?.preventDefault();
    // Joining is a real user gesture: it is what lets the deck start with
    // sound already on instead of a "tap for sound" prompt.
    markAudioUnlocked();
    if (busy) return;
    const cleanName = name.trim();
    const cleanPassword = password.trim();

    if (!cleanName) {
      fail("Tell us your name first.");
      return;
    }
    if (!cleanPassword) {
      fail("Enter the party or host password.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "join",
          password: cleanPassword,
          adminPassword: cleanPassword, // server picks whichever matches
          name: cleanName,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        if (res.status === 403) {
          setStage("closed");
          setBusy(false);
          return;
        }
        fail(data.error ?? "Could not join.");
        return;
      }
      const joined = data.user as JoinedUser;
      if (joined.isAdmin) {
        try {
          localStorage.setItem(LS_ADMIN, cleanPassword);
        } catch {
          /* ignore storage restrictions */
        }
      }
      onJoined(joined);
    } catch {
      fail("Network hiccup. Try again.");
    }
  };

  return (
    <main className="relative flex min-h-dvh items-center justify-center px-5 py-10">
      <Aurora />

      {/* floating decor */}
      <div className="pointer-events-none absolute left-[8%] top-[14%] hidden animate-float-y opacity-40 md:block">
        <AudioLines className="h-16 w-16 text-fuchsia-400/60" strokeWidth={1.2} />
      </div>
      <div
        className="pointer-events-none absolute bottom-[12%] right-[10%] hidden animate-float-y opacity-40 md:block"
        style={{ animationDelay: "-3s" }}
      >
        <Sparkles className="h-12 w-12 text-cyan-300/60" strokeWidth={1.2} />
      </div>

      <div className="relative z-10 w-full max-w-md">
        {/* logo lockup */}
        <div className="mb-10 flex flex-col items-center text-center animate-fade-up">
          <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-3xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-cyan-400 shadow-[0_0_50px_rgba(168,85,247,0.5)]">
            <AudioLines className="h-8 w-8 text-white" strokeWidth={2.2} />
          </div>
          <h1 className="font-display text-4xl font-bold tracking-tight text-white sm:text-5xl">
            vibe<span className="text-fuchsia-400">·</span>room
          </h1>
          <p className="mt-3 font-serif text-xl italic text-zinc-400">
            one deck, everyone dancing
          </p>
        </div>

        <div
          key={shake}
          className={`glass-deep rounded-[2rem] p-7 shadow-[0_40px_120px_rgba(0,0,0,0.6)] sm:p-9 ${shake ? "animate-shake" : "animate-pop-in"}`}
        >
          {stage === "form" && (
            <form onSubmit={submitJoin} className="animate-fade-up space-y-5">
              <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.3em] text-violet-300/80">
                <LockKeyhole className="h-3.5 w-3.5" />
                private session · step inside
              </p>

              <div>
                <label
                  htmlFor="entry-name"
                  className="mb-2 flex items-center gap-2 font-display text-sm text-zinc-100"
                >
                  <UserRound className="h-4 w-4 text-cyan-300" />
                  What do we call you?
                </label>
                <input
                  id="entry-name"
                  type="text"
                  autoFocus
                  maxLength={24}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="your name"
                  className="w-full rounded-2xl border border-white/10 bg-black/40 px-5 py-3.5 text-center font-display text-lg text-white outline-none transition placeholder:text-zinc-600 focus:border-cyan-300/60 focus:shadow-[0_0_30px_rgba(34,211,238,0.2)]"
                />
              </div>

              <div>
                <label
                  htmlFor="entry-password"
                  className="mb-2 flex items-center gap-2 font-display text-sm text-zinc-100"
                >
                  <LockKeyhole className="h-4 w-4 text-fuchsia-300" />
                  Enter the vibe code
                </label>
                <input
                  id="entry-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-2xl border border-white/10 bg-black/40 px-5 py-3.5 text-center font-display text-lg tracking-[0.35em] text-white outline-none transition placeholder:text-zinc-600 focus:border-fuchsia-400/60 focus:shadow-[0_0_30px_rgba(217,70,239,0.25)]"
                />
                <p className="mt-2 text-center text-xs text-zinc-500">
                  Party password — or the host password if you run the deck.
                </p>
              </div>

              {error && (
                <p className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-2.5 text-center text-sm text-rose-200">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={busy || !name.trim() || !password.trim()}
                className="group flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-violet-500 via-fuchsia-500 to-cyan-400 px-5 py-4 font-display text-sm font-bold uppercase tracking-[0.2em] text-white transition hover:shadow-[0_0_40px_rgba(217,70,239,0.45)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? (
                  <LoaderCircle className="h-5 w-5 animate-spin" />
                ) : (
                  <>
                    Join the party
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                  </>
                )}
              </button>
            </form>
          )}

          {stage === "closed" && (
            <div className="animate-fade-up text-center">
              <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/5">
                <DoorClosed className="h-7 w-7 text-zinc-400" />
              </div>
              <p className="font-display text-xl text-zinc-100">The room is dark right now</p>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                The host has ended this session. Come back when the lights are on — or log in
                with the host password to reopen the room.
              </p>
              <button
                onClick={() => {
                  setStage("form");
                  setError("");
                }}
                className="mt-6 w-full rounded-2xl border border-white/10 bg-white/5 px-5 py-4 font-display text-sm font-bold uppercase tracking-[0.2em] text-white transition hover:bg-white/10"
              >
                Try again
              </button>
            </div>
          )}
        </div>

        <p className="mt-8 text-center text-[10px] uppercase tracking-[0.4em] text-zinc-600">
          queue songs · chat live · lose track of time
        </p>
      </div>
    </main>
  );
}
