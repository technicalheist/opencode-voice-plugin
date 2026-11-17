import { createHash, randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Plugin } from '@opencode/plugin';
import { synthesizeSpeech } from './kokoro.js';
import { resolveOptions, type ResolvedOptions } from './options.js';
import { AudioPlayer } from './player.js';
import { SpeechQueue } from './queue.js';
import { chunkForSpeech, prepareForSpeech } from './speech.js';

interface TextPart {
  type: string;
  text?: string;
}

interface SpeechMessage {
  id: string;
  type: string;
  content?: TextPart[];
}

interface SessionInfoLike {
  id: string;
  parentID?: string | null;
  title?: string;
}

interface StoredSettings {
  enabled?: boolean;
  voice?: string;
  speed?: number;
}

interface VoiceSettings {
  enabled: boolean;
  voice: string;
  speed: number;
}

interface VoiceRuntime {
  options: ResolvedOptions;
  settings: VoiceSettings;
  player: AudioPlayer;
  queue: SpeechQueue;
  spoken: Set<string>;
  recentToolSpeech: Map<string, { text: string; at: number }>;
  debug: (text: string) => void;
  debugEnabled: boolean;
  tempDir: string;
  explicit: boolean;
}

const globals = globalThis as typeof globalThis & {
  __opencodeVoicePluginRuntime?: Promise<VoiceRuntime>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lastAssistantText(messages: SpeechMessage[]): { id: string; text: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.type !== 'assistant') continue;
    const text = (message.content ?? [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text?.trim() ?? '')
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) return { id: message.id, text };
  }
  return undefined;
}

function makeDebug(tempDir: string, enabled: boolean): (text: string) => void {
  if (!enabled) return () => {};
  const file = join(tempDir, 'debug.log');
  return (text: string) => {
    const line = `${new Date().toISOString()} ${text}`;
    console.log(`[voice] ${line}`);
    void appendFile(file, `${line}\n`).catch(() => {});
  };
}

function readStored(value: unknown, fallback: VoiceSettings): VoiceSettings {
  const stored = value as StoredSettings | undefined;
  return {
    enabled: typeof stored?.enabled === 'boolean' ? stored.enabled : fallback.enabled,
    voice: typeof stored?.voice === 'string' && stored.voice ? stored.voice : fallback.voice,
    speed:
      typeof stored?.speed === 'number' && Number.isFinite(stored.speed)
        ? Math.min(2, Math.max(0.5, stored.speed))
        : fallback.speed,
  };
}

function mergeSettings(target: VoiceSettings, source: StoredSettings | undefined): void {
  if (!source) return;
  if (typeof source.enabled === 'boolean') target.enabled = source.enabled;
  if (typeof source.voice === 'string' && source.voice) target.voice = source.voice;
  if (typeof source.speed === 'number' && Number.isFinite(source.speed)) {
    target.speed = Math.min(2, Math.max(0.5, source.speed));
  }
}

async function readSettingsFile(tempDir: string): Promise<StoredSettings | undefined> {
  try {
    const text = await readFile(join(tempDir, 'settings.json'), 'utf8');
    return JSON.parse(text) as StoredSettings;
  } catch {
    return undefined;
  }
}

async function writeSettingsFile(tempDir: string, settings: VoiceSettings): Promise<void> {
  await writeFile(join(tempDir, 'settings.json'), JSON.stringify(settings)).catch(() => {});
}

