import { copyFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

/** RGBA color, every channel 0–255. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Background to cut away: a concrete color, or "transparent" (anything with alpha ≈ 0). */
export type Background = { kind: 'transparent' } | { kind: 'color'; color: Rgba };

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Decoded image: tightly packed RGBA, 4 bytes per pixel, row by row. */
export interface Pixels {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface TrimOptions {
  /** `'auto'` (default) detects the background from the image border. */
  background?: Background | 'auto';
  /** Max per-channel difference (0–255) still counted as background. Default: {@link defaultTolerance}. */
  tolerance?: number;
  /** Pixels of the original margin to keep around the content. Default 0. */
  padding?: number;
}

export const DEFAULT_TOLERANCE = 10;
/** JPEG compression rings around edges by up to ~25 levels (worse at low quality / 4:2:0 chroma). */
export const DEFAULT_JPEG_TOLERANCE = 24;

/** Tolerance used when none is given: higher for JPEG, whose margins are never perfectly uniform. */
export function defaultTolerance(filePath: string): number {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.jpg' || ext === '.jpeg' ? DEFAULT_JPEG_TOLERANCE : DEFAULT_TOLERANCE;
}

const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);

/**
 * Picks the background as the most common color on the image's 1-px border.
 *
 * Margins around a logo are by definition what the border is made of, so this
 * works for transparent, white and any other solid background. Colors are
 * grouped into coarse buckets so JPEG noise doesn't split one background into
 * many slightly different colors; the result is the average of the winning bucket.
 */
export function detectBackground({ data, width, height }: Pixels, tolerance = DEFAULT_TOLERANCE): Background {
  const buckets = new Map<string, { count: number; r: number; g: number; b: number; a: number }>();

  const add = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!, a = data[i + 3]!;
    // All (nearly) invisible pixels are the same background regardless of their RGB.
    const key = a <= tolerance ? 'transparent' : `${r >> 4},${g >> 4},${b >> 4}`;
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0, a: 0 };
    bucket.count++;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.a += a;
    buckets.set(key, bucket);
  };

  for (let x = 0; x < width; x++) {
    add(x, 0);
    if (height > 1) add(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    add(0, y);
    if (width > 1) add(width - 1, y);
  }

  let bestKey = '';
  let best = { count: 0, r: 0, g: 0, b: 0, a: 0 };
  for (const [key, bucket] of buckets) {
    if (bucket.count > best.count) {
      bestKey = key;
      best = bucket;
    }
  }

  if (bestKey === 'transparent') return { kind: 'transparent' };
  const avg = (sum: number) => Math.round(sum / best.count);
  return { kind: 'color', color: { r: avg(best.r), g: avg(best.g), b: avg(best.b), a: avg(best.a) } };
}

/** Returns a predicate telling whether the pixel at byte offset `i` belongs to the background. */
function backgroundMatcher(data: Uint8Array, background: Background, tolerance: number): (i: number) => boolean {
  if (background.kind === 'transparent') {
    return (i) => data[i + 3]! <= tolerance;
  }

  const { r: br, g: bg, b: bb } = background.color;
  return (i) => {
    const a = data[i + 3]!;
    // A (nearly) invisible pixel never shows as content, whatever the background.
    if (a <= tolerance) return true;
    // Compare what the pixel actually looks like when drawn over the background,
    // so semi-transparent pixels are judged by their visible color.
    const alpha = a / 255;
    const visible = (c: number, base: number) => c * alpha + base * (1 - alpha);
    return (
      Math.abs(visible(data[i]!, br) - br) <= tolerance &&
      Math.abs(visible(data[i + 1]!, bg) - bg) <= tolerance &&
      Math.abs(visible(data[i + 2]!, bb) - bb) <= tolerance
    );
  };
}

/**
 * Finds the smallest box containing every non-background pixel.
 *
 * Scans rows from the top and from the bottom, then columns from the left and
 * from the right (only within the rows already known to hold content), stopping
 * at the first row/column that contains at least one non-background pixel.
 * Returns `null` when the whole image is background.
 */
