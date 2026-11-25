#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  DEFAULT_JPEG_TOLERANCE,
  DEFAULT_TOLERANCE,
  defaultOutputPath,
  describeBackground,
  parseBackground,
  trimFile,
  type Background,
  type TrimOptions,
} from './trim.ts';

const HELP = `img-trim — cuts the empty (transparent / white / solid color) margin around an image.

Usage:
  img-trim [options] <image> [<image> ...]

Writes <name>-trimmed.<ext> next to each input. Supports .png and .jpg/.jpeg.

Options:
  -b, --background <c>  Background to cut: auto (default), transparent, white, black, or hex (#f0f0f0).
                        "auto" takes the most common color on the image border.
  -t, --tolerance <n>   Max per-channel difference (0-255) still treated as background.
                        Default ${DEFAULT_TOLERANCE} for PNG, ${DEFAULT_JPEG_TOLERANCE} for JPEG (compression noise).
                        Raise it if noise is left around the content, lower it if faint content gets cut.
  -p, --padding <n>     Keep n pixels of margin around the content (default 0).
  -s, --suffix <text>   Output name suffix (default "-trimmed").
  -o, --output <file>   Output path (only with a single input).
      --in-place        Overwrite the input file(s).
  -h, --help            Show this help.
`;

function parseNonNegativeInt(name: string, value: string, max = Infinity): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || n > max) {
    throw new Error(`--${name} must be an integer between 0 and ${max}, got "${value}".`);
  }
  return n;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      background: { type: 'string', short: 'b' },
      tolerance: { type: 'string', short: 't' },
      padding: { type: 'string', short: 'p' },
      suffix: { type: 'string', short: 's' },
      output: { type: 'string', short: 'o' },
      'in-place': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return values.help ? 0 : 1;
  }
  if (values.output && positionals.length > 1) throw new Error('--output can only be used with a single input file.');
  if (values.output && values['in-place']) throw new Error('--output and --in-place cannot be used together.');

  const background: Background | 'auto' = parseBackground(values.background ?? 'auto');
  const options: TrimOptions = { background };
  if (values.tolerance !== undefined) options.tolerance = parseNonNegativeInt('tolerance', values.tolerance, 255);
  if (values.padding !== undefined) options.padding = parseNonNegativeInt('padding', values.padding);

  let failures = 0;
  for (const input of positionals) {
    const output = values['in-place'] ? input : (values.output ?? defaultOutputPath(input, values.suffix));
    try {
      if (!values['in-place'] && path.resolve(output) === path.resolve(input)) {
        throw new Error('output would overwrite the input; use --in-place if that is intended.');
      }
      const result = await trimFile(input, output, options);
      const { width, height } = result.original;
      const bg = describeBackground(result.background);
      if (!result.box) {
        console.warn(`${input}: whole image is background (${bg}), nothing written.`);
        failures++;
      } else if (!result.trimmed) {
        const where = output === input ? 'left unchanged' : `copied to ${output}`;
        console.log(`${input}: no margin to trim (background ${bg}), ${where}`);
      } else {
        console.log(
          `${input}: ${width}x${height} → ${result.box.width}x${result.box.height} (background ${bg}) → ${output}`,
        );
      }
    } catch (error) {
      console.error(`${input}: ${error instanceof Error ? error.message : String(error)}`);
      failures++;
    }
  }
  return failures === 0 ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  },
);
