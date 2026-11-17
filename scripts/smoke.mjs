import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synthesizeSpeech } from '../dist/kokoro.js';
import { AudioPlayer } from '../dist/player.js';

const baseUrl = (process.env.KOKORO_BASE_URL ?? 'https://kokoro.shivrajan.com').replace(/\/+$/, '');
const voice = process.env.KOKORO_VOICE ?? 'af_heart';
const text = 'Voice plugin smoke test. Kokoro is connected and playback is working.';

const player = new AudioPlayer({
  player: process.env.VOICE_PLAYER ?? 'auto',
  playerArgs: [],
  debug: (message) => console.log(`[player] ${message}`),
});

if (!player.available) {
  console.error('No audio player found. Install afplay, mpv, ffplay, paplay, or aplay.');
  process.exit(1);
}

console.log(`[smoke] Kokoro ${baseUrl}, voice ${voice}, player ${player.name}`);
const started = Date.now();
const audio = await synthesizeSpeech(
  text,
  {
    baseUrl,
    model: process.env.KOKORO_MODEL ?? 'kokoro',
    voice,
    speed: Number(process.env.KOKORO_SPEED ?? 1),
    timeoutMs: 60_000,
  },
  undefined,
  (message) => console.log(`[kokoro] ${message}`),
);
console.log(`[smoke] received ${audio.length} bytes in ${Date.now() - started} ms`);

const dir = join(tmpdir(), 'opencode-voice-plugin-smoke');
await mkdir(dir, { recursive: true });
const file = join(dir, 'smoke.wav');
await writeFile(file, audio);
try {
  await player.play(file);
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log('[smoke] done');