export function findContentBox(pixels: Pixels, background: Background, tolerance = DEFAULT_TOLERANCE): Box | null {
  const { data, width, height } = pixels;
  const isBackground = backgroundMatcher(data, background, tolerance);

  const rowIsBackground = (y: number) => {
    for (let x = 0; x < width; x++) if (!isBackground((y * width + x) * 4)) return false;
    return true;
  };

  let top = 0;
  while (top < height && rowIsBackground(top)) top++;
  if (top === height) return null;

  let bottom = height - 1;
  while (bottom > top && rowIsBackground(bottom)) bottom--;

  const columnIsBackground = (x: number) => {
    for (let y = top; y <= bottom; y++) if (!isBackground((y * width + x) * 4)) return false;
    return true;
  };

  let left = 0;
  while (left < width && columnIsBackground(left)) left++;

  let right = width - 1;
  while (right > left && columnIsBackground(right)) right--;

  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

/** Grows the box by `padding` on each side, without leaving the image. */
export function padBox(box: Box, padding: number, width: number, height: number): Box {
  const left = Math.max(0, box.left - padding);
  const top = Math.max(0, box.top - padding);
  const right = Math.min(width, box.left + box.width + padding);
  const bottom = Math.min(height, box.top + box.height + padding);
  return { left, top, width: right - left, height: bottom - top };
}

/** Parses `auto`, `transparent`, `white`, `black`, `#rgb`, `#rrggbb` or `#rrggbbaa`. */
export function parseBackground(value: string): Background | 'auto' {
  const v = value.trim().toLowerCase();
  if (v === 'auto') return 'auto';
  if (v === 'transparent') return { kind: 'transparent' };
  if (v === 'white') return { kind: 'color', color: { r: 255, g: 255, b: 255, a: 255 } };
  if (v === 'black') return { kind: 'color', color: { r: 0, g: 0, b: 0, a: 255 } };

  let hex = v.startsWith('#') ? v.slice(1) : v;
  if (/^[0-9a-f]{3}$/.test(hex)) hex = [...hex].map((c) => c + c).join('');
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(hex)) {
    const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
    return { kind: 'color', color: { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) : 255 } };
  }
  throw new Error(`Invalid background "${value}". Use auto, transparent, white, black or a hex color like #f0f0f0.`);
}

export function describeBackground(background: Background): string {
  if (background.kind === 'transparent') return 'transparent';
  const { r, g, b, a } = background.color;
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}${a < 255 ? hex(a) : ''}`;
}

/** `logo.png` → `logo-trimmed.png`, in the same directory. */
export function defaultOutputPath(inputPath: string, suffix = '-trimmed'): string {
  const { dir, name, ext } = path.parse(inputPath);
  return path.join(dir, `${name}${suffix}${ext}`);
}

/** Decodes a file to RGBA, applying EXIF orientation so coordinates match what viewers show. */
export async function readPixels(inputPath: string): Promise<Pixels> {
  const { data, info } = await sharp(inputPath).autoOrient().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export interface TrimResult {
  outputPath: string;
  background: Background;
  original: { width: number; height: number };
  /** Region kept from the original; `null` when the image is entirely background (nothing written). */
  box: Box | null;
  /** False when there was no margin: the output is a byte-for-byte copy (or untouched, if in place). */
  trimmed: boolean;
}

/** Writes via a temp file + rename, so an interrupted in-place write never leaves a half-written original. */
async function writeAtomically(outputPath: string, data: Uint8Array): Promise<void> {
  const tmp = `${outputPath}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, outputPath);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** Trims the background margin of one image file and writes the result to `outputPath`. */
export async function trimFile(inputPath: string, outputPath: string, options: TrimOptions = {}): Promise<TrimResult> {
  const ext = path.extname(inputPath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported file type "${ext || '(none)'}". Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}.`);
  }
  const tolerance = options.tolerance ?? defaultTolerance(inputPath);
  const padding = options.padding ?? 0;

  const pixels = await readPixels(inputPath);
  const background =
    !options.background || options.background === 'auto' ? detectBackground(pixels, tolerance) : options.background;
  const original = { width: pixels.width, height: pixels.height };

  const content = findContentBox(pixels, background, tolerance);
  if (!content) return { outputPath, background, original, box: null, trimmed: false };
  const box = padBox(content, padding, pixels.width, pixels.height);

  if (box.width === pixels.width && box.height === pixels.height) {
    // Nothing to cut: copy instead of re-encoding, which would lose JPEG quality for no benefit.
    if (path.resolve(outputPath) !== path.resolve(inputPath)) await copyFile(inputPath, outputPath);
    return { outputPath, background, original, box, trimmed: false };
  }

  // Crop the original file (not the decoded buffer) so the ICC profile survives.
  let image = sharp(inputPath).autoOrient().extract(box).keepIccProfile();
  if (ext === '.png') image = image.png({ compressionLevel: 9, adaptiveFiltering: true });
  else image = image.jpeg({ quality: 95, chromaSubsampling: '4:4:4', mozjpeg: true });
  // Encode to a buffer first so outputPath may equal inputPath (in-place trimming).
  await writeAtomically(outputPath, await image.toBuffer());

  return { outputPath, background, original, box, trimmed: true };
}
