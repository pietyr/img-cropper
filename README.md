# img-cropper

A CLI (`img-trim`) that cuts the empty margin around an image, whether it is transparent, white or any other solid color. It is built mainly for company logos that come on a canvas larger than the logo itself.

```
$ img-trim logo.png
logo.png: 800x500 → 408x140 (background transparent) → logo-trimmed.png
```

The result is saved next to the original as `<name>-trimmed.<ext>`. Supported formats: `.png`, `.jpg`/`.jpeg`.

## Installation

Requires Node 26 (LTS); the version is pinned in `.nvmrc`.

```sh
nvm use
npm install      # installs dependencies and builds dist/
npm link         # makes the `img-trim` command available globally
```

Without a global install: `node src/cli.ts <file>` (Node 26 runs TypeScript directly) or `npm start -- <file>`.

## Usage

```
img-trim [options] <image> [<image> ...]

  -b, --background <c>  Background to cut: auto (default), transparent, white, black or hex (#f0f0f0)
  -t, --tolerance <n>   Max per-channel difference (0-255) still treated as background.
                        Default 10 for PNG, 24 for JPEG
  -p, --padding <n>     Keep n pixels of margin around the content (default 0)
  -s, --suffix <text>   Output file name suffix (default "-trimmed")
  -o, --output <file>   Output path (single input file only)
      --in-place        Overwrite the input files
  -h, --help
```

Examples:

```sh
img-trim *.png *.jpg              # several files at once
img-trim -p 8 logo.png            # keep 8 px of breathing room
img-trim -b white logo.jpg        # force a white background instead of auto-detection
img-trim -t 40 noisy-scan.jpg     # heavily compressed JPEG
```

## Development

```sh
npm test           # tests (node:test)
npm run typecheck  # tsc --noEmit
npm run build      # compile to dist/
```
