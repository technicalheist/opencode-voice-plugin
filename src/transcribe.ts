import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const MODEL_CACHE = new Map<string, Promise<string>>();
const COMMAND_CACHE = new Map<string, Promise<string>>();

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findModel(explicit?: string): Promise<string> {
  const candidates = [
    explicit,
    process.env.WHISPER_MODEL,
    join(homedir(), 'Library/Caches/opencode-harness/ggml-tiny.en.bin'),
    join(homedir(), '.cache/opencode-harness/ggml-tiny.en.bin'),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }

  const dirs = [
    join(homedir(), 'Library/Caches/opencode-harness'),
    join(homedir(), '.cache/opencode-harness'),
  ];
  for (const dir of dirs) {
    try {
      const names = await readdir(dir);
      const found = names.find((name) => /^ggml-.*\.bin$/.test(name));
      if (found) return join(dir, found);
    } catch {
      continue;
    }
  }
  throw new Error('Whisper model not found. Set WHISPER_MODEL or the whisperModel option.');
}

export async function resolveWhisperModel(explicit?: string): Promise<string> {
  const key = explicit ?? '';
  const cached = MODEL_CACHE.get(key);
  if (cached) return cached;
  const promise = findModel(explicit);
  MODEL_CACHE.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    MODEL_CACHE.delete(key);
    throw error;
  }
}

async function resolveCommand(name: string, fallbacks: string[]): Promise<string> {
  const cached = COMMAND_CACHE.get(name);
  if (cached) return cached;

  const promise = (async () => {
    for (const candidate of [name, ...fallbacks]) {
      if (candidate.includes('/')) {
        if (await exists(candidate)) return candidate;
        continue;
      }
      try {
        await run('which', [candidate], { timeout: 3000 });
        return candidate;
      } catch {
        continue;
      }
    }
    throw new Error(`${name} is not installed.`);
  })();

  COMMAND_CACHE.set(name, promise);
  try {
    return await promise;
  } catch (error) {
    COMMAND_CACHE.delete(name);
    throw error;
  }
}

export interface TranscribeOptions {
  model?: string;
  language?: string;
}

export async function whisperStatus(options: TranscribeOptions): Promise<{
  ready: boolean;
  model: string;
  reason?: string;
}> {
  try {
    const [model] = await Promise.all([
      resolveWhisperModel(options.model),
      resolveCommand('ffmpeg', ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']),
      resolveCommand('whisper-cli', [
        '/opt/homebrew/bin/whisper-cli',
        '/usr/local/bin/whisper-cli',
      ]),
    ]);
    return { ready: true, model };
  } catch (error) {
    return {
      ready: false,
      model: '',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function transcribeAudio(
  audio: Buffer,
  format: string,
  options: TranscribeOptions,
  tempDir: string,
  signal?: AbortSignal,
): Promise<string> {
  if (audio.length === 0) throw new Error('Recording is empty.');
  if (audio.length > MAX_AUDIO_BYTES) throw new Error('Recording is larger than 16 MB.');

  const [model, ffmpeg, whisper] = await Promise.all([
    resolveWhisperModel(options.model),
    resolveCommand('ffmpeg', ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']),
    resolveCommand('whisper-cli', ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli']),
  ]);

  const dir = await mkdtemp(join(tempDir, 'whisper-'));
  const extension = format.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'webm';
  const input = join(dir, `input.${extension}`);
  const wav = join(dir, 'audio.wav');
  const output = join(dir, 'transcript');

  try {
    await writeFile(input, audio);
    await run(
      ffmpeg,
      ['-nostdin', '-loglevel', 'error', '-i', input, '-t', '121', '-ar', '16000', '-ac', '1', wav],
      { signal, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
    );
    await run(
      whisper,
      ['-m', model, '-f', wav, '-l', options.language ?? 'en', '-nt', '-otxt', '-of', output],
      { signal, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
    );
    const text = (await readFile(`${output}.txt`, 'utf8')).trim();
    const cleaned = text
      .replace(/\[(?:BLANK_AUDIO|MUSIC|NOISE|SILENCE|APPLAUSE)\]/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) throw new Error('No speech detected.');
    return cleaned;
  } catch (error) {
    if (error instanceof Error && error.message === 'No speech detected.') throw error;
    if (signal?.aborted) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Local transcription failed. ${detail}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
