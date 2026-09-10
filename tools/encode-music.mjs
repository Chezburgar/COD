/**
 * Transcodes a supplied music track to the compact mono-ish MP3 the menu
 * streams. The game generates every other sound at runtime; this is the one
 * file it ships, so it is worth keeping small.
 *
 *   node tools/encode-music.mjs <input> [src/assets/menu-theme.mp3]
 */
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2];
const DST = process.argv[3] ?? 'src/assets/menu-theme.mp3';

if (!SRC || !fs.existsSync(SRC)) {
  console.error('usage: node tools/encode-music.mjs <input> [output.mp3]');
  process.exit(1);
}

fs.mkdirSync(path.dirname(DST), { recursive: true });
execFileSync(ffmpeg, [
  '-y', '-i', SRC,
  '-af', 'loudnorm=I=-19:TP=-2:LRA=11',   // quiet enough to sit behind the UI
  '-ac', '2', '-ar', '44100', '-b:a', '112k',
  DST,
], { stdio: 'inherit' });

console.log(`${DST}: ${(fs.statSync(DST).size / 1e6).toFixed(2)} MB`);
