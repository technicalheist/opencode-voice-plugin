import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { transcribeAudio, whisperStatus } from '../dist/transcribe.js';

const run = promisify(execFile);
const status = await whisperStatus({});
console.log('[stt]', status);
if (!status.ready) process.exit(1);

const dir = await mkdtemp(join(tmpdir(), 'opencode-voice-stt-'));
try {
  let file = process.argv[2];
  if (!file) {
    if (process.platform !== 'darwin') {
      console.error('Pass an audio file path, or run this on macOS to generate one with say.');
      process.exit(1);
    }
    file = join(dir, 'sample.aiff');
    await run('say', ['-o', file, 'Testing the OpenCode voice plugin transcription.']);
  }
  const audio = await readFile(resolve(file));
  const format = extname(file).replace('.', '') || 'wav';
  const started = Date.now();
  const text = await transcribeAudio(audio, format, {}, dir);
  console.log(`[stt] ${text}`);
  console.log(`[stt] ${Date.now() - started} ms`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
