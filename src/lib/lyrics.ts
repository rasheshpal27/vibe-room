export function parseLyrics(lrc: string): { time: number; text: string }[] {
  return lrc.split(/\r?\n/).flatMap((line) => {
    const text = line.replace(/\[[^\]]*\]/g, "").trim();
    return [...line.matchAll(/\[(\d+):(\d{2}(?:\.\d+)?)\]/g)].map((match) => ({
      time: Number(match[1]) * 60 + Number(match[2]), text,
    }));
  }).sort((a, b) => a.time - b.time);
}
