"use client";

import { useEffect, useState } from "react";
import EntryGate, { type JoinedUser } from "@/components/EntryGate";
import PartyShell from "@/components/PartyShell";
import Aurora from "@/components/Aurora";
import { AudioLines } from "lucide-react";

const LS_USER = "vibe_user_v1";

export default function Page() {
  const [status, setStatus] = useState<"boot" | "gate" | "party">("boot");
  const [user, setUser] = useState<JoinedUser | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = localStorage.getItem(LS_USER);
        if (!raw) {
          setStatus("gate");
          return;
        }
        const stored = JSON.parse(raw) as JoinedUser;
        // verify the user still exists (host may have wiped the room)
        const res = await fetch(`/api/state?u=${stored.id}`, { cache: "no-store" });
        const snap = await res.json();
        if (cancelled) return;
        if (snap.you) {
          setUser({ id: snap.you.id, name: snap.you.name, isAdmin: snap.you.isAdmin, color: snap.you.color });
          setStatus("party");
        } else {
          localStorage.removeItem(LS_USER);
          setStatus("gate");
        }
      } catch {
        if (!cancelled) setStatus("gate");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleJoined = (u: JoinedUser) => {
    localStorage.setItem(LS_USER, JSON.stringify(u));
    setUser(u);
    setStatus("party");
  };

  const handleLeft = () => {
    localStorage.removeItem(LS_USER);
    setUser(null);
    setStatus("gate");
  };

  if (status === "boot") {
    return (
      <main className="relative flex min-h-dvh items-center justify-center">
        <Aurora />
        <div className="relative z-10 flex flex-col items-center gap-4">
          <AudioLines className="h-10 w-10 animate-breathe text-fuchsia-400" />
          <p className="font-display text-xs uppercase tracking-[0.5em] text-zinc-500">
            tuning the deck
          </p>
        </div>
      </main>
    );
  }

  if (status === "party" && user) {
    return <PartyShell me={user} onLeft={handleLeft} onMe={(u) => { localStorage.setItem(LS_USER, JSON.stringify(u)); setUser(u); }} />;
  }

  return <EntryGate onJoined={handleJoined} />;
}