async function acquireSpeechLock(
  tempDir: string,
  sessionID: string,
  messageID: string,
): Promise<boolean> {
  const dir = join(tempDir, 'locks');
  await mkdir(dir, { recursive: true }).catch(() => {});
  const key = createHash('sha256').update(`${sessionID}:${messageID}`).digest('hex').slice(0, 32);
  try {
    const handle = await open(join(dir, `${key}.lock`), 'wx');
    await handle.writeFile(new Date().toISOString());
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

async function pruneLocks(tempDir: string): Promise<void> {
  const dir = join(tempDir, 'locks');
  try {
    const names = await readdir(dir);
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    await Promise.all(
      names.map(async (name) => {
        const file = join(dir, name);
        const info = await stat(file).catch(() => undefined);
        if (info && info.mtimeMs < cutoff) await unlink(file).catch(() => {});
      }),
    );
  } catch {
    return;
  }
  const speechLog = join(tempDir, 'speech.log');
  const info = await stat(speechLog).catch(() => undefined);
  if (info && info.size > 512 * 1024) await rm(speechLog, { force: true }).catch(() => {});
}

async function stopRequested(tempDir: string, since: number): Promise<boolean> {
  try {
    const info = await stat(join(tempDir, 'stop'));
    return info.mtimeMs >= since;
  } catch {
    return false;
  }
}

async function requestStop(tempDir: string): Promise<void> {
  await writeFile(join(tempDir, 'stop'), String(Date.now())).catch(() => {});
}

async function speakText(
  runtime: VoiceRuntime,
  text: string,
  signal: AbortSignal,
  tag?: string,
): Promise<void> {
  const prepared = prepareForSpeech(text, runtime.options.maxChars);
  if (!prepared) return;
  const chunks = chunkForSpeech(prepared, runtime.options.chunkChars);
  const startedAt = Date.now();
  const itemID = randomUUID().slice(0, 8);
  void appendFile(
    join(runtime.tempDir, 'speech.log'),
    `${new Date().toISOString()} start item=${itemID} tag=${tag ?? '-'} chars=${prepared.length}\n`,
  ).catch(() => {});
  for (const chunk of chunks) {
    if (signal.aborted) return;
    const shared = await readSettingsFile(runtime.tempDir);
    if (shared?.enabled === false) return;
    if (await stopRequested(runtime.tempDir, startedAt)) return;
    const voice = shared?.voice ?? runtime.settings.voice;
    const speed =
      typeof shared?.speed === 'number' ? Math.min(2, Math.max(0.5, shared.speed)) : runtime.settings.speed;
    void appendFile(
      join(runtime.tempDir, 'speech.log'),
      `${new Date().toISOString()} request item=${itemID} tag=${tag ?? '-'} voice=${voice} chars=${chunk.length}\n`,
    ).catch(() => {});
    const audio = await synthesizeSpeech(
      chunk,
      {
        baseUrl: runtime.options.baseUrl,
        apiKey: runtime.options.apiKey,
        model: runtime.options.model,
        voice,
        speed,
        timeoutMs: runtime.options.timeoutMs,
      },
      signal,
      (message) => runtime.debug(message),
    );
    const file = join(runtime.tempDir, `speech-${Date.now()}-${randomUUID()}.wav`);
    await writeFile(file, audio);
    const stopPlayback = () => runtime.player.stop();
    signal.addEventListener('abort', stopPlayback, { once: true });
    const stopWatch = setInterval(() => {
      void stopRequested(runtime.tempDir, startedAt).then((stop) => {
        if (stop) runtime.player.stop();
      });
    }, 400);
    try {
      if (signal.aborted) return;
      await runtime.player.play(file);
    } finally {
      clearInterval(stopWatch);
      signal.removeEventListener('abort', stopPlayback);
      await rm(file, { force: true }).catch(() => {});
    }
  }
}

async function createRuntime(
  ctx: { storage: { get: (key: string) => Promise<unknown> } },
  options: ResolvedOptions,
  explicit: boolean,
): Promise<VoiceRuntime> {
  const tempDir = join(tmpdir(), 'opencode-voice-plugin');
  await mkdir(tempDir, { recursive: true }).catch(() => {});
  await pruneLocks(tempDir);
  const stored = await ctx.storage.get('settings').catch(() => undefined);
  const fileSettings = await readSettingsFile(tempDir);
  const settings = readStored(stored, {
    enabled: options.enabled,
    voice: options.voice,
    speed: options.speed,
  });
  mergeSettings(settings, fileSettings);
  const debugEnabled = options.debug;
  const debug = makeDebug(tempDir, debugEnabled);

  const runtime = {
    options,
    settings,
    player: new AudioPlayer({
      player: options.player,
      playerArgs: options.playerArgs,
      debug,
    }),
    spoken: new Set<string>(),
    recentToolSpeech: new Map(),
    debug,
    debugEnabled,
    tempDir,
    explicit,
  } as VoiceRuntime;

  runtime.queue = new SpeechQueue(
    (text, signal, tag) => speakText(runtime, text, signal, tag),
    (error) => console.error(`[voice] speech failed: ${messageOf(error)}`),
  );
  await writeSettingsFile(tempDir, settings);

  if (!runtime.player.available) {
    console.warn(
      '[voice] no audio player found. Install afplay, mpv, ffplay, paplay, aplay, or set the "player" option.',
    );
  }
  runtime.debug(
    `Kokoro ${options.baseUrl}, voice ${runtime.settings.voice}, player ${runtime.player.name}`,
  );
  return runtime;
}

async function getRuntime(
  ctx: { storage: { get: (key: string) => Promise<unknown> } },
  options: ResolvedOptions,
  explicit: boolean,
): Promise<VoiceRuntime> {
  globals.__opencodeVoicePluginRuntime ??= createRuntime(ctx, options, explicit);
  const runtime = await globals.__opencodeVoicePluginRuntime;

  if (!runtime.explicit && explicit) {
    runtime.options = options;
    runtime.explicit = true;
    if (options.player !== 'auto' || options.playerArgs.length > 0) {
      runtime.player = new AudioPlayer({
        player: options.player,
        playerArgs: options.playerArgs,
        debug: (message) => runtime.debug(message),
      });
    }
    runtime.debug(`applied the package options for ${options.baseUrl}`);
  }
  if (options.debug && !runtime.debugEnabled) {
    runtime.debugEnabled = true;
    runtime.debug = makeDebug(runtime.tempDir, true);
  }
  return runtime;
}

export default Plugin.define({
  id: 'opencode-voice-plugin',
  async setup(ctx) {
    const options = resolveOptions(ctx.options);
    const explicit = Object.keys(ctx.options).length > 0;
    const runtime = await getRuntime(ctx, options, explicit);

    runtime.debug(`setup in OpenCode ${ctx.app.version} at ${ctx.location.directory}`);

    const persist = (): void => {
      void writeSettingsFile(runtime.tempDir, runtime.settings);
      void ctx.storage.set('settings', { ...runtime.settings }).catch(() => {});
    };

    const debug = (text: string): void => runtime.debug(text);
    const inFlight = new Set<string>();
    const pending = new Set<string>();

    const handleIdle = async (
      sessionID: string,
      background: readonly { kind: string }[],
    ): Promise<void> => {
      mergeSettings(runtime.settings, await readSettingsFile(runtime.tempDir));
      if (!runtime.settings.enabled || !runtime.options.speakOnIdle) return;
      if (inFlight.has(sessionID)) {
        pending.add(sessionID);
        return;
      }
      inFlight.add(sessionID);
      try {
        if (background.some((item) => item.kind === 'subagent')) {
          debug(`waiting for subagents in ${sessionID}`);
          return;
        }

        const info = (await ctx.session.get({ sessionID }).catch(() => undefined)) as
          | SessionInfoLike
          | undefined;
        if (!info) return;

        const isSubagent = Boolean(info.parentID);
        if (isSubagent && !runtime.options.speakSubagents) return;

        const title = (info.title ?? '').toLowerCase();
        if (runtime.options.ignoreTitles.some((fragment) => title.includes(fragment.toLowerCase()))) {
          return;
        }

        const messages = (await ctx.session.context({ sessionID })) as unknown as SpeechMessage[];
        const last = lastAssistantText(messages);
        if (!last) {
          if (
            runtime.options.announceFinished &&
            !isSubagent &&
            (await acquireSpeechLock(runtime.tempDir, sessionID, 'finished'))
          ) {
            runtime.queue.push('Finished.', 'finished');
          }
          return;
        }

        const key = `${sessionID}:${last.id}`;
        if (runtime.spoken.has(key)) return;
        if (!(await acquireSpeechLock(runtime.tempDir, sessionID, last.id))) return;
        runtime.spoken.add(key);
        if (runtime.spoken.size > 500) {
          const oldest = runtime.spoken.values().next().value;
          if (oldest) runtime.spoken.delete(oldest);
        }

        const text = prepareForSpeech(last.text, runtime.options.maxChars);
        if (text.length < runtime.options.minChars) return;

        const recent = runtime.recentToolSpeech.get(sessionID);
        if (recent) {
          if (Date.now() - recent.at < 5 * 60_000 && recent.text === text) {
            runtime.recentToolSpeech.delete(sessionID);
            debug(`skipping ${last.id}; the agent already spoke this reply`);
            return;
          }
          if (Date.now() - recent.at >= 5 * 60_000) runtime.recentToolSpeech.delete(sessionID);
        }

        const spoken =
          isSubagent && runtime.options.subagentPrefix
            ? `${runtime.options.subagentPrefix} ${text}`
            : text;
        debug(
          `speaking ${last.id}${isSubagent ? ' from a subagent' : ''} (${spoken.length} characters)`,
        );
        runtime.queue.push(spoken, last.id);
      } catch (error) {
        debug(`idle handler skipped: ${messageOf(error)}`);
      } finally {
        inFlight.delete(sessionID);
        if (pending.delete(sessionID)) void handleIdle(sessionID, background);
      }
    };

    let idleRegistration: { dispose: () => Promise<void> } | undefined;
    let eventAbort: AbortController | undefined;

    try {
      idleRegistration = await ctx.session.hook('experimental.idle', (event) =>
        handleIdle(event.sessionID, event.background),
      );
      debug('registered the experimental idle hook');
    } catch (error) {
      debug(`idle hook unavailable (${messageOf(error)}); using session.idle events`);
      eventAbort = new AbortController();
      const signal = eventAbort.signal;
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({
            types: ['session.idle'] as const,
            signal,
          })) {
            if (event.type === 'session.idle') {
              await handleIdle(event.data.sessionID, []);
            }
          }
        } catch (error) {
          if (!signal.aborted) debug(`event stream stopped: ${messageOf(error)}`);
        }
      })();
    }

    let toolRegistration: { dispose: () => Promise<void> } | undefined;
    try {
      toolRegistration = await ctx.tool.transform((editor) => {
        editor.add({
          name: 'voice_speak',
          description:
            'Speak a short message out loud to the user. Normal replies are already spoken automatically, so do not call this tool to repeat your final reply. Use it only when the user explicitly asks to hear something while you are still working.',
          input: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description: 'The text to speak aloud.',
              },
            },
            required: ['text'],
            additionalProperties: false,
          } as const,
          options: { codemode: false },
          execute: async (input, context) => {
            const value = (input as { text?: unknown }).text;
            const text = typeof value === 'string' ? value.trim() : '';
            if (!text) return { content: 'No text was provided.' };
            if (!runtime.settings.enabled) return { content: 'Voice is off. Run /voice on first.' };
            runtime.recentToolSpeech.set(context.sessionID, {
              text: prepareForSpeech(text, runtime.options.maxChars),
              at: Date.now(),
            });
            runtime.queue.push(text, 'tool');
            return { content: `Speaking ${text.length} characters.` };
          },
        });
      });
    } catch (error) {
      console.error(`[voice] could not register the voice_speak tool: ${messageOf(error)}`);
    }

    const statusText = (): string =>
      `Voice ${runtime.settings.enabled ? 'on' : 'off'}, voice ${
        runtime.settings.voice
      }, speed ${runtime.settings.speed.toFixed(1)}, Kokoro ${
        runtime.options.baseUrl
      }, player ${runtime.player.name}.`;

    const reply = async (sessionID: string, text: string): Promise<void> => {
      await ctx.session
        .synthetic({ sessionID, text: `Voice: ${text}`, resume: false })
        .catch(() => {});
    };

    let commandRegistration: { dispose: () => Promise<void> } | undefined;
    try {
      commandRegistration = await ctx.command.transform((editor) => {
        editor.add({
          name: 'voice',
          description: 'Control spoken replies: on, off, status, test, repeat, stop, voice, speed',
          execute: async ({ sessionID, prompt }) => {
            const args = prompt.text.trim().split(/\s+/).filter(Boolean);
            const action = (args.shift() ?? 'status').toLowerCase();

            switch (action) {
              case 'on':
                runtime.settings.enabled = true;
                persist();
                await reply(sessionID, 'on.');
                break;
              case 'off':
                runtime.settings.enabled = false;
                persist();
                void requestStop(runtime.tempDir);
                runtime.queue.stop();
                await reply(sessionID, 'off.');
                break;
              case 'stop':
                void requestStop(runtime.tempDir);
                runtime.queue.stop();
                await reply(sessionID, 'stopped.');
                break;
              case 'test':
                runtime.settings.enabled = true;
                persist();
                runtime.queue.push('Voice is ready. This is the OpenCode voice plugin.', 'test');
                await reply(sessionID, 'playing a test sentence.');
                break;
              case 'repeat': {
                const messages = (await ctx.session
                  .context({ sessionID })
                  .catch(() => [])) as unknown as SpeechMessage[];
                const last = lastAssistantText(messages);
                if (!last) {
                  await reply(sessionID, 'there is nothing to repeat yet.');
                  break;
                }
                runtime.queue.push(last.text, 'repeat');
                await reply(sessionID, 'repeating the last reply.');
                break;
              }
              case 'voice': {
                const voice = args[0];
                if (!voice) {
                  await reply(sessionID, `voice is ${runtime.settings.voice}.`);
                  break;
                }
                runtime.settings.voice = voice;
                persist();
                await reply(sessionID, `voice set to ${voice}.`);
                break;
              }
              case 'speed': {
                const speed = Number(args[0]);
                if (!args[0] || !Number.isFinite(speed)) {
                  await reply(sessionID, 'usage: /voice speed 1.0');
                  break;
                }
                runtime.settings.speed = Math.min(2, Math.max(0.5, speed));
                persist();
                await reply(sessionID, `speed set to ${runtime.settings.speed.toFixed(1)}.`);
                break;
              }
              case 'status':
                await reply(sessionID, statusText());
                break;
              default:
                await reply(
                  sessionID,
                  'commands: on, off, status, test, repeat, stop, voice <id>, speed <0.5-2>.',
                );
                break;
            }
          },
        });
      });
    } catch (error) {
      console.error(`[voice] could not register the /voice command: ${messageOf(error)}`);
    }

    return async () => {
      eventAbort?.abort();
      if (runtime.queue.busy) runtime.queue.stop();
      await idleRegistration?.dispose().catch(() => {});
      await toolRegistration?.dispose().catch(() => {});
      await commandRegistration?.dispose().catch(() => {});
    };
  },
});
