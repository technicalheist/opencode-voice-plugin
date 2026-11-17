export interface VoicePluginOptions {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  voice?: string;
  speed?: number;
  speakOnIdle?: boolean;
  speakSubagents?: boolean;
  announceFinished?: boolean;
  subagentPrefix?: string;
  minChars?: number;
  maxChars?: number;
  chunkChars?: number;
  player?: string;
  playerArgs?: string[];
  timeoutMs?: number;
  ignoreTitles?: string[];
  whisperModel?: string;
  whisperLanguage?: string;
  debug?: boolean;
}

export interface ResolvedOptions {
  enabled: boolean;
  baseUrl: string;
  apiKey?: string;
  model: string;
  voice: string;
  speed: number;
  speakOnIdle: boolean;
  speakSubagents: boolean;
  announceFinished: boolean;
  subagentPrefix: string;
  minChars: number;
  maxChars: number;
  chunkChars: number;
  player: string;
  playerArgs: string[];
  timeoutMs: number;
  ignoreTitles: string[];
  whisperModel?: string;
  whisperLanguage: string;
  debug: boolean;
}

const DEFAULTS = {
  enabled: true,
  baseUrl: 'https://kokoro.shivrajan.com',
  model: 'kokoro',
  voice: 'af_heart',
  speed: 1,
  speakOnIdle: true,
  speakSubagents: true,
  announceFinished: false,
  subagentPrefix: 'Subtask finished.',
  minChars: 2,
  maxChars: 3000,
  chunkChars: 900,
  player: 'auto',
  timeoutMs: 60_000,
  whisperLanguage: 'en',
  debug: false,
};

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function resolveOptions(raw: Readonly<Record<string, unknown>> = {}): ResolvedOptions {
  const baseUrl = asString(raw.baseUrl, DEFAULTS.baseUrl).replace(/\/+$/, '');
  return {
    enabled: asBoolean(raw.enabled, DEFAULTS.enabled),
    baseUrl,
    apiKey: typeof raw.apiKey === 'string' && raw.apiKey.trim() ? raw.apiKey.trim() : undefined,
    model: asString(raw.model, DEFAULTS.model),
    voice: asString(raw.voice, DEFAULTS.voice),
    speed: asNumber(raw.speed, DEFAULTS.speed, 0.5, 2),
    speakOnIdle: asBoolean(raw.speakOnIdle, DEFAULTS.speakOnIdle),
    speakSubagents: asBoolean(raw.speakSubagents, DEFAULTS.speakSubagents),
    announceFinished: asBoolean(raw.announceFinished, DEFAULTS.announceFinished),
    subagentPrefix: asString(raw.subagentPrefix, DEFAULTS.subagentPrefix),
    minChars: Math.round(asNumber(raw.minChars, DEFAULTS.minChars, 1, 200)),
    maxChars: Math.round(asNumber(raw.maxChars, DEFAULTS.maxChars, 100, 20_000)),
    chunkChars: Math.round(asNumber(raw.chunkChars, DEFAULTS.chunkChars, 200, 2000)),
    player: asString(raw.player, DEFAULTS.player),
    playerArgs: asStringList(raw.playerArgs),
    timeoutMs: Math.round(asNumber(raw.timeoutMs, DEFAULTS.timeoutMs, 5000, 180_000)),
    ignoreTitles: asStringList(raw.ignoreTitles),
    whisperModel:
      typeof raw.whisperModel === 'string' && raw.whisperModel.trim()
        ? raw.whisperModel.trim()
        : undefined,
    whisperLanguage: asString(raw.whisperLanguage, DEFAULTS.whisperLanguage),
    debug: asBoolean(raw.debug, DEFAULTS.debug),
  };
}
