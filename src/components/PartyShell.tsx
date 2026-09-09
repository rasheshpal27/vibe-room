"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioLines,
  Crown,
  Disc3,
  ListMusic,
  LogOut,
  MessageSquare,
  Search,
  ListX,
  MessageSquareOff,
  Power,
  RotateCcw,
  Radio,
  X,
  LoaderCircle,
  SkipForward,
} from "lucide-react";
import Aurora from "./Aurora";
import NowPlaying from "./NowPlaying";
import QueuePanel from "./QueuePanel";
import SearchPanel from "./SearchPanel";
import ChatPanel from "./ChatPanel";
import type { PartySnapshot } from "@/lib/types";
import type { JoinedUser } from "./EntryGate";

const LS_ADMIN = "vibe_admin_key";
type Tab = "deck" | "queue" | "search" | "chat";

export default function PartyShell({
  me,
  onLeft,
  onMe,
}: {
  me: JoinedUser;
  onLeft: () => void;
  onMe: (u: JoinedUser) => void;
}) {
  const [snap, setSnap] = useState<PartySnapshot | null>(null);
  const [tab, setTab] = useState<Tab>("deck");
  const [adminKey, setAdminKey] = useState("");
  const [hostModal, setHostModal] = useState(false);
  const [unreadChat, setUnreadChat] = useState(0);
  const lastChatIdRef = useRef(0);
  const tabRef = useRef<Tab>("deck");
  tabRef.current = tab;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/state?u=${me.id}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as PartySnapshot;
      if (!data.you) {
        // we were removed (host ended the party)
        onLeft();
        return;
      }
      if (data.you.isAdmin !== me.isAdmin) {
        onMe({ ...me, isAdmin: data.you.isAdmin, color: data.you.color });
      }
      setSnap((prev) => {
        const last = data.chat[data.chat.length - 1];
        if (last && last.id !== lastChatIdRef.current) {
          if (tabRef.current !== "chat") {
            const prevMax = lastChatIdRef.current;
            setUnreadChat(data.chat.filter((c) => c.id > prevMax).length);
          }
          lastChatIdRef.current = last.id;
        }
        return data;
      });
    } catch {
      /* keep polling */
    }
  }, [me, onLeft, onMe]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const saved = localStorage.getItem(LS_ADMIN);
    if (saved) setAdminKey(saved);
  }, []);

  useEffect(() => {
    if (tab === "chat") setUnreadChat(0);
  }, [tab]);

  const isAdmin = !!adminKey;

  const playerAction = useCallback(
    async (action: string, extra: Record<string, unknown> = {}) => {
      await fetch("/api/player", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, adminKey, ...extra }),
      });
      await refresh();
    },
    [adminKey, refresh]
  );

  const adminAction = useCallback(
    async (action: string) => {
      await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, adminKey }),
      });
      if (action === "endParty") {
        onLeft();
        return;
      }
      await refresh();
    },
    [adminKey, refresh, onLeft]
  );

  const leave = async () => {
    await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "leave", userId: me.id }),
    }).catch(() => undefined);
    onLeft();
  };

  const playing = snap?.party.isPlaying && snap?.nowPlaying;
  const queueCount = snap?.queue.length ?? 0;

  return (
    <main className="grain relative flex min-h-dvh flex-col">
      <Aurora live={!!playing} />

      {/* ---------- header ---------- */}
      <header className="sticky top-0 z-40 border-b border-white/5 bg-[#050509]/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1500px] items-center gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-cyan-400">
              <AudioLines className="h-4.5 w-4.5 text-white" strokeWidth={2.4} />
            </div>
            <span className="hidden font-display text-sm font-bold tracking-tight sm:block">
              vibe<span className="text-fuchsia-400">·</span>room
            </span>
          </div>

          {/* live status */}
          <div className="flex items-center gap-2">
            {playing ? (
              <span className="flex items-center gap-1.5 rounded-full border border-red-400/30 bg-red-500/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em] text-red-300">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-red-400" />
                </span>
                On air
              </span>
            ) : (
              <span className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-400">
                <Radio className="h-3 w-3" />
                Standby
              </span>
            )}
            {(snap?.party.playCount ?? 0) > 0 && (
              <span className="hidden items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-400 md:flex">
                <Disc3 className="h-3 w-3" />
                {snap?.party.playCount} played
              </span>
            )}
          </div>

          <div className="ml-auto flex items-center gap-2.5">
            {/* listeners */}
            <div className="hidden items-center -space-x-2 sm:flex">
              {(snap?.users ?? []).slice(0, 6).map((u) => (
                <div
                  key={u.id}
                  title={u.name}
                  className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-[#0b0b13] text-[11px] font-bold text-black/80"
                  style={{ backgroundColor: u.color }}
                >
                  {u.name.slice(0, 1).toUpperCase()}
                </div>
              ))}
              <span className="ml-4 text-xs font-medium text-zinc-400">
                {snap?.users.length ?? 0} in room
              </span>
            </div>

            {!isAdmin && (
              <button
                onClick={() => setHostModal(true)}
                className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3.5 py-2 text-xs font-semibold text-zinc-300 transition hover:border-amber-300/40 hover:text-amber-200"
              >
                <Crown className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Host</span>
              </button>
            )}
            {isAdmin && (
              <span className="flex items-center gap-1.5 rounded-full border border-amber-300/30 bg-amber-400/10 px-3.5 py-2 text-xs font-bold text-amber-200">
                <Crown className="h-3.5 w-3.5" />
                HOST
              </span>
            )}
            <button
              onClick={leave}
              title="Leave the party"
              className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 text-zinc-400 transition hover:border-rose-400/40 hover:text-rose-300"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      {/* ---------- body ---------- */}
      <div className="relative z-10 mx-auto grid w-full max-w-[1500px] flex-1 gap-6 px-4 pb-28 pt-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_460px] lg:pb-10">
        {/* deck column */}
        <section className={`${tab === "deck" ? "block" : "hidden"} lg:block`}>
          <NowPlaying
            snap={snap}
            isAdmin={isAdmin}
            onPlayerAction={playerAction}
            onGoDiscover={() => setTab("search")}
          />
          {isAdmin && <AdminDock onAdmin={adminAction} onPlayer={playerAction} />}
        </section>

        {/* side panel */}
        <aside className={`${tab === "deck" ? "hidden lg:block" : "block"}`}>
          <div className="glass-deep flex h-full min-h-[60vh] flex-col overflow-hidden rounded-[1.8rem] lg:max-h-[calc(100dvh-7.5rem)] lg:sticky lg:top-24">
            {/* tabs */}
            <div className="flex items-center gap-1 border-b border-white/5 p-2">
              <SideTab
                active={tab === "queue"}
                onClick={() => setTab("queue")}
                icon={<ListMusic className="h-4 w-4" />}
                label={`Queue${queueCount ? ` · ${queueCount}` : ""}`}
              />
              <SideTab
                active={tab === "search"}
                onClick={() => setTab("search")}
                icon={<Search className="h-4 w-4" />}
                label="Discover"
              />
              <SideTab
                active={tab === "chat"}
                onClick={() => setTab("chat")}
                icon={<MessageSquare className="h-4 w-4" />}
                label="Chat"
                dot={unreadChat > 0}
                dotCount={unreadChat}
              />
            </div>
            <div className="min-h-0 flex-1">
              {tab === "queue" && (
                <QueuePanel snap={snap} isAdmin={isAdmin} adminKey={adminKey} refresh={refresh} onGoDiscover={() => setTab("search")} />
              )}
              {tab === "search" && <SearchPanel me={me} refresh={refresh} />}
              {tab === "chat" && <ChatPanel me={me} chat={snap?.chat ?? []} />}
              {tab === "deck" && (
                <div className="hidden lg:block">
                  <QueuePanel snap={snap} isAdmin={isAdmin} adminKey={adminKey} refresh={refresh} onGoDiscover={() => setTab("search")} />
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>

      {/* ---------- mobile bottom nav ---------- */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-white/10 bg-[#08080f]/95 backdrop-blur-xl lg:hidden">
        <div className="mx-auto grid max-w-md grid-cols-4 gap-1 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <NavBtn active={tab === "deck"} onClick={() => setTab("deck")} icon={<Disc3 className="h-5 w-5" />} label="Deck" playing={!!playing} />
          <NavBtn active={tab === "queue"} onClick={() => setTab("queue")} icon={<ListMusic className="h-5 w-5" />} label="Queue" badge={queueCount} />
          <NavBtn active={tab === "search"} onClick={() => setTab("search")} icon={<Search className="h-5 w-5" />} label="Discover" />
          <NavBtn active={tab === "chat"} onClick={() => setTab("chat")} icon={<MessageSquare className="h-5 w-5" />} label="Chat" badge={unreadChat} accent />
        </div>
      </nav>

      {/* ---------- host unlock modal ---------- */}
      {hostModal && (
        <HostModal
          me={me}
          onClose={() => setHostModal(false)}
          onUnlocked={(key, upgraded) => {
            localStorage.setItem(LS_ADMIN, key);
            setAdminKey(key);
            if (upgraded) onMe(upgraded);
            setHostModal(false);
            refresh();
          }}
          roomClosed={snap ? !snap.party.isOpen : false}
        />
      )}
      {!snap?.party.isOpen && snap && isAdmin && (
        <ReopenBanner onOpen={() => adminAction("openParty")} />
      )}
    </main>
  );
}

/* =============== pieces =============== */

function SideTab({
  active,
  onClick,
  icon,
  label,
  dot,
  dotCount,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  dot?: boolean;
  dotCount?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold transition ${
        active ? "bg-white/10 text-white" : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
      }`}
    >
      {icon}
      {label}
      {dot && (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-fuchsia-500 px-1 text-[9px] font-bold text-white">
          {dotCount && dotCount > 9 ? "9+" : dotCount}
        </span>
      )}
    </button>
  );
}

function NavBtn({
  active,
  onClick,
  icon,
  label,
  badge,
  playing,
  accent,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
  playing?: boolean;
  accent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative flex min-h-[48px] flex-col items-center justify-center gap-1 rounded-2xl text-[10px] font-semibold transition active:scale-95 ${
        active ? "bg-white/10 text-white" : "text-zinc-500"
      }`}
    >
      <span className={playing ? "animate-spin-slow" : ""}>{icon}</span>
      {label}
      {!!badge && (
        <span
          className={`absolute right-2 top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white ${
            accent ? "bg-fuchsia-500" : "bg-zinc-600"
          }`}
        >
          {badge > 9 ? "9+" : badge}
        </span>
      )}
    </button>
  );
}

function AdminDock({
  onAdmin,
  onPlayer,
}: {
  onAdmin: (a: string) => void;
  onPlayer: (a: string, e?: Record<string, unknown>) => void;
}) {
  const [armEnd, setArmEnd] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => void) => {
    setBusy(true);
    await fn();
    setBusy(false);
  };
  return (
    <div className="glass-deep mx-auto mt-6 flex w-fit max-w-full flex-wrap items-center justify-center gap-1.5 rounded-2xl p-2">
      <span className="mr-1 hidden items-center gap-1.5 px-2 text-[10px] font-bold uppercase tracking-[0.25em] text-amber-200/80 sm:flex">
        <Crown className="h-3.5 w-3.5" /> deck controls
      </span>
      <DockBtn title="Skip track" onClick={() => run(() => onPlayer("skip"))}>
        <SkipForward className="h-4 w-4" />
        <span className="text-xs font-semibold">Skip</span>
      </DockBtn>
      <DockBtn title="Clear queue" onClick={() => run(() => onAdmin("clearQueue"))}>
        <ListX className="h-4 w-4" />
        <span className="hidden text-xs font-semibold sm:inline">Clear queue</span>
      </DockBtn>
      <DockBtn title="Clear chat" onClick={() => run(() => onAdmin("clearChat"))}>
        <MessageSquareOff className="h-4 w-4" />
        <span className="hidden text-xs font-semibold sm:inline">Clear chat</span>
      </DockBtn>
      <DockBtn title="Reset everything (keep room open)" onClick={() => run(() => onAdmin("clearAll"))}>
        <RotateCcw className="h-4 w-4" />
        <span className="hidden text-xs font-semibold sm:inline">Reset</span>
      </DockBtn>
      <button
        onClick={() => {
          if (!armEnd) {
            setArmEnd(true);
            setTimeout(() => setArmEnd(false), 3200);
            return;
          }
          run(() => onAdmin("endParty"));
        }}
        className={`flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-bold transition ${
          armEnd
            ? "bg-red-500 text-white shadow-[0_0_24px_rgba(239,68,68,0.5)]"
            : "border border-red-400/30 bg-red-500/10 text-red-300 hover:bg-red-500/20"
        }`}
      >
        {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
        {armEnd ? "Tap again to END" : "End party"}
      </button>
    </div>
  );
}

function DockBtn({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-zinc-300 transition hover:border-violet-400/40 hover:text-white"
    >
      {children}
    </button>
  );
}

function ReopenBanner({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="fixed bottom-24 left-1/2 z-40 -translate-x-1/2 lg:bottom-8">
      <div className="glass-deep flex items-center gap-4 rounded-2xl px-5 py-3.5">
        <p className="text-sm text-zinc-300">Room is currently closed to guests.</p>
        <button
          onClick={onOpen}
          className="rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 px-4 py-2 text-xs font-bold uppercase tracking-widest text-white"
        >
          Reopen doors
        </button>
      </div>
    </div>
  );
}

function HostModal({
  me,
  onClose,
  onUnlocked,
  roomClosed,
}: {
  me: JoinedUser;
  onClose: () => void;
  onUnlocked: (key: string, upgraded: JoinedUser | null) => void;
  roomClosed: boolean;
}) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!pw.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      const check = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "admin", password: pw.trim() }),
      });
      if (!check.ok) {
        setErr("Wrong host password.");
        setBusy(false);
        return;
      }
      // upgrade this session to admin
      const join = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "join",
          password: pw.trim(),
          adminPassword: pw.trim(),
          name: me.name,
        }),
      }).then((r) => r.json());
      if (roomClosed) {
        await fetch("/api/admin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "openParty", adminKey: pw.trim() }),
        });
      }
      onUnlocked(pw.trim(), join?.user ?? null);
    } catch {
      setErr("Network hiccup. Try again.");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="glass-deep w-full max-w-sm animate-pop-in rounded-3xl p-7" onClick={(e) => e.stopPropagation()}>
        <div className="mb-5 flex items-start justify-between">
          <div>
            <p className="flex items-center gap-2 font-display text-lg text-white">
              <Crown className="h-5 w-5 text-amber-300" /> Host access
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              Control the deck, rearrange the queue, moderate the room.
            </p>
          </div>
          <button onClick={onClose} className="rounded-full p-1.5 text-zinc-500 hover:bg-white/10 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        <input
          type="password"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="host password"
          className="w-full rounded-2xl border border-white/10 bg-black/40 px-5 py-3.5 text-center font-display tracking-[0.3em] text-white outline-none focus:border-amber-300/50"
        />
        {err && <p className="mt-3 text-center text-sm text-rose-300">{err}</p>}
        <button
          onClick={submit}
          disabled={busy || !pw.trim()}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-amber-400 to-orange-500 px-5 py-3.5 font-display text-sm font-bold uppercase tracking-[0.2em] text-black transition hover:shadow-[0_0_30px_rgba(251,191,36,0.35)] disabled:opacity-40"
        >
          {busy ? <LoaderCircle className="h-5 w-5 animate-spin" /> : "Take the deck"}
        </button>
      </div>
    </div>
  );
}
