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

export interface JoinedUser {
  id: string;
  name: string;
  isAdmin: boolean;
  color: string;
}

type Stage = "password" | "name" | "closed";

export default function EntryGate({ onJoined }: { onJoined: (u: JoinedUser) => void }) {
  const [stage, setStage] = useState<Stage>("password");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);

  const fail = (msg: string) => {
    setError(msg);
    setShake((s) => s + 1);
    setBusy(false);
  };

  const submitPassword = async () => {
    if (!password.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      // The same field accepts the party password OR the host password.
      // Try party first via a join probe is wasteful — instead we decide at name stage.
      // But "closed room" detection needs the party password, so probe now with a
      // throwaway join-free check: attempt admin verify; if that fails we assume
      // party password and validate at join time.
      const adminProbe = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "admin", password: password.trim() }),
      }).then((r) => r.json());

      if (adminProbe.ok) {
        setStage("name");
        setBusy(false);
        return;
      }
      setStage("name");
      setBusy(false);
    } catch {
      fail("Network hiccup. Try again.");
    }
  };

  const submitName = async () => {
    if (busy) return;
    const clean = name.trim();
    if (!clean) {
      fail("Tell us your name first.");
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
          password: password.trim(),
          adminPassword: password.trim(), // server picks whichever matches
          name: clean,
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
      onJoined(data.user as JoinedUser);
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
          {stage === "password" && (
            <div className="animate-fade-up">
              <p className="mb-6 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.3em] text-violet-300/80">
                <LockKeyhole className="h-3.5 w-3.5" />
                private session
              </p>
              <label className="mb-2 block font-display text-lg text-zinc-100">
                Enter the vibe code
              </label>
              <input
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitPassword()}
                placeholder="••••••••"
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/40 px-5 py-4 text-center font-display text-xl tracking-[0.4em] text-white outline-none transition placeholder:text-zinc-600 focus:border-fuchsia-400/60 focus:shadow-[0_0_30px_rgba(217,70,239,0.25)]"
              />
              <p className="mt-3 text-center text-xs text-zinc-500">
                Party password — or the host password if you run the deck.
              </p>
              {error && (
                <p className="mt-4 rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-2.5 text-center text-sm text-rose-200">
                  {error}
                </p>
              )}
              <button
                onClick={submitPassword}
                disabled={busy || !password.trim()}
                className="group mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-violet-500 via-fuchsia-500 to-cyan-400 px-5 py-4 font-display text-sm font-bold uppercase tracking-[0.2em] text-white transition hover:shadow-[0_0_40px_rgba(217,70,239,0.45)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? (
                  <LoaderCircle className="h-5 w-5 animate-spin" />
                ) : (
                  <>
                    Step inside
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                  </>
                )}
              </button>
            </div>
          )}

          {stage === "name" && (
            <div className="animate-fade-up">
              <p className="mb-6 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.3em] text-cyan-300/80">
                <UserRound className="h-3.5 w-3.5" />
                almost in
              </p>
              <label className="mb-2 block font-display text-lg text-zinc-100">
                What do we call you?
              </label>
              <input
                type="text"
                autoFocus
                maxLength={24}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitName()}
                placeholder="your name"
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/40 px-5 py-4 text-center font-display text-xl text-white outline-none transition placeholder:text-zinc-600 focus:border-cyan-300/60 focus:shadow-[0_0_30px_rgba(34,211,238,0.2)]"
              />
              {error && (
                <p className="mt-4 rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-2.5 text-center text-sm text-rose-200">
                  {error}
                </p>
              )}
              <button
                onClick={submitName}
                disabled={busy || !name.trim()}
                className="group mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-violet-500 via-fuchsia-500 to-cyan-400 px-5 py-4 font-display text-sm font-bold uppercase tracking-[0.2em] text-white transition hover:shadow-[0_0_40px_rgba(34,211,238,0.35)] disabled:cursor-not-allowed disabled:opacity-40"
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
              <button
                onClick={() => {
                  setStage("password");
                  setError("");
                }}
                className="mt-4 w-full text-center text-xs text-zinc-500 underline-offset-4 transition hover:text-zinc-300 hover:underline"
              >
                back
              </button>
            </div>
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
                  setStage("password");
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
