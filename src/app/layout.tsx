import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Unbounded, Space_Grotesk, Instrument_Serif } from "next/font/google";
import "./globals.css";

const display = Unbounded({
  subsets: ["latin"],
  variable: "--font-unbounded",
  weight: ["400", "500", "600", "700", "800"],
});

const body = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space",
  weight: ["300", "400", "500", "600", "700"],
});

const serif = Instrument_Serif({
  subsets: ["latin"],
  variable: "--font-instrument",
  style: ["normal", "italic"],
  weight: "400",
});

export const metadata: Metadata = {
  title: "Vibe Room — one deck, everyone dancing",
  description:
    "A private listening room. Search any song, queue it up, chat live, and let the host run the deck.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#050509",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${serif.variable}`}>
      <body className="font-body bg-[#050509] text-zinc-100 antialiased selection:bg-fuchsia-500/40">
        {children}
      </body>
    </html>
  );
}
