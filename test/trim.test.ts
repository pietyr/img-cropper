import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { defaultOutputPath, parseBackground, readPixels, trimFile } from '../src/trim.ts';

let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'img-trim-test-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Color = { r: number; g: number; b: number; alpha: number };
const WHITE: Color = { r: 255, g: 255, b: 255, alpha: 1 };
const TRANSPARENT: Color = { r: 0, g: 0, b: 0, alpha: 0 };

/** Canvas of `bg` with one solid rectangle of `fg` on it. */
function canvas(width: number, height: number, bg: Color, rect: { left: number; top: number; width: number; height: number }, fg: Color) {
  return sharp({ create: { width, height, channels: 4, background: bg } }).composite([
    {
      input: { create: { width: rect.width, height: rect.height, channels: 4, background: fg } },
      left: rect.left,
      top: rect.top,
    },
  ]);
}

async function size(file: string) {
  const { width, height } = await sharp(file).metadata();
  return { width, height };
}

describe('trimFile', () => {
  test('transparent PNG: cuts exactly to the content', async () => {
    const input = path.join(dir, 'transparent.png');
    await canvas(100, 80, TRANSPARENT, { left: 20, top: 30, width: 40, height: 10 }, { r: 200, g: 0, b: 0, alpha: 1 }).png().toFile(input);

    const result = await trimFile(input, defaultOutputPath(input));

    assert.equal(result.background.kind, 'transparent');
    assert.deepEqual(result.box, { left: 20, top: 30, width: 40, height: 10 });
    assert.deepEqual(await size(path.join(dir, 'transparent-trimmed.png')), { width: 40, height: 10 });
  });

  test('white JPEG: default tolerance absorbs compression noise', async () => {
    const input = path.join(dir, 'white.jpg');
    await canvas(200, 120, WHITE, { left: 50, top: 40, width: 60, height: 30 }, { r: 20, g: 40, b: 120, alpha: 1 })
      .jpeg({ quality: 70 })
      .toFile(input);

    const result = await trimFile(input, defaultOutputPath(input));

    assert.equal(result.background.kind, 'color');
    const box = result.box!;
    // Allow a pixel or two of leftover ringing.
    assert.ok(Math.abs(box.left - 50) <= 2 && Math.abs(box.top - 40) <= 2, `box ${JSON.stringify(box)}`);
    assert.ok(Math.abs(box.width - 60) <= 4 && Math.abs(box.height - 30) <= 4, `box ${JSON.stringify(box)}`);
  });

  test('auto-detects a non-white solid background', async () => {
    const input = path.join(dir, 'blue.png');
    await canvas(90, 90, { r: 51, g: 102, b: 204, alpha: 1 }, { left: 5, top: 60, width: 70, height: 20 }, WHITE).png().toFile(input);

    const result = await trimFile(input, path.join(dir, 'blue-out.png'));

    assert.deepEqual(result.background, { kind: 'color', color: { r: 51, g: 102, b: 204, a: 255 } });
    assert.deepEqual(result.box, { left: 5, top: 60, width: 70, height: 20 });
  });

  test('explicit background overrides detection', async () => {
    // Content touches three edges, so the border is mostly content color; force white.
    const input = path.join(dir, 'mostly-content.png');
    await canvas(50, 50, WHITE, { left: 0, top: 0, width: 50, height: 40 }, { r: 0, g: 0, b: 0, alpha: 1 }).png().toFile(input);

    const result = await trimFile(input, path.join(dir, 'mostly-content-out.png'), { background: parseBackground('white') });

    assert.deepEqual(result.box, { left: 0, top: 0, width: 50, height: 40 });
  });

  test('padding keeps a margin, clamped to the image', async () => {
    const input = path.join(dir, 'pad.png');
    await canvas(100, 100, TRANSPARENT, { left: 3, top: 50, width: 10, height: 10 }, WHITE).png().toFile(input);

    const result = await trimFile(input, path.join(dir, 'pad-out.png'), { padding: 5 });

    assert.deepEqual(result.box, { left: 0, top: 45, width: 18, height: 20 });
  });

  test('fully blank image: nothing written', async () => {
    const input = path.join(dir, 'blank.png');
    const output = path.join(dir, 'blank-out.png');
    await sharp({ create: { width: 30, height: 30, channels: 4, background: WHITE } }).png().toFile(input);

    const result = await trimFile(input, output);

    assert.equal(result.box, null);
    assert.equal(existsSync(output), false);
  });

  test('respects EXIF orientation of JPEGs', async () => {
    const input = path.join(dir, 'rotated.jpg');
    // Stored 100x60 with a 30x10 block at (10,20); orientation 6 = displayed rotated 90° clockwise (60x100).
    await canvas(100, 60, WHITE, { left: 10, top: 20, width: 30, height: 10 }, { r: 0, g: 0, b: 0, alpha: 1 })
      .jpeg({ quality: 100 })
      .withMetadata({ orientation: 6 })
      .toFile(input);

    const result = await trimFile(input, path.join(dir, 'rotated-out.jpg'), {});

    assert.deepEqual(result.original, { width: 60, height: 100 });
    const box = result.box!;
    assert.ok(Math.abs(box.left - 30) <= 1 && Math.abs(box.top - 10) <= 1, `box ${JSON.stringify(box)}`);
    assert.ok(Math.abs(box.width - 10) <= 2 && Math.abs(box.height - 30) <= 2, `box ${JSON.stringify(box)}`);
    // The written file must show the same region: mostly the dark block.
    const out = await readPixels(path.join(dir, 'rotated-out.jpg'));
    assert.deepEqual({ width: out.width, height: out.height }, { width: box.width, height: box.height });
    const center = ((out.height >> 1) * out.width + (out.width >> 1)) * 4;
    assert.ok(out.data[center]! < 50, 'center of output should be the dark block');
  });

  test('in-place: output may be the input file', async () => {
    const input = path.join(dir, 'inplace.png');
    await canvas(40, 40, TRANSPARENT, { left: 10, top: 10, width: 5, height: 5 }, WHITE).png().toFile(input);

    await trimFile(input, input);

    assert.deepEqual(await size(input), { width: 5, height: 5 });
  });

  test('no margin: byte-for-byte copy, no re-encode', async () => {
    const input = path.join(dir, 'tight.jpg');
    const output = path.join(dir, 'tight-out.jpg');
    await canvas(40, 40, WHITE, { left: 3, top: 3, width: 34, height: 34 }, { r: 0, g: 0, b: 0, alpha: 1 })
      .jpeg({ quality: 60 })
      .toFile(input);

    // Padding grows the box back to the full image, so there is nothing to cut.
    const result = await trimFile(input, output, { padding: 5 });

    assert.equal(result.trimmed, false);
    assert.deepEqual(await readFile(output), await readFile(input));
  });

  test('rejects unsupported extensions', async () => {
    await assert.rejects(trimFile(path.join(dir, 'x.webp'), path.join(dir, 'y.webp')), /Unsupported file type/);
  });
});

describe('parseBackground', () => {
  test('named and hex colors', () => {
    assert.equal(parseBackground('auto'), 'auto');
    assert.deepEqual(parseBackground('Transparent'), { kind: 'transparent' });
    assert.deepEqual(parseBackground('#fff'), { kind: 'color', color: { r: 255, g: 255, b: 255, a: 255 } });
    assert.deepEqual(parseBackground('3366cc80'), { kind: 'color', color: { r: 51, g: 102, b: 204, a: 128 } });
    assert.throws(() => parseBackground('reddish'), /Invalid background/);
  });
});

test('defaultOutputPath keeps directory and extension', () => {
  assert.equal(defaultOutputPath('/a/b/logo.final.JPG'), '/a/b/logo.final-trimmed.JPG');
  assert.equal(defaultOutputPath('logo.png', '_cut'), 'logo_cut.png');
});
