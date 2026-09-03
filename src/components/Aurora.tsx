"use client";

export default function Aurora({ live = false }: { live?: boolean }) {
  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden>
      {/* deep space base */}
      <div className="absolute inset-0 bg-[#050509]" />

      {/* rotating aurora blobs */}
      <div
        className="absolute left-1/2 top-1/2 h-[140vmax] w-[140vmax] -translate-x-1/2 -translate-y-1/2 animate-aurora opacity-60"
        style={{
          animationDuration: live ? "18s" : "34s",
          background:
            "conic-gradient(from 40deg at 50% 50%, transparent 0deg, rgba(124,58,237,0.16) 70deg, transparent 140deg, rgba(219,39,119,0.13) 210deg, transparent 280deg, rgba(34,211,238,0.10) 330deg, transparent 360deg)",
          filter: "blur(60px)",
        }}
      />
      <div
        className="absolute -left-[20%] top-[-30%] h-[70vmax] w-[70vmax] rounded-full opacity-40"
        style={{
          background: "radial-gradient(circle, rgba(124,58,237,0.35), transparent 62%)",
          filter: "blur(70px)",
        }}
      />
      <div
        className="absolute -right-[25%] bottom-[-35%] h-[80vmax] w-[80vmax] rounded-full opacity-35"
        style={{
          background: "radial-gradient(circle, rgba(219,39,119,0.32), transparent 62%)",
          filter: "blur(80px)",
        }}
      />
      <div
        className="absolute bottom-[-20%] left-[10%] h-[50vmax] w-[50vmax] rounded-full opacity-25"
        style={{
          background: "radial-gradient(circle, rgba(34,211,238,0.3), transparent 62%)",
          filter: "blur(80px)",
        }}
      />

      {/* vignette */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 50% 40%, transparent 30%, rgba(5,5,9,0.75) 100%)",
        }}
      />
    </div>
  );
}
