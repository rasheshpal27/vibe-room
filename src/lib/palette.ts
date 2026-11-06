/**
 * Per-track colour theming.
 *
 * The dominant colour of the current artwork is pushed into CSS variables,
 * so the aurora, the glow and the accents change with every song. The maths
 * is pure (and unit tested); only `extractPaletteFromImage` touches the DOM,
 * and it fails silently — a tainted canvas or a blocked image just leaves
 * the default violet theme in place.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface RoomTheme {
  /** Main accent, punchy enough to read on near-black. */
  accent: Rgb;
  /** Secondary accent, rotated around the wheel. */
  accent2: Rgb;
  /** Low-alpha wash for the aurora blobs. */
  glow: Rgb;
}

export function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const hue = ((h % 1) + 1) % 1;
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t0: number) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: Math.round(channel(hue + 1 / 3) * 255),
    g: Math.round(channel(hue) * 255),
    b: Math.round(channel(hue - 1 / 3) * 255),
  };
}

/**
 * Pick the colour a human would call "the colour of this thumbnail".
 *
 * Straight averaging turns every image into the same brown, so pixels are
 * bucketed in a coarse RGB grid and weighted by how colourful they are.
 * Near-black, near-white and grey pixels (letterboxing, text, UI chrome)
 * barely count.
 */
export function dominantColor(
  pixels: ArrayLike<number>,
  options: { step?: number } = {}
): Rgb | null {
  const step = Math.max(1, Math.floor(options.step ?? 1)) * 4;
  const buckets = new Map<number, { w: number; r: number; g: number; b: number }>();

  for (let i = 0; i + 3 < pixels.length; i += step) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const a = pixels[i + 3];
    if (a < 128) continue;

    const { s, l } = rgbToHsl({ r, g, b });
    if (l < 0.12 || l > 0.94) continue; // crushed blacks / blown highlights
    if (s < 0.12) continue; // grey chrome

    // Saturated mid-tones win; a bright flat colour beats a muddy one.
    const weight = s * s * (1 - Math.abs(l - 0.55));
    if (weight <= 0) continue;

    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const cur = buckets.get(key);
    if (cur) {
      cur.w += weight;
      cur.r += r * weight;
      cur.g += g * weight;
      cur.b += b * weight;
    } else {
      buckets.set(key, { w: weight, r: r * weight, g: g * weight, b: b * weight });
    }
  }

  let best: { w: number; r: number; g: number; b: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.w > best.w) best = bucket;
  }
  if (!best || best.w <= 0) return null;

  return {
    r: Math.round(best.r / best.w),
    g: Math.round(best.g / best.w),
    b: Math.round(best.b / best.w),
  };
}

/**
 * Normalise an arbitrary artwork colour into something that reads on the
 * room's near-black background, plus a complementary partner.
 */
export function themeFromColor(color: Rgb): RoomTheme {
  const { h, s, l } = rgbToHsl(color);
  const sat = Math.min(0.92, Math.max(0.55, s * 1.25));
  const accent = hslToRgb(h, sat, Math.min(0.68, Math.max(0.52, l * 0.9 + 0.2)));
  const accent2 = hslToRgb(h + 0.11, Math.min(0.9, sat * 0.95), 0.6);
  const glow = hslToRgb(h - 0.06, Math.min(0.95, sat), 0.5);
  return { accent, accent2, glow };
}

export const DEFAULT_THEME: RoomTheme = {
  accent: { r: 167, g: 139, b: 250 }, // violet-400
  accent2: { r: 232, g: 121, b: 249 }, // fuchsia-400
  glow: { r: 34, g: 211, b: 238 }, // cyan-400
};

export function rgbString({ r, g, b }: Rgb): string {
  return `${r} ${g} ${b}`;
}

/** Push a theme onto the document as CSS custom properties. */
export function applyRoomTheme(theme: RoomTheme | null) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const t = theme ?? DEFAULT_THEME;
  root.style.setProperty("--vibe-accent", rgbString(t.accent));
  root.style.setProperty("--vibe-accent-2", rgbString(t.accent2));
  root.style.setProperty("--vibe-glow", rgbString(t.glow));
}

const cache = new Map<string, RoomTheme>();

/**
 * Read the dominant colour out of a thumbnail. Resolves to null whenever the
 * browser will not let us (CORS, decode failure, no canvas) — the caller just
 * keeps the previous theme.
 */
export function extractPaletteFromImage(
  url: string,
  timeoutMs = 4000
): Promise<RoomTheme | null> {
  if (typeof document === "undefined" || !url) return Promise.resolve(null);
  const cached = cache.get(url);
  if (cached) return Promise.resolve(cached);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (theme: RoomTheme | null) => {
      if (settled) return;
      settled = true;
      if (theme) cache.set(url, theme);
      resolve(theme);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.onload = () => {
      clearTimeout(timer);
      try {
        const size = 36;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return finish(null);
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);
        const color = dominantColor(data);
        finish(color ? themeFromColor(color) : null);
      } catch {
        finish(null); // tainted canvas
      }
    };
    img.onerror = () => {
      clearTimeout(timer);
      finish(null);
    };
    img.src = url;
  });
}
